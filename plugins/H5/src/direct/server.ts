import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "../../../chassis/src/http.ts";
import { findRoute } from "../../../chassis/src/router.ts";
import { mintPortalIdentity } from "../../../chassis/src/portal-identity.ts";
import { readSignedBody } from "../signed-request.ts";
import type { DirectConfig } from "./config.ts";
import type { CoreDeps } from "./core.ts";
import { directRoutes, type Ctx } from "./routes.ts";

const MAX_BODY_BYTES = 25_000_000;
const IDENTITY_TTL_MS = 60_000;

function parseBody(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function bootDirect(cfg: DirectConfig): {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} {
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://h5.local");
    const pathWithQuery = `${url.pathname}${url.search}`;

    const signed = await readSignedBody(req, {
      secret: cfg.signingSecret,
      method,
      pathWithQuery,
      maxBytes: MAX_BODY_BYTES,
    });
    if (!signed.ok) return json(res, signed.status, signed.body);

    const user = url.searchParams.get("principalId")?.trim();
    if (!user)
      return json(res, 400, { error: "bad_request", message: "principalId query parameter is required" });

    const found = findRoute(directRoutes, method, url.pathname);
    if (!found) return json(res, 404, { error: "not_found" });

    const deps: CoreDeps = {
      coreApiUrl: cfg.coreApiUrl,
      signingSecret: cfg.signingSecret,
      portalToken: mintPortalIdentity({ p: user, exp: Date.now() + IDENTITY_TTL_MS }, cfg.identitySecret),
    };
    const ctx: Ctx = {
      req,
      res,
      url,
      params: found.params,
      user,
      orgId: cfg.orgId,
      body: parseBody(signed.raw),
      deps,
    };
    await found.route.handle(ctx);
  };

  return { handle };
}
