import test from "node:test";
import assert from "node:assert/strict";
import { routes } from "../src/routes/index.ts";
import {
  LIBRARY_KEY,
  LIBRARY_SCOPE,
  PRINCIPAL_ID,
  USER_ID,
  chatHeaders,
  chatToken,
  ok,
  parseSse,
  partnerHeaders,
  readSse,
  recordingCore,
  sleep,
  startGateway,
  type CoreScript,
} from "./support.ts";

const SCOPE = "group:web-project-1";

async function post(base: string, path: string, body: unknown): Promise<Response> {
  const raw = JSON.stringify(body);
  return fetch(`${base}${path}`, { method: "POST", body: raw, headers: partnerHeaders("POST", path, raw) });
}

async function chatPost(base: string, path: string, body: unknown): Promise<Response> {
  const raw = JSON.stringify(body);
  return fetch(`${base}${path}`, {
    method: "POST",
    body: raw,
    headers: { ...chatHeaders(), "content-type": "application/json" },
  });
}

async function chatGet(base: string, pathWithQuery: string): Promise<Response> {
  return fetch(`${base}${pathWithQuery}`, { headers: chatHeaders() });
}

async function withGateway(script: CoreScript | undefined, run: (base: string) => Promise<void>): Promise<void> {
  const core = recordingCore(script);
  const gateway = await startGateway(core.factory);
  try {
    await run(gateway.base);
  } finally {
    await gateway.close();
  }
}

test("the whitelist is exactly the documented routes with their body limits", () => {
  assert.deepEqual(
    routes.map((route) => `${route.method} ${route.path} ${route.limit}`),
    [
      "POST /v1/assemble 128000",
      "POST /v1/chat-sessions 4000",
      "GET /chat 0",
      "GET /chat/assets/:name 0",
      "POST /v1/turn 64000",
      "GET /v1/events 0",
      "GET /v1/sessions/:id 0",
    ],
  );
});

test("unsigned partner calls and cookie-less chat calls are refused before any core call", async () => {
  const core = recordingCore();
  const gateway = await startGateway(core.factory);
  try {
    const unsigned = await fetch(`${gateway.base}/v1/chat-sessions`, { method: "POST", body: "{}" });
    assert.equal(unsigned.status, 401);
    assert.deepEqual(await unsigned.json(), { error: "unauthorized", message: "missing x-partner-id header" });

    const noCookie = await fetch(`${gateway.base}/v1/turn`, {
      method: "POST",
      body: JSON.stringify({ scopeId: SCOPE, text: "hi" }),
    });
    assert.equal(noCookie.status, 401);
    assert.deepEqual(await noCookie.json(), { error: "unauthorized", message: "missing chat session" });

    const noAssetCookie = await fetch(`${gateway.base}/chat/assets/main.js`);
    assert.equal(noAssetCookie.status, 401);
    assert.deepEqual(await noAssetCookie.json(), { error: "unauthorized", message: "missing chat session" });

    const unknown = await post(gateway.base, "/v1/admin/grants", { userId: USER_ID });
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: "not_found", message: "no such endpoint" });

    const anonymous = await post(gateway.base, "/v1/chat-sessions", { scopeId: SCOPE });
    assert.equal(anonymous.status, 400);
    assert.deepEqual(await anonymous.json(), { error: "bad_request", message: "userId is required" });

    assert.equal(core.calls.length, 0);
  } finally {
    await gateway.close();
  }
});

test("every response carries the protocol version header", async () => {
  await withGateway(
    () => ok(200, { sessions: [] }),
    async (base) => {
      const response = await post(base, "/v1/chat-sessions", { userId: USER_ID, scopeId: SCOPE, conversationId: "c1" });
      assert.equal(response.headers.get("x-partner-protocol"), "1");
      assert.equal(response.headers.get("cache-control"), "no-store");
      await response.text();
    },
  );
});

