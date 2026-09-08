import { createHmac } from "node:crypto";

const CORE = (process.env.CORE_API_URL || "http://localhost:8081").replace(/\/+$/, "");
const SECRET = process.env.CORE_SIGNING_SECRET || "";
const ORG = process.env.CORE_ORG_ID || "acme";
const ACTOR = process.env.ADMIN_ACTOR || `admin@acme.dev@${ORG}`;
const MCP_ID = process.env.MCP_ID || "demo-directory";
const MCP_URL = process.env.MCP_URL || "http://localhost:8300/mcp";

if (!SECRET) {
  console.error("CORE_SIGNING_SECRET missing — run with: node --env-file-if-exists=../../.env bootstrap/register-mcp.mjs");
  process.exit(1);
}

function adminHeaders(method, path, body) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = "v0=" + createHmac("sha256", SECRET).update(`v0:${ts}:${method}\n${path}\n${body}`).digest("hex");
  return { "x-timestamp": String(ts), "x-signature": sig, "x-admin-actor": ACTOR, "content-type": "application/json" };
}

async function show(label, p) {
  try {
    const r = await p;
    const t = await r.text();
    console.log(`${label} -> ${r.status} ${t.length > 600 ? t.slice(0, 600) + "…" : t}`);
  } catch (e) {
    console.log(`${label} -> ERR ${e.message}`);
  }
}

console.log(`registering MCP "${MCP_ID}" (${MCP_URL}) into core ${CORE} as ${ACTOR}`);
await show("preflight POST /mcp tools/list", fetch(MCP_URL, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
}));
const putBody = JSON.stringify({ url: MCP_URL, name: "甲方用户目录", auth: "none", readOnly: true, enabled: true, validate: true });
await show(`PUT /v1/admin/mcp-servers/${MCP_ID}`, fetch(`${CORE}/v1/admin/mcp-servers/${MCP_ID}`, {
  method: "PUT", headers: adminHeaders("PUT", `/v1/admin/mcp-servers/${MCP_ID}`, putBody), body: putBody,
}));
await show("GET /v1/admin/mcp-servers", fetch(`${CORE}/v1/admin/mcp-servers`, {
  method: "GET", headers: adminHeaders("GET", "/v1/admin/mcp-servers", ""),
}));
