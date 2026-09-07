import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { routes } from "../src/routes/index.ts";
import {
  PRINCIPAL_ID,
  USER_ID,
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

async function get(base: string, pathWithQuery: string): Promise<Response> {
  return fetch(`${base}${pathWithQuery}`, { headers: partnerHeaders("GET", pathWithQuery) });
}

function rawGet(base: string, path: string, signedPath = path): Promise<{ status: number; body: string }> {
  const origin = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: origin.hostname, port: origin.port, method: "GET", path, headers: partnerHeaders("GET", signedPath) },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end();
  });
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

test("the whitelist is exactly the seven documented endpoints with their body limits", () => {
  assert.deepEqual(
    routes.map((route) => `${route.method} ${route.path} ${route.limit}`),
    [
      "GET /v1/employees 0",
      "POST /v1/assemble 512000",
      "POST /v1/skills 160000",
      "POST /v1/turn 64000",
      "GET /v1/events 0",
      "GET /v1/sessions 0",
      "GET /v1/sessions/:id 0",
    ],
  );
});

test("unsigned, unknown, and identity-less requests are refused before any core call", async () => {
  const core = recordingCore();
  const gateway = await startGateway(core.factory);
  try {
    const unsigned = await fetch(`${gateway.base}/v1/employees?userId=${USER_ID}`);
    assert.equal(unsigned.status, 401);
    assert.deepEqual(await unsigned.json(), {
      error: "unauthorized",
      message: "missing x-partner-id header",
    });

    const unknown = await get(gateway.base, `/v1/admin/grants?userId=${USER_ID}`);
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: "not_found", message: "no such endpoint" });

    const wrongMethod = await post(gateway.base, "/v1/employees", { userId: USER_ID });
    assert.equal(wrongMethod.status, 404);

    const anonymous = await get(gateway.base, "/v1/employees");
    assert.equal(anonymous.status, 400);
    assert.deepEqual(await anonymous.json(), { error: "bad_request", message: "userId is required" });

    const colon = await get(gateway.base, "/v1/employees?userId=a%3Ab");
    assert.equal(colon.status, 400);

    assert.equal(core.calls.length, 0);
  } finally {
    await gateway.close();
  }
});

test("every response carries the protocol version header", async () => {
  await withGateway(
    () => ok(200, { projects: [] }),
    async (base) => {
      const response = await get(base, `/v1/employees?userId=${USER_ID}`);
      assert.equal(response.headers.get("x-partner-protocol"), "1");
      assert.equal(response.headers.get("cache-control"), "no-store");
    },
  );
});

