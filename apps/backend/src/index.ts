import Fastify from "fastify";
import { Readable } from "node:stream";
import { configProblems, readConfig } from "./config.ts";
import { createPartnerClient } from "./partner-client.ts";
import { authenticate } from "./auth.ts";
import { loadSkills } from "./skills.ts";
import { MCP_TOOL, registerMcpRoutes } from "./mcp.ts";

const config = readConfig();
const problems = configProblems(config);
if (problems.length) {
  for (const item of problems) console.error(`[app-backend] FATAL: ${item}`);
  throw new Error(`app-backend refusing to start: ${problems.length} misconfiguration(s)`);
}

const partner = createPartnerClient({
  gatewayUrl: config.gatewayUrl,
  partnerId: config.partnerId,
  partnerSecret: config.partnerSecret,
});

const app = Fastify({ logger: false });

app.addHook("onRequest", async (req, reply) => {
  reply.header("access-control-allow-origin", req.headers.origin ?? "*");
  reply.header("access-control-allow-headers", "content-type,x-user-id");
  reply.header("access-control-allow-methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return reply.status(204).send();
});

app.get("/healthz", async () => ({
  ok: true,
  gateway: config.gatewayUrl,
  partnerId: config.partnerId,
  mcp: { path: "/mcp", tools: [MCP_TOOL.name] },
}));

registerMcpRoutes(app, { name: "partner-app-mcp", version: "1.0.0" });

app.get("/api/employees", async (req, reply) => {
  const auth = authenticate(req);
  if (!auth.ok) return reply.status(auth.status).send({ error: auth.error, message: auth.message });
  const outcome = await partner.call("GET", `/v1/employees?userId=${encodeURIComponent(auth.userId)}`);
  return reply.status(outcome.status).send(outcome.json);
});

app.post<{ Body: { name?: unknown } }>("/api/employees", async (req, reply) => {
  const auth = authenticate(req);
  if (!auth.ok) return reply.status(auth.status).send({ error: auth.error, message: auth.message });
  const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim() : config.defaultEmployeeName;
  const skills = await loadSkills(config.skillsFile);
  const outcome = await partner.call("POST", "/v1/assemble", {
    userId: auth.userId,
    name,
    skills,
    soul: config.defaultSoul,
    standingOrders: config.defaultStandingOrders,
  });
  return reply.status(outcome.status).send(outcome.json);
});

app.get<{ Querystring: { scopeId?: string } }>("/api/runtime", async (req, reply) => {
  const auth = authenticate(req);
  if (!auth.ok) return reply.status(auth.status).send({ error: auth.error, message: auth.message });
  const scopeId = (req.query.scopeId ?? "").trim();
  if (!scopeId) return reply.status(400).send({ error: "bad_request", message: "scopeId is required" });
  const outcome = await partner.call(
    "GET",
    `/v1/runtime?userId=${encodeURIComponent(auth.userId)}&scopeId=${encodeURIComponent(scopeId)}`,
  );
  return reply.status(outcome.status).send(outcome.json);
});

app.post<{ Body: Record<string, unknown> }>("/api/turn", async (req, reply) => {
  const auth = authenticate(req);
  if (!auth.ok) return reply.status(auth.status).send({ error: auth.error, message: auth.message });
  const body = req.body ?? {};
  const outcome = await partner.call("POST", "/v1/turn", { ...body, userId: auth.userId });
  return reply.status(outcome.status).send(outcome.json);
});

app.get<{ Querystring: { runId?: string; scopeId?: string; conversationId?: string; userId?: string } }>(
  "/api/events",
  async (req, reply) => {
    const headerAuth = authenticate(req);
    const auth = headerAuth.ok
      ? headerAuth
      : req.query.userId?.trim()
        ? { ok: true as const, userId: req.query.userId.trim() }
        : headerAuth;
    if (!auth.ok) return reply.status(auth.status).send({ error: auth.error, message: auth.message });
    const query = new URLSearchParams({ userId: auth.userId });
    for (const key of ["runId", "scopeId", "conversationId"] as const) {
      const value = (req.query[key] ?? "").trim();
      if (value) query.set(key, value);
    }
    const upstream = await partner.stream("GET", `/v1/events?${query.toString()}`);
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      return reply.status(upstream.status || 502).type("application/json").send(text || '{"error":"upstream_error"}');
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": upstream.headers.get("content-type") ?? "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    req.raw.on("close", () => {
      upstream.body?.cancel().catch(() => undefined);
    });
    Readable.fromWeb(upstream.body as never).pipe(reply.raw);
  },
);

app.get<{ Querystring: { scopeId?: string } }>("/api/sessions", async (req, reply) => {
  const auth = authenticate(req);
  if (!auth.ok) return reply.status(auth.status).send({ error: auth.error, message: auth.message });
  const scopeId = (req.query.scopeId ?? "").trim();
  const query = new URLSearchParams({ userId: auth.userId });
  if (scopeId) query.set("scopeId", scopeId);
  const outcome = await partner.call("GET", `/v1/sessions?${query.toString()}`);
  return reply.status(outcome.status).send(outcome.json);
});

app.get<{ Params: { id: string }; Querystring: { scopeId?: string; tailTurns?: string } }>(
  "/api/sessions/:id",
  async (req, reply) => {
    const auth = authenticate(req);
    if (!auth.ok) return reply.status(auth.status).send({ error: auth.error, message: auth.message });
    const query = new URLSearchParams({ userId: auth.userId });
    const scopeId = (req.query.scopeId ?? "").trim();
    const tailTurns = Number(req.query.tailTurns ?? 20);
    if (scopeId) query.set("scopeId", scopeId);
    if (Number.isFinite(tailTurns) && tailTurns >= 1) query.set("tailTurns", String(Math.floor(tailTurns)));
    const outcome = await partner.call("GET", `/v1/sessions/${encodeURIComponent(req.params.id)}?${query.toString()}`);
    return reply.status(outcome.status).send(outcome.json);
  },
);

await app.listen({ port: config.port, host: "0.0.0.0" });
console.log(`[app-backend] http://localhost:${config.port} -> gateway ${config.gatewayUrl} (partner ${config.partnerId})`);
console.log(`[app-backend]   MCP endpoint: POST http://localhost:${config.port}/mcp (tool ${MCP_TOOL.name})`);
