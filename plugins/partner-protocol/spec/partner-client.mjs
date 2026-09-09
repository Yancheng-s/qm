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

const assembled = await callPartner("POST", "/v1/assemble", {
  userId: USER_ID,
  name: `示例员工 ${new Date().toISOString()}`,
  library: LIBRARY,
  soul: "语气克制，先给结论。",
});
console.log("employee", assembled.employee);
console.log("granted", assembled.granted);
console.log("soul", assembled.soul, assembled.soulError ?? "");

const chatSession = await callPartner("POST", "/v1/chat-sessions", {
  userId: USER_ID,
  scopeId: assembled.employee.scopeId,
  conversationId: "c1",
});
console.log("chatUrl", chatSession.chatUrl);

const chatUrl = new URL(chatSession.chatUrl, BASE_URL);
const returnTo = new URL(chatUrl.searchParams.get("returnTo") ?? "/chat/", chatUrl);
console.log("landing", `${returnTo.pathname}${returnTo.search}`);
const sessionId = returnTo.searchParams.get("session") ?? "";
console.log("session", sessionId);
console.log(`open ${chatUrl} in a browser — the silent idlogin handoff signs the user in and lands on the chat ui.`);
