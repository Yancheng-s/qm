import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, verifyPortalIdentity } from "../../chassis/src/portal-identity.ts";
import { createAuthProxy } from "../src/routes/auth/auth-proxy.ts";

const IDENTITY_SECRET = "auth-proxy-test-identity-secret-012345";
const PARTNER_UI = "http://localhost:5175";

function listen(server: Server): string {
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function startPortal(): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url ?? "/", "http://portal.local");
    if (pathname === "/auth/login") {
      res.writeHead(302, { location: "http://idlogin.local/authorize?response_type=code&client_id=qm-portal" });
      return void res.end();
    }
    if (pathname === "/auth/callback") {
      res.writeHead(302, { location: "/chat/?session=s1" });
      return void res.end();
    }
    if (pathname === "/auth/elsewhere") {
      res.writeHead(302, { location: "/dashboard" });
      return void res.end();
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: pathname }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    base: listen(server),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function proxyFetch(base: string, pathWithQuery: string): Promise<Response> {
  return fetch(`${base}${pathWithQuery}`, { redirect: "manual" });
}

test("a valid assertion is refreshed and attached to the authorize redirect", async () => {
  const portal = await startPortal();
  try {
    const proxy = createAuthProxy({
      portalUrl: portal.base,
      identitySecret: IDENTITY_SECRET,
      partnerUiOrigin: PARTNER_UI,
    });
    const server = createServer((req, res) => proxy(req, res, new URL(req.url ?? "/", "http://proxy.local")));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const base = listen(server);
    try {
      const presented = mintPortalIdentity({ p: "acme_u1", exp: Date.now() + 60_000 }, IDENTITY_SECRET);
      const response = await proxyFetch(base, `/auth/login?returnTo=%2Fchat%2F&assertion=${presented}`);
      assert.equal(response.status, 302);
      const location = new URL(response.headers.get("location") ?? "");
      assert.equal(location.origin, "http://idlogin.local");
      assert.equal(location.pathname, "/authorize");
      assert.equal(location.searchParams.get("id"), "acme_u1");
      const refreshed = verifyPortalIdentity(location.searchParams.get("assertion") ?? "", IDENTITY_SECRET, Date.now());
      assert.equal(refreshed?.p, "acme_u1");

      const body = await proxyFetch(base, "/healthz");
      assert.equal(body.status, 200);
      assert.deepEqual(await body.json(), { ok: true, path: "/healthz" });
    } finally {
      await closeServer(server);
    }
  } finally {
    await portal.close();
  }
});

test("a missing or bogus assertion leaves the authorize redirect untouched", async () => {
  const portal = await startPortal();
  try {
    const proxy = createAuthProxy({
      portalUrl: portal.base,
      identitySecret: IDENTITY_SECRET,
      partnerUiOrigin: PARTNER_UI,
    });
    const server = createServer((req, res) => proxy(req, res, new URL(req.url ?? "/", "http://proxy.local")));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const base = listen(server);
    try {
      const bare = await proxyFetch(base, "/auth/login?returnTo=%2Fchat%2F");
      assert.equal(
        bare.headers.get("location"),
        "http://idlogin.local/authorize?response_type=code&client_id=qm-portal",
      );

      const bogus = await proxyFetch(base, "/auth/login?returnTo=%2Fchat%2F&assertion=not.a.token");
      assert.equal(
        bogus.headers.get("location"),
        "http://idlogin.local/authorize?response_type=code&client_id=qm-portal",
      );
    } finally {
      await closeServer(server);
    }
  } finally {
    await portal.close();
  }
});

test("the callback landing is rewritten to the partner ui for chat paths", async () => {
  const portal = await startPortal();
  try {
    const proxy = createAuthProxy({
      portalUrl: portal.base,
      identitySecret: IDENTITY_SECRET,
      partnerUiOrigin: PARTNER_UI,
    });
    const server = createServer((req, res) => proxy(req, res, new URL(req.url ?? "/", "http://proxy.local")));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const base = listen(server);
    try {
      const chat = await proxyFetch(base, "/auth/callback?code=abc&state=xyz");
      assert.equal(chat.headers.get("location"), `${PARTNER_UI}/chat/?session=s1`);

      const elsewhere = await proxyFetch(base, "/auth/elsewhere");
      assert.equal(elsewhere.headers.get("location"), `${portal.base}/dashboard`);
    } finally {
      await closeServer(server);
    }
  } finally {
    await portal.close();
  }
});
