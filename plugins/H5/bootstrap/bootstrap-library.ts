import { pathToFileURL } from "node:url";
import { signedRequestHeaders, withSourceAuthNonce } from "../../chassis/src/core-client.ts";
import { CORE_API_URL, CORE_ORG_ID, CORE_SIGNING_SECRET } from "../../chassis/src/env.ts";

const IMPORT_TIMEOUT_MS = 120_000;
const MAX_NAME_CHARS = 200;
const MAX_ID_CHARS = 200;

export interface CoreResponse {
  status: number;
  json: unknown;
}

export interface CoreClient {
  call(method: "GET" | "POST", path: string, body?: unknown): Promise<CoreResponse>;
}

function createCoreClient(
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
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: response.status, json };
    },
  };
}

export interface BootstrapInput {
  adminPrincipalId: string;
  projectName: string;
  packUrl: string;
  packRef?: string;
  selected?: string[];
}

export interface Bootstrapped {
  status: "bootstrapped";
  projectId: string;
  projectScopeId: string;
  packId: string;
  projectCreated: boolean;
  packRegistered: boolean;
  importResult: unknown;
}

export interface BootstrapError {
  status: "error";
  code: string;
  message: string;
  upstream?: { status: number; body: unknown };
}

export type BootstrapOutcome = Bootstrapped | BootstrapError;

export interface BootstrapDeps {
  core: CoreClient;
  adminCore: CoreClient;
}

interface ProjectRef {
  id: string;
  scopeId: string;
  created: boolean;
}

async function ensureLibraryProject(deps: BootstrapDeps, input: BootstrapInput): Promise<ProjectRef | BootstrapError> {
  const list = await deps.core.call("GET", `/v1/projects?principalId=${encodeURIComponent(input.adminPrincipalId)}`);
  if (list.status !== 200) {
    return {
      status: "error",
      code: "project_list_failed",
      message: `core rejected project listing with ${list.status}`,
      upstream: { status: list.status, body: list.json },
    };
  }
  const projects = (list.json as { projects?: unknown }).projects;
  const existing = Array.isArray(projects)
    ? projects.find(
        (entry): entry is { id: string; scopeId: string } =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as { id?: unknown }).id === "string" &&
          typeof (entry as { scopeId?: unknown }).scopeId === "string" &&
          (entry as { name?: unknown }).name === input.projectName,
      )
    : undefined;
  if (existing) return { id: existing.id, scopeId: existing.scopeId, created: false };

  const created = await deps.core.call("POST", "/v1/projects", {
    principalId: input.adminPrincipalId,
    name: input.projectName,
  });
  if (created.status !== 201) {
    return {
      status: "error",
      code: "project_create_failed",
      message: `core rejected library project creation with ${created.status}`,
      upstream: { status: created.status, body: created.json },
    };
  }
  const project = (created.json as { project?: { id?: unknown; scopeId?: unknown } }).project;
  if (typeof project?.id !== "string" || typeof project.scopeId !== "string") {
    return {
      status: "error",
      code: "project_shape",
      message: "core returned a library project without id/scopeId",
      upstream: { status: created.status, body: created.json },
    };
  }
  return { id: project.id, scopeId: project.scopeId, created: true };
}

interface PackRef {
  id: string;
  registered: boolean;
}

async function ensurePack(deps: BootstrapDeps, input: BootstrapInput): Promise<PackRef | BootstrapError> {
  const list = await deps.adminCore.call("GET", "/v1/admin/skill-packs");
  if (list.status !== 200) {
    return {
      status: "error",
      code: "pack_list_failed",
      message: `core rejected skill pack listing with ${list.status} (x-admin-actor needs an admin grant)`,
      upstream: { status: list.status, body: list.json },
    };
  }
  const packs = (list.json as { packs?: unknown }).packs;
  const existing = Array.isArray(packs)
    ? packs.find(
        (entry): entry is { id: string } =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as { id?: unknown }).id === "string" &&
          (entry as { url?: unknown }).url === input.packUrl,
      )
    : undefined;
  if (existing) return { id: existing.id, registered: false };

  const registered = await deps.adminCore.call("POST", "/v1/admin/skill-packs", {
    url: input.packUrl,
    subset: "all",
    trustTier: "internal",
    ...(input.packRef ? { ref: input.packRef } : {}),
  });
  if (registered.status !== 200) {
    return {
      status: "error",
      code: "pack_register_failed",
      message: `core rejected skill pack registration with ${registered.status}`,
      upstream: { status: registered.status, body: registered.json },
    };
  }
  const pack = (registered.json as { pack?: { id?: unknown } }).pack;
  if (typeof pack?.id !== "string") {
    return {
      status: "error",
      code: "pack_shape",
      message: "core returned a skill pack without id",
      upstream: { status: registered.status, body: registered.json },
    };
  }
  return { id: pack.id, registered: true };
}

