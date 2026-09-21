import { existsSync, readdirSync, readFileSync, writeFileSync, type Dirent } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { signedRequestHeaders, withSourceAuthNonce } from "../../chassis/src/core-client.ts";
import { CORE_API_URL, CORE_ORG_ID, CORE_SIGNING_SECRET } from "../../chassis/src/env.ts";

const IMPORT_TIMEOUT_MS = 120_000;
const MAX_NAME_CHARS = 200;
const MAX_ID_CHARS = 200;
const LIBRARY_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MCP_ID = /^[a-z][a-z0-9-]{1,39}$/;
const SCOPE_ID = /^[a-z]+:.+$/;
const MAX_MCP_NAME = 80;
const BOOTSTRAP_DIR = dirname(fileURLToPath(import.meta.url));
export const WORKTREE_ENV = resolve(BOOTSTRAP_DIR, "../../../.env");

export function asLocalGitUrl(absPath: string): string {
  const unix = absPath.replaceAll("\\", "/");
  return unix.startsWith("/") ? unix : `/${unix}`;
}

export interface CoreResponse {
  status: number;
  json: unknown;
}

export interface CoreClient {
  call(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<CoreResponse>;
}

export function createCoreClient(
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

export interface McpManifest {
  id: string;
  url: string;
  name: string;
  readOnly: boolean;
  auth: "none";
}

export interface LibraryManifest {
  library: string;
  projectName: string;
  skills?: string[];
  mcp?: McpManifest[];
}

export interface ScannedPack extends LibraryManifest {
  dir: string;
  packUrl: string;
}

export interface BootstrapInput {
  adminPrincipalId: string;
  projectName: string;
  packUrl: string;
  packRef?: string;
  selected?: string[];
  preferredScopeId?: string;
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

export interface BootstrapCli {
  adminPrincipalId: string;
  libraries: string[];
}

function parseMcpUrl(raw: string, label: string): string | { problem: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { problem: `${label}: mcp.url must be a valid URL` };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    return { problem: `${label}: mcp.url must be http(s)` };
  if (parsed.username || parsed.password || parsed.search || parsed.hash)
    return { problem: `${label}: mcp.url must not carry credentials, query, or fragment` };
  return raw.trim();
}

function parseMcpEntry(raw: unknown, label: string): McpManifest | { problem: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { problem: `${label}: mcp entry must be an object` };
  const body = raw as Record<string, unknown>;
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!MCP_ID.test(id)) return { problem: `${label}: mcp.id must match ${MCP_ID.source}` };
  if (typeof body.url !== "string" || !body.url.trim()) return { problem: `${label}: mcp.url is required` };
  const url = parseMcpUrl(body.url, label);
  if (typeof url !== "string") return url;
  const name =
    typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, MAX_MCP_NAME) : id;
  if (body.readOnly !== undefined && typeof body.readOnly !== "boolean")
    return { problem: `${label}: mcp.readOnly must be a boolean` };
  if (body.auth !== undefined && body.auth !== "none") return { problem: `${label}: mcp.auth must be "none"` };
  return { id, url, name, readOnly: body.readOnly === true, auth: "none" };
}

function parseMcpField(raw: unknown, label: string): McpManifest[] | undefined | { problem: string } {
  if (raw === undefined) return undefined;
  const entries = Array.isArray(raw) ? raw : [raw];
  if (!entries.length) return undefined;
  const mcp: McpManifest[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const parsed = parseMcpEntry(entries[i], entries.length === 1 ? `${label} mcp` : `${label} mcp[${i}]`);
    if ("problem" in parsed) return parsed;
    if (seen.has(parsed.id)) return { problem: `${label}: duplicate mcp.id "${parsed.id}"` };
    seen.add(parsed.id);
    mcp.push(parsed);
  }
  return mcp;
}

export function parseLibraryManifest(raw: unknown, label: string): LibraryManifest | { problem: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { problem: `${label}: library.json must be an object` };
  const body = raw as Record<string, unknown>;
  const library = typeof body.library === "string" ? body.library.trim() : "";
  if (!LIBRARY_KEY.test(library))
    return { problem: `${label}: library must match ${LIBRARY_KEY.source}` };
  const projectName =
    typeof body.projectName === "string" && body.projectName.trim() ? body.projectName.trim() : library;
  if (projectName.length > MAX_NAME_CHARS) return { problem: `${label}: projectName is too long (max 200 chars)` };
  let skills: string[] | undefined;
  if (body.skills !== undefined) {
    if (!Array.isArray(body.skills) || body.skills.some((item) => typeof item !== "string" || !item.trim()))
      return { problem: `${label}: skills must be an array of names` };
    const trimmed = body.skills.map((item) => (item as string).trim()).filter(Boolean);
    if (trimmed.length) skills = trimmed;
  }
  const mcp = parseMcpField(body.mcp, label);
  if (mcp && "problem" in mcp) return mcp;
  return {
    library,
    projectName,
    ...(skills ? { skills } : {}),
    ...(mcp?.length ? { mcp } : {}),
  };
}

function readDirents(dir: string): Dirent[] {
  return readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
}

function hasSkillMd(dir: string): boolean {
  let entries: Dirent[];
  try {
    entries = readDirents(dir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === "skill.md") return true;
    if (entry.isDirectory() && hasSkillMd(path)) return true;
  }
  return false;
}

export function scanBootstrapPacks(root: string): { packs: ScannedPack[]; problems: string[] } {
  const packs: ScannedPack[] = [];
  const problems: string[] = [];
  let entries: Dirent[];
  try {
    entries = readDirents(root);
  } catch (error) {
    return { packs, problems: [`cannot read ${root}: ${error instanceof Error ? error.message : String(error)}`] };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    if (!existsSync(join(dir, ".git")) || !hasSkillMd(dir)) continue;
    const manifestPath = join(dir, "library.json");
    if (!existsSync(manifestPath)) {
      problems.push(`${entry.name}: missing library.json`);
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      problems.push(`${entry.name}: library.json is not valid JSON`);
      continue;
    }
    const parsed = parseLibraryManifest(json, entry.name);
    if ("problem" in parsed) {
      problems.push(parsed.problem);
      continue;
    }
    packs.push({ dir, packUrl: asLocalGitUrl(resolve(dir)), ...parsed });
  }
  const seen = new Map<string, string>();
  const seenMcp = new Map<string, string>();
  for (const pack of packs) {
    const owner = seen.get(pack.library);
    if (owner) problems.push(`library "${pack.library}" is declared by both ${owner} and ${pack.dir}`);
    else seen.set(pack.library, pack.dir);
    for (const server of pack.mcp ?? []) {
      const mcpOwner = seenMcp.get(server.id);
      if (mcpOwner) problems.push(`mcp.id "${server.id}" is declared by both ${mcpOwner} and ${pack.dir}`);
      else seenMcp.set(server.id, pack.dir);
    }
  }
  return { packs, problems };
}

export function filterPacksByLibrary(
  packs: readonly ScannedPack[],
  libraries: string[],
): { packs: ScannedPack[] } | { problem: string } {
  const selected = libraries.length ? packs.filter((pack) => libraries.includes(pack.library)) : [...packs];
  const missing = libraries.filter((name) => !selected.some((pack) => pack.library === name));
  if (missing.length) {
    return {
      problem: `unknown library: ${missing.join(", ")} (found: ${packs.map((pack) => pack.library).join(", ") || "none"})`,
    };
  }
  return { packs: selected };
}

export function loadSelectedPacks(
  root: string,
  libraries: string[],
): { packs: ScannedPack[] } | { problems: string[] } {
  const scanned = scanBootstrapPacks(root);
  if (scanned.problems.length) return { problems: scanned.problems };
  const filtered = filterPacksByLibrary(scanned.packs, libraries);
  if ("problem" in filtered) return { problems: [filtered.problem] };
  if (!filtered.packs.length) return { problems: ["no skill packs with library.json under bootstrap/"] };
  return { packs: filtered.packs };
}

export function parseLibraryScopes(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of raw.split(",")) {
    const candidate = entry.trim();
    if (!candidate) continue;
    const separator = candidate.indexOf("=");
    const key = (separator < 0 ? candidate : candidate.slice(0, separator)).trim();
    const scopeId = separator < 0 ? "" : candidate.slice(separator + 1).trim();
    if (!LIBRARY_KEY.test(key) || !SCOPE_ID.test(scopeId)) continue;
    out.set(key, scopeId);
  }
  return out;
}