test("employees are narrowed to id, name, scopeId and createdAt", async () => {
  const core = recordingCore(() =>
    ok(200, {
      projects: [
        {
          id: "web-project-1",
          orgId: "acme",
          name: "Support",
          ownerId: PRINCIPAL_ID,
          memberIds: [PRINCIPAL_ID],
          members: [{ id: PRINCIPAL_ID, role: "owner" }],
          scopeId: SCOPE,
          createdAt: 1700000000000,
          updatedAt: 1700000000001,
        },
      ],
    }),
  );
  const gateway = await startGateway(core.factory);
  try {
    const response = await get(gateway.base, `/v1/employees?userId=${USER_ID}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      employees: [{ id: "web-project-1", name: "Support", scopeId: SCOPE, createdAt: 1700000000000 }],
    });
    assert.deepEqual(
      core.calls.map((call) => [call.method, call.path, call.principalId]),
      [["GET", `/v1/projects?principalId=${PRINCIPAL_ID}`, PRINCIPAL_ID]],
    );
  } finally {
    await gateway.close();
  }
});

test("a core failure surfaces as upstream_error with the upstream status", async () => {
  await withGateway(
    () => ok(403, { error: "forbidden" }),
    async (base) => {
      const response = await get(base, `/v1/employees?userId=${USER_ID}`);
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), {
        error: "upstream_error",
        message: "employee listing failed",
        upstream: { status: 403, error: "forbidden" },
      });
    },
  );
});

test("turn builds the conversation coordinates and relays the queued run", async () => {
  const core = recordingCore((call) => {
    assert.equal(call.path, "/v1/turns?async=1");
    return ok(202, { status: "queued", runId: "run-1" });
  });
  const gateway = await startGateway(core.factory);
  try {
    const response = await post(gateway.base, "/v1/turn", {
      userId: USER_ID,
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
    const defaulted = await post(gateway.base, "/v1/turn", { userId: USER_ID, scopeId: SCOPE, text: "hi" });
    assert.equal(defaulted.status, 202);
    assert.deepEqual(await defaulted.json(), {
      status: "queued",
      runId: "run-1",
      threadRef: `web:${PRINCIPAL_ID}:default`,
    });

    const personal = await post(gateway.base, "/v1/turn", {
      userId: USER_ID,
      scopeId: `personal:${PRINCIPAL_ID}`,
      text: "hi",
    });
    assert.equal(personal.status, 400);
    assert.match(await personal.text(), /digital employee scope/);

    const missingScope = await post(gateway.base, "/v1/turn", { userId: USER_ID, text: "hi" });
    assert.equal(missingScope.status, 400);

    const badConversation = await post(gateway.base, "/v1/turn", {
      userId: USER_ID,
      scopeId: SCOPE,
      conversationId: "a:b",
      text: "hi",
    });
    assert.equal(badConversation.status, 400);
    assert.match(await badConversation.text(), /conversationId must match/);

    const empty = await post(gateway.base, "/v1/turn", { userId: USER_ID, scopeId: SCOPE, text: "   " });
    assert.equal(empty.status, 400);
    assert.match(await empty.text(), /text is required/);

    const badApproval = await post(gateway.base, "/v1/turn", {
      userId: USER_ID,
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
    const response = await post(gateway.base, "/v1/turn", {
      userId: USER_ID,
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
      const response = await post(base, "/v1/turn", { userId: USER_ID, scopeId: SCOPE, text: "hi" });
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: "refused", message: "screened" });
    },
  );
});

test("skills are created in the employee scope and conflicts are relayed", async () => {
  const core = recordingCore((call) => {
    const body = call.body as { name?: string };
    return body.name === "dup"
      ? ok(409, { error: "exists", message: "a skill of that name already exists here" })
      : ok(201, {
          skill: { id: "skill-1", name: body.name, description: "d", body: "b", status: "draft", version: 1 },
        });
  });
  const gateway = await startGateway(core.factory);
  try {
    const created = await post(gateway.base, "/v1/skills", {
      userId: USER_ID,
      scopeId: SCOPE,
      name: "fresh",
      description: "does things",
      body: "# fresh\n",
    });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { skill: { id: "skill-1", name: "fresh" } });
    assert.deepEqual(core.calls[0]?.body, {
      principalId: PRINCIPAL_ID,
      scopeId: SCOPE,
      name: "fresh",
      description: "does things",
      body: "# fresh\n",
    });

    const conflict = await post(gateway.base, "/v1/skills", {
      userId: USER_ID,
      scopeId: SCOPE,
      name: "dup",
      description: "does things",
      body: "# dup\n",
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), {
      error: "exists",
      message: "a skill of that name already exists here",
    });

    const forbidden = await post(gateway.base, "/v1/skills", {
      userId: USER_ID,
      scopeId: "org:acme",
      name: "nope",
      description: "d",
      body: "b",
    });
    assert.equal(forbidden.status, 400);
  } finally {
    await gateway.close();
  }
});

test("the signature covers the request target exactly as it arrived on the wire", async () => {
  const core = recordingCore(() => ok(200, { projects: [] }));
  const gateway = await startGateway(core.factory);
  try {
    const dotted = await rawGet(gateway.base, `/v1/employees/../employees?userId=${USER_ID}`);
    assert.equal(dotted.status, 200, dotted.body);
    assert.deepEqual(JSON.parse(dotted.body) as unknown, { employees: [] });
    assert.equal(core.calls[0]?.path, `/v1/projects?principalId=${PRINCIPAL_ID}`);

    const tampered = await rawGet(
      gateway.base,
      `/v1/employees?userId=${USER_ID}&extra=1`,
      `/v1/employees?userId=${USER_ID}`,
    );
    assert.equal(tampered.status, 401);
    assert.match(tampered.body, /signature mismatch/);
    assert.equal(core.calls.length, 1);
  } finally {
    await gateway.close();
  }
});

test("relayed core errors fall back to documented protocol codes", async () => {
  const core = recordingCore((call) => {
    if (call.path === "/v1/skills") {
      const body = call.body as { name?: string };
      return body.name === "clash" ? ok(409, {}) : ok(403, {});
    }
    return ok(400, {});
  });
  const gateway = await startGateway(core.factory);
  try {
    const forbidden = await post(gateway.base, "/v1/skills", {
      userId: USER_ID,
      scopeId: SCOPE,
      name: "nope",
      description: "d",
      body: "b",
    });
    assert.equal(forbidden.status, 403);
    assert.deepEqual(await forbidden.json(), { error: "forbidden", message: "core replied 403" });

    const clash = await post(gateway.base, "/v1/skills", {
      userId: USER_ID,
      scopeId: SCOPE,
      name: "clash",
      description: "d",
      body: "b",
    });
    assert.equal(clash.status, 409);
    assert.deepEqual(await clash.json(), { error: "exists", message: "core replied 409" });

    const badTurn = await post(gateway.base, "/v1/turn", { userId: USER_ID, scopeId: SCOPE, text: "hi" });
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
      return await readSse(gateway.base, `/v1/events?userId=${USER_ID}&runId=run-1`);
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
    const pathWithQuery = `/v1/events?userId=${USER_ID}&scopeId=${encodeURIComponent(SCOPE)}&conversationId=c1`;
    const events = await readSse(gateway.base, pathWithQuery);
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
    const events = await readSse(gateway.base, `/v1/events?userId=${USER_ID}&scopeId=${encodeURIComponent(SCOPE)}`);
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
    const badRun = await get(gateway.base, `/v1/events?userId=${USER_ID}&runId=not%20valid`);
    assert.equal(badRun.status, 400);
    assert.match(await badRun.text(), /runId must match/);

    const missingScope = await get(gateway.base, `/v1/events?userId=${USER_ID}`);
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
    const pathWithQuery = `/v1/events?userId=${USER_ID}&runId=run-1`;
    const controller = new AbortController();
    const pending = fetch(`${gateway.base}${pathWithQuery}`, {
      headers: partnerHeaders("GET", pathWithQuery),
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
    const events = await readSse(gateway.base, `/v1/events?userId=${USER_ID}&runId=run-1`);
    assert.deepEqual(events, [{ event: "failed", data: { reason: "HTTP 500" } }]);
    assert.equal(core.calls.length, 2);
  } finally {
    await gateway.close();
  }
});

test("sessions are narrowed and can be filtered by employee scope", async () => {
  const listed = [
    {
      id: "s1",
      type: "group",
      scopeId: SCOPE,
      threadRef: `web:${PRINCIPAL_ID}:c1`,
      surface: "web",
      title: "First",
      createdAt: 1,
      lastActivityAt: 5,
      working: true,
      awaitingInput: false,
      archived: true,
      pinned: true,
      color: "red",
      hasEntries: true,
    },
    {
      id: "s2",
      type: "group",
      scopeId: "group:web-project-2",
      threadRef: `web:${PRINCIPAL_ID}:c2`,
      title: null,
      createdAt: 2,
    },
  ];
  const core = recordingCore(() => ok(200, { sessions: listed }));
  const gateway = await startGateway(core.factory);
  try {
    const all = await get(gateway.base, `/v1/sessions?userId=${USER_ID}`);
    assert.equal(all.status, 200);
    assert.deepEqual(await all.json(), {
      sessions: [
        {
          id: "s1",
          type: "group",
          scopeId: SCOPE,
          threadRef: `web:${PRINCIPAL_ID}:c1`,
          title: "First",
          createdAt: 1,
          lastActivityAt: 5,
          working: true,
          awaitingInput: false,
        },
        {
          id: "s2",
          type: "group",
          scopeId: "group:web-project-2",
          threadRef: `web:${PRINCIPAL_ID}:c2`,
          title: null,
          createdAt: 2,
        },
      ],
    });

    const filtered = await get(gateway.base, `/v1/sessions?userId=${USER_ID}&scopeId=${encodeURIComponent(SCOPE)}`);
    const narrowed = (await filtered.json()) as { sessions: { id: string }[] };
    assert.deepEqual(
      narrowed.sessions.map((session) => session.id),
      ["s1"],
    );

    const rejected = await get(gateway.base, `/v1/sessions?userId=${USER_ID}&scopeId=personal%3Aacme_u1`);
    assert.equal(rejected.status, 400);
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
    const response = await get(gateway.base, `/v1/sessions/s1?userId=${USER_ID}&tailTurns=2`);
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
    const badId = await get(gateway.base, `/v1/sessions/not%20an%20id?userId=${USER_ID}`);
    assert.equal(badId.status, 404);
    assert.deepEqual(await badId.json(), { error: "not_found", message: "unknown session" });

    const traversal = await get(gateway.base, `/v1/sessions/a/b?userId=${USER_ID}`);
    assert.equal(traversal.status, 404);

    const badWindow = await get(gateway.base, `/v1/sessions/s1?userId=${USER_ID}&tailTurns=0`);
    assert.equal(badWindow.status, 400);
    assert.match(await badWindow.text(), /tailTurns must be an integer >= 1/);

    const missing = await get(gateway.base, `/v1/sessions/s1?userId=${USER_ID}`);
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
    if (call.path === "/v1/projects") {
      projects += 1;
      return ok(201, { project: { id: `web-project-${projects}`, scopeId: `group:web-project-${projects}` } });
    }
    if (call.path === "/v1/skills") return ok(201, { skill: { id: "skill-1", name: "one" } });
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
      skills: [{ name: "one", description: "d", body: "b" }],
      soul: "Be terse.",
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      employee: { id: "web-project-1", scopeId: "group:web-project-1", name: "Support" },
      skills: [{ name: "one", ok: true }],
      soul: true,
      standingOrders: false,
    });
    assert.deepEqual(
      core.calls.map((call) => call.path),
      ["/v1/projects", "/v1/skills", "/v1/soul"],
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
      headers: partnerHeaders("POST", "/v1/turn", raw),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "bad_json", message: "request body must be valid JSON" });

    const arrayBody = "[1,2]";
    const rejected = await fetch(`${gateway.base}/v1/turn`, {
      method: "POST",
      body: arrayBody,
      headers: partnerHeaders("POST", "/v1/turn", arrayBody),
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
