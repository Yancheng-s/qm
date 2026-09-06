import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import { CAPABILITY_HEADER, signedHeaders, withSourceAuthNonce } from "../../../chassis/src/core-client.ts";
import { PORTAL_IDENTITY_HEADER } from "../../../chassis/src/portal-identity.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface CoreDeps {
  coreApiUrl: string;
  signingSecret: string | undefined;
  portalToken: string;
}

const SKIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

export async function coreFetch(
  deps: CoreDeps,
  method: HttpMethod,
  pathWithQuery: string,
  rawBody = "",
): Promise<Response> {
  const signedPath = withSourceAuthNonce(pathWithQuery, deps.signingSecret);
  return fetch(`${deps.coreApiUrl}${signedPath}`, {
    method,
    headers: {
      ...signedHeaders(deps.signingSecret, method, signedPath, rawBody),
      ...(deps.portalToken ? { [PORTAL_IDENTITY_HEADER]: deps.portalToken } : {}),
    },
    ...(rawBody ? { body: rawBody } : {}),
    redirect: "manual",
  });
}

export async function coreFetchCap(
  deps: CoreDeps,
  method: HttpMethod,
  pathWithQuery: string,
  rawBody = "",
): Promise<Response> {
  const cap = await coreFetch(deps, "POST", "/v1/session-cap", "");
  if (cap.status !== 200) return cap;
  let token = "";
  try {
    token = String((JSON.parse(await cap.text()) as { token?: unknown }).token ?? "");
  } catch {
    token = "";
  }
  if (!token)
    return new Response(JSON.stringify({ error: "not_configured", message: "no session capability" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  return fetch(`${deps.coreApiUrl}${pathWithQuery}`, {
    method,
    headers: { "content-type": "application/json", [CAPABILITY_HEADER]: token },
    ...(rawBody ? { body: rawBody } : {}),
    redirect: "manual",
  });
}

export async function relayResponse(res: ServerResponse, up: Response): Promise<void> {
  const headers: Record<string, string> = {};
  up.headers.forEach((value, key) => {
    if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) headers[key] = value;
  });
  res.writeHead(up.status, headers);
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
    nodeStream.on("error", finish);
    nodeStream.on("end", finish);
    res.on("close", finish);
    nodeStream.pipe(res);
  });
}

export function sseEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