test("chat-sessions mints a cookie token and resolves the session for the conversation", async () => {
  const core = recordingCore((call) =>
    call.path.startsWith("/v1/sessions?")
      ? ok(200, { sessions: [{ id: "s1", threadRef: `web:${PRINCIPAL_ID}:c1`, scopeId: SCOPE }] })
      : ok(200, {}),
  );
  const gateway = await startGateway(core.factory);
  try {
    const response = await post(gateway.base, "/v1/chat-sessions", {
      userId: USER_ID,
      scopeId: SCOPE,
      conversationId: "c1",
    });
    assert.equal(response.status, 200);
    const { chatUrl } = (await response.json()) as { chatUrl: string };
    const url = new URL(chatUrl, "http://gateway.local");
    assert.equal(url.pathname, "/chat");
    assert.equal(url.searchParams.get("scopeId"), SCOPE);
    assert.equal(url.searchParams.get("conversationId"), "c1");
    assert.equal(url.searchParams.get("sessionId"), "s1");
    assert.ok((url.searchParams.get("token") ?? "").includes("."), "expected a signed token");

    const badScope = await post(gateway.base, "/v1/chat-sessions", {
      userId: USER_ID,
      scopeId: `personal:${PRINCIPAL_ID}`,
      conversationId: "c1",
    });
    assert.equal(badScope.status, 400);
    assert.match(await badScope.text(), /digital employee scope/);
  } finally {
    await gateway.close();
  }
});

test("chat serves the page, sets the cookie, and rejects a bad ticket or scope", async () => {
  const gateway = await startGateway(recordingCore(() => ok(200, {})).factory);
  try {
    const token = chatToken();
    const page = await fetch(
      `${gateway.base}/chat?token=${token}&scopeId=${encodeURIComponent(SCOPE)}&conversationId=c1&sessionId=s1`,
    );
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    const setCookie = page.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /partner_chat=/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    const html = await page.text();
    assert.match(html, /data-scope-id="group:web-project-1"/);
    assert.match(html, /data-conversation-id="c1"/);
    assert.match(html, /data-session-id="s1"/);
    assert.match(html, /href="\/chat\/assets\/styles.css"/);
    assert.match(html, /src="\/chat\/assets\/main.js"/);

    const asset = await chatGet(gateway.base, "/chat/assets/main.js");
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type") ?? "", /text\/javascript/);
    assert.match(await asset.text(), /postTurn/);

    const missingAsset = await chatGet(gateway.base, "/chat/assets/missing.js");
    assert.equal(missingAsset.status, 404);

    const badTicket = await fetch(
      `${gateway.base}/chat?token=garbage&scopeId=${encodeURIComponent(SCOPE)}&conversationId=c1`,
    );
    assert.equal(badTicket.status, 401);

    const badScope = await fetch(`${gateway.base}/chat?token=${token}&scopeId=personal%3Ax&conversationId=c1`);
    assert.equal(badScope.status, 400);
  } finally {
    await gateway.close();
  }
});

test("turn builds the conversation coordinates and relays the queued run", async () => {
  const core = recordingCore((call) => {
    assert.equal(call.path, "/v1/turns?async=1");
    return ok(202, { status: "queued", runId: "run-1" });
  });
  const gateway = await startGateway(core.factory);
  try {
    const response = await chatPost(gateway.base, "/v1/turn", {
      scopeId: SCOPE,
      conversationId: "ticket-42",
      text: "hello",
      model: "claude",
      harness: "pi",
      thinkingLevel: "high",
      timezone: "Asia/Shanghai",
      principalId: "attacker",
      attachments: [{ name: "x" }],
      proactiveOpener: true,
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      status: "queued",
      runId: "run-1",
      threadRef: `web:${PRINCIPAL_ID}:ticket-42`,
    });
    assert.deepEqual(core.calls[0]?.body, {
      surface: "web",
      actor: { externalId: PRINCIPAL_ID },
      conversation: { kind: "group", channelRef: "web-project-1", threadRef: `web:${PRINCIPAL_ID}:ticket-42` },
      liveActor: true,
      deliveryTarget: `web:${PRINCIPAL_ID}:ticket-42`,
      text: "hello",
      model: "claude",
      harness: "pi",
      thinkingLevel: "high",
      timezone: "Asia/Shanghai",
    });
  } finally {
    await gateway.close();
  }
});

