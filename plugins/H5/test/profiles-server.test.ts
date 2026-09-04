import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { signedRequestHeaders } from "../../chassis/src/core-client.ts";
import { createProfilesHandler } from "../src/profiles/server.ts";
import { createMemoryAssemblyRegistry } from "../src/profiles/assemble-store.ts";
import type { CoreClient } from "../src/profiles/assemble.ts";

const SECRET = "profiles-test-signing-secret-0123456789";

function signedPost(
  pathWithQuery: string,
  body: string,
  opts: { secret?: string; nowSec?: number } = {},
): { method: string; body: string; headers: Record<string, string> } {
  const headers = signedRequestHeaders(
    opts.secret ?? SECRET,
    "POST",
    pathWithQuery,
    body,
    { "content-type": "application/json" },
    opts.nowSec,
  );
  return { method: "POST", body, headers };
}

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
      libraryScopeId: "group:web-project-lib",
      libraryPrincipalId: "app_admin",
      skillNames: ["space-xhs-title"],
    },
    signingSecret: SECRET,
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

test("assemble rejects a request the signing secret does not cover", async () => {
  await withServer(async (base) => {
    const body = JSON.stringify({ name: "p", principalId: "app_u1" });

    const unsigned = await fetch(`${base}/assemble`, { method: "POST", body });
    assert.equal(unsigned.status, 401);
    assert.deepEqual(await unsigned.json(), {
      error: "unauthorized",
      message: "missing signature (unsigned request)",
    });

    const wrongSecret = await fetch(`${base}/assemble`, signedPost("/assemble", body, { secret: "other-secret" }));
    assert.equal(wrongSecret.status, 401);
    assert.deepEqual(await wrongSecret.json(), { error: "unauthorized", message: "signature mismatch" });

    const stale = await fetch(
      `${base}/assemble`,
      signedPost("/assemble", body, { nowSec: Math.floor(Date.now() / 1000) - 3600 }),
    );
    assert.equal(stale.status, 401);
    assert.deepEqual(await stale.json(), { error: "unauthorized", message: "stale timestamp (replay protection)" });

    const tampered = await fetch(`${base}/assemble`, {
      ...signedPost("/assemble", body),
      body: JSON.stringify({ name: "p", principalId: "app_u2" }),
    });
    assert.equal(tampered.status, 401);
    assert.deepEqual(await tampered.json(), { error: "unauthorized", message: "signature mismatch" });

    const otherPath = await fetch(`${base}/assemble?nonce=1`, signedPost("/assemble", body));
    assert.equal(otherPath.status, 401);
    assert.deepEqual(await otherPath.json(), { error: "unauthorized", message: "signature mismatch" });
  });
});

test("assemble validates the body before touching core", async () => {
  await withServer(async (base) => {
    const badJson = await fetch(`${base}/assemble`, signedPost("/assemble", "{"));
    assert.equal(badJson.status, 400);
    assert.deepEqual(await badJson.json(), { error: "bad_json" });

    const r = await fetch(`${base}/assemble`, signedPost("/assemble", JSON.stringify({ principalId: "app_u1" })));
    assert.equal(r.status, 400);
    const parsed = (await r.json()) as { error: string };
    assert.equal(parsed.error, "bad_request");
  });
});

test("assemble returns the assembled project", async () => {
  await withServer(async (base) => {
    const r = await fetch(
      `${base}/assemble`,
      signedPost("/assemble", JSON.stringify({ name: "张三的运营项目", principalId: "app_u1", externalId: "mini-1" })),
    );
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
