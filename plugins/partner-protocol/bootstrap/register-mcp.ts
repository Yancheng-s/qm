import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { signedRequestHeaders, withSourceAuthNonce } from "../../chassis/src/core-client.ts";
import { CORE_API_URL, CORE_ORG_ID, CORE_SIGNING_SECRET } from "../../chassis/src/env.ts";

const BOOTSTRAP_DIR = dirname(fileURLToPath(import.meta.url));
const PROBE_TIMEOUT_MS = 15_000;
const MCP_ACCEPT = "application/json, text/event-stream";
const MCP_ID = /^[a-z][a-z0-9-]{1,39}$/;
const MCP_BEARER_ENV = /^[A-Z][A-Z0-9_]{0,127}$/;
const LIBRARY_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface CoreResponse {
  status: number;
  json: unknown;
}

export interface CoreClient {
  call(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<CoreResponse>;
}

export interface McpManifestBase {
  id: string;
  url: string;
  name: string;
  readOnly: boolean;
}

export interface McpNoneManifest extends McpManifestBase {
  auth: "none";
}

export interface McpBearerManifest extends McpManifestBase {
  auth: "bearer";
  bearerEnv: string;
}

export type McpManifest = McpNoneManifest | McpBearerManifest;

export interface ScannedPack {
  library: string;
  mcp?: McpManifest[];
}

export function adminActorHeader(principalId: string, orgId: string): string {
  return JSON.stringify({ principalId, orgId });
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

function parseMcp(raw: unknown, label: string): McpManifest[] | { problem: string } | undefined {
  if (raw === undefined) return undefined;
  const entries = Array.isArray(raw) ? raw : [raw];
  const mcp: McpManifest[] = [];
  const ids = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return { problem: `${label}: mcp entry must be an object` };
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const url = typeof item.url === "string" ? item.url.trim() : "";
    if (!MCP_ID.test(id)) return { problem: `${label}: mcp.id must match ${MCP_ID.source}` };
    if (ids.has(id)) return { problem: `${label}: duplicate mcp.id "${id}"` };
    let parsed: URL;
    try { parsed = new URL(url); } catch { return { problem: `${label}: mcp.url must be a valid URL` }; }
    if (!url || (parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.search || parsed.hash)
      return { problem: `${label}: mcp.url must be a credential-free http(s) URL without query or fragment` };
    if (item.readOnly !== undefined && typeof item.readOnly !== "boolean") return { problem: `${label}: mcp.readOnly must be a boolean` };
    const name = typeof item.name === "string" && item.name.trim() ? item.name.trim().slice(0, 80) : id;
    const common = { id, url, name, readOnly: item.readOnly === true };
    if (item.auth === undefined || item.auth === null || item.auth === "" || item.auth === "none") {
      if (item.bearerEnv !== undefined) return { problem: `${label}: mcp.bearerEnv is only valid when mcp.auth is "bearer"` };
      mcp.push({ ...common, auth: "none" });
    } else if (item.auth === "bearer") {
      const bearerEnv = typeof item.bearerEnv === "string" ? item.bearerEnv.trim() : "";
      if (!MCP_BEARER_ENV.test(bearerEnv)) return { problem: `${label}: mcp.bearerEnv must name an env var like PMOS_API_KEY` };
      mcp.push({ ...common, auth: "bearer", bearerEnv });
    } else return { problem: `${label}: mcp.auth must be "none" or "bearer"` };
    ids.add(id);
  }
  return mcp.length ? mcp : undefined;
}

export function loadSelectedPacks(root: string, selected: readonly string[]): { packs: ScannedPack[] } | { problems: string[] } {
  const packs: ScannedPack[] = [];
  const problems: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ".git") continue;
    const dir = join(root, entry.name);
    if (!existsSync(join(dir, ".git")) || !existsSync(join(dir, "library.json"))) continue;
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(join(dir, "library.json"), "utf8")); } catch { problems.push(`${dir}: library.json must be valid JSON`); continue; }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) { problems.push(`${dir}: library.json must be an object`); continue; }
    const body = raw as Record<string, unknown>;
    const library = typeof body.library === "string" ? body.library.trim() : "";
    if (!LIBRARY_KEY.test(library)) { problems.push(`${dir}: library must match ${LIBRARY_KEY.source}`); continue; }
    const mcp = parseMcp(body.mcp, `${dir} mcp`);
    if (mcp && "problem" in mcp) { problems.push(mcp.problem); continue; }
    packs.push({ library, ...(mcp ? { mcp } : {}) });
  }
  const seen = new Set<string>();
  for (const pack of packs) {
    if (seen.has(pack.library)) problems.push(`library "${pack.library}" is declared twice`);
    seen.add(pack.library);
  }
  const requested = selected.length ? new Set(selected) : undefined;
  if (requested) {
    const found = new Set(packs.map((pack) => pack.library));
    const missing = [...requested].filter((library) => !found.has(library));
    if (missing.length) problems.push(`unknown library: ${missing.join(", ")}`);
  }
  if (problems.length) return { problems };
  const filtered = requested ? packs.filter((pack) => requested.has(pack.library)) : packs;
  return filtered.length ? { packs: filtered } : { problems: ["no library.json packs under bootstrap/"] };
}

