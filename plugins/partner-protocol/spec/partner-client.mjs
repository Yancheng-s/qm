#!/usr/bin/env node
import { createHmac } from "node:crypto";

const BASE_URL = process.env.PARTNER_BASE_URL ?? "http://localhost:8211";
const PARTNER_ID = process.env.PARTNER_ID ?? "acme";
const SECRET = process.env.PARTNER_SECRET ?? "";
const USER_ID = process.env.PARTNER_USER_ID ?? "u1";
const LIBRARY = process.env.PARTNER_LIBRARY ?? "xhs";

if (!SECRET) {
  console.error("set PARTNER_SECRET (and optionally PARTNER_BASE_URL / PARTNER_ID / PARTNER_USER_ID) first");
  process.exit(1);
}

function signedHeaders(method, pathWithQuery, raw) {
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

async function callPartner(method, pathWithQuery, body) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const response = await fetch(`${BASE_URL}${pathWithQuery}`, {
    method,
    headers: signedHeaders(method, pathWithQuery, raw),
    ...(raw ? { body: raw } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${pathWithQuery} -> ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

function readChatCookie(response) {
  const entries =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie") ?? ""];
  const cookie = entries.find((entry) => entry.startsWith("partner_chat="));
  return cookie ? cookie.split(";")[0] : "";
}

async function openChatPage(chatUrl) {
  const response = await fetch(`${BASE_URL}${chatUrl}`);
  const html = await response.text();
  if (!response.ok) throw new Error(`GET ${chatUrl} -> ${response.status} ${html}`);
  const cookie = readChatCookie(response);
  if (!cookie) throw new Error("chat page did not set a partner_chat cookie");
  return cookie;
}

async function callChat(method, pathWithQuery, body, cookie) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const response = await fetch(`${BASE_URL}${pathWithQuery}`, {
    method,
    headers: { "content-type": "application/json", cookie },
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

async function streamChat(pathWithQuery, cookie, onEvent) {
  const response = await fetch(`${BASE_URL}${pathWithQuery}`, { headers: { cookie } });
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

const assembled = await callPartner("POST", "/v1/assemble", {
  userId: USER_ID,
  name: `示例员工 ${new Date().toISOString()}`,
  library: LIBRARY,
  soul: "语气克制，先给结论。",
});
console.log("employee", assembled.employee);
console.log("granted", assembled.granted);
console.log("soul", assembled.soul, assembled.soulError ?? "");

const scopeId = assembled.employee.scopeId;
const conversationId = "c1";

const chatSession = await callPartner("POST", "/v1/chat-sessions", { userId: USER_ID, scopeId, conversationId });
console.log("chatUrl", chatSession.chatUrl);

const cookie = await openChatPage(chatSession.chatUrl);

const turn = await callChat("POST", "/v1/turn", { scopeId, conversationId, text: "你好，介绍一下你自己。" }, cookie);
console.log("turn", turn);

await streamChat(`/v1/events?runId=${turn.runId}`, cookie, (event, data) => {
  if (event === "partial") return console.log("partial", String(data.partial).slice(-120));
  if (event === "activity") return console.log("activity", data.activity.length);
  return console.log(event, data);
});

const sessionId = new URL(chatSession.chatUrl, BASE_URL).searchParams.get("sessionId");
if (sessionId) {
  const history = await callChat("GET", `/v1/sessions/${sessionId}?tailTurns=1`, undefined, cookie);
  console.log("history", history.entries.length, history.earlierEntries ?? 0);
}
