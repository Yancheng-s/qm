import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "../../../chassis/src/http.ts";
import { errMessage } from "../../../chassis/src/errors.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../../chassis/src/portal-identity.ts";
import { readSignedBody } from "../signed-request.ts";

const MAX_BODY_BYTES = 25_000_000;
const IDENTITY_TTL_MS = 60_000;
const SKIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "x-signature",
  "x-timestamp",
  PORTAL_IDENTITY_HEADER,
]);
const SKIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

export interface BridgeDeps {
  webUiApiUrl: string;
  signingSecret: string | undefined;
  identitySecret: string;
}

function upstreamHeaders(req: IncomingMessage, identity: string): Record<string, string> {
  const out: Record<string, string> = { [PORTAL_IDENTITY_HEADER]: identity };
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || SKIP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function downstreamHeaders(src: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  src.forEach((value, key) => {
    if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) out[key] = value;
  });
  return out;
}

export function bootBridge(deps: BridgeDeps): {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} {
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", deps.webUiApiUrl);
    const pathWithQuery = `${url.pathname}${url.search}`;

    const signed = await readSignedBody(req, {
      secret: deps.signingSecret,
      method,
      pathWithQuery,
      maxBytes: MAX_BODY_BYTES,
    });
    if (!signed.ok) return json(res, signed.status, signed.body);

    const principalId = url.searchParams.get("principalId")?.trim();
    if (!principalId)
      return json(res, 400, { error: "bad_request", message: "principalId query parameter is required" });

    const identity = mintPortalIdentity({ p: principalId, exp: Date.now() + IDENTITY_TTL_MS }, deps.identitySecret);
    const hasBody = method !== "GET" && method !== "HEAD";

    let up: Response;
    try {
      up = await fetch(`${deps.webUiApiUrl}${pathWithQuery}`, {
        method,
        headers: upstreamHeaders(req, identity),
        ...(hasBody ? { body: signed.raw } : {}),
        redirect: "manual",
      });
    } catch (e) {
      return json(res, 502, { error: "bad_gateway", message: errMessage(e) });
    }

    res.writeHead(up.status, downstreamHeaders(up.headers));
    if (!up.body) {
      res.end();
      return;
    }
    await new Promise<void>((resolve) => {
      const nodeStream = Readable.fromWeb(up.body as ReadableStream);
      const finish = (): void => {
        nodeStream.destroy();
        resolve();
      };
      nodeStream.on("error", (e: unknown) => {
        console.error("[h5] bridge upstream stream error: %s", errMessage(e));
        finish();
      });
      nodeStream.on("end", finish);
      res.on("close", finish);
      nodeStream.pipe(res);
    });
  };
  return { handle };
}
