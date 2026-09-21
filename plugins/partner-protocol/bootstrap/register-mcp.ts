import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CORE_API_URL, CORE_ORG_ID, CORE_SIGNING_SECRET } from "../../chassis/src/env.ts";
import {
  adminActorHeader,
  createCoreClient,
  loadSelectedPacks,
  parseBootstrapArgs,
  type CoreClient,
  type McpManifest,
  type ScannedPack,
} from "./bootstrap-library.ts";

const BOOTSTRAP_DIR = dirname(fileURLToPath(import.meta.url));
const PROBE_TIMEOUT_MS = 10_000;

export interface McpProbe {
  listTools(url: string): Promise<{ ok: true } | { ok: false; message: string }>;
}

export type RegisterMcpOutcome =
  | { status: "registered"; id: string; url: string; upstream: unknown }
  | { status: "error"; code: string; message: string; upstream?: { status: number; body: unknown } };

export function collectMcpServers(packs: readonly ScannedPack[]): Array<McpManifest & { library: string }> {
  const servers: Array<McpManifest & { library: string }> = [];
  for (const pack of packs) {
    for (const server of pack.mcp ?? []) servers.push({ ...server, library: pack.library });
  }
  return servers;
}

async function probeMcpUrl(url: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, message: `HTTP ${response.status} ${text.slice(0, 200)}` };
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function registerMcpServer(
  deps: { adminCore: CoreClient; probe: McpProbe },
  server: McpManifest,
): Promise<RegisterMcpOutcome> {
  const probed = await deps.probe.listTools(server.url);
  if (!probed.ok) {
    return {
      status: "error",
      code: "mcp_unreachable",
      message: `tools/list against ${server.url} failed: ${probed.message}`,
    };
  }
  const put = await deps.adminCore.call("PUT", `/v1/admin/mcp-servers/${encodeURIComponent(server.id)}`, {
    url: server.url,
    name: server.name,
    auth: server.auth,
    readOnly: server.readOnly,
    enabled: true,
    validate: true,
  });
  if (put.status !== 200) {
    return {
      status: "error",
      code: "mcp_register_failed",
      message: `core rejected MCP registration with ${put.status}`,
      upstream: { status: put.status, body: put.json },
    };
  }
  return { status: "registered", id: server.id, url: server.url, upstream: put.json };
}

export async function registerScannedMcp(
  deps: { adminCore: CoreClient; probe: McpProbe },
  packs: readonly ScannedPack[],
): Promise<Array<{ library: string; id: string; outcome: RegisterMcpOutcome }>> {
  const results: Array<{ library: string; id: string; outcome: RegisterMcpOutcome }> = [];
  for (const server of collectMcpServers(packs)) {
    results.push({ library: server.library, id: server.id, outcome: await registerMcpServer(deps, server) });
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
    console.error("       env: LIBRARY_PRINCIPAL");
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
  const results = await registerScannedMcp({ adminCore, probe: { listTools: probeMcpUrl } }, loaded.packs);
  console.log(JSON.stringify(results, null, 2));
  if (results.some((row) => row.outcome.status !== "registered")) process.exitCode = 1;
}

const invoked = process.argv[1];
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  await runCli();
}
