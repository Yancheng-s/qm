import test from "node:test";
import assert from "node:assert/strict";
import { canonicalPayload, signRequest } from "../../chassis/src/source-auth-sign.ts";
import {
  FRESHNESS_WINDOW_S,
  PARTNER_ID_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  principalFor,
  threadRefFor,
  verifySignedRequest,
  type SignedRequestInput,
} from "../src/auth.ts";
import { PARTNER_ID, PARTNER_SECRET, PARTNERS } from "./support.ts";

interface InputOverrides {
  partners?: ReadonlyMap<string, string>;
  method?: string;
  pathWithQuery?: string;
  raw?: string;
  headers?: Record<string, string>;
}

function signedHeaders(method: string, pathWithQuery: string, raw: string, timestamp: number): Record<string, string> {
  return {
    [PARTNER_ID_HEADER]: PARTNER_ID,
    [TIMESTAMP_HEADER]: String(timestamp),
    [SIGNATURE_HEADER]: signRequest(PARTNER_SECRET, timestamp, canonicalPayload(method, pathWithQuery, raw)),
  };
}

function input(overrides: InputOverrides = {}): SignedRequestInput {
  const method = overrides.method ?? "POST";
  const pathWithQuery = overrides.pathWithQuery ?? "/v1/turn";
  const raw = overrides.raw ?? "";
  const headers = overrides.headers ?? signedHeaders(method, pathWithQuery, raw, Math.floor(Date.now() / 1000));
  return {
    partners: overrides.partners ?? PARTNERS,
    method,
    pathWithQuery,
    raw,
    header: (name) => headers[name.toLowerCase()],
  };
}

function reason(found: ReturnType<typeof verifySignedRequest>): string {
  assert.equal(found.ok, false);
  if (found.ok) throw new Error("unreachable");
  assert.equal(found.problem.status, 401);
  assert.equal(found.problem.body.error, "unauthorized");
  return String(found.problem.body.message);
}

test("a correctly signed request is accepted and names the partner", () => {
  const found = verifySignedRequest(input());
  assert.deepEqual(found, { ok: true, partnerId: PARTNER_ID });
});

test("the body and the query both take part in the signature", () => {
  const raw = JSON.stringify({ userId: "u1", text: "hello" });
  const accepted = verifySignedRequest(input({ raw, pathWithQuery: "/v1/turn?trace=1" }));
  assert.equal(accepted.ok, true);

  const tamperedBody = verifySignedRequest(
    input({ raw, headers: signedHeaders("POST", "/v1/turn?trace=1", "{}", Math.floor(Date.now() / 1000)) }),
  );
  assert.equal(reason(tamperedBody), "signature mismatch");

  const tamperedQuery = verifySignedRequest(
    input({
      raw,
      pathWithQuery: "/v1/turn?trace=2",
      headers: signedHeaders("POST", "/v1/turn?trace=1", raw, Math.floor(Date.now() / 1000)),
    }),
  );
  assert.equal(reason(tamperedQuery), "signature mismatch");

  const tamperedMethod = verifySignedRequest(
    input({ method: "GET", headers: signedHeaders("POST", "/v1/turn", "", Math.floor(Date.now() / 1000)) }),
  );
  assert.equal(reason(tamperedMethod), "signature mismatch");
});

test("every verification step rejects with its own reason", () => {
  assert.equal(reason(verifySignedRequest(input({ headers: {} }))), `missing ${PARTNER_ID_HEADER} header`);
  assert.equal(
    reason(
      verifySignedRequest(
        input({
          headers: {
            [PARTNER_ID_HEADER]: "nobody",
            [TIMESTAMP_HEADER]: "1",
            [SIGNATURE_HEADER]: "v0=deadbeef",
          },
        }),
      ),
    ),
    "unknown partner",
  );
  assert.equal(
    reason(verifySignedRequest(input({ headers: { [PARTNER_ID_HEADER]: PARTNER_ID } }))),
    "missing signature (unsigned request)",
  );
  assert.equal(
    reason(
      verifySignedRequest(
        input({
          headers: {
            [PARTNER_ID_HEADER]: PARTNER_ID,
            [TIMESTAMP_HEADER]: "not-a-number",
            [SIGNATURE_HEADER]: "v0=deadbeef",
          },
        }),
      ),
    ),
    "invalid timestamp",
  );

  const stale = Math.floor(Date.now() / 1000) - FRESHNESS_WINDOW_S - 1;
  assert.equal(
    reason(verifySignedRequest(input({ headers: signedHeaders("POST", "/v1/turn", "", stale) }))),
    `timestamp outside the ${FRESHNESS_WINDOW_S}s freshness window`,
  );

  const future = Math.floor(Date.now() / 1000) + FRESHNESS_WINDOW_S + 1;
  assert.equal(
    reason(verifySignedRequest(input({ headers: signedHeaders("POST", "/v1/turn", "", future) }))),
    `timestamp outside the ${FRESHNESS_WINDOW_S}s freshness window`,
  );

  assert.equal(
    reason(
      verifySignedRequest(
        input({
          headers: {
            [PARTNER_ID_HEADER]: PARTNER_ID,
            [TIMESTAMP_HEADER]: String(Math.floor(Date.now() / 1000)),
            [SIGNATURE_HEADER]: signRequest("a-different-secret-0123456789abcdef", 1, "x"),
          },
        }),
      ),
    ),
    "signature mismatch",
  );
});

test("an unknown partner is rejected even with a well-formed signature", () => {
  const found = verifySignedRequest(input({ partners: new Map([["other", PARTNER_SECRET]]) }));
  assert.equal(reason(found), "unknown partner");
});

test("principalFor derives partnerId_userId and refuses anything else", () => {
  assert.deepEqual(principalFor(PARTNER_ID, "u1"), { ok: true, userId: "u1", principalId: "acme_u1" });
  assert.deepEqual(principalFor(PARTNER_ID, "  u-2_A  "), { ok: true, userId: "u-2_A", principalId: "acme_u-2_A" });

  for (const candidate of [undefined, null, "", "   ", 42, {}, "a:b", "a/b", "甲", "u".repeat(65)]) {
    const found = principalFor(PARTNER_ID, candidate);
    assert.equal(found.ok, false, `expected ${JSON.stringify(candidate)} to be refused`);
    if (found.ok) continue;
    assert.equal(found.problem.status, 400);
    assert.equal(found.problem.body.error, "bad_request");
  }

  assert.deepEqual(principalFor("beta", "u1"), { ok: true, userId: "u1", principalId: "beta_u1" });
});

test("the derivation is injective because a partner id cannot contain the separator", () => {
  const derived = new Map<string, string>();
  for (const partnerId of ["acme", "acme-x", "a", "beta"])
    for (const userId of ["u1", "x_y", "y", "a_b_c", "U-1"]) {
      const found = principalFor(partnerId, userId);
      assert.equal(found.ok, true);
      if (!found.ok) continue;
      const previous = derived.get(found.principalId);
      assert.equal(previous, undefined, `${found.principalId} collides with ${previous ?? ""}`);
      derived.set(found.principalId, `${partnerId}/${userId}`);
      assert.equal(found.principalId.indexOf("_"), partnerId.length);
    }
});

test("threadRefFor namespaces the conversation under the principal", () => {
  assert.equal(threadRefFor("acme_u1", "default"), "web:acme_u1:default");
  assert.equal(threadRefFor("acme_u1", "ticket-42"), "web:acme_u1:ticket-42");
});