test("turn defaults the conversation and validates its inputs", async () => {
  const core = recordingCore(() => ok(202, { status: "queued", runId: "run-1" }));
  const gateway = await startGateway(core.factory);
  try {
    const defaulted = await chatPost(gateway.base, "/v1/turn", { scopeId: SCOPE, text: "hi" });
    assert.equal(defaulted.status, 202);
    assert.deepEqual(await defaulted.json(), {
      status: "queued",
      runId: "run-1",
      threadRef: `web:${PRINCIPAL_ID}:default`,
    });

    const personal = await chatPost(gateway.base, "/v1/turn", { scopeId: `personal:${PRINCIPAL_ID}`, text: "hi" });
    assert.equal(personal.status, 400);
    assert.match(await personal.text(), /digital employee scope/);

    const missingScope = await chatPost(gateway.base, "/v1/turn", { text: "hi" });
    assert.equal(missingScope.status, 400);

    const badConversation = await chatPost(gateway.base, "/v1/turn", {
      scopeId: SCOPE,
      conversationId: "a:b",
      text: "hi",
    });
    assert.equal(badConversation.status, 400);
    assert.match(await badConversation.text(), /conversationId must match/);

    const empty = await chatPost(gateway.base, "/v1/turn", { scopeId: SCOPE, text: "   " });
    assert.equal(empty.status, 400);
    assert.match(await empty.text(), /text is required/);

    const badApproval = await chatPost(gateway.base, "/v1/turn", {
      scopeId: SCOPE,
      text: "hi",
      approval: { requestId: "r1" },
    });
    assert.equal(badApproval.status, 400);
    assert.match(await badApproval.text(), /approval requires requestId/);

    assert.equal(core.calls.length, 1);
  } finally {
    await gateway.close();
  }
});

test("turn carries an approval receipt on its own", async () => {
  const core = recordingCore(() => ok(202, { status: "queued", runId: "run-2" }));
  const gateway = await startGateway(core.factory);
  try {
    const response = await chatPost(gateway.base, "/v1/turn", {
      scopeId: SCOPE,
      conversationId: "c1",
      approval: { requestId: "req-1", approved: true, scope: "session", extra: "dropped" },
    });
    assert.equal(response.status, 202);
    const body = core.calls[0]?.body as { text: string; approval: unknown };
    assert.equal(body.text, "");
    assert.deepEqual(body.approval, { requestId: "req-1", approved: true, scope: "session" });
  } finally {
    await gateway.close();
  }
});

test("turn relays a refusal from core as a protocol error", async () => {
  await withGateway(
    () => ok(403, { status: "refused", reason: "screened" }),
    async (base) => {
      const response = await chatPost(base, "/v1/turn", { scopeId: SCOPE, text: "hi" });
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: "refused", message: "screened" });
    },
  );
});

test("the partner signature covers the target and body exactly as sent", async () => {
  const core = recordingCore(() => ok(200, { sessions: [] }));
  const gateway = await startGateway(core.factory);
  try {
    const body = JSON.stringify({ userId: USER_ID, scopeId: SCOPE, conversationId: "c1" });
    const wrongBody = await fetch(`${gateway.base}/v1/chat-sessions`, {
      method: "POST",
      body,
      headers: partnerHeaders("POST", "/v1/chat-sessions", "{}"),
    });
    assert.equal(wrongBody.status, 401);
    assert.match(await wrongBody.text(), /signature mismatch/);

    const wrongPath = await fetch(`${gateway.base}/v1/chat-sessions`, {
      method: "POST",
      body,
      headers: partnerHeaders("POST", "/v1/assemble", body),
    });
    assert.equal(wrongPath.status, 401);
    assert.match(await wrongPath.text(), /signature mismatch/);

    assert.equal(core.calls.length, 0);
  } finally {
    await gateway.close();
  }
});

test("relayed core errors fall back to documented protocol codes", async () => {
  const core = recordingCore(() => ok(400, {}));
  const gateway = await startGateway(core.factory);
  try {
    const badTurn = await chatPost(gateway.base, "/v1/turn", { scopeId: SCOPE, text: "hi" });
    assert.equal(badTurn.status, 400);
    assert.deepEqual(await badTurn.json(), { error: "bad_request", message: "core replied 400" });
  } finally {
    await gateway.close();
  }
});

test("events stream partial then done for a run id", async () => {
  let polls = 0;
  const events = await (async () => {
    const core = recordingCore((call) => {
      assert.equal(call.path, "/v1/runs/run-1");
      polls += 1;
      if (polls === 1) return ok(200, { status: "running", partial: "", activity: [], alive: true });
      return ok(200, {
        status: "done",
        partial: "Hello",
        result: { text: "Hello" },
        activity: [{ kind: "tool", name: "bash" }],
        alive: false,
        stale: false,
        replyComplete: true,
        startedAt: 1,
        finishedAt: 2,
      });
    });
    const gateway = await startGateway(core.factory);
    try {
      return await readSse(gateway.base, "/v1/events?runId=run-1");
    } finally {
      await gateway.close();
    }
  })();

  assert.deepEqual(
    events.map((item) => item.event),
    ["partial", "activity", "done"],
  );
  assert.deepEqual(events[0]?.data, { partial: "Hello" });
  assert.deepEqual(events[1]?.data, { activity: [{ kind: "tool", name: "bash" }], startedAt: 1 });
  assert.deepEqual(events[2]?.data, {
    status: "done",
    result: { text: "Hello" },
    partial: "Hello",
    activity: [{ kind: "tool", name: "bash" }],
    replyComplete: true,
    startedAt: 1,
    finishedAt: 2,
  });
});

