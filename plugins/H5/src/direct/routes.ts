import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { json } from "../../../chassis/src/http.ts";
import type { RouteShape } from "../../../chassis/src/router.ts";
import { coreFetch, coreFetchCap, relayResponse, sseEvent, sleep, type CoreDeps, type HttpMethod } from "./core.ts";

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  user: string;
  orgId: string;
  body: Record<string, unknown>;
  deps: CoreDeps;
}

export type Route = { handle: (c: Ctx) => Promise<void> | void } & RouteShape;

const enc = encodeURIComponent;

const SSE_CORE_POLL_MS = 100;
const SSE_STALE_POLL_MS = 1_000;
const SSE_IDLE_MS = 6 * 60_000;
const SSE_STALE_GRACE_MS = 10 * 60_000;
const SSE_HEARTBEAT_MS = 15_000;

function strField(b: Record<string, unknown>, k: string): string | undefined {
  const v = b[k];
  return typeof v === "string" ? v : undefined;
}

function boolField(b: Record<string, unknown>, k: string): boolean | undefined {
  const v = b[k];
  return typeof v === "boolean" ? v : undefined;
}

function pickStrings(b: Record<string, unknown>, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = b[k];
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function relayGet(pathFn: (c: Ctx) => string): (c: Ctx) => Promise<void> {
  return async (c) => {
    await relayResponse(c.res, await coreFetch(c.deps, "GET", pathFn(c)));
  };
}

function relaySend(
  method: HttpMethod,
  pathFn: (c: Ctx) => string,
  bodyFn: (c: Ctx) => unknown,
): (c: Ctx) => Promise<void> {
  return async (c) => {
    await relayResponse(c.res, await coreFetch(c.deps, method, pathFn(c), JSON.stringify(bodyFn(c))));
  };
}

function relaySendNoBody(method: HttpMethod, pathFn: (c: Ctx) => string): (c: Ctx) => Promise<void> {
  return async (c) => {
    await relayResponse(c.res, await coreFetch(c.deps, method, pathFn(c)));
  };
}

function relayCap(
  method: HttpMethod,
  pathFn: (c: Ctx) => string,
  bodyFn?: (c: Ctx) => unknown,
): (c: Ctx) => Promise<void> {
  return async (c) => {
    const raw = bodyFn ? JSON.stringify(bodyFn(c)) : "";
    await relayResponse(c.res, await coreFetchCap(c.deps, method, pathFn(c), raw));
  };
}

function handleMe(c: Ctx): void {
  json(c.res, 200, { user: c.user, org: c.orgId, mode: "direct" });
}

interface Conversation {
  kind: "dm" | "channel" | "group";
  threadRef: string;
  channelRef?: string;
  channelName?: string;
}

function conversationForScope(
  user: string,
  threadRef: string,
  scope: string | undefined,
  channelName: string | undefined,
): Conversation | null {
  if (!scope || scope === `personal:${user}`) return { kind: "dm", threadRef };
  const sep = scope.indexOf(":");
  const kind = scope.slice(0, sep);
  const ref = scope.slice(sep + 1);
  if ((kind !== "channel" && kind !== "group") || !ref) return null;
  return { kind, channelRef: ref, threadRef, ...(channelName ? { channelName } : {}) };
}

interface CoreAttachment {
  name: string;
  mimetype: string;
  sizeBytes: number;
  blobId: string;
}

async function handleTurn(c: Ctx): Promise<void> {
  const b = c.body;
  const ownPrefix = `web:${c.user}:`;
  const text = typeof b.text === "string" ? b.text : "";
  let threadRef = `${ownPrefix}default`;
  if (typeof b.threadRef === "string" && b.threadRef.startsWith("web:")) threadRef = b.threadRef;
  const scope = strField(b, "scopeId");
  const channelTrim = strField(b, "channelName")?.trim();
  const channelName = channelTrim ? channelTrim.slice(0, 200) : undefined;
  const model = strField(b, "model");
  const harness = typeof b.harness === "string" ? b.harness : undefined;
  const thinkingLevel = typeof b.thinkingLevel === "string" ? b.thinkingLevel : undefined;
  const fastMode = boolField(b, "fastMode");
  const tzTrim = strField(b, "timezone")?.trim();
  const timezone = tzTrim ? tzTrim.slice(0, 64) : undefined;
  const proactiveOpener = b.proactiveOpener === true;

  let approval: { requestId: string; approved: boolean; scope?: string } | undefined;
  const rawApproval = b.approval;
  if (rawApproval && typeof rawApproval === "object") {
    const a = rawApproval as { requestId?: unknown; approved?: unknown; scope?: unknown };
    if (typeof a.requestId === "string" && typeof a.approved === "boolean") {
      approval = {
        requestId: a.requestId,
        approved: a.approved,
        ...(a.scope === "once" || a.scope === "session" || a.scope === "always" ? { scope: a.scope } : {}),
      };
    }
  }

  const attachments: CoreAttachment[] = [];
  if (Array.isArray(b.attachments)) {
    for (const item of b.attachments as unknown[]) {
      if (!item || typeof item !== "object") continue;
      const a = item as { name?: unknown; mimetype?: unknown; sizeBytes?: unknown; blobId?: unknown };
      if (typeof a.name !== "string" || typeof a.blobId !== "string" || !a.blobId) continue;
      attachments.push({
        name: a.name,
        mimetype: typeof a.mimetype === "string" && a.mimetype ? a.mimetype : "application/octet-stream",
        sizeBytes: typeof a.sizeBytes === "number" ? a.sizeBytes : 0,
        blobId: a.blobId,
      });
    }
  }

  if (!text.trim() && attachments.length === 0 && !approval && !proactiveOpener)
    return json(c.res, 400, { error: "empty message" });
  if (!threadRef.startsWith(ownPrefix) && !(scope?.startsWith("channel:") || scope?.startsWith("group:")))
    return json(c.res, 403, {
      error: "forbidden_thread",
      message: "this conversation can only be continued from its own context",
    });
  const conversation = conversationForScope(c.user, threadRef, scope, channelName);
  if (!conversation)
    return json(c.res, 403, {
      error: "forbidden_scope",
      message: "you can only chat in your personal context or a shared context you're in",
    });

  const turn = {
    surface: "web",
    actor: { externalId: c.user },
    conversation,
    liveActor: true,
    deliveryTarget: threadRef,
    text,
    ...(harness ? { harness } : {}),
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(typeof fastMode === "boolean" ? { fastMode } : {}),
    ...(timezone ? { timezone } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(approval ? { approval } : {}),
    ...(proactiveOpener ? { proactiveOpener: true } : {}),
  };
  await relayResponse(c.res, await coreFetch(c.deps, "POST", "/v1/turns?async=1", JSON.stringify(turn)));
}

interface CoreApprovalRecord {
  request?: { conversation?: { threadRef?: unknown }; actor?: { externalId?: unknown } } & Record<string, unknown>;
}

async function handleApprovals(c: Ctx): Promise<void> {
  const requestId = c.params.requestId!;
  const approved = c.body.approved === true;
  const rawScope = c.body.scope;
  const scope = rawScope === "once" || rawScope === "session" || rawScope === "always" ? rawScope : undefined;
  const fetched = await coreFetch(c.deps, "GET", `/v1/approvals/${enc(requestId)}`);
  if (!fetched.ok) return relayResponse(c.res, fetched);
  let record: CoreApprovalRecord;
  try {
    record = JSON.parse(await fetched.text()) as CoreApprovalRecord;
  } catch {
    return json(c.res, 502, { error: "bad_core_response" });
  }
  const threadRef =
    typeof record.request?.conversation?.threadRef === "string" ? record.request.conversation.threadRef : "";
  const actor = typeof record.request?.actor?.externalId === "string" ? record.request.actor.externalId : "";
  if (!threadRef.startsWith("web:") || actor !== c.user || !record.request)
    return json(c.res, 404, { error: "not_found" });
  const turn = { ...record.request, approval: { requestId, approved, ...(scope ? { scope } : {}) } };
  await relayResponse(c.res, await coreFetch(c.deps, "POST", "/v1/turns?async=1", JSON.stringify(turn)));
}

async function handleRunsActive(c: Ctx): Promise<void> {
  const threadRef = c.url.searchParams.get("threadRef") ?? "";
  if (!threadRef.startsWith("web:")) return json(c.res, 404, { error: "not_found" });
  const durable = await coreFetch(c.deps, "GET", `/v1/runs?threadRef=${enc(threadRef)}`);
  if (!durable.ok) return relayResponse(c.res, durable);
  let runId: string | null = null;
  let queued: Array<{ runId: string; text: string }> = [];
  try {
    const parsed = JSON.parse(await durable.text()) as { runId?: string | null; queued?: typeof queued };
    runId = parsed.runId ?? null;
    queued = parsed.queued ?? [];
  } catch {
    void 0;
  }
  if (runId) {
    const r = await coreFetch(c.deps, "GET", `/v1/runs/${enc(runId)}`);
    if (r.ok) {
      let status = "";
      try {
        status = String((JSON.parse(await r.text()) as { status?: unknown }).status ?? "");
      } catch {
        void 0;
      }
      if (status !== "done" && status !== "failed") {
        const activeRunId = runId;
        const waiting = queued.filter((x) => x.runId !== activeRunId);
        return json(c.res, 200, { runId, ...(waiting.length ? { queued: waiting } : {}) });
      }
    }
  }
  json(c.res, 200, { runId: null, ...(queued.length ? { queued } : {}) });
}

interface CoreRun {
  status?: string;
  result?: unknown;
  partial?: string;
  alive?: boolean;
  stale?: boolean;
  replyComplete?: boolean;
  activity?: unknown[];
  startedAt?: number | null;
  finishedAt?: number | null;
}

async function handleRunsEvents(c: Ctx): Promise<void> {
  const res = c.res;
  const id = c.params.id!;
  let closed = false;
  c.req.on("close", () => {
    closed = true;
  });
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": open\n\n");
  let acc = "";
  let activityLen = 0;
  let lastStale: boolean | null = null;
  let staleSince: number | null = null;
  let lastProgressAt = Date.now();
  let lastBeat = lastProgressAt;
  for (;;) {
    if (closed) return;
    let r: Response;
    try {
      r = await coreFetch(c.deps, "GET", `/v1/runs/${enc(id)}`);
    } catch {
      try {
        r = await coreFetch(c.deps, "GET", `/v1/runs/${enc(id)}`);
      } catch {
        sseEvent(res, "failed", { reason: "upstream_unreachable" });
        break;
      }
    }
    if (closed) return;
    if (!r.ok) {
      sseEvent(res, "failed", { reason: `HTTP ${r.status}` });
      break;
    }
    const text = await r.text();
    let run: CoreRun = {};
    let parsed = true;
    try {
      run = JSON.parse(text) as CoreRun;
    } catch {
      parsed = false;
    }
    const now = Date.now();
    const partial = typeof run.partial === "string" ? run.partial : "";
    const activity = Array.isArray(run.activity) ? run.activity : [];
    if (partial.length > acc.length) {
      acc = partial;
      sseEvent(res, "partial", { partial: acc });
      lastProgressAt = now;
      lastBeat = now;
    }
    if (activity.length > activityLen) {
      activityLen = activity.length;
      sseEvent(res, "activity", { activity, startedAt: run.startedAt ?? null });
      lastProgressAt = now;
      lastBeat = now;
    }
    if (parsed) {
      if (run.stale === true) staleSince ??= now;
      else staleSince = null;
      if ((run.stale === true) !== lastStale) {
        lastStale = run.stale === true;
        sseEvent(res, "stale", { stale: lastStale });
        lastBeat = now;
      }
    }
    if (now - lastBeat > SSE_HEARTBEAT_MS) {
      if (run.alive === true) sseEvent(res, "alive", { at: now });
      else if (lastStale === true) sseEvent(res, "stale", { stale: true });
      else res.write(": ping\n\n");
      lastBeat = now;
    }
    if (run.alive === true || (staleSince !== null && now - staleSince < SSE_STALE_GRACE_MS)) lastProgressAt = now;
    const terminal = run.status === "done" || run.status === "failed" || run.result != null;
    if (terminal || run.replyComplete) {
      sseEvent(res, "done", {
        status: run.status ?? null,
        result: run.result ?? null,
        partial: acc,
        activity,
        replyComplete: run.replyComplete ?? false,
        startedAt: run.startedAt ?? null,
        finishedAt: run.finishedAt ?? null,
      });
      break;
    }
    if (now - lastProgressAt > SSE_IDLE_MS) break;
    await sleep(lastStale === true ? SSE_STALE_POLL_MS : SSE_CORE_POLL_MS);
  }
  if (!closed) res.end();
}

function sessionDetailQuery(c: Ctx): string {
  const s = new URLSearchParams({ viewer: c.user });
  for (const k of ["tailTurns", "sinceSeq", "beforeSeq"] as const) {
    const v = c.url.searchParams.get(k);
    if (v !== null) s.set(k, v);
  }
  return s.toString();
}

async function handleSessionEntry(c: Ctx): Promise<void> {
  const seq = c.params.seq!;
  if (!/^\d+$/.test(seq)) return json(c.res, 404, { error: "not_found" });
  await relayResponse(
    c.res,
    await coreFetch(c.deps, "GET", `/v1/sessions/${enc(c.params.id!)}/entries/${seq}?viewer=${enc(c.user)}`),
  );
}

async function handleSessionPatch(c: Ctx): Promise<void> {
  const b = c.body;
  const patch: Record<string, unknown> = {};
  if (b.title === null || typeof b.title === "string") patch.title = b.title;
  if (typeof b.archived === "boolean") patch.archived = b.archived;
  if (typeof b.pinned === "boolean") patch.pinned = b.pinned;
  if (b.color === null || typeof b.color === "string") patch.color = b.color;
  if (Object.keys(patch).length === 0)
    return json(c.res, 400, { error: "bad_request", message: "title, archived, pinned, or color required" });
  await relayResponse(
    c.res,
    await coreFetch(c.deps, "POST", `/v1/sessions/${enc(c.params.id!)}`, JSON.stringify({ principalId: c.user, ...patch })),
  );
}

async function handleProjectCreate(c: Ctx): Promise<void> {
  const name = (strField(c.body, "name") ?? "").trim().slice(0, 200);
  if (!name) return json(c.res, 400, { error: "bad_request", message: "name required" });
  await relayResponse(c.res, await coreFetch(c.deps, "POST", "/v1/projects", JSON.stringify({ principalId: c.user, name })));
}

async function handleProjectRename(c: Ctx): Promise<void> {
  const name = (strField(c.body, "name") ?? "").trim().slice(0, 200);
  if (!name) return json(c.res, 400, { error: "bad_request", message: "name required" });
  await relayResponse(
    c.res,
    await coreFetch(c.deps, "PATCH", `/v1/projects/${enc(c.params.id!)}`, JSON.stringify({ principalId: c.user, name })),
  );
}

async function handleProjectAddMember(c: Ctx): Promise<void> {
  const memberId = (strField(c.body, "memberId") ?? "").trim();
  if (!memberId) return json(c.res, 400, { error: "bad_request", message: "memberId required" });
  await relayResponse(
    c.res,
    await coreFetch(
      c.deps,
      "POST",
      `/v1/projects/${enc(c.params.id!)}/members`,
      JSON.stringify({ principalId: c.user, memberId }),
    ),
  );
}

async function handleDirectoryResolve(c: Ctx): Promise<void> {
  const q = (c.url.searchParams.get("q") ?? "").trim().slice(0, 80);
  if (!q) return json(c.res, 400, { error: "bad_request", message: "q required" });
  await relayResponse(c.res, await coreFetch(c.deps, "GET", `/v1/directory/resolve?q=${enc(q)}`));
}

async function handleScopeResources(c: Ctx): Promise<void> {
  const scope = c.url.searchParams.get("scope");
  if (!scope) return json(c.res, 400, { error: "bad_request", message: "scope required" });
  await relayResponse(
    c.res,
    await coreFetch(c.deps, "GET", `/v1/scope-resources?principalId=${enc(c.user)}&scope=${enc(scope)}`),
  );
}

async function handleMemoryPut(c: Ctx): Promise<void> {
  const content = strField(c.body, "content");
  if (content === undefined)
    return json(c.res, 400, { error: "bad_request", message: "content must be a string" });
  let revision = strField(c.body, "revision") ?? "";
  if (!revision) {
    const head = await coreFetch(c.deps, "GET", `/v1/memory?principalId=${enc(c.user)}`);
    try {
      revision = String((JSON.parse(await head.text()) as { revision?: unknown }).revision ?? "");
    } catch {
      revision = "";
    }
  }
  await relayResponse(
    c.res,
    await coreFetch(c.deps, "PUT", "/v1/memory", JSON.stringify({ principalId: c.user, content, revision })),
  );
}

async function handleConnectorsRevoke(c: Ctx): Promise<void> {
  const provider = strField(c.body, "provider") ?? "";
  const host = strField(c.body, "host") ?? "";
  if (!provider && !host)
    return json(c.res, 400, { error: "bad_request", message: "provider or host required" });
  const rawBody = JSON.stringify({ principalId: c.user, ...(provider ? { provider } : { host }) });
  await relayResponse(c.res, await coreFetch(c.deps, "POST", "/v1/connectors/oauth/revoke", rawBody));
}

function validFilters(filters: unknown): filters is Array<{ path: string; in: string[] }> {
  return (
    Array.isArray(filters) &&
    filters.every((f) => {
      if (!f || typeof f !== "object") return false;
      const cand = f as { path?: unknown; in?: unknown };
      return (
        typeof cand.path === "string" &&
        cand.path.trim().length > 0 &&
        Array.isArray(cand.in) &&
        cand.in.length > 0 &&
        cand.in.every((v) => typeof v === "string" && v.trim().length > 0)
      );
    })
  );
}

async function handleWebhooksPost(c: Ctx): Promise<void> {
  const b = c.body;
  const action = (typeof b.action === "string" ? b.action : "").trim();
  let verification: { scheme: string; secret?: string } = { scheme: "hmac-sha256" };
  if (b.verification !== undefined) {
    const v = b.verification;
    if (typeof v !== "object" || v === null || typeof (v as { scheme?: unknown }).scheme !== "string")
      return json(c.res, 400, {
        error: "unsupported_verification",
        message: "verification requires a scheme (HMAC-SHA256, GitHub, Slack, or Stripe)",
      });
    const vv = v as { scheme: string; secret?: unknown };
    verification = {
      scheme: vv.scheme,
      ...(typeof vv.secret === "string" && vv.secret ? { secret: vv.secret } : {}),
    };
  }
  let filters: Array<{ path: string; in: string[] }> | undefined;
  if (b.filters !== undefined) {
    if (!validFilters(b.filters))
      return json(c.res, 400, {
        error: "invalid_filters",
        message: "every filter requires a path and at least one value",
      });
    filters = b.filters;
  }
  if (b.destination !== undefined)
    return json(c.res, 400, {
      error: "invalid_destination",
      message: "choose webhook destinations with the agent so teammate and channel names can be resolved safely",
    });
  if (!action)
    return json(c.res, 400, { error: "action_required", message: "an action (the agent's instructions) is required" });
  if (!["hmac-sha256", "github", "slack", "stripe"].includes(verification.scheme))
    return json(c.res, 400, {
      error: "unsupported_verification",
      message: "choose HMAC-SHA256, GitHub, Slack, or Stripe signature verification",
    });
  if (!verification.secret) verification = { ...verification, secret: randomBytes(32).toString("hex") };
  const reqBody = JSON.stringify({
    ownerScopeId: `personal:${c.user}`,
    owner: c.user,
    createdBy: c.user,
    action,
    verification,
    ...(filters ? { filters } : {}),
  });
  await relayResponse(c.res, await coreFetch(c.deps, "POST", "/v1/webhooks", reqBody));
}

async function gateManageDeployment(c: Ctx, id: string): Promise<boolean> {
  const r = await coreFetch(c.deps, "GET", `/v1/deployments?principalId=${enc(c.user)}`);
  if (!r.ok) {
    await relayResponse(c.res, r);
    return false;
  }
  let list: Array<Record<string, unknown>> = [];
  try {
    list = (JSON.parse(await r.text()) as { deployments?: Array<Record<string, unknown>> }).deployments ?? [];
  } catch {
    list = [];
  }
  const d = list.find((x) => x.id === id || x.name === id);
  if (!d) {
    json(c.res, 404, { error: "not_found" });
    return false;
  }
  if (d.permission !== "write") {
    json(c.res, 403, { error: "forbidden", message: "you do not manage this deployment" });
    return false;
  }
  return true;
}

function deploymentManage(coreSuffix: string, bodyFn?: (c: Ctx) => unknown): (c: Ctx) => Promise<void> {
  return async (c) => {
    const id = c.params.id!;
    if (!(await gateManageDeployment(c, id))) return;
    const raw = bodyFn ? JSON.stringify(bodyFn(c)) : "";
    await relayResponse(c.res, await coreFetch(c.deps, "POST", `/v1/deployments/${enc(id)}/${coreSuffix}`, raw));
  };
}

function runtimeScopeId(c: Ctx): string {
  const s = c.url.searchParams.get("scopeId") || strField(c.body, "scopeId");
  return s && s.trim() ? s.trim() : `personal:${c.user}`;
}

export const directRoutes: readonly Route[] = [
  { match: (_method, pathname) => pathname === "/me", handle: handleMe },

  { method: "POST", path: "/api/turn", handle: handleTurn },
  { method: "POST", path: "/api/approvals/:requestId", handle: handleApprovals },
  { method: "GET", path: "/api/runs/active", handle: handleRunsActive },
  { method: "GET", path: "/api/runs/:id/events", handle: handleRunsEvents },
  { method: "GET", path: "/api/runs/:id", handle: relayGet((c) => `/v1/runs/${enc(c.params.id!)}`) },
  {
    method: "POST",
    path: "/api/runs/:id/signal",
    handle: relaySend("POST", (c) => `/v1/runs/${enc(c.params.id!)}/signal`, (c) => ({
      kind: strField(c.body, "kind") ?? "",
      ...(strField(c.body, "text") !== undefined ? { text: strField(c.body, "text") } : {}),
    })),
  },
  {
    method: "POST",
    path: "/api/runs/:id/withdraw",
    handle: relaySendNoBody("POST", (c) => `/v1/runs/${enc(c.params.id!)}/withdraw`),
  },

  {
    method: "GET",
    path: "/api/search",
    handle: relayGet(
      (c) =>
        `/v1/sessions/search?principalId=${enc(c.user)}&q=${enc(c.url.searchParams.get("q") ?? "")}${
          c.url.searchParams.get("limit") ? `&limit=${enc(c.url.searchParams.get("limit")!)}` : ""
        }`,
    ),
  },
  { method: "GET", path: "/api/sessions", handle: relayGet((c) => `/v1/sessions?principalId=${enc(c.user)}`) },
  {
    method: "GET",
    path: "/api/sessions/:id",
    handle: relayGet((c) => `/v1/sessions/${enc(c.params.id!)}?${sessionDetailQuery(c)}`),
  },
  { method: "POST", path: "/api/sessions/:id", handle: handleSessionPatch },
  {
    method: "POST",
    path: "/api/sessions/:id/title",
    handle: relaySend("POST", (c) => `/v1/sessions/${enc(c.params.id!)}/title`, (c) => ({ principalId: c.user })),
  },
  {
    method: "POST",
    path: "/api/sessions/:id/fork",
    handle: relaySend("POST", (c) => `/v1/sessions/${enc(c.params.id!)}/fork`, (c) => ({
      principalId: c.user,
      ...(typeof c.body.upToSeq === "number" ? { upToSeq: c.body.upToSeq } : {}),
    })),
  },
  {
    method: "GET",
    path: "/api/sessions/:id/approvals",
    handle: relayGet((c) => `/v1/sessions/${enc(c.params.id!)}/approvals?viewer=${enc(c.user)}`),
  },
  {
    method: "GET",
    path: "/api/sessions/:id/background",
    handle: relayGet((c) => `/v1/sessions/${enc(c.params.id!)}/background?viewer=${enc(c.user)}`),
  },
  {
    method: "GET",
    path: "/api/sessions/:id/background/:pid/output",
    handle: relayGet(
      (c) =>
        `/v1/sessions/${enc(c.params.id!)}/background/${enc(c.params.pid!)}/output?viewer=${enc(
          c.user,
        )}&sinceCursor=${enc(c.url.searchParams.get("sinceCursor") ?? "0")}`,
    ),
  },
  { method: "GET", path: "/api/sessions/:id/entries/:seq", handle: handleSessionEntry },

  { method: "GET", path: "/api/contexts", handle: relayGet((c) => `/v1/contexts?principalId=${enc(c.user)}`) },
  {
    method: "GET",
    path: "/api/contexts/:scope/ambient-policy",
    handle: relayGet(
      (c) => `/v1/contexts/policy?principalId=${enc(c.user)}&scope=${enc(c.params.scope!)}`,
    ),
  },
  {
    method: "PUT",
    path: "/api/contexts/:scope/ambient-policy",
    handle: relaySend("PUT", () => "/v1/contexts/policy", (c) => ({
      principalId: c.user,
      scope: c.params.scope!,
      orders: c.body.orders,
      bots: c.body.bots,
      ambientEnabled: c.body.ambientEnabled,
      baseUpdatedAt: c.body.baseUpdatedAt,
    })),
  },

  { method: "POST", path: "/api/projects", handle: handleProjectCreate },
  { method: "PATCH", path: "/api/projects/:id", handle: handleProjectRename },
  { method: "POST", path: "/api/projects/:id/members", handle: handleProjectAddMember },
  {
    method: "DELETE",
    path: "/api/projects/:id/members/:memberId",
    handle: relaySend(
      "DELETE",
      (c) => `/v1/projects/${enc(c.params.id!)}/members/${enc(c.params.memberId!)}`,
      (c) => ({ principalId: c.user }),
    ),
  },

  { method: "GET", path: "/api/directory/resolve", handle: handleDirectoryResolve },
  { method: "GET", path: "/api/surface-config", handle: relayGet(() => "/v1/surface-config") },
  { method: "GET", path: "/api/scope-resources", handle: handleScopeResources },

  {
    method: "GET",
    path: "/api/runtime-config",
    handle: relayGet((c) => `/v1/runtime-config?principalId=${enc(c.user)}&scopeId=${enc(runtimeScopeId(c))}`),
  },
  {
    method: "PUT",
    path: "/api/runtime-config",
    handle: relaySend("PUT", () => "/v1/runtime-config", (c) => ({
      ...c.body,
      principalId: c.user,
      scopeId: runtimeScopeId(c),
    })),
  },

  {
    method: "GET",
    path: "/api/skills",
    handle: relayGet(
      (c) =>
        `/v1/skills?principalId=${enc(c.user)}${
          c.url.searchParams.get("includeShadowed") === "1" ? "&includeShadowed=1" : ""
        }`,
    ),
  },
  {
    method: "GET",
    path: "/api/skills/:id",
    handle: relayGet((c) => `/v1/skills/${enc(c.params.id!)}?principalId=${enc(c.user)}`),
  },
  {
    method: "POST",
    path: "/api/skills",
    handle: relaySend("POST", () => "/v1/skills", (c) => ({
      principalId: c.user,
      ...pickStrings(c.body, ["name", "description", "body", "scopeId"]),
    })),
  },
  {
    method: "PUT",
    path: "/api/skills/:id",
    handle: relaySend("PUT", (c) => `/v1/skills/${enc(c.params.id!)}`, (c) => ({
      principalId: c.user,
      ...pickStrings(c.body, ["description", "body"]),
    })),
  },
  {
    method: "DELETE",
    path: "/api/skills/:id",
    handle: relaySend("DELETE", (c) => `/v1/skills/${enc(c.params.id!)}`, (c) => ({ principalId: c.user })),
  },
  {
    method: "POST",
    path: "/api/skills/:id/restore",
    handle: relaySend("POST", (c) => `/v1/skills/${enc(c.params.id!)}/restore`, (c) => ({ principalId: c.user })),
  },

  {
    method: "GET",
    path: "/api/files",
    handle: relayGet((c) => {
      const s = new URLSearchParams({ viewer: c.user });
      for (const k of ["limit", "cursor", "scope"] as const) {
        const v = c.url.searchParams.get(k);
        if (v !== null) s.set(k, v);
      }
      return `/v1/files?${s.toString()}`;
    }),
  },
  {
    method: "GET",
    path: "/api/files/:id/content",
    handle: relayGet((c) => `/v1/files/${enc(c.params.id!)}/content?viewer=${enc(c.user)}`),
  },

  { method: "GET", path: "/api/memory", handle: relayGet((c) => `/v1/memory?principalId=${enc(c.user)}`) },
  {
    method: "GET",
    path: "/api/memory/history",
    handle: relayGet((c) => `/v1/memory/history?principalId=${enc(c.user)}`),
  },
  { method: "PUT", path: "/api/memory", handle: handleMemoryPut },
  {
    method: "POST",
    path: "/api/memory/restore",
    handle: relaySend("POST", () => "/v1/memory/restore", (c) => ({
      principalId: c.user,
      revision: strField(c.body, "revision") ?? "",
      expectedRevision: strField(c.body, "expectedRevision") ?? "",
    })),
  },

  {
    method: "GET",
    path: "/api/connectors",
    handle: relayGet((c) => `/v1/connectors/oauth/status?principalId=${enc(c.user)}`),
  },
  { method: "POST", path: "/api/connectors/revoke", handle: handleConnectorsRevoke },

  { method: "GET", path: "/api/keychain/credentials", handle: relayCap("GET", () => "/v1/keychain/credentials") },
  { method: "GET", path: "/api/keychain/overview", handle: relayCap("GET", () => "/v1/keychain/overview") },
  {
    method: "POST",
    path: "/api/keychain/grants/:id/revoke",
    handle: relayCap("POST", (c) => `/v1/keychain/grants/${enc(c.params.id!)}/revoke`, () => ({})),
  },
  {
    method: "POST",
    path: "/api/keychain/drops",
    handle: relayCap("POST", () => "/v1/keychain/drops", (c) => pickStrings(c.body, ["service", "purpose", "envKey"])),
  },
  {
    method: "DELETE",
    path: "/api/keychain/credentials/:id",
    handle: relayCap("DELETE", (c) => `/v1/keychain/credentials/${enc(c.params.id!)}`),
  },

  {
    method: "GET",
    path: "/api/deployments",
    handle: relayGet((c) => `/v1/deployments?principalId=${enc(c.user)}`),
  },
  {
    method: "GET",
    path: "/api/deployments/:id",
    handle: relayGet((c) => `/v1/deployments/${enc(c.params.id!)}?principalId=${enc(c.user)}`),
  },
  {
    method: "GET",
    path: "/api/deployments/:id/owner-url",
    handle: relayGet((c) => `/v1/deployments/${enc(c.params.id!)}/owner-url?principalId=${enc(c.user)}`),
  },
  {
    method: "POST",
    path: "/api/deployments/:id/display-name",
    handle: deploymentManage("display-name", (c) => ({ displayName: String(c.body.displayName ?? "") })),
  },
  {
    method: "POST",
    path: "/api/deployments/:id/name",
    handle: deploymentManage("name", (c) => ({ name: String(c.body.name ?? "") })),
  },
  { method: "POST", path: "/api/deployments/:id/archive", handle: deploymentManage("archive") },
  {
    method: "POST",
    path: "/api/deployments/:id/restore",
    handle: deploymentManage("restore", (c) => ({ principalId: c.user })),
  },

  { method: "GET", path: "/api/webhooks", handle: relayGet((c) => `/v1/webhooks?viewer=${enc(c.user)}`) },
  { method: "POST", path: "/api/webhooks", handle: handleWebhooksPost },
  {
    method: "POST",
    path: "/api/webhooks/:id/disable",
    handle: relaySendNoBody("POST", (c) => `/v1/webhooks/${enc(c.params.id!)}/disable?principalId=${enc(c.user)}`),
  },
  {
    method: "POST",
    path: "/api/webhooks/:id/enable",
    handle: relaySendNoBody("POST", (c) => `/v1/webhooks/${enc(c.params.id!)}/enable?principalId=${enc(c.user)}`),
  },

  { method: "GET", path: "/api/crons", handle: relayGet((c) => `/v1/crons?viewer=${enc(c.user)}`) },
  {
    method: "GET",
    path: "/api/crons/:id/runs",
    handle: relayGet((c) => `/v1/crons/${enc(c.params.id!)}/runs?principalId=${enc(c.user)}&limit=20`),
  },
  {
    method: "PATCH",
    path: "/api/crons/:id",
    handle: relaySend("PATCH", (c) => `/v1/crons/${enc(c.params.id!)}?principalId=${enc(c.user)}`, (c) => c.body),
  },
  {
    method: "POST",
    path: "/api/crons/:id/disable",
    handle: relaySendNoBody("POST", (c) => `/v1/crons/${enc(c.params.id!)}/disable?principalId=${enc(c.user)}`),
  },
  {
    method: "POST",
    path: "/api/crons/:id/enable",
    handle: relaySend(
      "PATCH",
      (c) => `/v1/crons/${enc(c.params.id!)}?principalId=${enc(c.user)}`,
      () => ({ enabled: true, archived: false }),
    ),
  },
  {
    method: "POST",
    path: "/api/crons/:id/run",
    handle: relaySendNoBody("POST", (c) => `/v1/crons/${enc(c.params.id!)}/run?principalId=${enc(c.user)}`),
  },
  {
    method: "DELETE",
    path: "/api/crons/:id",
    handle: relaySendNoBody("DELETE", (c) => `/v1/crons/${enc(c.params.id!)}?principalId=${enc(c.user)}`),
  },
];
