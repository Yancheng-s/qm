import { stringField, type CoreOutcome } from "../../core-client.ts";
import { problem, sendJson, sendProblem, type Problem } from "../../transport.ts";
import type { Ctx } from "../index.ts";
import { CONNECTOR_HOST, MAX_ACCESS_TOKEN_CHARS } from "./assemble.ts";

export interface ReplaceConnector {
  host: string;
  accessToken: string;
  expiresAt?: number | string;
}

export type ReplaceConnectorParse = { ok: true; connector: ReplaceConnector } | { ok: false; problem: Problem };

export function parseReplaceConnector(body: Record<string, unknown>): ReplaceConnectorParse {
  const host = typeof body.host === "string" ? body.host.trim() : "";
  const accessToken = typeof body.accessToken === "string" ? body.accessToken.trim() : "";
  if (!CONNECTOR_HOST.test(host)) {
    return { ok: false, problem: problem(400, "bad_request", "host must be a credential host") };
  }
  if (!accessToken || accessToken.length > MAX_ACCESS_TOKEN_CHARS) {
    return {
      ok: false,
      problem: problem(400, "bad_request", `accessToken is required (max ${MAX_ACCESS_TOKEN_CHARS} chars)`),
    };
  }
  if (body.expiresAt === undefined || body.expiresAt === null || body.expiresAt === "") {
    return { ok: true, connector: { host, accessToken } };
  }
  if (typeof body.expiresAt !== "number" && typeof body.expiresAt !== "string") {
    return { ok: false, problem: problem(400, "bad_request", "expiresAt must be an epoch timestamp or an ISO date") };
  }
  return { ok: true, connector: { host, accessToken, expiresAt: body.expiresAt } };
}

function failure(outcome: CoreOutcome): Problem {
  if (!outcome.ok) return problem(502, "connector_token_failed", "core unreachable");
  if (outcome.status === 400) {
    return problem(400, "bad_request", stringField(outcome.json, "message") || "connector token was rejected");
  }
  return problem(502, "connector_token_failed", "connector token was not saved");
}

export async function handleReplaceConnector(c: Ctx): Promise<void> {
  const parsed = parseReplaceConnector(c.body);
  if (!parsed.ok) return sendProblem(c.res, parsed.problem);
  const { host, accessToken, expiresAt } = parsed.connector;
  const outcome = await c.core("POST", "/v1/connectors/token", {
    host,
    principalId: c.principalId,
    accessToken,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  });
  if (!outcome.ok || outcome.status !== 200) return sendProblem(c.res, failure(outcome));
  sendJson(c.res, 200, { host });
}
