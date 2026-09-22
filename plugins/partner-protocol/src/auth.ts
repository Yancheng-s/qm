import { createHmac, timingSafeEqual } from "node:crypto";
import { mintPortalIdentity } from "../../chassis/src/portal-identity.ts";
import { canonicalPayload, signRequest } from "../../chassis/src/source-auth-sign.ts";
import type { Problem } from "./transport.ts";

export const PARTNER_ID_HEADER = "x-partner-id";
export const TIMESTAMP_HEADER = "x-timestamp";
export const SIGNATURE_HEADER = "x-signature";
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const FRESHNESS_WINDOW_S = 300;

export type VerifiedRequest = { ok: true; partnerId: string } | { ok: false; problem: Problem };

export type DerivedIdentity = { ok: true; userId: string; principalId: string } | { ok: false; problem: Problem };

export interface SignedRequestInput {
  partners: ReadonlyMap<string, string>;
  method: string;
  pathWithQuery: string;
  raw: string;
  header: (name: string) => string | undefined;
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = createHmac("sha256", "partner-protocol-compare").update(a, "utf8").digest();
  const right = createHmac("sha256", "partner-protocol-compare").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}

function rejected(message: string): VerifiedRequest {
  return { ok: false, problem: { status: 401, body: { error: "unauthorized", message } } };
}

export function verifySignedRequest(input: SignedRequestInput): VerifiedRequest {
  const partnerId = input.header(PARTNER_ID_HEADER)?.trim() ?? "";
  if (!partnerId) return rejected(`missing ${PARTNER_ID_HEADER} header`);
  const secret = input.partners.get(partnerId);
  if (!secret) return rejected("unknown partner");
  const signature = input.header(SIGNATURE_HEADER);
  if (!signature) return rejected("missing signature (unsigned request)");
  const timestamp = Number(input.header(TIMESTAMP_HEADER));
  if (!Number.isFinite(timestamp)) return rejected("invalid timestamp");
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > FRESHNESS_WINDOW_S)
    return rejected(`timestamp outside the ${FRESHNESS_WINDOW_S}s freshness window`);
  const expected = signRequest(secret, timestamp, canonicalPayload(input.method, input.pathWithQuery, input.raw));
  return constantTimeEqual(expected, signature) ? { ok: true, partnerId } : rejected("signature mismatch");
}

export function principalFor(partnerId: string, candidate: unknown): DerivedIdentity {
  const userId = typeof candidate === "string" ? candidate.trim() : "";
  if (!userId)
    return {
      ok: false,
      problem: { status: 400, body: { error: "bad_request", message: "userId is required" } },
    };
  if (!USER_ID.test(userId))
    return {
      ok: false,
      problem: {
        status: 400,
        body: { error: "bad_request", message: `userId must match ${USER_ID.source}` },
      },
    };
  return { ok: true, userId, principalId: `${partnerId}_${userId}` };
}

export function threadRefFor(principalId: string, conversationId: string): string {
  return `web:${principalId}:${conversationId}`;
}

const ASSERTION_TTL_MS = 120_000;

export function mintPartnerAssertion(principalId: string, secret: string): string {
  return mintPortalIdentity({ p: principalId, exp: Date.now() + ASSERTION_TTL_MS }, secret);
}
