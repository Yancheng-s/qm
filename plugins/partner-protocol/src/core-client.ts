import { createHash } from "node:crypto";
import {
  signedHeaders,
  signedRequestHeaders,
  withSourceAuthNonce,
  type HttpMethod,
} from "../../chassis/src/core-client.ts";
import { PORTAL_IDENTITY_HEADER, mintPortalIdentity } from "../../chassis/src/portal-identity.ts";
import { problem, type Problem } from "./transport.ts";

const IDENTITY_TTL_MS = 60_000;
const CORE_TIMEOUT_MS = 15_000;

export interface CoreDeps {
  coreApiUrl: string;
  signingSecret: string | undefined;
  identitySecret: string;
  timeoutMs?: number;
}

export type CoreOutcome = { ok: true; status: number; json: unknown } | { ok: false; problem: Problem };

export interface CoreCall {
  (method: HttpMethod, pathWithQuery: string, body?: unknown): Promise<CoreOutcome>;
  stageBlob?(data: Uint8Array): Promise<CoreOutcome>;
}

export function createCoreCall(deps: CoreDeps, principalId: string): CoreCall {
  const parseJsonResponse = async (response: Response): Promise<CoreOutcome> => {
    const text = await response.text();
    if (!text) return { ok: true, status: response.status, json: null };
    try {
      return { ok: true, status: response.status, json: JSON.parse(text) as unknown };
    } catch {
      return {
        ok: false,
        problem: problem(502, "upstream_error", `core returned a non-JSON ${response.status} response`),
      };
    }
  };

  const call = async (method: HttpMethod, pathWithQuery: string, body?: unknown): Promise<CoreOutcome> => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const path = withSourceAuthNonce(pathWithQuery, deps.signingSecret);
    let response: Response;
    try {
      response = await fetch(`${deps.coreApiUrl}${path}`, {
        method,
        headers: {
          ...signedHeaders(deps.signingSecret, method, path, raw),
          [PORTAL_IDENTITY_HEADER]: mintPortalIdentity(
            { p: principalId, exp: Date.now() + IDENTITY_TTL_MS },
            deps.identitySecret,
          ),
        },
        ...(raw ? { body: raw } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(deps.timeoutMs ?? CORE_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, problem: problem(502, "upstream_error", "core unreachable") };
    }
    return parseJsonResponse(response);
  };

  return Object.assign(call, {
    async stageBlob(data: Uint8Array): Promise<CoreOutcome> {
      const path = withSourceAuthNonce("/v1/blobs", deps.signingSecret);
      const sha256 = createHash("sha256").update(data).digest("hex");
      let response: Response;
      try {
        response = await fetch(`${deps.coreApiUrl}${path}`, {
          method: "POST",
          headers: {
            ...signedRequestHeaders(deps.signingSecret, "POST", path, sha256, {
              "content-type": "application/octet-stream",
              "x-content-sha256": sha256,
            }),
            [PORTAL_IDENTITY_HEADER]: mintPortalIdentity(
              { p: principalId, exp: Date.now() + IDENTITY_TTL_MS },
              deps.identitySecret,
            ),
          },
          body: Buffer.from(data),
          redirect: "manual",
          signal: AbortSignal.timeout(deps.timeoutMs ?? CORE_TIMEOUT_MS),
        });
      } catch {
        return { ok: false, problem: problem(502, "upstream_error", "core unreachable") };
      }
      return parseJsonResponse(response);
    },
  });
}

export function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function stringField(source: unknown, key: string): string {
  const value = asObject(source)?.[key];
  return typeof value === "string" ? value : "";
}

export function numberField(source: unknown, key: string): number | undefined {
  const value = asObject(source)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function booleanField(source: unknown, key: string): boolean | undefined {
  const value = asObject(source)?.[key];
  return typeof value === "boolean" ? value : undefined;
}

export function upstreamProblem(status: number, json: unknown, message: string): Problem {
  const upstream: Record<string, unknown> = { status };
  const error = stringField(json, "error");
  const detail = stringField(json, "message");
  if (error) upstream.error = error;
  if (detail) upstream.message = detail;
  return problem(502, "upstream_error", message, { upstream });
}

const RELAY_ERROR_CODES: ReadonlyMap<number, string> = new Map([
  [400, "bad_request"],
  [403, "forbidden"],
  [404, "not_found"],
  [409, "exists"],
]);

export function relayProblem(status: number, json: unknown, override?: string): Problem {
  const error = stringField(json, "error") || override || RELAY_ERROR_CODES.get(status) || "upstream_error";
  const message = stringField(json, "message") || stringField(json, "reason") || `core replied ${status}`;
  return { status, body: { error, message } };
}
