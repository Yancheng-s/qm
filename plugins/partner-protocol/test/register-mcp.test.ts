import test from "node:test";
import assert from "node:assert/strict";
import {
  collectMcpServers,
  probeMcpServer,
  registerMcpServer,
  registerScannedMcp,
  resolveMcpServer,
  type McpProbe,
  type ResolvedMcpServer,
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

function probeFor(servers: ResolvedMcpServer[]): McpProbe {
  const counts = new Map(servers.map((server) => [server.id, 3]));
  return {
    async listTools(server) {
      const toolCount = counts.get(server.id) ?? 1;
      return { ok: true, toolCount };
    },
  };
}

const reachable = probeFor([
  {
    id: "zhiqu-card",
    url: "http://127.0.0.1:8310/mcp",
    name: "智渠名片创建",
    readOnly: false,
    auth: "none",
  },
]);

const unreachable: McpProbe = {
  async listTools() {
    return { ok: false, message: "ECONNREFUSED" };
  },
};

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

const pmosPack: ScannedPack = {
  dir: "/pack/pmos",
  packUrl: "/pack/pmos",
  library: "pmos",
  projectName: "PMOS 营销素材技能库",
  skills: ["pmos-activate"],
  mcp: [
    {
      id: "pmos",
      url: "http://127.0.0.1:3000/mcp",
      name: "PMOS 营销素材",
      readOnly: false,
      auth: "bearer",
      bearerEnv: "PMOS_API_KEY",
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

test("resolveMcpServer reads bearer tokens from env", () => {
  assert.deepEqual(resolveMcpServer(pmosPack.mcp![0]!, { PMOS_API_KEY: "pmos_test" }), {
    id: "pmos",
    url: "http://127.0.0.1:3000/mcp",
    name: "PMOS 营销素材",
    readOnly: false,
    auth: "bearer",
    bearerEnv: "PMOS_API_KEY",
    bearerToken: "pmos_test",
  });
  assert.ok("problem" in resolveMcpServer(pmosPack.mcp![0]!, {}));
});

test("registerMcpServer probes then PUTs a writable server", async () => {
  const admin = createAdminCore();
  const outcome = await registerMcpServer({ adminCore: admin.client, probe: reachable }, cardPack.mcp![0]!);
  assert.equal(outcome.status, "registered");
  if (outcome.status !== "registered") return;
  assert.equal(outcome.toolCount, 3);
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

test("registerMcpServer PUTs bearerToken for bearer servers", async () => {
  const admin = createAdminCore();
  const outcome = await registerMcpServer(
    { adminCore: admin.client, probe: probeFor([{ ...pmosPack.mcp![0]!, bearerToken: "pmos_test" }]) },
    pmosPack.mcp![0]!,
    { PMOS_API_KEY: "pmos_test" },
  );
  assert.equal(outcome.status, "registered");
  assert.deepEqual(admin.calls[0]?.body, {
    url: "http://127.0.0.1:3000/mcp",
    name: "PMOS 营销素材",
    auth: "bearer",
    bearerToken: "pmos_test",
    readOnly: false,
    enabled: true,
    validate: true,
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

test("a missing bearer env does not probe or write to core", async () => {
  const admin = createAdminCore();
  const outcome = await registerMcpServer({ adminCore: admin.client, probe: reachable }, pmosPack.mcp![0]!, {});
  assert.equal(outcome.status, "error");
  if (outcome.status !== "error") return;
  assert.equal(outcome.code, "mcp_auth_missing");
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

test("probeMcpServer sends bearer auth and requires tools for bearer servers", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { headers: Record<string, string>; body: string }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: String(init?.body ?? ""),
    });
    return new Response(JSON.stringify({ result: { tools: [{ name: "pmos_system_whoami" }] } }), { status: 200 });
  };
  try {
    const outcome = await probeMcpServer({
      id: "pmos",
      url: "http://127.0.0.1:3000/mcp",
      name: "PMOS 营销素材",
      readOnly: false,
      auth: "bearer",
      bearerEnv: "PMOS_API_KEY",
      bearerToken: "pmos_test",
    });
    assert.deepEqual(outcome, { ok: true, toolCount: 1 });
    assert.equal(calls[0]?.headers.authorization, "Bearer pmos_test");
    assert.match(calls[0]?.headers.accept ?? "", /application\/json/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
