import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createCoreCall } from "../src/core-client.ts";
import {
  IDENTITY_SECRET,
  PARTNER_ID,
  PARTNER_SECRET,
  ROOT,
  SIGNING_SECRET,
  USER_ID,
  startStubCore,
  withGateway,
} from "./support.ts";

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
      assert.match(ran.output, /granted \[ 'space-xhs-writer', 'space-xhs-title' \]/);
      assert.match(ran.output, /soul true/);
      assert.match(ran.output, /chatUrl \/chat\?token=/);
      assert.match(ran.output, /turn \{[^}]*runId: 'run-1'/);
      assert.match(ran.output, /threadRef: 'web:acme_u1:c1'/);
      assert.match(ran.output, /partial Hello back/);
      assert.match(ran.output, /done \{/);
      assert.match(ran.output, /history 1 0/);

      assert.deepEqual(
        core.calls.map((call) => `${call.method} ${call.path}`),
        [
          "GET /v1/skills",
          "POST /v1/projects",
          "POST /v1/grants",
          "POST /v1/grants",
          "POST /v1/soul",
          "GET /v1/sessions",
          "POST /v1/turns",
          "GET /v1/runs/run-1",
          "GET /v1/runs/run-1",
          "GET /v1/sessions/s1",
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

test("core client stages binary blobs with source auth bound to the sha256", async () => {
  const core = await startStubCore();
  try {
    const client = createCoreCall(
      { coreApiUrl: core.url, signingSecret: SIGNING_SECRET, identitySecret: IDENTITY_SECRET },
      "acme_u1",
    );
    const bytes = Buffer.from("hello");
    const outcome = await client.stageBlob!(bytes);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.ok ? outcome.status : 0, 200);
    assert.equal(core.calls.at(-1)?.path, "/v1/blobs");
    assert.equal(core.calls.at(-1)?.body, "hello");
    assert.equal(core.calls.at(-1)?.headers["x-content-sha256"], createHash("sha256").update(bytes).digest("hex"));
    assert.ok(core.calls.at(-1)?.headers["x-signature"]);
  } finally {
    await core.close();
  }
});
