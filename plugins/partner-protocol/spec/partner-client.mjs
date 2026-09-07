#!/usr/bin/env node
import { createHmac } from "node:crypto";

const BASE_URL = process.env.PARTNER_BASE_URL ?? "http://localhost:8211";
const PARTNER_ID = process.env.PARTNER_ID ?? "acme";
const SECRET = process.env.PARTNER_SECRET ?? "";
const USER_ID = process.env.PARTNER_USER_ID ?? "u1";

if (!SECRET) {
  console.error("set PARTNER_SECRET (and optionally PARTNER_BASE_URL / PARTNER_ID / PARTNER_USER_ID) first");
  process.exit(1);
}

function headers(method, pathWithQuery, raw) {
  const timestamp = Math.floor(Date.now() / 1000);
  const canonical = `${method}\n${pathWithQuery}\n${raw}`;
  const digest = createHmac("sha256", SECRET).update(`v0:${timestamp}:${canonical}`, "utf8").digest("hex");
  return {
    "content-type": "application/json",
    "x-partner-id": PARTNER_ID,
    "x-timestamp": String(timestamp),
    "x-signature": `v0=${digest}`,
  };
}

async function call(method, pathWithQuery, body) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const response = await fetch(`${BASE_URL}${pathWithQuery}`, {
    method,
    headers: headers(method, pathWithQuery, raw),
    ...(raw ? { body: raw } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${pathWithQuery} -> ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

function parseBlock(block) {
  let event = "message";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice("event: ".length);
    else if (line.startsWith("data: ")) data += line.slice("data: ".length);
  }
  return data ? { event, data: JSON.parse(data) } : null;
}

async function stream(pathWithQuery, onEvent) {
  const response = await fetch(`${BASE_URL}${pathWithQuery}`, { headers: headers("GET", pathWithQuery, "") });
  if (!response.ok || !response.body)
    throw new Error(`GET ${pathWithQuery} -> ${response.status} ${await response.text()}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const parsed = parseBlock(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      if (parsed) onEvent(parsed.event, parsed.data);
      boundary = buffer.indexOf("\n\n");
    }
  }
}

const assembled = await call("POST", "/v1/assemble", {
  userId: USER_ID,
  name: `示例员工 ${new Date().toISOString()}`,
  skills: [{ name: "hello", description: "用一句话问好", body: "# hello\n\n收到问候时回一句话。\n" }],
  soul: "语气克制，先给结论。",
});
console.log("employee", assembled.employee);
console.log("skills", assembled.skills);
console.log("soul", assembled.soul, assembled.soulError ?? "");

const conversationId = `demo-${Date.now()}`;
const scopeId = assembled.employee.scopeId;
const turn = await call("POST", "/v1/turn", {
  userId: USER_ID,
  scopeId,
  conversationId,
  text: "你好，介绍一下你自己。",
});
console.log("turn", turn);

await stream(`/v1/events?userId=${USER_ID}&runId=${turn.runId}`, (event, data) => {
  if (event === "partial") return console.log("partial", String(data.partial).slice(-120));
  if (event === "activity") return console.log("activity", data.activity.length);
  return console.log(event, data);
});

const listed = await call("GET", `/v1/sessions?userId=${USER_ID}&scopeId=${encodeURIComponent(scopeId)}`);
console.log("sessions", listed.sessions);

const current = listed.sessions.find((session) => session.threadRef === turn.threadRef) ?? listed.sessions.at(-1);
if (current) {
  const history = await call("GET", `/v1/sessions/${current.id}?userId=${USER_ID}&tailTurns=1`);
  console.log("history", history.entries.length, history.earlierEntries ?? 0);
}

console.log("employees", await call("GET", `/v1/employees?userId=${USER_ID}`));
