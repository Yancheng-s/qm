import type { IncomingMessage, ServerResponse } from "node:http";
import { findRoute } from "../../../chassis/src/router.ts";
import { principalFor, verifySignedRequest } from "../auth.ts";
import { createCoreCall, type CoreCall } from "../core-client.ts";
import { createRateLimiter, problem, readJsonBody, sendProblem, type RateLimiter } from "../transport.ts";
import { handleAssemble } from "./assemble.ts";
import { handleEmployees } from "./employees.ts";
import { handleEvents } from "./events.ts";
import { handleSessionById, handleSessions } from "./sessions.ts";
import { handleSkillCreate } from "./skills.ts";
import { handleTurn } from "./turn.ts";

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  partnerId: string;
  userId: string;
  principalId: string;
  body: Record<string, unknown>;
  core: CoreCall;
}

export interface Route {
  method: string;
  path: string;
  limit: number;
  handle: (c: Ctx) => Promise<void>;
}

export const routes: readonly Route[] = [
  { method: "GET", path: "/v1/employees", limit: 0, handle: handleEmployees },
  { method: "POST", path: "/v1/assemble", limit: 512_000, handle: handleAssemble },
  { method: "POST", path: "/v1/skills", limit: 160_000, handle: handleSkillCreate },
  { method: "POST", path: "/v1/turn", limit: 64_000, handle: handleTurn },
  { method: "GET", path: "/v1/events", limit: 0, handle: handleEvents },
  { method: "GET", path: "/v1/sessions", limit: 0, handle: handleSessions },
  { method: "GET", path: "/v1/sessions/:id", limit: 0, handle: handleSessionById },
];

const UNKNOWN_PATH_BODY_LIMIT = 512_000;

export interface GatewayDeps {
  coreApiUrl: string;
  signingSecret: string | undefined;
  identitySecret: string;
  partners: ReadonlyMap<string, string>;
  ratePerMin: number;
  core?: (principalId: string) => CoreCall;
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function createHandler(deps: GatewayDeps): Handler {
  const limiter: RateLimiter = createRateLimiter(deps.ratePerMin);
  const coreFor =
    deps.core ??
    ((principalId: string) =>
      createCoreCall(
        {
          coreApiUrl: deps.coreApiUrl,
          signingSecret: deps.signingSecret,
          identitySecret: deps.identitySecret,
        },
        principalId,
      ));

  return async (req, res) => {
    const method = req.method ?? "GET";
    const pathWithQuery = req.url ?? "/";
    let url: URL;
    try {
      url = new URL(pathWithQuery, "http://partner-protocol.local");
    } catch {
      return sendProblem(res, problem(400, "bad_request", "malformed request target"));
    }
    const found = findRoute(routes, method, url.pathname);

    const read = await readJsonBody(req, found?.route.limit ?? UNKNOWN_PATH_BODY_LIMIT);
    if (!read.ok) return sendProblem(res, read.problem);

    const verified = verifySignedRequest({
      partners: deps.partners,
      method,
      pathWithQuery,
      raw: read.raw,
      header: (name) => {
        const value = req.headers[name];
        return Array.isArray(value) ? value[0] : value;
      },
    });
    if (!verified.ok) return sendProblem(res, verified.problem);

    const identity = principalFor(
      verified.partnerId,
      method === "GET" ? url.searchParams.get("userId") : read.body.userId,
    );
    if (!identity.ok) return sendProblem(res, identity.problem);

    const retryAfter = limiter.take(verified.partnerId);
    if (retryAfter !== null) {
      res.setHeader("retry-after", String(retryAfter));
      return sendProblem(
        res,
        problem(429, "rate_limited", `partner quota exceeded, retry in ${retryAfter}s`, {
          retryAfter,
        }),
      );
    }

    if (!found) return sendProblem(res, problem(404, "not_found", "no such endpoint"));

    await found.route.handle({
      req,
      res,
      url,
      params: found.params,
      partnerId: verified.partnerId,
      userId: identity.userId,
      principalId: identity.principalId,
      body: read.body,
      core: coreFor(identity.principalId),
    });
  };
}
