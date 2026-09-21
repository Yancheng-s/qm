import test from "node:test";
import assert from "node:assert/strict";
import {
  collectMcpServers,
  registerMcpServer,
  registerScannedMcp,
  type McpProbe,
} from "../bootstrap/register-mcp.ts";
import type { CoreClient, CoreResponse, ScannedPack } from "../bootstrap/bootstrap-library.ts";

interface Recorded {
  method: string;
  path: string;
  body?: unknown;
}

function createAdminCore(opts: { putStatus?: number } = {}): { client: CoreClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const client: CoreClient = {
    async call(method, path, body): Promise<CoreResponse> {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) });
      if (method === "PUT" && path.startsWith("/v1/admin/mcp-servers/")) {
        if (opts.putStatus !== undefined && opts.putStatus !== 200)
          return { status: opts.putStatus, json: { error: "boom" } };
        return { status: 200, json: { ok: true, tools: ["create_card"] } };
      }
      return { status: 404, json: { error: "not_found" } };
    },
  };
  return { client, calls };
}

const reachable: McpProbe = { async listTools() { return { ok: true }; } };
const unreachable: McpProbe = { async listTools() { return { ok: false, message: "ECONNREFUSED" }; } };

const cardPack: ScannedPack = {
  dir: "/pack/card",
  packUrl: "/pack/card",
  library: "card",
  projectName: "智渠名片技能库",
  skills: ["zhiqu-card-create"],
  mcp: [
    {
      id: "zhiqu-card",
      url: "http://127.0.0.1:8310/mcp",
      name: "智渠名片创建",
      readOnly: false,
      auth: "none",
    },
  ],
};

test("collectMcpServers skips packs without mcp", () => {
  assert.deepEqual(
    collectMcpServers([
      cardPack,
      { dir: "/pack/docs", packUrl: "/pack/docs", library: "docs", projectName: "文案库" },
    ]),
    [
      {
        id: "zhiqu-card",
        url: "http://127.0.0.1:8310/mcp",
        name: "智渠名片创建",
        readOnly: false,
        auth: "none",
        library: "card",
      },
    ],
  );
});

test("registerMcpServer probes then PUTs a writable server", async () => {
  const admin = createAdminCore();
  const outcome = await registerMcpServer({ adminCore: admin.client, probe: reachable }, cardPack.mcp![0]!);
  assert.equal(outcome.status, "registered");
  assert.deepEqual(admin.calls[0], {
    method: "PUT",
    path: "/v1/admin/mcp-servers/zhiqu-card",
    body: {
      url: "http://127.0.0.1:8310/mcp",
      name: "智渠名片创建",
      auth: "none",
      readOnly: false,
      enabled: true,
      validate: true,
    },
  });
});

test("an unreachable MCP does not write to core", async () => {
  const admin = createAdminCore();
  const outcome = await registerMcpServer({ adminCore: admin.client, probe: unreachable }, cardPack.mcp![0]!);
  assert.equal(outcome.status, "error");
  if (outcome.status !== "error") return;
  assert.equal(outcome.code, "mcp_unreachable");
  assert.equal(admin.calls.length, 0);
});

test("a rejected PUT surfaces as mcp_register_failed", async () => {
  const admin = createAdminCore({ putStatus: 400 });
  const outcome = await registerMcpServer({ adminCore: admin.client, probe: reachable }, cardPack.mcp![0]!);
  assert.equal(outcome.status, "error");
  if (outcome.status !== "error") return;
  assert.equal(outcome.code, "mcp_register_failed");
  assert.equal(outcome.upstream?.status, 400);
});

test("registerScannedMcp registers each declared server", async () => {
  const admin = createAdminCore();
  const results = await registerScannedMcp({ adminCore: admin.client, probe: reachable }, [
    cardPack,
    { dir: "/pack/docs", packUrl: "/pack/docs", library: "docs", projectName: "文案库" },
  ]);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.library, "card");
  assert.equal(results[0]?.id, "zhiqu-card");
  assert.equal(results[0]?.outcome.status, "registered");
});
