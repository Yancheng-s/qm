import { spawn } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { PARTNER_ID, PARTNER_SECRET, ROOT, USER_ID, startStubCore, withGateway } from "./support.ts";

interface ClientRun {
  code: number | null;
  output: string;
}

function runClient(env: Record<string, string | undefined>, base?: string): Promise<ClientRun> {
  const child = spawn(process.execPath, [join(ROOT, "spec", "partner-client.mjs")], {
    cwd: ROOT,
    env: { ...process.env, ...env, ...(base ? { PARTNER_BASE_URL: base } : {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: string[] = [];
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => output.push(chunk));
  child.stderr?.on("data", (chunk: string) => output.push(chunk));
  return new Promise((resolve) => child.once("exit", (code) => resolve({ code, output: output.join("") })));
}

const CLIENT_ENV = { PARTNER_ID, PARTNER_SECRET, PARTNER_USER_ID: USER_ID };

test("the sample client walks the whole protocol against a stub core", async () => {
  const core = await startStubCore();
  try {
    await withGateway({ CORE_API_URL: core.url }, async (base) => {
      const ran = await runClient(CLIENT_ENV, base);
      assert.equal(ran.code, 0, ran.output);
      assert.match(ran.output, /employee \{[^}]*scopeId: 'group:web-project-1'/);
      assert.match(ran.output, /skills \[ \{ name: 'hello', ok: true \} \]/);
      assert.match(ran.output, /soul true/);
      assert.match(ran.output, /turn \{[^}]*runId: 'run-1'/);
      assert.match(ran.output, /threadRef: 'web:acme_u1:demo-/);
      assert.match(ran.output, /partial Hello back/);
      assert.match(ran.output, /done \{/);
      assert.match(ran.output, /sessions \[/);
      assert.match(ran.output, /history 1 0/);
      assert.match(ran.output, /employees \{/);

      assert.deepEqual(
        core.calls.map((call) => `${call.method} ${call.path}`),
        [
          "POST /v1/projects",
          "POST /v1/skills",
          "POST /v1/soul",
          "POST /v1/turns",
          "GET /v1/runs/run-1",
          "GET /v1/runs/run-1",
          "GET /v1/sessions",
          "GET /v1/sessions/s1",
          "GET /v1/projects",
        ],
      );
    });
  } finally {
    await core.close();
  }
});

test("the sample client refuses to run without a secret", async () => {
  const ran = await runClient({ PARTNER_ID, PARTNER_SECRET: undefined, PARTNER_USER_ID: USER_ID });
  assert.equal(ran.code, 1);
  assert.match(ran.output, /set PARTNER_SECRET/);
});
