import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { PayloadTooLargeError, readBody } from "../../chassis/src/http.ts";
import { canonicalPayload, signRequest } from "../../chassis/src/source-auth-sign.ts";

const REPLAY_WINDOW_S = 300;

interface SignedRequestOptions {
  secret: string | undefined;
  method: string;
  pathWithQuery: string;
  maxBytes: number;
}

type SignedBody = { ok: true; raw: string } | { ok: false; status: number; body: Record<string, string> };

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" ? value : undefined;
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = createHmac("sha256", "source-auth-compare").update(a, "utf8").digest();
  const right = createHmac("sha256", "source-auth-compare").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}

function signatureProblem(
  secret: string | undefined,
  opts: SignedRequestOptions,
  raw: string,
  req: IncomingMessage,
): string | undefined {
  if (!secret) return "source authentication is not configured";
  const signature = header(req, "x-signature");
  if (!signature) return "missing signature (unsigned request)";
  const timestamp = Number(header(req, "x-timestamp"));
  if (!Number.isFinite(timestamp)) return "invalid timestamp";
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > REPLAY_WINDOW_S)
    return "stale timestamp (replay protection)";
  const expected = signRequest(secret, timestamp, canonicalPayload(opts.method, opts.pathWithQuery, raw));
  return constantTimeEqual(expected, signature) ? undefined : "signature mismatch";
}

export async function readSignedBody(req: IncomingMessage, opts: SignedRequestOptions): Promise<SignedBody> {
  let raw: string;
  try {
    raw = await readBody(req, opts.maxBytes);
  } catch (e) {
    if (e instanceof PayloadTooLargeError) return { ok: false, status: 413, body: { error: "payload_too_large" } };
    throw e;
  }
  const problem = signatureProblem(opts.secret, opts, raw, req);
  if (problem) return { ok: false, status: 401, body: { error: "unauthorized", message: problem } };
  return { ok: true, raw };
}
