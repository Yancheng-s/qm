import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CORE_API_URL, CORE_ORG_ID, CORE_SIGNING_SECRET } from "../../chassis/src/env.ts";
import {
  adminActorHeader,
  createCoreClient,
  loadSelectedPacks,
  parseBootstrapArgs,
  type CoreClient,
  type McpBearerManifest,
  type McpManifest,
  type McpNoneManifest,
  type ScannedPack,
} from "./bootstrap-library.ts";

const BOOTSTRAP_DIR = dirname(fileURLToPath(import.meta.url));
const PROBE_TIMEOUT_MS = 15_000;
const MCP_ACCEPT = "application/json, text/event-stream";

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