test("events resolve the active run from the conversation and go idle without one", async () => {
  const core = recordingCore((call) =>
    call.path.startsWith("/v1/runs?") ? ok(200, { runId: null }) : ok(200, { status: "running" }),
  );
  const gateway = await startGateway(core.factory);
  try {
    const events = await readSse(gateway.base, `/v1/events?scopeId=${encodeURIComponent(SCOPE)}&conversationId=c1`);
    assert.deepEqual(events, [{ event: "idle", data: {} }]);
    assert.equal(core.calls[0]?.path, `/v1/runs?threadRef=${encodeURIComponent(`web:${PRINCIPAL_ID}:c1`)}`);
  } finally {
    await gateway.close();
  }
});

test("events follow the active run when it exists", async () => {
  let polls = 0;
  const core = recordingCore((call) => {
    if (call.path.startsWith("/v1/runs?")) return ok(200, { runId: "run-9", queued: false });
    polls += 1;
    return ok(200, {
      status: "done",
      partial: "done",
      result: { text: "done" },
      activity: [],
      alive: false,
      replyComplete: true,
    });
  });
  const gateway = await startGateway(core.factory);
  try {
    const events = await readSse(gateway.base, `/v1/events?scopeId=${encodeURIComponent(SCOPE)}`);
    assert.deepEqual(
      events.map((item) => item.event),
      ["partial", "done"],
    );
    assert.equal(polls, 1);
  } finally {
    await gateway.close();
  }
});

test("events reject a malformed run id and a missing conversation scope", async () => {
  const core = recordingCore();
  const gateway = await startGateway(core.factory);
  try {
    const badRun = await chatGet(gateway.base, "/v1/events?runId=not%20valid");
    assert.equal(badRun.status, 400);
    assert.match(await badRun.text(), /runId must match/);

    const missingScope = await chatGet(gateway.base, "/v1/events");
    assert.equal(missingScope.status, 400);
    assert.match(await missingScope.text(), /scopeId is required/);

    assert.equal(core.calls.length, 0);
  } finally {
    await gateway.close();
  }
});

test("events stop polling once the client hangs up", async () => {
  const core = recordingCore(() => ok(200, { status: "running", partial: "", activity: [], alive: true }));
  const gateway = await startGateway(core.factory);
  try {
    const controller = new AbortController();
    const pending = fetch(`${gateway.base}/v1/events?runId=run-1`, {
      headers: chatHeaders(),
      signal: controller.signal,
    }).catch(() => null);
    await sleep(300);
    controller.abort();
    await pending;
    await sleep(300);
    const settled = core.calls.length;
    assert.ok(settled > 1, `expected repeated polling, saw ${settled}`);
    await sleep(500);
    assert.equal(core.calls.length, settled);
  } finally {
    await gateway.close();
  }
});

test("events report an unreachable core as failed", async () => {
  const core = recordingCore((call) => (call.path.startsWith("/v1/runs/") ? ok(500, {}) : ok(200, {})));
  const gateway = await startGateway(core.factory);
  try {
    const events = await readSse(gateway.base, "/v1/events?runId=run-1");
    assert.deepEqual(events, [{ event: "failed", data: { reason: "HTTP 500" } }]);
    assert.equal(core.calls.length, 2);
  } finally {
    await gateway.close();
  }
});

