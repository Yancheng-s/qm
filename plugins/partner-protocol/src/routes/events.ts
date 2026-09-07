import { threadRefFor } from "../auth.ts";
import { asObject, booleanField, numberField, stringField, upstreamProblem } from "../core-client.ts";
import { openSse, problem, readConversationId, requireGroupScope, sendProblem, sseEvent, sleep } from "../transport.ts";
import type { Ctx } from "./index.ts";

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CORE_POLL_MS = 100;
const STALE_POLL_MS = 1_000;
const IDLE_MS = 6 * 60_000;
const STALE_GRACE_MS = 10 * 60_000;
const HEARTBEAT_MS = 15_000;
const MAX_CONSECUTIVE_FAILURES = 2;

interface CoreRun {
  status: string;
  result: unknown;
  partial: string;
  activity: unknown[];
  alive: boolean;
  stale: boolean;
  replyComplete: boolean;
  startedAt: number | null;
  finishedAt: number | null;
}

function readRun(json: unknown): CoreRun {
  const run = asObject(json);
  const activity = run?.activity;
  return {
    status: stringField(run, "status"),
    result: run?.result ?? null,
    partial: stringField(run, "partial"),
    activity: Array.isArray(activity) ? activity : [],
    alive: booleanField(run, "alive") === true,
    stale: booleanField(run, "stale") === true,
    replyComplete: booleanField(run, "replyComplete") === true,
    startedAt: numberField(run, "startedAt") ?? null,
    finishedAt: numberField(run, "finishedAt") ?? null,
  };
}

type RunResolution = { kind: "run"; runId: string } | { kind: "idle" } | { kind: "handled" };

async function resolveRunId(c: Ctx): Promise<RunResolution> {
  const scope = requireGroupScope(c.url.searchParams.get("scopeId"));
  if (!scope.ok) {
    sendProblem(c.res, scope.problem);
    return { kind: "handled" };
  }
  const conversation = readConversationId(c.url.searchParams.get("conversationId") ?? undefined);
  if (!conversation.ok) {
    sendProblem(c.res, conversation.problem);
    return { kind: "handled" };
  }
  const threadRef = threadRefFor(c.principalId, conversation.conversationId);
  const active = await c.core("GET", `/v1/runs?threadRef=${encodeURIComponent(threadRef)}`);
  if (!active.ok) {
    sendProblem(c.res, active.problem);
    return { kind: "handled" };
  }
  if (active.status !== 200) {
    sendProblem(c.res, upstreamProblem(active.status, active.json, "active run lookup failed"));
    return { kind: "handled" };
  }
  const runId = stringField(active.json, "runId");
  return runId ? { kind: "run", runId } : { kind: "idle" };
}

export async function handleEvents(c: Ctx): Promise<void> {
  const requested = c.url.searchParams.get("runId")?.trim() ?? "";
  let runId = requested;
  if (!runId) {
    const resolved = await resolveRunId(c);
    if (resolved.kind === "handled") return;
    if (resolved.kind === "idle") {
      openSse(c.res);
      sseEvent(c.res, "idle", {});
      c.res.end();
      return;
    }
    runId = resolved.runId;
  }
  if (!RUN_ID.test(runId)) return sendProblem(c.res, problem(400, "bad_request", `runId must match ${RUN_ID.source}`));

  const res = c.res;
  let closed = false;
  c.req.on("close", () => {
    closed = true;
  });
  const gone = (): boolean => closed || res.destroyed || res.writableEnded;
  openSse(res);

  let acc = "";
  let activityLen = 0;
  let lastStale = false;
  let staleSince: number | null = null;
  let failures = 0;
  let lastProgressAt = Date.now();
  let lastBeat = lastProgressAt;

  for (;;) {
    if (gone()) return;
    const outcome = await c.core("GET", `/v1/runs/${encodeURIComponent(runId)}`);
    if (gone()) return;
    if (!outcome.ok || outcome.status !== 200) {
      failures += 1;
      if (failures < MAX_CONSECUTIVE_FAILURES) {
        await sleep(CORE_POLL_MS);
        continue;
      }
      sseEvent(res, "failed", outcome.ok ? { reason: `HTTP ${outcome.status}` } : { reason: "upstream_unreachable" });
      break;
    }
    failures = 0;
    const run = readRun(outcome.json);
    const now = Date.now();

    if (run.partial.length > acc.length) {
      acc = run.partial;
      sseEvent(res, "partial", { partial: acc });
      lastProgressAt = now;
      lastBeat = now;
    }
    if (run.activity.length > activityLen) {
      activityLen = run.activity.length;
      sseEvent(res, "activity", { activity: run.activity, startedAt: run.startedAt });
      lastProgressAt = now;
      lastBeat = now;
    }
    if (run.stale) staleSince ??= now;
    else staleSince = null;
    if (run.stale !== lastStale) {
      lastStale = run.stale;
      sseEvent(res, "stale", { stale: lastStale });
      lastBeat = now;
    }
    if (now - lastBeat > HEARTBEAT_MS) {
      if (run.alive) sseEvent(res, "alive", { at: now });
      else if (lastStale) sseEvent(res, "stale", { stale: true });
      else res.write(": ping\n\n");
      lastBeat = now;
    }
    if (run.alive || (staleSince !== null && now - staleSince < STALE_GRACE_MS)) lastProgressAt = now;

    const terminal = run.status === "done" || run.status === "failed" || run.result !== null;
    if (terminal || run.replyComplete) {
      sseEvent(res, "done", {
        status: run.status || null,
        result: run.result,
        partial: acc,
        activity: run.activity,
        replyComplete: run.replyComplete,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      });
      break;
    }
    if (now - lastProgressAt > IDLE_MS) break;
    await sleep(lastStale ? STALE_POLL_MS : CORE_POLL_MS);
  }
  if (!gone()) res.end();
}
