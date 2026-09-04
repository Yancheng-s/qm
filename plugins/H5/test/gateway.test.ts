import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { signedRequestHeaders } from "../../chassis/src/core-client.ts";

const ROOT = join(import.meta.dirname, "..");
const READY_TIMEOUT_MS = 20_000;
const SIGNING_SECRET = "gateway-test-signing-secret-0123456789";

const VALID_ENV = {
  IDLOGIN_ISSUER: "http://h5.test",
  IDLOGIN_CLIENT_ID: "qm-portal",
  IDLOGIN_CLIENT_SECRET: "gateway-test-secret-0123456789abcdef",
  IDLOGIN_REDIRECT_URI: "http://h5.test/auth/callback",
  PROFILES_LIBRARY_SCOPES: "xhs=group:web-project-lib",
  PROFILES_LIBRARY_PRINCIPAL: "app_admin",
  WEB_UI_API_URL: "http://127.0.0.1:9",
  CORE_SIGNING_SECRET: SIGNING_SECRET,
};

function signedPost(path: string, body: string): { method: string; body: string; headers: Record<string, string> } {
  const headers = signedRequestHeaders(SIGNING_SECRET, "POST", path, body, { "content-type": "application/json" });
  return { method: "POST", body, headers };
}

function startStubCore(): Promise<{ url: string; calls: string[]; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const calls: string[] = [];
    const server: Server = createServer((req, res) => {
      const url = req.url ?? "/";
      req.resume();
      req.once("end", () => {
        calls.push(url.split("?")[0]!);
        res.setHeader("content-type", "application/json");
        if (url.startsWith("/v1/skills")) {
          res.writeHead(200);
          const skills = [{ id: "skill-1", name: "space-xhs-title", scopeId: "group:web-project-lib" }];
          return void res.end(JSON.stringify({ skills }));
        }
        if (url.startsWith("/v1/projects")) {
          res.writeHead(201);
          const project = { id: "web-project-1", scopeId: "group:web-project-1" };
          return void res.end(JSON.stringify({ project }));
        }
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
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

function gatewayEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: "0" };
  delete env.DATABASE_URL;
  delete env.CORE_API_URL;
  delete env.CORE_SIGNING_SECRET;
  return { ...env, ...overrides };
}

function bootGateway(env: Record<string, string>): { child: ReturnType<typeof spawn>; output: string[] } {
  const child = spawn(process.execPath, [join(ROOT, "src", "index.ts")], {
    cwd: ROOT,
    env: gatewayEnv(env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: string[] = [];
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => output.push(chunk));
  child.stderr!.on("data", (chunk: string) => output.push(chunk));
  return { child, output };
}

async function stopGateway(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function withGateway(
  overrides: Record<string, string>,
  run: (base: string, banner: string) => Promise<void>,
): Promise<void> {
  const { child, output } = bootGateway({ ...VALID_ENV, ...overrides });
  let base: string;
  try {
    base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`gateway never listened: ${output.join("")}`)), READY_TIMEOUT_MS);
      const ready = (): void => {
        const match = /http:\/\/localhost:(\d+)/.exec(output.join(""));
        if (!match) return;
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      };
      child.stdout!.on("data", ready);
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`gateway exited ${code}: ${output.join("")}`));
      });
    });
  } catch (e) {
    await stopGateway(child);
    throw e;
  }
  try {
    await run(base, output.join(""));
  } finally {
    await stopGateway(child);
  }
}

