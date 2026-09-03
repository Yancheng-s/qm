import { type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readBody, PayloadTooLargeError } from "../../../chassis/src/http.ts";
import { CORE_API_URL, CORE_SIGNING_SECRET } from "../../../chassis/src/env.ts";
import type { ProfilesConfig } from "./config.ts";
import {
  assembleProject,
  createSignedCoreClient,
  type AssembleInput,
  type AssembleOutcome,
  type CoreClient,
} from "./assemble.ts";
import {
  createMemoryAssemblyRegistry,
  createPostgresAssemblyRegistry,
  type AssemblyRegistry,
} from "./assemble-store.ts";

const MAX_BODY_BYTES = 8 * 1024;
const MAX_NAME_CHARS = 200;
const MAX_ID_CHARS = 200;

export interface ProfilesDeps {
  cfg: ProfilesConfig;
  core: CoreClient;
  registry: AssemblyRegistry;
}

function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}

function bearerToken(header: string | undefined): string | null {
  if (!header || !/^bearer /i.test(header)) return null;
  const token = header.slice(7).trim();
  return token || null;
}

function noStore(): Record<string, string> {
  return {
    "cache-control": "no-store",
    "content-type": "application/json",
    "x-content-type-options": "nosniff",
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, noStore());
  res.end(JSON.stringify(body));
}

function parseAssembleInput(raw: unknown): AssembleInput | { problem: string } {
  if (typeof raw !== "object" || raw === null) return { problem: "request body must be a JSON object" };
  const body = raw as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > MAX_NAME_CHARS) return { problem: "name is required (max 200 chars)" };
  const principalId = typeof body.principalId === "string" ? body.principalId.trim() : "";
  if (!principalId || principalId.length > MAX_ID_CHARS) return { problem: "principalId is required (max 200 chars)" };
  const externalId = typeof body.externalId === "string" ? body.externalId.trim() : "";
  if (externalId.length > MAX_ID_CHARS) return { problem: "externalId too long (max 200 chars)" };
  return { name, principalId, ...(externalId ? { externalId } : {}) };
}

function outcomeStatus(outcome: AssembleOutcome): number {
  if (outcome.status === "assembled") return 200;
  if (outcome.code === "library_empty") return 400;
  return 502;
}

export function createProfilesHandler(
  deps: ProfilesDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://h5.local");

    if (method === "POST" && url.pathname === "/assemble") {
      const token = bearerToken(req.headers.authorization);
      if (!token || !safeEqual(token, deps.cfg.assembleKey)) {
        res.writeHead(401, { ...noStore(), "www-authenticate": 'Bearer realm="qm-profiles"' });
        return void res.end(JSON.stringify({ error: "invalid_key" }));
      }
      let raw: string;
      try {
        raw = await readBody(req, MAX_BODY_BYTES);
      } catch (e) {
        if (e instanceof PayloadTooLargeError) return sendJson(res, 413, { error: "payload_too_large" });
        throw e;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return sendJson(res, 400, { error: "bad_json" });
      }
      const input = parseAssembleInput(parsed);
      if ("problem" in input) return sendJson(res, 400, { error: "bad_request", message: input.problem });
      const outcome = await assembleProject(deps, input);
      return sendJson(res, outcomeStatus(outcome), outcome);
    }

    return sendJson(res, 404, { error: "not_found" });
  };
}

export async function bootProfiles(
  cfg: ProfilesConfig,
  databaseUrl: string | undefined,
): Promise<(req: IncomingMessage, res: ServerResponse) => Promise<void>> {
  const registry = databaseUrl ? await createPostgresAssemblyRegistry(databaseUrl) : createMemoryAssemblyRegistry();
  const core = createSignedCoreClient(CORE_API_URL, CORE_SIGNING_SECRET);
  return createProfilesHandler({ cfg, core, registry });
}
