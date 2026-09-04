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

interface Recorded {
  method: string;
  path: string;
}

function stubCore(calls: Recorded[]): CoreClient {
  return {
    async call(method, path) {
      calls.push({ method, path });
      if (method === "GET" && path.startsWith("/v1/skills"))
        return {
          status: 200,
          json: {
            skills: [
              { id: "skill-1", name: "space-xhs-title", scopeId: "group:web-project-lib" },
              { id: "skill-2", name: "ecom-product-shot", scopeId: "group:web-project-ecom" },
            ],
          },
        };
      if (method === "POST" && path === "/v1/projects")
        return { status: 201, json: { project: { id: "web-project-1", scopeId: "group:web-project-1" } } };
      return { status: 200, json: { ok: true } };
    },
  };
}

async function withServer(run: (base: string, calls: Recorded[]) => Promise<void>): Promise<void> {
  const calls: Recorded[] = [];
  const handler = createProfilesHandler({
    cfg: {
      libraries: [
        { key: "xhs", scopeId: "group:web-project-lib" },
        { key: "ecom", scopeId: "group:web-project-ecom" },
        { key: "tools", scopeId: "group:web-project-tools" },
      ],
      libraryPrincipalId: "app_admin",
    },
    signingSecret: SECRET,
    core: stubCore(calls),
    registry: createMemoryAssemblyRegistry(),
  });
  const server: Server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no listen address");
  try {
    await run(`http://127.0.0.1:${address.port}`, calls);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("assemble rejects a request the signing secret does not cover", async () => {
  await withServer(async (base, calls) => {
    const body = JSON.stringify({ library: "xhs", name: "p", principalId: "app_u1" });

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
      body: JSON.stringify({ library: "xhs", name: "p", principalId: "app_u2" }),
    });
    assert.equal(tampered.status, 401);
    assert.deepEqual(await tampered.json(), { error: "unauthorized", message: "signature mismatch" });

    const otherPath = await fetch(`${base}/assemble?nonce=1`, signedPost("/assemble", body));
    assert.equal(otherPath.status, 401);
    assert.deepEqual(await otherPath.json(), { error: "unauthorized", message: "signature mismatch" });
    assert.equal(calls.length, 0);
  });
});

test("assemble validates the body before touching core", async () => {
  await withServer(async (base, calls) => {
    const badJson = await fetch(`${base}/assemble`, signedPost("/assemble", "{"));
    assert.equal(badJson.status, 400);
    assert.deepEqual(await badJson.json(), { error: "bad_json" });

    const r = await fetch(
      `${base}/assemble`,
      signedPost("/assemble", JSON.stringify({ library: "xhs", principalId: "app_u1" })),
    );
    assert.equal(r.status, 400);
    const parsed = (await r.json()) as { error: string };
    assert.equal(parsed.error, "bad_request");

    const noLibrary = await fetch(`${base}/assemble`, signedPost("/assemble", JSON.stringify({ name: "p" })));
    assert.equal(noLibrary.status, 400);
    assert.deepEqual(await noLibrary.json(), { error: "bad_request", message: "library is required" });

    const shaped = await fetch(`${base}/assemble`, signedPost("/assemble", JSON.stringify({ library: "XHS 类" })));
    assert.equal(shaped.status, 400);
    const shapedBody = (await shaped.json()) as { error: string; message: string };
    assert.equal(shapedBody.error, "bad_request");
    assert.equal(shapedBody.message.startsWith("library must match"), true);
    assert.equal(calls.length, 0);
  });
});

test("assemble refuses a library the deployment does not bind", async () => {
  await withServer(async (base) => {
    const r = await fetch(
      `${base}/assemble`,
      signedPost("/assemble", JSON.stringify({ library: "douyin", name: "p", principalId: "app_u1" })),
    );
    assert.equal(r.status, 400);
    const parsed = (await r.json()) as { status: string; code: string; message: string };
    assert.equal(parsed.status, "error");
    assert.equal(parsed.code, "unknown_library");
    assert.equal(parsed.message, 'unknown library "douyin" (known: xhs, ecom, tools)');
  });
});

test("a library scope holding no skill is a deployment fault, not a caller fault", async () => {
  await withServer(async (base) => {
    const r = await fetch(
      `${base}/assemble`,
      signedPost("/assemble", JSON.stringify({ library: "tools", name: "p", principalId: "app_u1" })),
    );
    assert.equal(r.status, 502);
    const parsed = (await r.json()) as { code: string; message: string };
    assert.equal(parsed.code, "library_empty");
    assert.equal(parsed.message, 'no skill available in library "tools"');
  });
});

test("assemble returns the assembled project", async () => {
  await withServer(async (base) => {
    const r = await fetch(
      `${base}/assemble`,
      signedPost(
        "/assemble",
        JSON.stringify({ library: "xhs", name: "张三的运营项目", principalId: "app_u1", externalId: "mini-1" }),
      ),
    );
    assert.equal(r.status, 200);
    const parsed = (await r.json()) as {
      status: string;
      library: string;
      projectId: string;
      projectScopeId: string;
      granted: string[];
      reused: boolean;
    };
    assert.equal(parsed.status, "assembled");
    assert.equal(parsed.library, "xhs");
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
