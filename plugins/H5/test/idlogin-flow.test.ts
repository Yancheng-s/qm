import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { calculateJwkThumbprint, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, type JWK } from "jose";
import {
  createIdLoginHandler,
  readConfig,
  type DirectoryMemberPush,
  type IdLoginConfig,
} from "../src/idlogin/server.ts";
import { createMemoryUserRegistry, type UserRegistry } from "../src/idlogin/users.ts";

const CLIENT_ID = "qm-portal";
const CLIENT_SECRET = "test-client-secret-0123456789abcdef0123456789";
const API_KEY = "test-api-key-0123456789abcdef0123456789";
const REDIRECT_URI = "http://localhost:18130/auth/callback";

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function authorizeQuery(over: Record<string, string> = {}): URLSearchParams {
  const { challenge } = pkcePair();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "openid profile",
    state: "st-1",
    nonce: "no-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...over,
  });
  return params;
}

function hiddenRequestToken(html: string): string {
  const match = /name="request" value="([^"]+)"/.exec(html);
  assert.ok(match, "authorize page should carry a hidden request token");
  return match[1]!;
}

function form(body: Record<string, string>): { method: string; body: string; headers: Record<string, string> } {
  return {
    method: "POST",
    body: new URLSearchParams(body).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  };
}

async function startHandler(
  cfg: IdLoginConfig,
  opts: { users?: UserRegistry; pushes?: DirectoryMemberPush[][]; pushFails?: boolean } = {},
): Promise<{ base: string; close: () => Promise<void> }> {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const publicJwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(publicJwk, "sha256");
  let pushDirectory: ((members: DirectoryMemberPush[]) => Promise<void>) | undefined;
  if (opts.pushFails) {
    pushDirectory = async () => {
      throw new Error("core replied 500");
    };
  } else if (opts.pushes) {
    const pushes = opts.pushes;
    pushDirectory = async (members) => void pushes.push(members);
  }
  const handle = createIdLoginHandler({
    cfg,
    signingKey: { privateKey, publicJwk: { ...publicJwk, kid, use: "sig", alg: "ES256" }, kid },
    sealSecret: randomBytes(32),
    users: opts.users ?? createMemoryUserRegistry(),
    ...(pushDirectory ? { pushDirectory } : {}),
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

function cfgFor(over: Partial<IdLoginConfig> = {}): IdLoginConfig {
  const cfg = readConfig({
    IDLOGIN_ISSUER: "http://idlogin.test",
    IDLOGIN_CLIENT_ID: CLIENT_ID,
    IDLOGIN_CLIENT_SECRET: CLIENT_SECRET,
    IDLOGIN_REDIRECT_URI: REDIRECT_URI,
    IDLOGIN_API_KEY: API_KEY,
  });
  return { ...cfg, ...over };
}

let base = "";
let closeServer: () => Promise<void>;

test.before(async () => {
  const started = await startHandler(cfgFor());
  base = started.base;
  closeServer = started.close;
});

test.after(async () => {
  await closeServer();
});

async function obtainCode(
  id: string,
  query: URLSearchParams,
  name?: string,
  baseUrl = base,
): Promise<{ code: string; location: URL }> {
  const page = await fetch(`${baseUrl}/authorize?${query}`);
  assert.equal(page.status, 200);
  const submit = await fetch(`${baseUrl}/authorize`, {
    ...form({ request: hiddenRequestToken(await page.text()), id, ...(name !== undefined ? { name } : {}) }),
    redirect: "manual",
  });
  assert.equal(submit.status, 302, await submit.text());
  const location = new URL(submit.headers.get("location")!);
  assert.equal(location.origin + location.pathname, REDIRECT_URI);
  assert.equal(location.searchParams.get("state"), query.get("state"));
  return { code: location.searchParams.get("code")!, location };
}

async function waitFor<T>(fn: () => T | false | undefined | null, timeoutMs = 1_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function redeem(code: string, verifier: string, secret = CLIENT_SECRET, baseUrl = base): Promise<Response> {
  const basic = Buffer.from(`${CLIENT_ID}:${secret}`).toString("base64");
  return fetch(`${baseUrl}/token`, {
    ...form({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier }),
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` },
  });
}

test("GET /authorize renders the id form; POST issues a one-shot code that redeems into a valid id_token", async () => {
  const { verifier, challenge } = pkcePair();
  const query = authorizeQuery({ code_challenge: challenge });
  const { code } = await obtainCode("app_u10086", query);
  const response = await redeem(code, verifier);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const body = JSON.parse(text) as { access_token: string; id_token: string };
  assert.ok(body.access_token);

  const jwksBody = (await (await fetch(`${base}/.well-known/jwks.json`)).json()) as { keys: JWK[] };
  const jwks = createLocalJWKSet(jwksBody);
  const { payload } = await jwtVerify(body.id_token, jwks, {
    issuer: "http://idlogin.test",
    audience: CLIENT_ID,
    algorithms: ["ES256"],
  });
  assert.equal(payload.sub, "app_u10086");
  assert.equal(payload.nonce, "no-1");
});

test("userinfo returns the id as sub and name", async () => {
  const { verifier, challenge } = pkcePair();
  const { code } = await obtainCode("app_u20001", authorizeQuery({ code_challenge: challenge }));
  const body = (await (await redeem(code, verifier)).json()) as { access_token: string };
  const info = await fetch(`${base}/userinfo`, { headers: { authorization: `Bearer ${body.access_token}` } });
  assert.equal(info.status, 200);
  assert.deepEqual(await info.json(), { sub: "app_u20001", name: "app_u20001" });
});

test("a code redeems exactly once", async () => {
  const { verifier, challenge } = pkcePair();
  const { code } = await obtainCode("app_u10086", authorizeQuery({ code_challenge: challenge }));
  assert.equal((await redeem(code, verifier)).status, 200);
  const replay = await redeem(code, verifier);
  assert.equal(replay.status, 400);
  assert.equal(((await replay.json()) as { error: string }).error, "invalid_grant");
});

test("a wrong PKCE verifier is rejected", async () => {
  const { challenge } = pkcePair();
  const { code } = await obtainCode("app_u10086", authorizeQuery({ code_challenge: challenge }));
  const response = await redeem(code, randomBytes(32).toString("base64url"));
  assert.equal(response.status, 400);
});

test("unknown client_id is refused at /authorize", async () => {
  const page = await fetch(`${base}/authorize?${authorizeQuery({ client_id: "intruder" })}`);
  assert.equal(page.status, 400);
});

test("a wrong client secret is refused at /token", async () => {
  const { verifier, challenge } = pkcePair();
  const { code } = await obtainCode("app_u10086", authorizeQuery({ code_challenge: challenge }));
  const response = await redeem(code, verifier, "wrong-secret-0123456789abcdef0123456789abcdef");
  assert.equal(response.status, 401);
});

test("allowedIds whitelist refuses ids outside the list", async () => {
  const started = await startHandler(cfgFor({ allowedIds: ["app_u10086"] }));
  try {
    const query = authorizeQuery();
    const page = await fetch(`${started.base}/authorize?${query}`);
    assert.equal(page.status, 200);
    const submit = await fetch(`${started.base}/authorize`, {
      ...form({ request: hiddenRequestToken(await page.text()), id: "intruder" }),
      redirect: "manual",
    });
    assert.equal(submit.status, 403);
  } finally {
    await started.close();
  }
});

test("the display name entered at login flows into id_token and userinfo", async () => {
  const { verifier, challenge } = pkcePair();
  const { code } = await obtainCode("app_u30001", authorizeQuery({ code_challenge: challenge }), "张三");
  const response = await redeem(code, verifier);
  const body = JSON.parse(await response.text()) as { access_token: string; id_token: string };
  const jwksBody = (await (await fetch(`${base}/.well-known/jwks.json`)).json()) as { keys: JWK[] };
  const { payload } = await jwtVerify(body.id_token, createLocalJWKSet(jwksBody), {
    issuer: "http://idlogin.test",
    audience: CLIENT_ID,
    algorithms: ["ES256"],
  });
  assert.equal(payload.name, "张三");
  const info = await fetch(`${base}/userinfo`, { headers: { authorization: `Bearer ${body.access_token}` } });
  assert.deepEqual(await info.json(), { sub: "app_u30001", name: "张三" });
});

test("logging in again without a name keeps the stored display name", async () => {
  const started = await startHandler(cfgFor());
  try {
    await obtainCode("app_u40001", authorizeQuery(), "李四", started.base);
    const { verifier, challenge } = pkcePair();
    const { code } = await obtainCode("app_u40001", authorizeQuery({ code_challenge: challenge }), "", started.base);
    const body = (await (await redeem(code, verifier, CLIENT_SECRET, started.base)).json()) as { access_token: string };
    const info = await fetch(`${started.base}/userinfo`, { headers: { authorization: `Bearer ${body.access_token}` } });
    assert.deepEqual(await info.json(), { sub: "app_u40001", name: "李四" });
  } finally {
    await started.close();
  }
});

test("each successful login pushes the full roster to the directory", async () => {
  const pushes: DirectoryMemberPush[][] = [];
  const started = await startHandler(cfgFor(), { pushes });
  try {
    await obtainCode("app_u50001", authorizeQuery(), "甲", started.base);
    await waitFor(() => pushes.length >= 1);
    await obtainCode("app_u50002", authorizeQuery(), "乙", started.base);
    const last = await waitFor(() => pushes[1]);
    assert.deepEqual(
      [...last].sort((a, b) => a.principalId.localeCompare(b.principalId)),
      [
        { principalId: "app_u50001", displayName: "甲", type: "internal" },
        { principalId: "app_u50002", displayName: "乙", type: "internal" },
      ],
    );
  } finally {
    await started.close();
  }
});

async function loginCall(baseUrl: string, body: unknown, key = API_KEY): Promise<Response> {
  return fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
}

test("POST /login upserts the account and pushes the roster before replying", async () => {
  const pushes: DirectoryMemberPush[][] = [];
  const started = await startHandler(cfgFor(), { pushes });
  try {
    const first = await loginCall(started.base, { id: "app_u60001", name: "王五" });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), {
      ok: true,
      principalId: "app_u60001",
      displayName: "王五",
      created: true,
    });
    assert.deepEqual(pushes, [[{ principalId: "app_u60001", displayName: "王五", type: "internal" }]]);

    const again = await loginCall(started.base, { id: "app_u60001" });
    assert.deepEqual(await again.json(), {
      ok: true,
      principalId: "app_u60001",
      displayName: "王五",
      created: false,
    });

    const renamed = await loginCall(started.base, { id: "app_u60001", name: "赵六" });
    assert.deepEqual(await renamed.json(), {
      ok: true,
      principalId: "app_u60001",
      displayName: "赵六",
      created: false,
    });
    assert.deepEqual(pushes[2], [{ principalId: "app_u60001", displayName: "赵六", type: "internal" }]);
  } finally {
    await started.close();
  }
});

test("POST /login refuses a missing or wrong key", async () => {
  const started = await startHandler(cfgFor());
  try {
    const wrong = await loginCall(started.base, { id: "app_u60002" }, "wrong-key-0123456789abcdef0123456789");
    assert.equal(wrong.status, 401);
    assert.deepEqual(await wrong.json(), { error: "invalid_key" });
    assert.match(wrong.headers.get("www-authenticate") ?? "", /qm-idlogin/);

    const missing = await fetch(`${started.base}/login`, { method: "POST", body: JSON.stringify({ id: "a" }) });
    assert.equal(missing.status, 401);

    const assembleKey = await loginCall(started.base, { id: "app_u60002" }, CLIENT_SECRET);
    assert.equal(assembleKey.status, 401);
  } finally {
    await started.close();
  }
});

test("POST /login rejects malformed bodies", async () => {
  const started = await startHandler(cfgFor());
  try {
    const badJson = await fetch(`${started.base}/login`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
      body: "{",
    });
    assert.equal(badJson.status, 400);
    assert.deepEqual(await badJson.json(), { error: "bad_json" });

    const noId = await loginCall(started.base, { name: "x" });
    assert.equal(noId.status, 400);
    assert.deepEqual(await noId.json(), { error: "bad_request", message: "id is required (max 200 chars)" });

    const blankId = await loginCall(started.base, { id: "   " });
    assert.equal(blankId.status, 400);

    const longName = await loginCall(started.base, { id: "app_u60003", name: "n".repeat(201) });
    assert.equal(longName.status, 400);
    assert.deepEqual(await longName.json(), { error: "bad_request", message: "name too long (max 200 chars)" });

    const oversize = await loginCall(started.base, { id: "app_u60004", name: "n".repeat(64 * 1024) });
    assert.equal(oversize.status, 413);
    assert.deepEqual(await oversize.json(), { error: "payload_too_large" });
  } finally {
    await started.close();
  }
});

test("POST /login honors the allowedIds whitelist", async () => {
  const started = await startHandler(cfgFor({ allowedIds: ["app_u60005"] }));
  try {
    const refused = await loginCall(started.base, { id: "intruder" });
    assert.equal(refused.status, 403);
    assert.deepEqual(await refused.json(), { error: "id_not_allowed" });

    const allowed = await loginCall(started.base, { id: "app_u60005" });
    assert.equal(allowed.status, 200);
  } finally {
    await started.close();
  }
});

test("POST /login reports a failed directory push as 502", async () => {
  const started = await startHandler(cfgFor(), { pushFails: true });
  try {
    const response = await loginCall(started.base, { id: "app_u60006", name: "孙七" });
    assert.equal(response.status, 502);
    const body = (await response.json()) as { error: string; message: string };
    assert.equal(body.error, "directory_sync_failed");
    assert.match(body.message, /core replied 500/);

    const retry = await loginCall(started.base, { id: "app_u60006" });
    assert.equal(retry.status, 502);
  } finally {
    await started.close();
  }
});

test("an account created by POST /login signs in through the browser flow", async () => {
  const started = await startHandler(cfgFor());
  try {
    const created = await loginCall(started.base, { id: "app_u60007", name: "周八" });
    assert.equal(created.status, 200);
    const { verifier, challenge } = pkcePair();
    const { code } = await obtainCode("app_u60007", authorizeQuery({ code_challenge: challenge }), "", started.base);
    const body = (await (await redeem(code, verifier, CLIENT_SECRET, started.base)).json()) as { access_token: string };
    const info = await fetch(`${started.base}/userinfo`, { headers: { authorization: `Bearer ${body.access_token}` } });
    assert.deepEqual(await info.json(), { sub: "app_u60007", name: "周八" });
  } finally {
    await started.close();
  }
});

test("discovery and jwks expose the endpoints portal consumes", async () => {
  const discovery = (await (await fetch(`${base}/.well-known/openid-configuration`)).json()) as Record<string, unknown>;
  assert.equal(discovery.issuer, "http://idlogin.test");
  assert.equal(discovery.authorization_endpoint, "http://idlogin.test/authorize");
  assert.equal(discovery.token_endpoint, "http://idlogin.test/token");
  const jwks = (await (await fetch(`${base}/.well-known/jwks.json`)).json()) as {
    keys: Array<Record<string, unknown>>;
  };
  assert.equal(jwks.keys.length, 1);
  assert.equal(jwks.keys[0]!.alg, "ES256");
});