export async function bootstrapLibrary(deps: BootstrapDeps, input: BootstrapInput): Promise<BootstrapOutcome> {
  const project = await ensureLibraryProject(deps, input);
  if ("code" in project) return project;
  const pack = await ensurePack(deps, input);
  if ("code" in pack) return pack;
  const imported = await deps.adminCore.call("POST", `/v1/admin/skill-packs/${encodeURIComponent(pack.id)}/import`, {
    selected: input.selected?.length ? input.selected : "all",
    scopeIds: [project.scopeId],
  });
  if (imported.status !== 200) {
    return {
      status: "error",
      code: "pack_import_failed",
      message: `core rejected skill pack import with ${imported.status}`,
      upstream: { status: imported.status, body: imported.json },
    };
  }
  return {
    status: "bootstrapped",
    projectId: project.id,
    projectScopeId: project.scopeId,
    packId: pack.id,
    projectCreated: project.created,
    packRegistered: pack.registered,
    importResult: imported.json,
  };
}

export function parseBootstrapArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): BootstrapInput | { problem: string } {
  const single = new Map<string, string>();
  const selected: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag !== "--url" && flag !== "--name" && flag !== "--admin" && flag !== "--ref" && flag !== "--skill")
      return { problem: `unknown flag: ${flag}` };
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) return { problem: `${flag} requires a value` };
    if (flag === "--skill") selected.push(value);
    else single.set(flag, value);
    i++;
  }
  const packUrl = single.get("--url")?.trim() ?? "";
  const projectName = single.get("--name")?.trim() ?? "";
  const adminPrincipalId = single.get("--admin")?.trim() || env.PROFILES_LIBRARY_PRINCIPAL?.trim() || "";
  if (!packUrl) return { problem: "--url <git repository> is required" };
  if (!projectName) return { problem: "--name <library project name> is required" };
  if (!adminPrincipalId) return { problem: "--admin <principalId> or PROFILES_LIBRARY_PRINCIPAL is required" };
  if (projectName.length > MAX_NAME_CHARS) return { problem: "--name is too long (max 200 chars)" };
  if (adminPrincipalId.length > MAX_ID_CHARS) return { problem: "--admin is too long (max 200 chars)" };
  const packRef = single.get("--ref")?.trim() ?? "";
  return {
    adminPrincipalId,
    projectName,
    packUrl,
    ...(packRef ? { packRef } : {}),
    ...(selected.length ? { selected } : {}),
  };
}

export function adminActorHeader(principalId: string, orgId: string): string {
  return principalId.endsWith(`@${orgId}`) ? principalId : `${principalId}@${orgId}`;
}

async function runCli(): Promise<void> {
  const parsed = parseBootstrapArgs(process.argv.slice(2), process.env);
  if ("problem" in parsed) {
    console.error(`[h5-bootstrap] ${parsed.problem}`);
    console.error(
      "usage: node bootstrap/bootstrap-library.ts --url <git repository> --name <library project> [--admin <principalId>] [--ref <git ref>] [--skill <name>]...",
    );
    process.exitCode = 1;
    return;
  }
  const core = createCoreClient(CORE_API_URL, CORE_SIGNING_SECRET);
  const adminCore = createCoreClient(
    CORE_API_URL,
    CORE_SIGNING_SECRET,
    { "x-admin-actor": adminActorHeader(parsed.adminPrincipalId, CORE_ORG_ID) },
    IMPORT_TIMEOUT_MS,
  );
  const outcome = await bootstrapLibrary({ core, adminCore }, parsed);
  console.log(JSON.stringify(outcome, null, 2));
  if (outcome.status === "bootstrapped") console.error(`[h5-bootstrap] library scope: ${outcome.projectScopeId}`);
  else process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