test("one port serves health, assemble, id sign-in, and the app login api", async () => {
  const core = await startStubCore();
  try {
    await withGateway({ CORE_API_URL: core.url }, async (base, banner) => {
      assert.match(banner, /assemble libraries xhs=group:web-project-lib/);

      const health = await fetch(`${base}/healthz`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { ok: true });

      const unsigned = await fetch(`${base}/assemble`, {
        method: "POST",
        body: JSON.stringify({ library: "xhs", name: "p", principalId: "app_u1" }),
      });
      assert.equal(unsigned.status, 401);
      assert.deepEqual(await unsigned.json(), {
        error: "unauthorized",
        message: "missing signature (unsigned request)",
      });

      const assemble = await fetch(
        `${base}/assemble`,
        signedPost("/assemble", JSON.stringify({ library: "xhs", name: "p", principalId: "app_u1" })),
      );
      assert.equal(assemble.status, 200);
      const assembled = (await assemble.json()) as { status: string; projectId: string; granted: string[] };
      assert.equal(assembled.status, "assembled");
      assert.equal(assembled.projectId, "web-project-1");
      assert.deepEqual(assembled.granted, ["space-xhs-title"]);

      const authorize = await fetch(`${base}/authorize`);
      assert.equal(authorize.status, 400);
      assert.match(await authorize.text(), /无法开始登录/);

      const login = await fetch(`${base}/login`, signedPost("/login", JSON.stringify({ id: "app_u1", name: "甲" })));
      assert.equal(login.status, 200);
      assert.deepEqual(await login.json(), { ok: true, principalId: "app_u1", displayName: "甲", created: true });
      assert.ok(core.calls.includes("/v1/directory"), `expected a directory push, saw ${core.calls.join(", ")}`);

      const loginUnsigned = await fetch(`${base}/login`, { method: "POST", body: JSON.stringify({ id: "app_u2" }) });
      assert.equal(loginUnsigned.status, 401);
      assert.deepEqual(await loginUnsigned.json(), {
        error: "unauthorized",
        message: "missing signature (unsigned request)",
      });

      const discovery = await fetch(`${base}/.well-known/openid-configuration`);
      assert.equal(discovery.status, 200);
      const metadata = (await discovery.json()) as { issuer: string };
      assert.equal(metadata.issuer, VALID_ENV.IDLOGIN_ISSUER);

      const unknown = await fetch(`${base}/nope`);
      assert.equal(unknown.status, 404);
      assert.deepEqual(await unknown.json(), { error: "not_found" });
    });
  } finally {
    await core.close();
  }
});

test("gateway refuses to start when either service is misconfigured", async () => {
  const { child, output } = bootGateway({
    ...VALID_ENV,
    IDLOGIN_CLIENT_ID: "",
    PROFILES_LIBRARY_SCOPES: "",
  });
  const code = await new Promise<number | null>((resolve) => child.once("exit", (exitCode) => resolve(exitCode)));
  assert.notEqual(code, 0);
  const logged = output.join("");
  assert.match(logged, /IDLOGIN_CLIENT_ID is required/);
  assert.match(logged, /PROFILES_LIBRARY_SCOPES is required/);
  assert.match(logged, /h5 refusing to start: 2 misconfiguration/);
});

test("gateway refuses to start when a library binding is malformed", async () => {
  const { child, output } = bootGateway({
    ...VALID_ENV,
    PROFILES_LIBRARY_SCOPES: "xhs=group:web-project-lib,XHS=group:c,xhs=group:d",
  });
  const code = await new Promise<number | null>((resolve) => child.once("exit", (exitCode) => resolve(exitCode)));
  assert.notEqual(code, 0);
  const logged = output.join("");
  assert.match(logged, /key "XHS" must match/);
  assert.match(logged, /binds "xhs" twice/);
  assert.match(logged, /h5 refusing to start: 2 misconfiguration/);
});

test("gateway refuses to start without the signing secret", async () => {
  const env: Record<string, string> = { ...VALID_ENV };
  delete env.CORE_SIGNING_SECRET;
  const { child, output } = bootGateway(env);
  const code = await new Promise<number | null>((resolve) => child.once("exit", (exitCode) => resolve(exitCode)));
  assert.notEqual(code, 0);
  const logged = output.join("");
  assert.match(logged, /CORE_SIGNING_SECRET is required/);
  assert.match(logged, /h5 refusing to start: 1 misconfiguration/);
});
