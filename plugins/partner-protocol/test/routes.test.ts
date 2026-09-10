import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { verifyPortalIdentity } from "../../chassis/src/portal-identity.ts";
import { createHandler, routes } from "../src/routes/index.ts";
import {
  IDENTITY_SECRET,
  LIBRARIES,
  LIBRARY_KEY,
  LIBRARY_PRINCIPAL,
  LIBRARY_SCOPE,
  PARTNERS,
  PRINCIPAL_ID,
  USER_ID,
  ok,
  partnerHeaders,
  recordingCore,
  startGateway,
  type CoreScript,
} from "./support.ts";

const SCOPE = "group:web-project-1";

async function post(base: string, path: string, body: unknown): Promise<Response> {
  const raw = JSON.stringify(body);
  return fetch(`${base}${path}`, { method: "POST", body: raw, headers: partnerHeaders("POST", path, raw) });
}

async function withGateway(script: CoreScript | undefined, run: (base: string) => Promise<void>): Promise<void> {
  const core = recordingCore(script);
  const gateway = await startGateway(core.factory);
  try {
    await run(gateway.base);
  } finally {
    await gateway.close();
  }
}

test("the whitelist is exactly the documented routes with their body limits", () => {
  assert.deepEqual(
    routes.map((route) => `${route.method} ${route.path} ${route.limit}`),
    ["POST /v1/assemble 128000", "POST /v1/chat-sessions 4000"],
  );
});

test("unsigned partner calls are refused before any core call", async () => {
  const core = recordingCore();
  const gateway = await startGateway(core.factory);
  try {
    const unsigned = await fetch(`${gateway.base}/v1/chat-sessions`, { method: "POST", body: "{}" });
    assert.equal(unsigned.status, 401);
    assert.deepEqual(await unsigned.json(), { error: "unauthorized", message: "missing x-partner-id header" });

    const unknown = await post(gateway.base, "/v1/admin/grants", { userId: USER_ID });
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: "not_found", message: "no such endpoint" });

    const anonymous = await post(gateway.base, "/v1/chat-sessions", { scopeId: SCOPE });
    assert.equal(anonymous.status, 400);
    assert.deepEqual(await anonymous.json(), { error: "bad_request", message: "userId is required" });

    assert.equal(core.calls.length, 0);
  } finally {
    await gateway.close();
  }
});

test("every response carries the protocol version header", async () => {
  await withGateway(
    () => ok(200, { sessions: [] }),
    async (base) => {
      const response = await post(base, "/v1/chat-sessions", { userId: USER_ID, scopeId: SCOPE, conversationId: "c1" });
      assert.equal(response.headers.get("x-partner-protocol"), "1");
      assert.equal(response.headers.get("cache-control"), "no-store");
      await response.text();
    },
  );
});

test("chat-sessions mints a short-lived assertion and lands on the partner ui", async () => {
  const core = recordingCore((call) =>
    call.path.startsWith("/v1/sessions?")
      ? ok(200, { sessions: [{ id: "s1", threadRef: `web:${PRINCIPAL_ID}:c1`, scopeId: SCOPE }] })
      : ok(200, {}),
  );
  const gateway = await startGateway(core.factory);
  try {
    const response = await post(gateway.base, "/v1/chat-sessions", {
      userId: USER_ID,
      scopeId: SCOPE,
      conversationId: "c1",
    });
    assert.equal(response.status, 200);
    const { chatUrl } = (await response.json()) as { chatUrl: string };
    const url = new URL(chatUrl, "http://gateway.local");
    assert.equal(url.pathname, "/auth/login");
    assert.equal(
      url.searchParams.get("returnTo"),
      `/chat/?scopeId=${encodeURIComponent(SCOPE)}&conversationId=c1&session=s1`,
    );
    const claims = verifyPortalIdentity(url.searchParams.get("assertion") ?? "", IDENTITY_SECRET, Date.now());
    assert.equal(claims?.p, PRINCIPAL_ID);

    const badScope = await post(gateway.base, "/v1/chat-sessions", {
      userId: USER_ID,
      scopeId: `personal:${PRINCIPAL_ID}`,
      conversationId: "c1",
    });
    assert.equal(badScope.status, 400);
    assert.match(await badScope.text(), /digital employee scope/);
  } finally {
    await gateway.close();
  }
});

