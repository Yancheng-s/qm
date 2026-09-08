import { asObject, booleanField, numberField, stringField, upstreamProblem } from "../core-client.ts";
import { problem, sendJson, sendProblem, type Problem } from "../transport.ts";
import type { Ctx } from "./index.ts";

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const WINDOW_PARAMS = { tailTurns: 1, sinceSeq: 0, beforeSeq: 1 } as const;

type SessionWindow = { ok: true; query: string } | { ok: false; problem: Problem };

function readSessionWindow(searchParams: URLSearchParams): SessionWindow {
  const query = new URLSearchParams();
  for (const [name, min] of Object.entries(WINDOW_PARAMS)) {
    const raw = searchParams.get(name);
    if (raw === null) continue;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < min)
      return {
        ok: false,
        problem: problem(400, "bad_request", `${name} must be an integer >= ${min}`),
      };
    query.set(name, String(parsed));
  }
  return { ok: true, query: query.toString() };
}

function narrowSession(source: unknown): Record<string, unknown> | null {
  const session = asObject(source);
  if (!session) return null;
  const id = stringField(session, "id");
  if (!id) return null;
  const lastActivityAt = numberField(session, "lastActivityAt");
  const working = booleanField(session, "working");
  const awaitingInput = booleanField(session, "awaitingInput");
  return {
    id,
    type: stringField(session, "type"),
    scopeId: stringField(session, "scopeId"),
    threadRef: stringField(session, "threadRef"),
    title: session.title === null || session.title === undefined ? null : stringField(session, "title"),
    createdAt: numberField(session, "createdAt") ?? 0,
    ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
    ...(working === undefined ? {} : { working }),
    ...(awaitingInput === undefined ? {} : { awaitingInput }),
  };
}

export async function handleSessionById(c: Ctx): Promise<void> {
  const id = c.params.id ?? "";
  if (!SESSION_ID.test(id)) return sendProblem(c.res, problem(404, "not_found", "unknown session"));

  const window = readSessionWindow(c.url.searchParams);
  if (!window.ok) return sendProblem(c.res, window.problem);

  const query = new URLSearchParams({ viewer: c.principalId });
  for (const [name, value] of new URLSearchParams(window.query)) query.set(name, value);

  const outcome = await c.core("GET", `/v1/sessions/${encodeURIComponent(id)}?${query.toString()}`);
  if (!outcome.ok) return sendProblem(c.res, outcome.problem);
  if (outcome.status === 404) return sendProblem(c.res, problem(404, "not_found", "unknown session"));
  if (outcome.status !== 200)
    return sendProblem(c.res, upstreamProblem(outcome.status, outcome.json, "session read failed"));

  const found = asObject(outcome.json);
  const session = narrowSession(found?.session);
  if (!session)
    return sendProblem(c.res, upstreamProblem(outcome.status, outcome.json, "core returned an unexpected session"));

  const entries = found?.entries;
  const earlierEntries = numberField(found, "earlierEntries");
  sendJson(c.res, 200, {
    session,
    entries: Array.isArray(entries) ? entries : [],
    ...(earlierEntries === undefined ? {} : { earlierEntries }),
  });
}
