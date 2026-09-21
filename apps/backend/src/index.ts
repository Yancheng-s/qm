import Fastify from "fastify";
import { configProblems, readConfig } from "./config.ts";
import { LIBRARY_PRESETS, resolveLibraryPreset } from "./libraries.ts";
import { createPartnerClient } from "./partner-client.ts";
import { authenticate } from "./auth.ts";

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
  defaultLibrary: config.defaultLibrary,
  libraries: Object.values(LIBRARY_PRESETS).map((preset) => ({
    key: preset.key,
    label: preset.label,
    description: preset.description,
  })),
}));

app.get("/api/libraries", async () => ({
  defaultLibrary: config.defaultLibrary,
  libraries: Object.values(LIBRARY_PRESETS).map((preset) => ({
    key: preset.key,
    label: preset.label,
    description: preset.description,
    defaultEmployeeName: preset.defaultEmployeeName,
    skills: preset.skills,
  })),
}));

app.post<{ Body: { name?: unknown; library?: unknown; files?: unknown; skills?: unknown } }>(
  "/api/employees",
  async (req, reply) => {
    const auth = authenticate(req);
    if (!auth.ok) return reply.status(auth.status).send({ error: auth.error, message: auth.message });
    const libraryKey =
      typeof req.body?.library === "string" && req.body.library.trim()
        ? req.body.library.trim()
        : config.defaultLibrary;
    const preset = resolveLibraryPreset(libraryKey);
    if (!preset) {
      return reply.status(400).send({
        error: "bad_request",
        message: `unknown library "${libraryKey}" (supported: ${Object.keys(LIBRARY_PRESETS).join(", ")})`,
      });
    }
    const name =
      typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim() : preset.defaultEmployeeName;
    const skills = Array.isArray(req.body?.skills) ? req.body.skills : [...preset.skills];
    const outcome = await partner.call("POST", "/v1/assemble", {
      userId: auth.userId,
      name,
      library: preset.key,
      skills,
      ...(Array.isArray(req.body?.files) ? { files: req.body.files } : {}),
      soul: preset.soul,
      standingOrders: preset.standingOrders,
    });
    return reply.status(outcome.status).send(outcome.json);
  },
);

app.post<{ Body: { scopeId?: unknown; conversationId?: unknown } }>("/api/chat-sessions", async (req, reply) => {
  const auth = authenticate(req);
  if (!auth.ok) return reply.status(auth.status).send({ error: auth.error, message: auth.message });
  const scopeId = typeof req.body?.scopeId === "string" ? req.body.scopeId.trim() : "";
  if (!scopeId) return reply.status(400).send({ error: "bad_request", message: "scopeId is required" });
  const conversationId =
    typeof req.body?.conversationId === "string" && req.body.conversationId.trim()
      ? req.body.conversationId.trim()
      : `conv-${Date.now()}`;
  const outcome = await partner.call("POST", "/v1/chat-sessions", { userId: auth.userId, scopeId, conversationId });
  if (!outcome.ok) return reply.status(outcome.status).send(outcome.json);
  const chatUrl = (outcome.json as { chatUrl?: string }).chatUrl ?? "";
  return reply.status(200).send({ chatUrl: `${config.gatewayPublicUrl}${chatUrl}`, conversationId });
});

app.get<{ Querystring: { scopeId?: string } }>("/api/chat-sessions", async (req, reply) => {
  const auth = authenticate(req);
  if (!auth.ok) return reply.status(auth.status).send({ error: auth.error, message: auth.message });
  const scopeId = (req.query.scopeId ?? "").trim();
  const query = scopeId ? `&scopeId=${encodeURIComponent(scopeId)}` : "";
  const outcome = await partner.call("GET", `/v1/chat-sessions?userId=${encodeURIComponent(auth.userId)}${query}`);
  return reply.status(outcome.status).send(outcome.json);
});

await app.listen({ port: config.port, host: "0.0.0.0" });
console.log(
  `[app-backend] http://localhost:${config.port} -> gateway ${config.gatewayUrl} (partner ${config.partnerId}, libraries ${Object.keys(LIBRARY_PRESETS).join(",")})`,
);
