import { spawn } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const ROOT = join(import.meta.dirname, "..");
const READY_TIMEOUT_MS = 20_000;

const VALID_ENV = {
  IDLOGIN_ISSUER: "http://h5.test",
  IDLOGIN_CLIENT_ID: "qm-portal",
  IDLOGIN_CLIENT_SECRET: "gateway-test-secret-0123456789abcdef",
  IDLOGIN_REDIRECT_URI: "http://h5.test/auth/callback",
  IDLOGIN_API_KEY: "gateway-test-api-key-0123456789abcdef",
  PROFILES_ASSEMBLE_KEY: "gateway-test-key-0123456789abcdef",
  PROFILES_LIBRARY_SCOPE: "group:web-project-lib",
  PROFILES_LIBRARY_PRINCIPAL: "app_admin",
};

function gatewayEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides, PORT: "0" };
  delete env.DATABASE_URL;
  delete env.CORE_SIGNING_SECRET;
  return env;
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

async function withGateway(run: (base: string) => Promise<void>): Promise<void> {
  const { child, output } = bootGateway(VALID_ENV);
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
    await run(base);
  } finally {
    await stopGateway(child);
  }
}

test("one port serves health, assemble, id sign-in, and the app login api", async () => {
  await withGateway(async (base) => {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const assemble = await fetch(`${base}/assemble`, {
      method: "POST",
      body: JSON.stringify({ name: "p", principalId: "app_u1" }),
    });
    assert.equal(assemble.status, 401);
    assert.deepEqual(await assemble.json(), { error: "invalid_key" });

    const authorize = await fetch(`${base}/authorize`);
    assert.equal(authorize.status, 400);
    assert.match(await authorize.text(), /无法开始登录/);

    const login = await fetch(`${base}/login`, {
      method: "POST",
      headers: { authorization: `Bearer ${VALID_ENV.IDLOGIN_API_KEY}` },
      body: JSON.stringify({ id: "app_u1", name: "甲" }),
    });
    assert.equal(login.status, 200);
    assert.deepEqual(await login.json(), { ok: true, principalId: "app_u1", displayName: "甲", created: true });

    const loginNoKey = await fetch(`${base}/login`, { method: "POST", body: JSON.stringify({ id: "app_u2" }) });
    assert.equal(loginNoKey.status, 401);
    assert.deepEqual(await loginNoKey.json(), { error: "invalid_key" });

    const discovery = await fetch(`${base}/.well-known/openid-configuration`);
    assert.equal(discovery.status, 200);
    const metadata = (await discovery.json()) as { issuer: string };
    assert.equal(metadata.issuer, VALID_ENV.IDLOGIN_ISSUER);

    const unknown = await fetch(`${base}/nope`);
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: "not_found" });
  });
});

test("gateway refuses to start when either service is misconfigured", async () => {
  const { child, output } = bootGateway({
    ...VALID_ENV,
    IDLOGIN_CLIENT_ID: "",
    PROFILES_LIBRARY_SCOPE: "",
  });
  const code = await new Promise<number | null>((resolve) => child.once("exit", (exitCode) => resolve(exitCode)));
  assert.notEqual(code, 0);
  const logged = output.join("");
  assert.match(logged, /IDLOGIN_CLIENT_ID is required/);
  assert.match(logged, /PROFILES_LIBRARY_SCOPE is required/);
  assert.match(logged, /h5 refusing to start: 2 misconfiguration/);
});
