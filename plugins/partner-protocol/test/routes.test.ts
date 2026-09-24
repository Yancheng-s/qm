import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { verifyPortalIdentity } from "../../chassis/src/portal-identity.ts";
import { createHandler, routes } from "../src/routes/index.ts";
import {
  IDENTITY_SECRET,
  LIBRARY_PRINCIPAL,
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
    ["POST /v1/assemble 128000", "POST /v1/chat-sessions 4000", "GET /v1/chat-sessions 4000"],
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

test("chat-sessions mints a short-lived assertion and lands on the chat path", async () => {
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
    libraryPrincipalId: LIBRARY_PRINCIPAL,
    ratePerMin: 0,
    portalUrl: "http://portal.invalid",
    partnerWebRedirectUrl: "http://localhost:8129/",
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
