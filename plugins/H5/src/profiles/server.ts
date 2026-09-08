import { type IncomingMessage, type ServerResponse } from "node:http";
import { CORE_API_URL, CORE_SIGNING_SECRET } from "../../../chassis/src/env.ts";
import { readSignedBody } from "../signed-request.ts";
import { LIBRARY_KEY, type ProfilesConfig } from "./config.ts";
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
  signingSecret: string | undefined;
  core: CoreClient;
  registry: AssemblyRegistry;
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
  const library = typeof body.library === "string" ? body.library.trim() : "";
  if (!library) return { problem: "library is required" };
  if (!LIBRARY_KEY.test(library)) return { problem: `library must match ${LIBRARY_KEY.source}` };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > MAX_NAME_CHARS) return { problem: "name is required (max 200 chars)" };
  const principalId = typeof body.principalId === "string" ? body.principalId.trim() : "";
  if (!principalId || principalId.length > MAX_ID_CHARS) return { problem: "principalId is required (max 200 chars)" };
  const externalId = typeof body.externalId === "string" ? body.externalId.trim() : "";
  if (externalId.length > MAX_ID_CHARS) return { problem: "externalId too long (max 200 chars)" };
  const soul = typeof body.soul === "string" ? body.soul.trim() : "";
  return { library, name, principalId, ...(externalId ? { externalId } : {}), ...(soul ? { soul } : {}) };
}

function outcomeStatus(outcome: AssembleOutcome): number {
  if (outcome.status === "assembled") return 200;
  if (outcome.code === "unknown_library") return 400;
  return 502;
}

export function createProfilesHandler(
  deps: ProfilesDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://h5.local");

    if (method === "POST" && url.pathname === "/assemble") {
      const signed = await readSignedBody(req, {
        secret: deps.signingSecret,
        method,
        pathWithQuery: url.pathname + url.search,
        maxBytes: MAX_BODY_BYTES,
      });
      if (!signed.ok) return sendJson(res, signed.status, signed.body);
      let parsed: unknown;
      try {
        parsed = JSON.parse(signed.raw);
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
  const legacyLibrary = cfg.libraries.length === 1 ? cfg.libraries[0]!.key : "";
  const registry = databaseUrl
    ? await createPostgresAssemblyRegistry(databaseUrl, legacyLibrary)
    : createMemoryAssemblyRegistry();
  const core = createSignedCoreClient(CORE_API_URL, CORE_SIGNING_SECRET);
  return createProfilesHandler({ cfg, signingSecret: CORE_SIGNING_SECRET, core, registry });
}