test("a single session returns its narrowed header and transcript", async () => {
  const core = recordingCore((call) => {
    assert.match(call.path, /^\/v1\/sessions\/s1\?/);
    return ok(200, {
      session: {
        id: "s1",
        type: "group",
        scopeId: SCOPE,
        threadRef: `web:${PRINCIPAL_ID}:c1`,
        title: "First",
        createdAt: 1,
        lastActivityAt: 5,
        archived: true,
      },
      entries: [{ seq: 1, type: "user", payload: { text: "hi" } }],
      earlierEntries: 3,
    });
  });
  const gateway = await startGateway(core.factory);
  try {
    const response = await chatGet(gateway.base, "/v1/sessions/s1?tailTurns=2");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      session: {
        id: "s1",
        type: "group",
        scopeId: SCOPE,
        threadRef: `web:${PRINCIPAL_ID}:c1`,
        title: "First",
        createdAt: 1,
        lastActivityAt: 5,
      },
      entries: [{ seq: 1, type: "user", payload: { text: "hi" } }],
      earlierEntries: 3,
    });
    const query = new URLSearchParams(core.calls[0]?.path.split("?")[1] ?? "");
    assert.equal(query.get("viewer"), PRINCIPAL_ID);
    assert.equal(query.get("tailTurns"), "2");
    assert.equal(query.get("sinceSeq"), null);
  } finally {
    await gateway.close();
  }
});

test("session detail refuses bad ids, bad windows, and unknown sessions", async () => {
  const core = recordingCore(() => ok(404, { error: "not_found" }));
  const gateway = await startGateway(core.factory);
  try {
    const badId = await chatGet(gateway.base, "/v1/sessions/not%20an%20id");
    assert.equal(badId.status, 404);
    assert.deepEqual(await badId.json(), { error: "not_found", message: "unknown session" });

    const badWindow = await chatGet(gateway.base, "/v1/sessions/s1?tailTurns=0");
    assert.equal(badWindow.status, 400);
    assert.match(await badWindow.text(), /tailTurns must be an integer >= 1/);

    const missing = await chatGet(gateway.base, "/v1/sessions/s1");
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "not_found", message: "unknown session" });

    assert.equal(core.calls.length, 1);
  } finally {
    await gateway.close();
  }
});

test("assemble is reachable end to end through the pipeline", async () => {
  let projects = 0;
  const core = recordingCore((call) => {
    if (call.path.startsWith("/v1/skills")) {
      return ok(200, {
        skills: [
          { id: "skill-writer", name: "space-xhs-writer", scopeId: LIBRARY_SCOPE, status: "active" },
          { id: "skill-title", name: "space-xhs-title", scopeId: LIBRARY_SCOPE, status: "active" },
        ],
      });
    }
    if (call.path === "/v1/projects") {
      projects += 1;
      return ok(201, { project: { id: `web-project-${projects}`, scopeId: `group:web-project-${projects}` } });
    }
    if (call.path === "/v1/grants") return ok(200, { ok: true });
    if (call.path === "/v1/soul") return ok(200, { ok: true, version: 1 });
    if (call.path === "/v1/contexts/policy") {
      const body = call.body as { orders?: string };
      return ok(200, { policy: { orders: body.orders ?? "", bots: {}, ambientEnabled: null, updatedAt: 1 } });
    }
    return ok(404, { error: "not_found" });
  });
  const gateway = await startGateway(core.factory);
  try {
    const response = await post(gateway.base, "/v1/assemble", {
      userId: USER_ID,
      name: "Support",
      library: LIBRARY_KEY,
      soul: "Be terse.",
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      employee: { id: "web-project-1", scopeId: "group:web-project-1", name: "Support" },
      granted: ["space-xhs-writer", "space-xhs-title"],
      soul: true,
      standingOrders: false,
      files: [],
    });
    assert.deepEqual(
      core.calls.map((call) => call.path.split("?")[0]),
      ["/v1/skills", "/v1/projects", "/v1/grants", "/v1/grants", "/v1/soul"],
    );
  } finally {
    await gateway.close();
  }
});

test("a body that is not JSON is refused before verification is even attempted", async () => {
  const core = recordingCore();
  const gateway = await startGateway(core.factory);
  try {
    const raw = "{not json";
    const response = await fetch(`${gateway.base}/v1/turn`, {
      method: "POST",
      body: raw,
      headers: { ...chatHeaders(), "content-type": "application/json" },
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "bad_json", message: "request body must be valid JSON" });

    const arrayBody = "[1,2]";
    const rejected = await fetch(`${gateway.base}/v1/chat-sessions`, {
      method: "POST",
      body: arrayBody,
      headers: partnerHeaders("POST", "/v1/chat-sessions", arrayBody),
    });
    assert.equal(rejected.status, 400);
    assert.match(await rejected.text(), /must be a JSON object/);
    assert.equal(core.calls.length, 0);
  } finally {
    await gateway.close();
  }
});

test("parseSse ignores comment lines", () => {
  assert.deepEqual(parseSse(": open\n\nevent: idle\ndata: {}\n\n: ping\n\n"), [{ event: "idle", data: {} }]);
});
