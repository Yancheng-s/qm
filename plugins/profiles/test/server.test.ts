import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createProfilesHandler } from "../src/server.ts";
import { createMemoryAssemblyRegistry } from "../src/assemble-store.ts";
import type { CoreClient } from "../src/assemble.ts";

const KEY = "profiles-test-key-0123456789abcdef";

function stubCore(): CoreClient {
  return {
    async call(method, path) {
      if (method === "GET" && path.startsWith("/v1/skills"))
        return {
          status: 200,
          json: { skills: [{ id: "skill-1", name: "space-xhs-title", scopeId: "group:web-project-lib" }] },
        };
      if (method === "POST" && path === "/v1/projects")
        return { status: 201, json: { project: { id: "web-project-1", scopeId: "group:web-project-1" } } };
      return { status: 200, json: { ok: true } };
    },
  };
}

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const handler = createProfilesHandler({
    cfg: {
      assembleKey: KEY,
      libraryScopeId: "group:web-project-lib",
      libraryPrincipalId: "app_admin",
      skillNames: ["space-xhs-title"],
    },
    core: stubCore(),
    registry: createMemoryAssemblyRegistry(),
  });
  const server: Server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no listen address");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("healthz is open", async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/healthz`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
  });
});

test("assemble rejects a missing or wrong key", async () => {
  await withServer(async (base) => {
    const body = JSON.stringify({ name: "p", principalId: "app_u1" });
    const noKey = await fetch(`${base}/assemble`, { method: "POST", body });
    assert.equal(noKey.status, 401);
    const wrongKey = await fetch(`${base}/assemble`, {
      method: "POST",
      body,
      headers: { authorization: "Bearer nope" },
    });
    assert.equal(wrongKey.status, 401);
  });
});

test("assemble validates the body before touching core", async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/assemble`, {
      method: "POST",
      body: JSON.stringify({ principalId: "app_u1" }),
      headers: { authorization: `Bearer ${KEY}` },
    });
    assert.equal(r.status, 400);
    const parsed = (await r.json()) as { error: string };
    assert.equal(parsed.error, "bad_request");
  });
});

test("assemble returns the assembled project", async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/assemble`, {
      method: "POST",
      body: JSON.stringify({ name: "张三的运营项目", principalId: "app_u1", externalId: "mini-1" }),
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    });
    assert.equal(r.status, 200);
    const parsed = (await r.json()) as {
      status: string;
      projectId: string;
      projectScopeId: string;
      granted: string[];
      reused: boolean;
    };
    assert.equal(parsed.status, "assembled");
    assert.equal(parsed.projectId, "web-project-1");
    assert.equal(parsed.projectScopeId, "group:web-project-1");
    assert.deepEqual(parsed.granted, ["space-xhs-title"]);
    assert.equal(parsed.reused, false);
  });
});

test("unknown routes 404", async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/nope`);
    assert.equal(r.status, 404);
  });
});
