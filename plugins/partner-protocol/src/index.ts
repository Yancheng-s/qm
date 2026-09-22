import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { errMessage } from "../../chassis/src/errors.ts";
import { bootProblems, readConfig } from "./config.ts";
import { createHandler } from "./routes/index.ts";
import { problem, sendJson, sendProblem } from "./transport.ts";

const cfg = readConfig(process.env);
const problems = bootProblems(cfg);
if (problems.length) {
  for (const item of problems) console.error(`[partner-protocol] FATAL: ${item}`);
  throw new Error(`partner-protocol refusing to start: ${problems.length} misconfiguration(s)`);
}

const dispatch = createHandler({
  coreApiUrl: cfg.coreApiUrl,
  signingSecret: cfg.signingSecret,
  identitySecret: cfg.identitySecret,
  partners: cfg.partners,
  libraries: cfg.libraries,
  libraryPrincipalId: cfg.libraryPrincipalId,
  ratePerMin: cfg.ratePerMin,
  portalUrl: cfg.portalUrl,
  partnerWebRedirectUrl: cfg.partnerWebRedirectUrl,
});

const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const method = req.method ?? "GET";
  const { pathname } = new URL(req.url ?? "/", "http://partner-protocol.local");
  if (method === "GET" && pathname === "/healthz") return sendJson(res, 200, { ok: true });
  return dispatch(req, res);
};

const server = createServer((req, res) => {
  void handle(req, res).catch((e: unknown) => {
    console.error("[partner-protocol] 500 %s %s: %s", req.method ?? "?", (req.url ?? "?").split("?")[0], errMessage(e));
    if (!res.headersSent) sendProblem(res, problem(500, "internal_error", "the gateway hit an unexpected error"));
    else res.end();
  });
});

server.listen(cfg.port, () => {
  const port = (server.address() as AddressInfo).port;
  console.log(
    `[partner-protocol] gateway on http://localhost:${port} (core ${cfg.coreApiUrl}, partners ${[...cfg.partners.keys()].join(", ")}, rate ${cfg.ratePerMin}/min)`,
  );
});
