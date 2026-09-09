import type { IncomingMessage, ServerResponse } from "node:http";
import { findRoute } from "../../../chassis/src/router.ts";
import { principalFor, verifySignedRequest } from "../auth.ts";
import { createCoreCall, type CoreCall } from "../core-client.ts";
import { createRateLimiter, problem, readJsonBody, sendProblem, type RateLimiter } from "../transport.ts";
import { createAuthProxy, type AuthProxy } from "./auth/auth-proxy.ts";
import { handleAssemble } from "./partner/assemble.ts";
import { handleChatSessions } from "./partner/chat-sessions.ts";

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
  partnerWebRedirectUrl: string;
}

export interface Route {
  method: string;
  path: string;
  limit: number;
  handle: (c: Ctx) => Promise<void>;
}

export const routes: readonly Route[] = [
  { method: "POST", path: "/v1/assemble", limit: 128_000, handle: handleAssemble },
  { method: "POST", path: "/v1/chat-sessions", limit: 4_000, handle: handleChatSessions },
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
  portalUrl: string;
  partnerWebRedirectUrl: string;
  core?: (principalId: string) => CoreCall;
  authProxy?: AuthProxy;
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

interface ResolvedIdentity {
  partnerId: string;
  userId: string;
  principalId: string;
}

export function createHandler(deps: GatewayDeps): Handler {
  const limiter: RateLimiter = createRateLimiter(deps.ratePerMin);
  const authProxy =
    deps.authProxy ??
    createAuthProxy({
      portalUrl: deps.portalUrl,
      identitySecret: deps.identitySecret,
      partnerUiOrigin: new URL(deps.partnerWebRedirectUrl).origin,
    });
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

    if (url.pathname === "/auth" || url.pathname.startsWith("/auth/")) return authProxy(req, res, url);

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
    const derived = principalFor(
      verified.partnerId,
      method === "GET" ? url.searchParams.get("userId") : read.body.userId,
    );
    if (!derived.ok) return sendProblem(res, derived.problem);
    const identity: ResolvedIdentity = {
      partnerId: verified.partnerId,
      userId: derived.userId,
      principalId: derived.principalId,
    };

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
      partnerWebRedirectUrl: deps.partnerWebRedirectUrl,
    });
  };
}
