import type { FastifyRequest } from "fastify";

const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type AuthOutcome = { ok: true; userId: string } | { ok: false; status: number; error: string; message: string };

export function authenticate(req: FastifyRequest): AuthOutcome {
  const header = req.headers["x-user-id"];
  const userId = Array.isArray(header) ? header[0] : header;
  const candidate = typeof userId === "string" ? userId.trim() : "";
  if (!candidate) return { ok: false, status: 401, error: "unauthorized", message: "missing x-user-id header" };
  if (!USER_ID.test(candidate))
    return { ok: false, status: 400, error: "bad_request", message: `x-user-id must match ${USER_ID.source}` };
  return { ok: true, userId: candidate };
}