test("the auth path is dispatched to the proxy without partner verification", async () => {
  const seen: string[] = [];
  const handler = createHandler({
    coreApiUrl: "http://core.invalid",
    signingSecret: "test-signing-secret-not-used-outbound",
    identitySecret: IDENTITY_SECRET,
    partners: PARTNERS,
    libraries: LIBRARIES,
    libraryPrincipalId: LIBRARY_PRINCIPAL,
    ratePerMin: 0,
    portalUrl: "http://portal.invalid",
    partnerWebRedirectUrl: "http://localhost:5175/chat/",
    core: recordingCore(() => ok(200, {})).factory,
    authProxy: (req, res, url) => {
      seen.push(`${req.method} ${url.pathname}`);
      res.writeHead(302, { location: "http://portal.invalid/next" });
      res.end();
    },
  });
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    const login = await fetch(`http://127.0.0.1:${port}/auth/login?returnTo=%2Fchat%2F`, { redirect: "manual" });
    assert.equal(login.status, 302);
    assert.equal(login.headers.get("location"), "http://portal.invalid/next");
    const logout = await fetch(`http://127.0.0.1:${port}/auth/logout`, { method: "POST", redirect: "manual" });
    assert.equal(logout.status, 302);
    assert.deepEqual(seen, ["GET /auth/login", "POST /auth/logout"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the partner signature covers the target and body exactly as sent", async () => {
  const core = recordingCore(() => ok(200, { sessions: [] }));
  const gateway = await startGateway(core.factory);
  try {
    const body = JSON.stringify({ userId: USER_ID, scopeId: SCOPE, conversationId: "c1" });
    const wrongBody = await fetch(`${gateway.base}/v1/chat-sessions`, {
      method: "POST",
      body,
      headers: partnerHeaders("POST", "/v1/chat-sessions", "{}"),
    });
    assert.equal(wrongBody.status, 401);
    assert.match(await wrongBody.text(), /signature mismatch/);

    const wrongPath = await fetch(`${gateway.base}/v1/chat-sessions`, {
      method: "POST",
      body,
      headers: partnerHeaders("POST", "/v1/assemble", body),
    });
    assert.equal(wrongPath.status, 401);
    assert.match(await wrongPath.text(), /signature mismatch/);

    assert.equal(core.calls.length, 0);
  } finally {
    await gateway.close();
  }
});

test("relayed core errors surface as upstream errors", async () => {
  const core = recordingCore(() => ok(400, {}));
  const gateway = await startGateway(core.factory);
  try {
    const badAssemble = await post(gateway.base, "/v1/assemble", { userId: USER_ID, name: "Support", skills: [] });
    assert.equal(badAssemble.status, 502);
    assert.deepEqual(await badAssemble.json(), {
      error: "upstream_error",
      message: "skill listing failed",
      upstream: { status: 400 },
    });
  } finally {
    await gateway.close();
  }
});

test("assemble is reachable end to end through the pipeline", async () => {
  let projects = 0;
  const core = recordingCore((call) => {
    if (call.path.startsWith("/v1/skills")) {
      return ok(200, {
        skills: [
          { id: "skill-writer", name: "space-xhs-writer", scopeId: LIBRARY_SCOPE, status: "active" },
          { id: "skill-title", name: "space-xhs-title", scopeId: LIBRARY_SCOPE, status: "active" },
        ],
      });
    }
    if (call.path === "/v1/projects") {
      projects += 1;
      return ok(201, { project: { id: `web-project-${projects}`, scopeId: `group:web-project-${projects}` } });
    }
    if (call.path === "/v1/grants") return ok(200, { ok: true });
    if (call.path === "/v1/soul") return ok(200, { ok: true, version: 1 });
    if (call.path === "/v1/contexts/policy") {
      const body = call.body as { orders?: string };
      return ok(200, { policy: { orders: body.orders ?? "", bots: {}, ambientEnabled: null, updatedAt: 1 } });
    }
    return ok(404, { error: "not_found" });
  });
  const gateway = await startGateway(core.factory);
  try {
    const response = await post(gateway.base, "/v1/assemble", {
      userId: USER_ID,
      name: "Support",
      library: LIBRARY_KEY,
      soul: "Be terse.",
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      employee: { id: "web-project-1", scopeId: "group:web-project-1", name: "Support" },
      granted: ["space-xhs-writer", "space-xhs-title"],
      soul: true,
      standingOrders: false,
      files: [],
    });
    assert.deepEqual(
      core.calls.map((call) => call.path.split("?")[0]),
      ["/v1/skills", "/v1/projects", "/v1/grants", "/v1/grants", "/v1/soul"],
    );
  } finally {
    await gateway.close();
  }
});

test("a body that is not JSON is refused before verification is even attempted", async () => {
  const core = recordingCore();
  const gateway = await startGateway(core.factory);
  try {
    const raw = "{not json";
    const response = await fetch(`${gateway.base}/v1/chat-sessions`, {
      method: "POST",
      body: raw,
      headers: partnerHeaders("POST", "/v1/chat-sessions", raw),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "bad_json", message: "request body must be valid JSON" });

    const arrayBody = "[1,2]";
    const rejected = await fetch(`${gateway.base}/v1/chat-sessions`, {
      method: "POST",
      body: arrayBody,
      headers: partnerHeaders("POST", "/v1/chat-sessions", arrayBody),
    });
    assert.equal(rejected.status, 400);
    assert.match(await rejected.text(), /must be a JSON object/);
    assert.equal(core.calls.length, 0);
  } finally {
    await gateway.close();
  }
});
