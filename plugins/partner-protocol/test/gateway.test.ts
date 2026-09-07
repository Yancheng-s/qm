import test from "node:test";
import assert from "node:assert/strict";
import { verifyPortalIdentity } from "../../chassis/src/portal-identity.ts";
import { bootProblems, readConfig } from "../src/config.ts";
import {
  CREDENTIALS,
  IDENTITY_SECRET,
  PARTNER_ID,
  PARTNER_SECRET,
  PRINCIPAL_ID,
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
  const cfg = readConfig({
    ...secrets,
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

  const blank = readConfig({ ...secrets, CORE_API_URL: "/", PARTNER_CREDENTIALS: CREDENTIALS });
  assert.deepEqual(bootProblems(blank), ["CORE_API_URL is required (core base url, e.g. http://localhost:8081)"]);

  const defaults = readConfig({ ...secrets, CORE_API_URL: "http://core.local", PARTNER_CREDENTIALS: CREDENTIALS });
  assert.equal(defaults.port, 8211);
  assert.equal(defaults.ratePerMin, 120);
  assert.deepEqual(bootProblems(defaults), []);

  const derived = readConfig({
    CORE_SIGNING_SECRET: SIGNING_SECRET,
    CORE_API_URL: "http://core.local",
    PARTNER_CREDENTIALS: CREDENTIALS,
  });
  assert.equal(derived.signingSecret, SIGNING_SECRET);
  assert.ok(derived.identitySecret.length > 0, "the identity secret must fall back to the signing secret");
  assert.deepEqual(bootProblems(derived), []);
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
});

test("the whole protocol closes against a stub core", async () => {
  const core = await startStubCore();
  try {
    await withGateway({ CORE_API_URL: core.url }, async (base, banner) => {
      assert.match(banner, /partners acme/);
      assert.doesNotMatch(banner, new RegExp(PARTNER_SECRET));

      const health = await fetch(`${base}/healthz`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { ok: true });

      const unsigned = await fetch(`${base}/v1/employees?userId=${USER_ID}`);
      assert.equal(unsigned.status, 401);

      const unknown = await fetch(`${base}/v1/nope?userId=${USER_ID}`, {
        headers: partnerHeaders("GET", `/v1/nope?userId=${USER_ID}`),
      });
      assert.equal(unknown.status, 404);

      const assembleBody = JSON.stringify({
        userId: USER_ID,
        name: "Support",
        skills: [{ name: "triage", description: "sorts tickets", body: "# triage\n" }],
        soul: "Be terse.",
      });
      const assembled = await fetch(`${base}/v1/assemble`, {
        method: "POST",
        body: assembleBody,
        headers: partnerHeaders("POST", "/v1/assemble", assembleBody),
      });
      assert.equal(assembled.status, 201);
      assert.deepEqual(await assembled.json(), {
        employee: { id: "web-project-1", scopeId: "group:web-project-1", name: "Support" },
        skills: [{ name: "triage", ok: true }],
        soul: true,
        standingOrders: false,
      });

      const outbound = core.calls.find((call) => call.path === "/v1/projects" && call.method === "POST");
      assert.ok(outbound, "expected a project creation call");
      assert.ok(outbound.headers["x-signature"]?.startsWith("v0="), "expected a source-auth signature");
      assert.ok(outbound.headers["x-timestamp"], "expected a source-auth timestamp");
      const claims = verifyPortalIdentity(outbound.headers["x-portal-identity"] ?? "", IDENTITY_SECRET, Date.now());
      assert.equal(claims?.p, PRINCIPAL_ID);

      const turnBody = JSON.stringify({
        userId: USER_ID,
        scopeId: "group:web-project-1",
        conversationId: "c1",
        text: "hello",
      });
      const turn = await fetch(`${base}/v1/turn`, {
        method: "POST",
        body: turnBody,
        headers: partnerHeaders("POST", "/v1/turn", turnBody),
      });
      assert.equal(turn.status, 202);
      assert.deepEqual(await turn.json(), {
        status: "queued",
        runId: "run-1",
        threadRef: `web:${PRINCIPAL_ID}:c1`,
      });

      const events = await fetch(`${base}/v1/events?userId=${USER_ID}&runId=run-1`, {
        headers: partnerHeaders("GET", `/v1/events?userId=${USER_ID}&runId=run-1`),
      });
      assert.equal(events.status, 200);
      assert.match(events.headers.get("content-type") ?? "", /text\/event-stream/);
      const stream = await events.text();
      assert.match(stream, /event: partial\ndata: \{"partial":"Hello back"\}/);
      assert.match(stream, /event: done\n/);

      const listed = await fetch(`${base}/v1/sessions?userId=${USER_ID}`, {
        headers: partnerHeaders("GET", `/v1/sessions?userId=${USER_ID}`),
      });
      assert.equal(listed.status, 200);
      assert.deepEqual(await listed.json(), {
        sessions: [
          {
            id: "s1",
            type: "group",
            scopeId: "group:web-project-1",
            threadRef: `web:${PRINCIPAL_ID}:c1`,
            title: "First",
            createdAt: 1,
            lastActivityAt: 2,
          },
        ],
      });

      const detail = await fetch(`${base}/v1/sessions/s1?userId=${USER_ID}`, {
        headers: partnerHeaders("GET", `/v1/sessions/s1?userId=${USER_ID}`),
      });
      assert.equal(detail.status, 200);
      const detailBody = (await detail.json()) as { entries: unknown[] };
      assert.deepEqual(detailBody.entries, [{ seq: 1, type: "user", payload: { text: "hi" } }]);

      const employees = await fetch(`${base}/v1/employees?userId=${USER_ID}`, {
        headers: partnerHeaders("GET", `/v1/employees?userId=${USER_ID}`),
      });
      assert.equal(employees.status, 200);
      assert.deepEqual(await employees.json(), {
        employees: [{ id: "web-project-1", name: "Support", scopeId: "group:web-project-1", createdAt: 1 }],
      });

      assert.ok(
        core.calls.every((call) => !call.path.includes("admin")),
        "the gateway must never touch an admin endpoint",
      );
    });
  } finally {
    await core.close();
  }
});

test("the partner quota answers 429 with a retry-after", async () => {
  const core = await startStubCore();
  try {
    await withGateway({ CORE_API_URL: core.url, PARTNER_RATE_LIMIT_PER_MIN: "1" }, async (base) => {
      const pathWithQuery = `/v1/employees?userId=${USER_ID}`;
      const first = await fetch(`${base}${pathWithQuery}`, { headers: partnerHeaders("GET", pathWithQuery) });
      assert.equal(first.status, 200);
      await first.text();

      const second = await fetch(`${base}${pathWithQuery}`, { headers: partnerHeaders("GET", pathWithQuery) });
      assert.equal(second.status, 429);
      assert.ok(Number(second.headers.get("retry-after")) >= 1);
      const body = (await second.json()) as { error: string; retryAfter: number };
      assert.equal(body.error, "rate_limited");
      assert.ok(body.retryAfter >= 1);

      const otherUser = `/v1/employees?userId=u2`;
      const alsoLimited = await fetch(`${base}${otherUser}`, { headers: partnerHeaders("GET", otherUser) });
      assert.equal(alsoLimited.status, 429);
      await alsoLimited.text();
    });
  } finally {
    await core.close();
  }
});