export function parseBootstrapArgs(args: readonly string[], env: NodeJS.ProcessEnv): { adminPrincipalId: string; libraries: string[] } | { problem: string } {
  const libraries: string[] = [];
  let adminPrincipalId = "";
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--admin") {
      const value = args[++index];
      if (!value || value.startsWith("--")) return { problem: "--admin requires a value" };
      adminPrincipalId = value;
    } else if (arg.startsWith("-")) return { problem: `unknown flag: ${arg}` };
    else libraries.push(arg);
  }
  adminPrincipalId ||= env.LIBRARY_PRINCIPAL?.trim() ?? "";
  if (!adminPrincipalId || adminPrincipalId.length > 200) return { problem: "--admin <principalId> or LIBRARY_PRINCIPAL is required" };
  const invalid = libraries.filter((library) => !LIBRARY_KEY.test(library));
  if (invalid.length) return { problem: `invalid library key: ${invalid.join(", ")}` };
  return { adminPrincipalId, libraries };
}

export type ResolvedMcpServer = McpNoneManifest | (McpBearerManifest & { bearerToken: string });

export interface McpProbe {
  listTools(server: ResolvedMcpServer): Promise<{ ok: true; toolCount: number } | { ok: false; message: string }>;
}

export type RegisterMcpOutcome =
  | { status: "registered"; id: string; url: string; toolCount: number; upstream: unknown }
  | { status: "error"; code: string; message: string; upstream?: { status: number; body: unknown } };

export function collectMcpServers(packs: readonly ScannedPack[]): Array<McpManifest & { library: string }> {
  const servers: Array<McpManifest & { library: string }> = [];
  for (const pack of packs) {
    for (const server of pack.mcp ?? []) servers.push({ ...server, library: pack.library });
  }
  return servers;
}

export function resolveMcpServer(
  server: McpManifest,
  env: NodeJS.ProcessEnv,
): ResolvedMcpServer | { problem: string } {
  if (server.auth === "none") return server;
  const bearerToken = env[server.bearerEnv]?.trim() ?? "";
  if (!bearerToken) {
    return { problem: `${server.id}: env ${server.bearerEnv} is required for bearer MCP registration` };
  }
  return { ...server, bearerToken };
}

function toolCountFromProbeBody(text: string): number | { problem: string } {
  try {
    const json = JSON.parse(text) as { result?: { tools?: unknown[] } };
    return Array.isArray(json.result?.tools) ? json.result.tools.length : 0;
  } catch {
    return { problem: "tools/list response was not JSON" };
  }
}