export function formatLibraryScopes(scopes: ReadonlyMap<string, string>): string {
  return [...scopes.entries()].map(([key, scopeId]) => `${key}=${scopeId}`).join(",");
}

export function mergeLibraryScopes(
  existing: ReadonlyMap<string, string>,
  updates: Iterable<readonly [string, string]>,
): Map<string, string> {
  const merged = new Map(existing);
  for (const [key, scopeId] of updates) merged.set(key, scopeId);
  return merged;
}

export function upsertEnvKey(contents: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(contents)) return contents.replace(pattern, line);
  const trimmed = contents.replace(/(?:\r?\n)+$/, "");
  return `${trimmed}${trimmed ? "\n" : ""}${line}\n`;
}

export function parseBootstrapArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): BootstrapCli | { problem: string } {
  const libraries: string[] = [];
  let admin = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--admin") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) return { problem: "--admin requires a value" };
      admin = value.trim();
      i++;
      continue;
    }
    if (arg.startsWith("-")) return { problem: `unknown flag: ${arg}` };
    const name = arg.trim();
    if (name) libraries.push(name);
  }
  const adminPrincipalId = admin || env.LIBRARY_PRINCIPAL?.trim() || "";
  if (!adminPrincipalId) return { problem: "--admin <principalId> or LIBRARY_PRINCIPAL is required" };
  if (adminPrincipalId.length > MAX_ID_CHARS) return { problem: "--admin is too long (max 200 chars)" };
  const unknown = libraries.filter((name) => !LIBRARY_KEY.test(name));
  if (unknown.length) return { problem: `invalid library key: ${unknown.join(", ")}` };
  return { adminPrincipalId, libraries: [...new Set(libraries)] };
}

