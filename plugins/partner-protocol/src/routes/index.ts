import type { IncomingMessage, ServerResponse } from "node:http";
import { findRoute } from "../../../chassis/src/router.ts";
import { principalFor, readChatCookie, verifyChatToken, verifySignedRequest } from "../auth.ts";
import { createCoreCall, type CoreCall } from "../core-client.ts";
import { createRateLimiter, problem, readJsonBody, sendProblem, type RateLimiter } from "../transport.ts";
import { handleAssemble } from "./partner/assemble.ts";
import { handleChatSessions } from "./partner/chat-sessions.ts";
import { handleChat } from "./chat/chat.ts";
import { handleEvents } from "./chat/events.ts";
import { handleSessionById } from "./chat/sessions.ts";
import { handleTurn } from "./chat/turn.ts";

export type RouteAuth = "partner" | "chat-cookie" | "chat-ticket";

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
  libraryCore: CoreCall;
  libraries: ReadonlyMap<string, string>;
  libraryPrincipalId: string;
  identitySecret: string;
  chatCookieSecure: boolean;
  chatToken: string;
}

export interface Route {
  method: string;
  path: string;
  limit: number;
  auth: RouteAuth;
  handle: (c: Ctx) => Promise<void>;
}

export const routes: readonly Route[] = [
  { method: "POST", path: "/v1/assemble", limit: 128_000, auth: "partner", handle: handleAssemble },
  { method: "POST", path: "/v1/chat-sessions", limit: 4_000, auth: "partner", handle: handleChatSessions },
  { method: "GET", path: "/chat", limit: 0, auth: "chat-ticket", handle: handleChat },
  { method: "POST", path: "/v1/turn", limit: 64_000, auth: "chat-cookie", handle: handleTurn },
  { method: "GET", path: "/v1/events", limit: 0, auth: "chat-cookie", handle: handleEvents },
  { method: "GET", path: "/v1/sessions/:id", limit: 0, auth: "chat-cookie", handle: handleSessionById },
];

const UNKNOWN_PATH_BODY_LIMIT = 512_000;

export interface GatewayDeps {
  coreApiUrl: string;
  signingSecret: string | undefined;
  identitySecret: string;
  partners: ReadonlyMap<string, string>;
  libraries: ReadonlyMap<string, string>;
  libraryPrincipalId: string;
  ratePerMin: number;
  chatCookieSecure: boolean;
  core?: (principalId: string) => CoreCall;
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

interface ResolvedIdentity {
  partnerId: string;
  userId: string;
  principalId: string;
  chatToken: string;
}

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

  const libraryCore = coreFor(deps.libraryPrincipalId);

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

    const auth: RouteAuth = found?.route.auth ?? "partner";
    let identity: ResolvedIdentity;
    if (auth === "partner") {
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
      const derived = principalFor(
        verified.partnerId,
        method === "GET" ? url.searchParams.get("userId") : read.body.userId,
      );
      if (!derived.ok) return sendProblem(res, derived.problem);
      identity = {
        partnerId: verified.partnerId,
        userId: derived.userId,
        principalId: derived.principalId,
        chatToken: "",
      };
    } else {
      const token = auth === "chat-ticket" ? url.searchParams.get("token") : readChatCookie(req);
      const verified = verifyChatToken(token, deps.identitySecret);
      if (!verified.ok) return sendProblem(res, verified.problem);
      const separator = verified.principalId.indexOf("_");
      identity = {
        partnerId: verified.partnerId,
        userId: separator > 0 ? verified.principalId.slice(separator + 1) : "",
        principalId: verified.principalId,
        chatToken: verified.token,
      };
    }

    const retryAfter = limiter.take(identity.partnerId);
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
      partnerId: identity.partnerId,
      userId: identity.userId,
      principalId: identity.principalId,
      body: read.body,
      core: coreFor(identity.principalId),
      libraryCore,
      libraries: deps.libraries,
      libraryPrincipalId: deps.libraryPrincipalId,
      identitySecret: deps.identitySecret,
      chatCookieSecure: deps.chatCookieSecure,
      chatToken: identity.chatToken,
    });
  };
}
