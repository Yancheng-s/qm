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
  CORE_SIGNING_SECRET: "gateway-test-signing-secret-0123456789",
};

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

test("one port serves health and id sign-in", async () => {
  await withGateway({}, async (base, banner) => {
    assert.match(banner, /id sign-in issuer http:\/\/h5\.test/);

    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const authorize = await fetch(`${base}/authorize`);
    assert.equal(authorize.status, 400);
    assert.match(await authorize.text(), /无法开始登录/);

    const discovery = await fetch(`${base}/.well-known/openid-configuration`);
    assert.equal(discovery.status, 200);
    const metadata = (await discovery.json()) as { issuer: string };
    assert.equal(metadata.issuer, VALID_ENV.IDLOGIN_ISSUER);

    const unknown = await fetch(`${base}/nope`);
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: "not_found" });
  });
});

test("gateway refuses to start when idlogin is misconfigured", async () => {
  const { child, output } = bootGateway({ ...VALID_ENV, IDLOGIN_CLIENT_ID: "" });
  const code = await new Promise<number | null>((resolve) => child.once("exit", (exitCode) => resolve(exitCode)));
  assert.notEqual(code, 0);
  const logged = output.join("");
  assert.match(logged, /IDLOGIN_CLIENT_ID is required/);
  assert.match(logged, /h5 refusing to start: 1 misconfiguration/);
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
