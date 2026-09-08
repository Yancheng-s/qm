import type { IncomingMessage, ServerResponse } from "node:http";
import { PayloadTooLargeError, readBody } from "../../chassis/src/http.ts";

const PROTOCOL_VERSION = "1";
const PROTOCOL_VERSION_HEADER = "x-partner-protocol";
const CONVERSATION_ID = /^[A-Za-z0-9._-]{1,120}$/;
const DEFAULT_CONVERSATION_ID = "default";

export interface Problem {
  status: number;
  body: Record<string, unknown>;
}

export function problem(status: number, error: string, message: string, extra?: Record<string, unknown>): Problem {
  return { status, body: { error, message, ...extra } };
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    [PROTOCOL_VERSION_HEADER]: PROTOCOL_VERSION,
  });
  res.end(JSON.stringify(body));
}

export function sendProblem(res: ServerResponse, found: Problem): void {
  sendJson(res, found.status, found.body);
}

export function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(html);
}

export type BodyRead = { ok: true; raw: string; body: Record<string, unknown> } | { ok: false; problem: Problem };

export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<BodyRead> {
  let raw: string;
  try {
    raw = await readBody(req, maxBytes);
  } catch (e) {
    if (e instanceof PayloadTooLargeError)
      return { ok: false, problem: problem(413, "payload_too_large", `request body exceeds ${maxBytes} bytes`) };
    throw e;
  }
  if (!raw.trim()) return { ok: true, raw, body: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, problem: problem(400, "bad_json", "request body must be valid JSON") };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { ok: false, problem: problem(400, "bad_json", "request body must be a JSON object") };
  return { ok: true, raw, body: parsed as Record<string, unknown> };
}

export interface RateLimiter {
  take(key: string): number | null;
}

export function createRateLimiter(perMin: number, now: () => number = Date.now): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    take(key: string): number | null {
      if (perMin <= 0) return null;
      const at = now();
      const window = windows.get(key);
      if (!window || at - window.start >= 60_000) {
        windows.set(key, { start: at, count: 1 });
        return null;
      }
      window.count += 1;
      if (window.count <= perMin) return null;
      return Math.max(1, Math.ceil((60_000 - (at - window.start)) / 1000));
    },
  };
}

export type GroupScope = { ok: true; scopeId: string; ref: string } | { ok: false; problem: Problem };

export function requireGroupScope(candidate: unknown): GroupScope {
  const scopeId = typeof candidate === "string" ? candidate.trim() : "";
  if (!scopeId) return { ok: false, problem: problem(400, "bad_request", "scopeId is required") };
  if (!scopeId.startsWith("group:") || scopeId.length <= "group:".length)
    return {
      ok: false,
      problem: problem(400, "bad_request", "scopeId must be a digital employee scope (group:…)"),
    };
  return { ok: true, scopeId, ref: scopeId.slice("group:".length) };
}

export type ConversationIdRead = { ok: true; conversationId: string } | { ok: false; problem: Problem };

export function readConversationId(candidate: unknown): ConversationIdRead {
  if (candidate === undefined || candidate === null || candidate === "")
    return { ok: true, conversationId: DEFAULT_CONVERSATION_ID };
  if (typeof candidate !== "string" || !CONVERSATION_ID.test(candidate))
    return {
      ok: false,
      problem: problem(400, "bad_request", `conversationId must match ${CONVERSATION_ID.source}`),
    };
  return { ok: true, conversationId: candidate };
}

export function openSse(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    [PROTOCOL_VERSION_HEADER]: PROTOCOL_VERSION,
  });
  res.write(": open\n\n");
}

export function sseEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
