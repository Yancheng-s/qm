import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { mintPortalIdentity, verifyPortalIdentity } from "../../../../chassis/src/portal-identity.ts";

const ASSERTION_TTL_MS = 60_000;

export interface AuthProxyDeps {
  portalUrl: string;
  identitySecret: string;
  partnerUiOrigin: string;
}

export type AuthProxy = (req: IncomingMessage, res: ServerResponse, url: URL) => void;

export function createAuthProxy(deps: AuthProxyDeps): AuthProxy {
  const upstream = new URL(deps.portalUrl);
  return (req, res, url) => {
    const presented = url.searchParams.get("assertion") ?? "";
    const verified = presented ? verifyPortalIdentity(presented, deps.identitySecret, Date.now()) : null;
    const pathname = url.pathname;
    const upstreamReq = httpRequest(
      {
        host: upstream.hostname,
        port: upstream.port || 80,
        method: req.method ?? "GET",
        path: `${pathname}${url.search}`,
        headers: { ...req.headers, host: upstream.host },
      },
      (upRes) => {
        const status = upRes.statusCode ?? 502;
        const headers = { ...upRes.headers };
        const location = upRes.headers.location;
        if (status >= 300 && status < 400 && location) {
          if (pathname === "/auth/login" && verified && location.includes("/authorize")) {
            const target = new URL(location, deps.portalUrl);
            target.searchParams.set("id", verified.p);
            target.searchParams.set(
              "assertion",
              mintPortalIdentity({ p: verified.p, exp: Date.now() + ASSERTION_TTL_MS }, deps.identitySecret),
            );
            headers.location = target.toString();
          } else if (location.startsWith("/") && !location.startsWith("//")) {
            headers.location = `${location.startsWith("/chat") ? deps.partnerUiOrigin : deps.portalUrl}${location}`;
          }
        }
        res.writeHead(status, headers);
        upRes.pipe(res);
      },
    );
    upstreamReq.on("error", () => {
      if (res.headersSent) return void res.end();
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "upstream_error", message: "portal unreachable" }));
    });
    req.pipe(upstreamReq);
  };
}