interface ProjectRef {
  id: string;
  scopeId: string;
  created: boolean;
}

function asProject(entry: unknown): { id: string; name: string; scopeId: string } | null {
  if (typeof entry !== "object" || entry === null) return null;
  const item = entry as { id?: unknown; name?: unknown; scopeId?: unknown };
  if (typeof item.id !== "string" || typeof item.scopeId !== "string") return null;
  return { id: item.id, scopeId: item.scopeId, name: typeof item.name === "string" ? item.name : "" };
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
  const projects = Array.isArray((list.json as { projects?: unknown }).projects)
    ? ((list.json as { projects: unknown[] }).projects.map(asProject).filter(Boolean) as Array<{
        id: string;
        name: string;
        scopeId: string;
      }>)
    : [];
  const byScope = input.preferredScopeId
    ? projects.find((project) => project.scopeId === input.preferredScopeId)
    : undefined;
  if (byScope) return { id: byScope.id, scopeId: byScope.scopeId, created: false };
  const byName = projects.find((project) => project.name === input.projectName);
  if (byName) return { id: byName.id, scopeId: byName.scopeId, created: false };

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

export async function bootstrapScannedPacks(
  deps: BootstrapDeps,
  packs: readonly ScannedPack[],
  adminPrincipalId: string,
  existingScopes: ReadonlyMap<string, string>,
): Promise<{
  results: Array<{ library: string; outcome: BootstrapOutcome }>;
  scopes: Map<string, string>;
}> {
  const scopes = new Map(existingScopes);
  const results: Array<{ library: string; outcome: BootstrapOutcome }> = [];
  for (const pack of packs) {
    const outcome = await bootstrapLibrary(deps, {
      adminPrincipalId,
      projectName: pack.projectName,
      packUrl: pack.packUrl,
      ...(pack.skills?.length ? { selected: pack.skills } : {}),
      ...(scopes.get(pack.library) ? { preferredScopeId: scopes.get(pack.library) } : {}),
    });
    results.push({ library: pack.library, outcome });
    if (outcome.status === "bootstrapped") scopes.set(pack.library, outcome.projectScopeId);
  }
  return { results, scopes };
}

export function adminActorHeader(principalId: string, orgId: string): string {
  return principalId.endsWith(`@${orgId}`) ? principalId : `${principalId}@${orgId}`;
}

function writeLibraryScopes(envPath: string, scopes: ReadonlyMap<string, string>): void {
  const formatted = formatLibraryScopes(scopes);
  const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  writeFileSync(envPath, upsertEnvKey(current, "LIBRARY_SCOPES", formatted));
}

async function runCli(): Promise<void> {
  const parsed = parseBootstrapArgs(process.argv.slice(2), process.env);
  if ("problem" in parsed) {
    console.error(`[partner-bootstrap] ${parsed.problem}`);
    console.error("usage: node bootstrap/bootstrap-library.ts [library]... [--admin <principal>]");
    console.error("       env: LIBRARY_PRINCIPAL");
    process.exitCode = 1;
    return;
  }
  const loaded = loadSelectedPacks(BOOTSTRAP_DIR, parsed.libraries);
  if ("problems" in loaded) {
    for (const problem of loaded.problems) console.error(`[partner-bootstrap] ${problem}`);
    process.exitCode = 1;
    return;
  }
  const selected = loaded.packs;
  const core = createCoreClient(CORE_API_URL, CORE_SIGNING_SECRET);
  const adminCore = createCoreClient(
    CORE_API_URL,
    CORE_SIGNING_SECRET,
    { "x-admin-actor": adminActorHeader(parsed.adminPrincipalId, CORE_ORG_ID) },
    IMPORT_TIMEOUT_MS,
  );
  const existingScopes = parseLibraryScopes(process.env.LIBRARY_SCOPES ?? "");
  const { results, scopes } = await bootstrapScannedPacks(
    { core, adminCore },
    selected,
    parsed.adminPrincipalId,
    existingScopes,
  );
  console.log(JSON.stringify(results, null, 2));
  const failed = results.filter((row) => row.outcome.status !== "bootstrapped");
  const succeeded = results.filter(
    (row): row is { library: string; outcome: Bootstrapped } => row.outcome.status === "bootstrapped",
  );
  if (succeeded.length) {
    writeLibraryScopes(WORKTREE_ENV, scopes);
    console.error(`[partner-bootstrap] LIBRARY_SCOPES=${formatLibraryScopes(scopes)}`);
    console.error("[partner-bootstrap] run: node scripts/dev/cli.ts up --no-slack");
  }
  if (failed.length) process.exitCode = 1;
}

const invoked = process.argv[1];
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  await runCli();
}
