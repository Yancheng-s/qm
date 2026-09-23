import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

const requests: Array<{ url: string; authorization: string; contentType: string; body: string }> = [];
let status = 200;
let result: unknown = { text: "语音转写结果" };
const provider = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  requests.push({
    url: req.url!,
    authorization: req.headers.authorization ?? "",
    contentType: req.headers["content-type"] ?? "",
    body: Buffer.concat(chunks).toString("utf8"),
  });
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(result));
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerBase = "http://127.0.0.1:" + (provider.address() as AddressInfo).port;
const secret = "asr-route-test-identity";
process.env.CORE_SIGNING_SECRET = secret;
process.env.PORTAL_IDENTITY_SECRET = secret;
process.env.WEB_UI_PRINCIPALS = "alice";
process.env.WEB_UI_ASR_URL = providerBase + "/v1/audio/transcriptions";
process.env.WEB_UI_ASR_MODEL = "test-asr";
process.env.WEB_UI_ASR_API_KEY = "private-asr-key";
const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, "127.0.0.1", resolve));
const base = "http://127.0.0.1:" + (surface.address() as AddressInfo).port;
const identity = { [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60000 }, secret) };
const audio = {
  audio: Buffer.from("recorded-audio").toString("base64"),
  mimeType: "audio/webm;codecs=opus",
  durationMs: 2100,
};
const post = (body: unknown = audio, headers: Record<string, string> = identity) =>
  fetch(base + "/api/asr", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

test.after(() => {
  surface.closeAllConnections();
  surface.close();
  provider.closeAllConnections();
  provider.close();
});

test("ASR requires an authenticated web user", async () => {
  const response = await post(audio, {});
  assert.equal(response.status, 401);
  assert.equal(requests.length, 0);
});

test("ASR forwards a multipart recording using only the server-side key", async () => {
  const response = await post();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: "语音转写结果" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  const sent = requests.at(-1)!;
  assert.equal(sent.authorization, "Bearer private-asr-key");
  assert.match(sent.contentType, /multipart\/form-data/);
  assert.match(sent.body, /recording.webm/);
  assert.match(sent.body, /recorded-audio/);
  assert.match(sent.body, /test-asr/);
});

test("Qwen ASR receives inline audio through chat completions", async () => {
  process.env.WEB_UI_ASR_URL = providerBase + "/compatible-mode/v1/chat/completions";
  result = { choices: [{ message: { content: " 千问识别结果 " } }] };
  const response = await post();
  assert.deepEqual(await response.json(), { text: "千问识别结果" });
  const body = JSON.parse(requests.at(-1)!.body);
  assert.equal(body.stream, false);
  assert.equal(body.messages[0].content[0].input_audio.data, "data:audio/webm;base64," + audio.audio);
  process.env.WEB_UI_ASR_URL = providerBase + "/v1/audio/transcriptions";
  result = { text: "语音转写结果" };
});

test("invalid audio and cross-site requests never reach the model", async () => {
  const before = requests.length;
  for (const invalid of [
    null,
    { ...audio, mimeType: "text/html" },
    { ...audio, audio: "invalid!" },
    { ...audio, durationMs: 66000 },
    { ...audio, durationMs: 0 },
  ]) {
    assert.equal((await post(invalid)).status, 400);
  }
  assert.equal((await post(audio, { ...identity, origin: "https://other.example" })).status, 403);
  assert.equal(requests.length, before);
});

test("missing configuration returns a useful error without disclosing configuration", async () => {
  delete process.env.WEB_UI_ASR_API_KEY;
  const response = await post();
  assert.equal(response.status, 503);
  assert.match(await response.text(), /尚未配置/);
  process.env.WEB_UI_ASR_API_KEY = "private-asr-key";
});

test("upstream errors cannot leak the key or raw provider response", async () => {
  status = 401;
  result = { error: "private-asr-key supplier internals" };
  const response = await post();
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.doesNotMatch(body, /private-asr-key|supplier/);
  status = 200;
  result = { text: " " };
  const empty = await post();
  assert.equal(empty.status, 422);
  result = { malformed: true };
  assert.equal((await post()).status, 502);
});

test("oversize recordings are rejected before reaching the model", async () => {
  const before = requests.length;
  const response = await post({ ...audio, audio: Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64") });
  assert.equal(response.status, 413);
  assert.equal(requests.length, before);
});
