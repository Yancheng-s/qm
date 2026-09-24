import test from "node:test";
import assert from "node:assert/strict";
import { bootProblems, readConfig } from "../src/config.ts";
import {
  CREDENTIALS,
  IDENTITY_SECRET,
  LIBRARY_PRINCIPAL,
  PARTNER_ID,
  PARTNER_SECRET,
  SIGNING_SECRET,
  USER_ID,
  VALID_ENV,
  exitOutput,
  partnerHeaders,
  startStubCore,
  withGateway,
  without,
} from "./support.ts";

test("config parsing keeps secrets out of the partner table and reports every problem at once", () => {
  const secrets = { CORE_SIGNING_SECRET: SIGNING_SECRET, PORTAL_IDENTITY_SECRET: IDENTITY_SECRET };
  const library = { LIBRARY_URLS: VALID_ENV.LIBRARY_URLS, LIBRARY_PRINCIPAL: LIBRARY_PRINCIPAL };
  const cfg = readConfig({
    ...secrets,
    ...library,
    PORT: "8300",
    CORE_API_URL: "http://core.local:8081/",
    PARTNER_CREDENTIALS: ` ${PARTNER_ID}=${PARTNER_SECRET} , beta=${"b".repeat(32)} , `,
    PARTNER_RATE_LIMIT_PER_MIN: "0",
  });
  assert.deepEqual(bootProblems(cfg), []);
  assert.equal(cfg.port, 8300);
  assert.equal(cfg.coreApiUrl, "http://core.local:8081");
  assert.equal(cfg.ratePerMin, 0);
  assert.deepEqual([...cfg.partners.keys()], [PARTNER_ID, "beta"]);
  assert.deepEqual([...cfg.pluginSources.keys()], ["card"]);
  assert.equal(cfg.libraryPrincipalId, LIBRARY_PRINCIPAL);

  const blank = readConfig({ ...secrets, ...library, CORE_API_URL: "/", PARTNER_CREDENTIALS: CREDENTIALS });
  assert.deepEqual(bootProblems(blank), ["CORE_API_URL is required (core base url, e.g. http://localhost:8081)"]);

  const defaults = readConfig({
    ...secrets,
    ...library,
    CORE_API_URL: "http://core.local",
    PARTNER_CREDENTIALS: CREDENTIALS,
  });
  assert.equal(defaults.port, 8211);
  assert.equal(defaults.ratePerMin, 120);
  assert.equal(defaults.partnerWebRedirectUrl, "http://localhost:8129/");
  assert.equal(defaults.portalUrl, "http://localhost:8129");
  assert.deepEqual(bootProblems(defaults), []);

  const derived = readConfig({
    CORE_SIGNING_SECRET: SIGNING_SECRET,
    CORE_API_URL: "http://core.local",
    PARTNER_CREDENTIALS: CREDENTIALS,
    ...library,
  });
  assert.equal(derived.signingSecret, SIGNING_SECRET);
  assert.ok(derived.identitySecret.length > 0, "the identity secret must fall back to the signing secret");
  assert.deepEqual(bootProblems(derived), []);

  const noLibrary = readConfig({ ...secrets, CORE_API_URL: "http://core.local", PARTNER_CREDENTIALS: CREDENTIALS });
  assert.deepEqual(bootProblems(noLibrary), [
    "LIBRARY_URLS is required",
    "LIBRARY_PRINCIPAL is required",
  ]);

  const badLibrary = readConfig({
    ...secrets,
    CORE_API_URL: "http://core.local",
    PARTNER_CREDENTIALS: CREDENTIALS,
    LIBRARY_URLS: "not-json",
    LIBRARY_PRINCIPAL: LIBRARY_PRINCIPAL,
  });
  const problems = bootProblems(badLibrary);
  assert.ok(problems.some((item) => /LIBRARY_URLS must be a JSON mapping/.test(item)));
});

