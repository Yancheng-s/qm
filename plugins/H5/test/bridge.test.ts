import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { signedRequestHeaders } from "../../chassis/src/core-client.ts";
import { verifyPortalIdentity } from "../../chassis/src/portal-identity.ts";
import { bootBridge } from "../src/bridge/server.ts";
import { bootProblems, readConfig } from "../src/bridge/config.ts";

const SIGNING_SECRET = "bridge-test-signing-secret-0123456789";
const IDENTITY_SECRET = "bridge-test-identity-secret-9876543210";

interface Recorded {
  method: string;
  url: string;
  principal: string | null;
  body: string;
  contentType: string | null;
  signature: string | null;
}

interface MockWebUi {
  url: string;
  calls: Recorded[];
  close: () => Promise<void>;
}

function startMockWebUi(opts: { sse?: boolean } = {}): Promise<MockWebUi> {
  return new Promise((resolve) => {
    const calls: Recorded[] = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.once("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const rawIdentity = req.headers["x-portal-identity"];
        const token = Array.isArray(rawIdentity) ? rawIdentity[0] : rawIdentity;
        const claims = token ? verifyPortalIdentity(token, IDENTITY_SECRET, Date.now()) : null;
        const rawSig = req.headers["x-signature"];
        calls.push({
          method: req.method ?? "GET",
          url: req.url ?? "/",
          principal: claims?.p ?? null,
          body,
          contentType: typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : null,
          signature: typeof rawSig === "string" ? rawSig : null,
        });
        if (opts.sse) {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          res.write("data: one\n\n");
          res.write("data: two\n\n");
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, principal: claims?.p ?? null }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function withBridge(mockUrl: string, run: (base: string) => Promise<void>): Promise<void> {
  const bridge = bootBridge({ webUiApiUrl: mockUrl, signingSecret: SIGNING_SECRET, identitySecret: IDENTITY_SECRET });
  const server: Server = createServer((req, res) => {
    void bridge.handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function signed(
  method: string,
  pathWithQuery: string,
  body = "",
  opts: { secret?: string } = {},
): { method: string; body?: string; headers: Record<string, string> } {
  const headers = signedRequestHeaders(
    opts.secret ?? SIGNING_SECRET,
    method,
    pathWithQuery,
    body,
    body ? { "content-type": "application/json" } : {},
  );
  return { method, ...(body ? { body } : {}), headers };
}

test("bridge config requires a valid absolute http(s) url", () => {
  assert.deepEqual(bootProblems(readConfig({})), [
    "WEB_UI_API_URL is required (web-ui server base url, e.g. http://localhost:8097)",
  ]);
  assert.deepEqual(bootProblems(readConfig({ WEB_UI_API_URL: "not a url" })), [
    'WEB_UI_API_URL must be an absolute url, got "not a url"',
  ]);
  assert.deepEqual(bootProblems(readConfig({ WEB_UI_API_URL: "ftp://host" })), [
    'WEB_UI_API_URL must be http(s), got "ftp://"',
  ]);
  assert.deepEqual(bootProblems(readConfig({ WEB_UI_API_URL: "http://localhost:8097/" })), []);
  assert.equal(readConfig({ WEB_UI_API_URL: "http://localhost:8097/" }).webUiApiUrl, "http://localhost:8097");
});

test("bridge rejects requests the signing secret does not cover", async () => {
  const mock = await startMockWebUi();
  try {
    await withBridge(mock.url, async (base) => {
      const unsigned = await fetch(`${base}/api/turn?principalId=U1`, { method: "POST", body: "{}" });
      assert.equal(unsigned.status, 401);
      assert.deepEqual(await unsigned.json(), {
        error: "unauthorized",
        message: "missing signature (unsigned request)",
      });

      const wrongSecret = await fetch(
        `${base}/api/turn?principalId=U1`,
        signed("POST", "/api/turn?principalId=U1", "{}", { secret: "other-secret" }),
      );
      assert.equal(wrongSecret.status, 401);
      assert.deepEqual(await wrongSecret.json(), { error: "unauthorized", message: "signature mismatch" });

      const tampered = await fetch(`${base}/api/turn?principalId=U2`, signed("POST", "/api/turn?principalId=U1", "{}"));
      assert.equal(tampered.status, 401);
      assert.deepEqual(await tampered.json(), { error: "unauthorized", message: "signature mismatch" });

      assert.equal(mock.calls.length, 0);
    });
  } finally {
    await mock.close();
  }
});

test("bridge requires a principalId query parameter", async () => {
  const mock = await startMockWebUi();
  try {
    await withBridge(mock.url, async (base) => {
      const r = await fetch(`${base}/api/sessions`, signed("GET", "/api/sessions"));
      assert.equal(r.status, 400);
      assert.deepEqual(await r.json(), {
        error: "bad_request",
        message: "principalId query parameter is required",
      });
      assert.equal(mock.calls.length, 0);
    });
  } finally {
    await mock.close();
  }
});

test("bridge injects a verified identity header and forwards the body", async () => {
  const mock = await startMockWebUi();
  try {
    await withBridge(mock.url, async (base) => {
      const body = JSON.stringify({ text: "hello", threadRef: "web:U1:t1" });
      const r = await fetch(`${base}/api/turn?principalId=U1`, signed("POST", "/api/turn?principalId=U1", body));
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true, principal: "U1" });
      assert.equal(mock.calls.length, 1);
      const call = mock.calls[0]!;
      assert.equal(call.method, "POST");
      assert.equal(call.url, "/api/turn?principalId=U1");
      assert.equal(call.principal, "U1");
      assert.equal(call.body, body);
      assert.equal(call.contentType, "application/json");
      assert.equal(call.signature, null, "the HMAC signature header must not leak upstream");
    });
  } finally {
    await mock.close();
  }
});

test("bridge forwards GET requests with their query string", async () => {
  const mock = await startMockWebUi();
  try {
    await withBridge(mock.url, async (base) => {
      const r = await fetch(
        `${base}/api/sessions?principalId=U1&limit=5`,
        signed("GET", "/api/sessions?principalId=U1&limit=5"),
      );
      assert.equal(r.status, 200);
      const call = mock.calls[0]!;
      assert.equal(call.method, "GET");
      assert.equal(call.url, "/api/sessions?principalId=U1&limit=5");
      assert.equal(call.principal, "U1");
      assert.equal(call.body, "");
    });
  } finally {
    await mock.close();
  }
});

test("bridge streams server-sent events without buffering", async () => {
  const mock = await startMockWebUi({ sse: true });
  try {
    await withBridge(mock.url, async (base) => {
      const r = await fetch(
        `${base}/api/deliveries/events?principalId=U1`,
        signed("GET", "/api/deliveries/events?principalId=U1"),
      );
      assert.equal(r.status, 200);
      assert.match(r.headers.get("content-type") ?? "", /text\/event-stream/);
      const text = await r.text();
      assert.match(text, /data: one/);
      assert.match(text, /data: two/);
      assert.equal(mock.calls[0]!.principal, "U1");
    });
  } finally {
    await mock.close();
  }
});

test("bridge accepts bodies far larger than the 8KB login cap", async () => {
  const mock = await startMockWebUi();
  try {
    await withBridge(mock.url, async (base) => {
      const body = JSON.stringify({ blob: "x".repeat(20_000) });
      const r = await fetch(`${base}/api/blobs?principalId=U1`, signed("POST", "/api/blobs?principalId=U1", body));
      assert.equal(r.status, 200);
      assert.equal(mock.calls[0]!.body.length, body.length);
      assert.equal(mock.calls[0]!.principal, "U1");
    });
  } finally {
    await mock.close();
  }
});
