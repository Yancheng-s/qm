import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createCoreCall } from "../src/core-client.ts";
import {
  IDENTITY_SECRET,
  PARTNER_ID,
  ROOT,
  SIGNING_SECRET,
  USER_ID,
  startStubCore,
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