test("the gateway refuses to start when it is misconfigured", async () => {
  const empty = await exitOutput(without(VALID_ENV, "PARTNER_CREDENTIALS"));
  assert.notEqual(empty.code, 0);
  assert.match(empty.logged, /PARTNER_CREDENTIALS is required/);
  assert.match(empty.logged, /partner-protocol refusing to start: 1 misconfiguration/);

  const noSecret = await exitOutput(without(VALID_ENV, "CORE_SIGNING_SECRET", "PORTAL_IDENTITY_SECRET"));
  assert.notEqual(noSecret.code, 0);
  assert.match(noSecret.logged, /CORE_SIGNING_SECRET is required/);
  assert.match(noSecret.logged, /PORTAL_IDENTITY_SECRET or CORE_SIGNING_SECRET is required/);
  assert.match(noSecret.logged, /refusing to start: 2 misconfiguration/);

  const badCredentials = await exitOutput({
    ...VALID_ENV,
    PARTNER_CREDENTIALS: [
      "ACME=01234567890123456789012345678901",
      "acme_x=01234567890123456789012345678901",
      "beta=short",
      "beta=01234567890123456789012345678901",
      "beta=11234567890123456789012345678901",
      "gamma=01234567890123456789012345678901",
      "noseparator",
    ].join(","),
  });
  assert.notEqual(badCredentials.code, 0);
  assert.match(badCredentials.logged, /id "ACME" must match/);
  assert.match(badCredentials.logged, /id "acme_x" must match/);
  assert.match(badCredentials.logged, /secret for "beta" must be at least 32 characters/);
  assert.match(badCredentials.logged, /binds "beta" twice/);
  assert.match(badCredentials.logged, /gives "gamma" the same secret as "beta"/);
  assert.match(badCredentials.logged, /secret for "noseparator" must be at least 32 characters/);
  assert.match(badCredentials.logged, /refusing to start: 6 misconfiguration/);

  const badRate = await exitOutput({ ...VALID_ENV, PARTNER_RATE_LIMIT_PER_MIN: "lots" });
  assert.notEqual(badRate.code, 0);
  assert.match(badRate.logged, /PARTNER_RATE_LIMIT_PER_MIN must be an integer/);

  const noLibrary = await exitOutput(without(VALID_ENV, "LIBRARY_URLS", "LIBRARY_PRINCIPAL"));
  assert.notEqual(noLibrary.code, 0);
  assert.match(noLibrary.logged, /LIBRARY_URLS is required/);
  assert.match(noLibrary.logged, /LIBRARY_PRINCIPAL is required/);
  assert.match(noLibrary.logged, /refusing to start: 2 misconfiguration/);
});

test("the partner quota answers 429 with a retry-after", async () => {
  const core = await startStubCore();
  try {
    await withGateway({ CORE_API_URL: core.url, PARTNER_RATE_LIMIT_PER_MIN: "1" }, async (base) => {
      const path = "/v1/chat-sessions";
      const body = JSON.stringify({ userId: USER_ID, scopeId: "group:web-project-1", conversationId: "c1" });
      const first = await fetch(`${base}${path}`, {
        method: "POST",
        body,
        headers: partnerHeaders("POST", path, body),
      });
      assert.equal(first.status, 200);
      await first.text();

      const second = await fetch(`${base}${path}`, {
        method: "POST",
        body,
        headers: partnerHeaders("POST", path, body),
      });
      assert.equal(second.status, 429);
      assert.ok(Number(second.headers.get("retry-after")) >= 1);
      const secondBody = (await second.json()) as { error: string; retryAfter: number };
      assert.equal(secondBody.error, "rate_limited");
      assert.ok(secondBody.retryAfter >= 1);

      const otherBody = JSON.stringify({ userId: "u2", scopeId: "group:web-project-1", conversationId: "c1" });
      const alsoLimited = await fetch(`${base}${path}`, {
        method: "POST",
        body: otherBody,
        headers: partnerHeaders("POST", path, otherBody),
      });
      assert.equal(alsoLimited.status, 429);
      await alsoLimited.text();
    });
  } finally {
    await core.close();
  }
});