export async function probeMcpServer(
  server: ResolvedMcpServer,
): Promise<{ ok: true; toolCount: number } | { ok: false; message: string }> {
  const headers: Record<string, string> = {
    accept: MCP_ACCEPT,
    "content-type": "application/json",
  };
  if (server.auth === "bearer") headers.authorization = `Bearer ${server.bearerToken}`;
  try {
    const response = await fetch(server.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, message: `HTTP ${response.status} ${text.slice(0, 200)}` };
    const parsed = toolCountFromProbeBody(text);
    if (typeof parsed !== "number") return { ok: false, message: parsed.problem };
    if (server.auth === "bearer" && parsed === 0) {
      return { ok: false, message: "tools/list returned no tools" };
    }
    return { ok: true, toolCount: parsed };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function registerMcpServer(
  deps: { adminCore: CoreClient; probe: McpProbe },
  server: McpManifest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RegisterMcpOutcome> {
  const resolved = resolveMcpServer(server, env);
  if ("problem" in resolved) {
    return { status: "error", code: "mcp_auth_missing", message: resolved.problem };
  }
  const probed = await deps.probe.listTools(resolved);
  if (!probed.ok) {
    return {
      status: "error",
      code: "mcp_unreachable",
      message: `tools/list against ${server.url} failed: ${probed.message}`,
    };
  }
  const putBody =
    resolved.auth === "bearer"
      ? {
          url: server.url,
          name: server.name,
          auth: "bearer" as const,
          bearerToken: resolved.bearerToken,
          readOnly: server.readOnly,
          enabled: true,
          validate: true,
        }
      : {
          url: server.url,
          name: server.name,
          auth: "none" as const,
          readOnly: server.readOnly,
          enabled: true,
          validate: true,
        };
  const put = await deps.adminCore.call("PUT", `/v1/admin/mcp-servers/${encodeURIComponent(server.id)}`, putBody);
  if (put.status !== 200) {
    return {
      status: "error",
      code: "mcp_register_failed",
      message: `core rejected MCP registration with ${put.status}`,
      upstream: { status: put.status, body: put.json },
    };
  }
  return {
    status: "registered",
    id: server.id,
    url: server.url,
    toolCount: probed.toolCount,
    upstream: put.json,
  };
}

export async function registerScannedMcp(
  deps: { adminCore: CoreClient; probe: McpProbe },
  packs: readonly ScannedPack[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<Array<{ library: string; id: string; outcome: RegisterMcpOutcome }>> {
  const results: Array<{ library: string; id: string; outcome: RegisterMcpOutcome }> = [];
  for (const server of collectMcpServers(packs)) {
    results.push({ library: server.library, id: server.id, outcome: await registerMcpServer(deps, server, env) });
  }
  return results;
}

async function runCli(): Promise<void> {
  if (!CORE_SIGNING_SECRET) {
    console.error("[partner-register-mcp] CORE_SIGNING_SECRET is required");
    process.exitCode = 1;
    return;
  }
  const parsed = parseBootstrapArgs(process.argv.slice(2), process.env);
  if ("problem" in parsed) {
    console.error(`[partner-register-mcp] ${parsed.problem}`);
    console.error("usage: node bootstrap/register-mcp.ts [library]... [--admin <principal>]");
    console.error("       env: LIBRARY_PRINCIPAL, <pack>.mcp.bearerEnv for bearer servers");
    process.exitCode = 1;
    return;
  }
  const loaded = loadSelectedPacks(BOOTSTRAP_DIR, parsed.libraries);
  if ("problems" in loaded) {
    for (const problem of loaded.problems) console.error(`[partner-register-mcp] ${problem}`);
    process.exitCode = 1;
    return;
  }
  const servers = collectMcpServers(loaded.packs);
  if (!servers.length) {
    console.error("[partner-register-mcp] no mcp declared in selected library.json files");
    process.exitCode = 1;
    return;
  }
  const adminCore = createCoreClient(
    CORE_API_URL,
    CORE_SIGNING_SECRET,
    { "x-admin-actor": adminActorHeader(parsed.adminPrincipalId, CORE_ORG_ID) },
  );
  const results = await registerScannedMcp({ adminCore, probe: { listTools: probeMcpServer } }, loaded.packs, process.env);
  for (const row of results) {
    if (row.outcome.status === "registered") {
      console.error(
        `[partner-register-mcp] ${row.library}/${row.id}: registered (${row.outcome.toolCount} tools probed)`,
      );
    }
  }
  console.log(JSON.stringify(results, null, 2));
  if (results.some((row) => row.outcome.status !== "registered")) process.exitCode = 1;
}

const invoked = process.argv[1];
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  await runCli();
}
