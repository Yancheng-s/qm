import { signedRequestHeaders, withSourceAuthNonce } from "../../chassis/src/core-client.ts";
import type { ProfilesConfig } from "./config.ts";
import type { AssemblyRegistry } from "./assemble-store.ts";

export interface CoreResponse {
  status: number;
  json: unknown;
}

export interface CoreClient {
  call(method: "GET" | "POST", path: string, body?: unknown): Promise<CoreResponse>;
}

export function createSignedCoreClient(
  baseUrl: string,
  secret: string | undefined,
  extraHeaders: Record<string, string> = {},
  timeoutMs = 15_000,
): CoreClient {
  return {
    async call(method, path, body) {
      const raw = body === undefined ? "" : JSON.stringify(body);
      const signedPath = withSourceAuthNonce(path, secret);
      const headers = signedRequestHeaders(secret, method, signedPath, raw, {
        ...extraHeaders,
        ...(raw ? { "content-type": "application/json" } : {}),
      });
      const response = await fetch(`${baseUrl}${signedPath}`, {
        method,
        headers,
        ...(raw ? { body: raw } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: response.status, json };
    },
  };
}

export interface AssembleInput {
  externalId?: string;
  name: string;
  principalId: string;
}

export interface Assembled {
  status: "assembled";
  projectId: string;
  projectScopeId: string;
  granted: string[];
  missing: string[];
  reused: boolean;
}

export interface AssembleError {
  status: "error";
  code: string;
  message: string;
  projectId?: string;
  granted?: string[];
  upstream?: { status: number; body: unknown };
}

export type AssembleOutcome = Assembled | AssembleError;

export interface AssembleDeps {
  core: CoreClient;
  cfg: ProfilesConfig;
  registry: AssemblyRegistry; 
  now?: () => number;
}

interface LibrarySkill {
  id: string;
  name: string;
}

async function resolveLibrarySkills(deps: AssembleDeps): Promise<{ found: LibrarySkill[]; missing: string[] }> {
  const path = `/v1/skills?principalId=${encodeURIComponent(deps.cfg.libraryPrincipalId)}`;
  const response = await deps.core.call("GET", path);
  if (response.status !== 200) {
    throw Object.assign(new Error(`core rejected skill listing with ${response.status}`), {
      code: "skill_list_failed",
      upstream: { status: response.status, body: response.json },
    });
  }
  const listed = (response.json as { skills?: unknown }).skills;
  if (!Array.isArray(listed)) {
    throw Object.assign(new Error("core returned an unexpected skill listing shape"), {
      code: "skill_list_failed",
    });
  }
  const inLibrary = listed.filter(
    (entry): entry is { id: string; name: string; scopeId: string } =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { id?: unknown }).id === "string" &&
      typeof (entry as { name?: unknown }).name === "string" &&
      (entry as { scopeId?: unknown }).scopeId === deps.cfg.libraryScopeId,
  );
  const found: LibrarySkill[] = [];
  const missing: string[] = [];
  if (!deps.cfg.skillNames.length) {
    for (const entry of inLibrary) found.push({ id: entry.id, name: entry.name });
    return { found, missing };
  }
  for (const name of deps.cfg.skillNames) {
    const match = inLibrary.find((entry) => entry.name === name);
    if (match) found.push({ id: match.id, name: match.name });
    else missing.push(name);
  }
  return { found, missing };
}

async function ensureGrants(
  deps: AssembleDeps,
  projectScopeId: string,
  skills: LibrarySkill[],
): Promise<{ granted: LibrarySkill[]; failed: Array<{ name: string; status: number; body: unknown }> }> {
  const granted: LibrarySkill[] = [];
  const failed: Array<{ name: string; status: number; body: unknown }> = [];
  for (const skill of skills) {
    const response = await deps.core.call("POST", "/v1/grants", {
      ownerScopeId: deps.cfg.libraryScopeId,
      ref: `skill:${skill.id}`,
      granteeScopeId: projectScopeId,
      permission: "read",
      grantedBy: deps.cfg.libraryPrincipalId,
    });
    if (response.status === 200) granted.push(skill);
    else failed.push({ name: skill.name, status: response.status, body: response.json });
  }
  return { granted, failed };
}

export async function assembleProject(deps: AssembleDeps, input: AssembleInput): Promise<AssembleOutcome> {
  const now = deps.now ?? (() => Date.now());
  let library: { found: LibrarySkill[]; missing: string[] };
  try {
    library = await resolveLibrarySkills(deps);
  } catch (e) {
    const err = e as Error & { code?: string; upstream?: { status: number; body: unknown } };
    return {
      status: "error",
      code: err.code ?? "skill_list_failed",
      message: err.message,
      ...(err.upstream ? { upstream: err.upstream } : {}),
    };
  }
  if (!library.found.length) {
    return {
      status: "error",
      code: "library_empty",
      message: `no skill available in library scope ${deps.cfg.libraryScopeId}`,
    };
  }

  const existing = input.externalId ? await deps.registry.get(input.externalId) : null;
  let projectId: string;
  let projectScopeId: string;
  let reused = false;

  if (existing) {
    projectId = existing.projectId;
    projectScopeId = existing.projectScopeId;
    reused = true;
  } else {
    const created = await deps.core.call("POST", "/v1/projects", {
      principalId: input.principalId,
      name: input.name,
    });
    if (created.status !== 201) {
      return {
        status: "error",
        code: "project_create_failed",
        message: `core rejected project creation with ${created.status}`,
        upstream: { status: created.status, body: created.json },
      };
    }
    const project = (created.json as { project?: { id?: unknown; scopeId?: unknown } }).project;
    if (typeof project?.id !== "string" || typeof project.scopeId !== "string") {
      return {
        status: "error",
        code: "project_shape",
        message: "core returned a project without id/scopeId",
        upstream: { status: created.status, body: created.json },
      };
    }
    projectId = project.id;
    projectScopeId = project.scopeId;
  }

  const { granted, failed } = await ensureGrants(deps, projectScopeId, library.found);
  const grantedNames = granted.map((skill) => skill.name);
  if (input.externalId) {
    await deps.registry.put({
      externalId: input.externalId,
      projectId,
      projectScopeId,
      grantedSkillIds: granted.map((skill) => skill.id),
      at: now(),
    });
  }
  if (failed.length) {
    return {
      status: "error",
      code: "grant_failed",
      message: `${failed.length} of ${library.found.length} grants rejected: ${failed.map((f) => f.name).join(", ")}`,
      projectId,
      granted: grantedNames,
      upstream: { status: failed[0]!.status, body: failed[0]!.body },
    };
  }
  return {
    status: "assembled",
    projectId,
    projectScopeId,
    granted: grantedNames,
    missing: library.missing,
    reused,
  };
}
