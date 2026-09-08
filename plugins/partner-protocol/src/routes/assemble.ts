import { asObject, stringField, upstreamProblem, type CoreCall, type CoreOutcome } from "../core-client.ts";
import { problem, sendJson, sendProblem, type Problem } from "../transport.ts";
import type { Ctx } from "./index.ts";

export const MAX_NAME_CHARS = 200;
export const MAX_LIBRARY_SKILLS = 50;
export const MAX_SOUL_BYTES = 8 * 1024;
export const MAX_STANDING_ORDERS_CHARS = 20_000;
const SKILL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

interface AssembleRequest {
  name: string;
  library?: string;
  skills: readonly string[];
  soul?: string;
  standingOrders?: string;
}

export interface AssembleInput extends AssembleRequest {
  principalId: string;
}

export interface AssembleDeps {
  core: CoreCall;
  libraryCore: CoreCall;
  libraries: ReadonlyMap<string, string>;
  libraryPrincipalId: string;
}

interface LibrarySkill {
  id: string;
  name: string;
}

export type AssembleOutcome =
  | {
      status: "assembled";
      employee: { id: string; scopeId: string; name: string };
      granted: readonly string[];
      grantFailures?: readonly { name: string; error: string }[];
      soul: boolean;
      soulError?: string;
      standingOrders: boolean;
      standingOrdersError?: string;
    }
  | { status: "failed"; problem: Problem };

export type AssembleParse = { ok: true; request: AssembleRequest } | { ok: false; problem: Problem };

export function parseAssembleBody(body: Record<string, unknown>): AssembleParse {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > MAX_NAME_CHARS)
    return {
      ok: false,
      problem: problem(400, "bad_request", `name is required (max ${MAX_NAME_CHARS} chars)`),
    };

  let library: string | undefined;
  if (body.library !== undefined && body.library !== null && body.library !== "") {
    if (typeof body.library !== "string")
      return { ok: false, problem: problem(400, "bad_request", "library must be a string") };
    library = body.library.trim();
  }

  const skills: string[] = [];
  if (body.skills !== undefined && body.skills !== null) {
    if (!Array.isArray(body.skills))
      return { ok: false, problem: problem(400, "bad_request", "skills must be an array of skill names") };
    if (body.skills.length > MAX_LIBRARY_SKILLS)
      return {
        ok: false,
        problem: problem(400, "bad_request", `skills accepts at most ${MAX_LIBRARY_SKILLS} entries`),
      };
    const seen = new Set<string>();
    for (const entry of body.skills) {
      const skillName = typeof entry === "string" ? entry.trim() : "";
      if (!SKILL_NAME.test(skillName))
        return {
          ok: false,
          problem: problem(400, "bad_request", `each skill must be a name matching ${SKILL_NAME.source}`),
        };
      if (seen.has(skillName))
        return {
          ok: false,
          problem: problem(400, "bad_request", `skill "${skillName}" appears twice in this request`),
        };
      seen.add(skillName);
      skills.push(skillName);
    }
  }

  let soul: string | undefined;
  if (body.soul !== undefined && body.soul !== null && body.soul !== "") {
    if (typeof body.soul !== "string")
      return { ok: false, problem: problem(400, "bad_request", "soul must be a string") };
    if (Buffer.byteLength(body.soul, "utf8") > MAX_SOUL_BYTES)
      return { ok: false, problem: problem(400, "bad_request", `soul exceeds ${MAX_SOUL_BYTES} bytes`) };
    soul = body.soul;
  }

  let standingOrders: string | undefined;
  if (body.standingOrders !== undefined && body.standingOrders !== null && body.standingOrders !== "") {
    if (typeof body.standingOrders !== "string")
      return { ok: false, problem: problem(400, "bad_request", "standingOrders must be a string") };
    if (body.standingOrders.length > MAX_STANDING_ORDERS_CHARS)
      return {
        ok: false,
        problem: problem(400, "bad_request", `standingOrders exceeds ${MAX_STANDING_ORDERS_CHARS} characters`),
      };
    standingOrders = body.standingOrders;
  }

  return {
    ok: true,
    request: {
      name,
      skills,
      ...(library ? { library } : {}),
      ...(soul ? { soul } : {}),
      ...(standingOrders ? { standingOrders } : {}),
    },
  };
}

function failureMessage(outcome: CoreOutcome): string {
  if (!outcome.ok) return "core unreachable";
  return stringField(outcome.json, "error") || `core replied ${outcome.status}`;
}

function librarySkills(json: unknown, libraryScopeId: string): LibrarySkill[] {
  const listed = asObject(json)?.skills;
  if (!Array.isArray(listed)) return [];
  const skills: LibrarySkill[] = [];
  for (const entry of listed) {
    const item = asObject(entry);
    if (!item) continue;
    if (typeof item.id !== "string" || typeof item.name !== "string") continue;
    if (item.status === "archived") continue;
    if (item.scopeId !== libraryScopeId) continue;
    skills.push({ id: item.id, name: item.name });
  }
  return skills;
}

function resolveLibrary(
  deps: AssembleDeps,
  requested: string | undefined,
): { key: string; scopeId: string } | { problem: Problem } {
  const known = [...deps.libraries.keys()];
  const key = requested ?? (known.length === 1 ? known[0]! : "");
  if (!key) return { problem: problem(400, "bad_request", `library is required (bound: ${known.join(", ")})`) };
  const scopeId = deps.libraries.get(key);
  if (!scopeId)
    return { problem: problem(400, "bad_request", `unknown library "${key}" (bound: ${known.join(", ")})`) };
  return { key, scopeId };
}

export async function assembleEmployee(deps: AssembleDeps, input: AssembleInput): Promise<AssembleOutcome> {
  const library = resolveLibrary(deps, input.library);
  if ("problem" in library) return { status: "failed", problem: library.problem };

  const listed = await deps.libraryCore("GET", `/v1/skills?principalId=${encodeURIComponent(deps.libraryPrincipalId)}`);
  if (!listed.ok) return { status: "failed", problem: listed.problem };
  if (listed.status !== 200)
    return { status: "failed", problem: upstreamProblem(listed.status, listed.json, "skill listing failed") };
  const available = librarySkills(listed.json, library.scopeId);

  let selected = available;
  if (input.skills.length) {
    const byName = new Map(available.map((skill) => [skill.name, skill]));
    const unknown = input.skills.filter((name) => !byName.has(name));
    if (unknown.length)
      return {
        status: "failed",
        problem: problem(400, "bad_request", `unknown skill(s) in library "${library.key}": ${unknown.join(", ")}`),
      };
    selected = input.skills.map((name) => byName.get(name)!);
  }
  if (!selected.length)
    return {
      status: "failed",
      problem: problem(400, "bad_request", `library "${library.key}" holds no skill to grant`),
    };

  const created = await deps.core("POST", "/v1/projects", { principalId: input.principalId, name: input.name });
  if (!created.ok) return { status: "failed", problem: created.problem };
  if (created.status !== 201)
    return { status: "failed", problem: upstreamProblem(created.status, created.json, "project creation failed") };

  const project = asObject(created.json)?.project;
  const projectId = stringField(project, "id");
  const scopeId = stringField(project, "scopeId");
  if (!projectId || !scopeId)
    return {
      status: "failed",
      problem: upstreamProblem(created.status, created.json, "core returned a project without id/scopeId"),
    };

  const granted: string[] = [];
  const grantFailures: { name: string; error: string }[] = [];
  for (const skill of selected) {
    const outcome = await deps.libraryCore("POST", "/v1/grants", {
      ownerScopeId: library.scopeId,
      ref: `skill:${skill.id}`,
      granteeScopeId: scopeId,
      permission: "read",
      grantedBy: deps.libraryPrincipalId,
    });
    if (outcome.ok && outcome.status === 200) granted.push(skill.name);
    else grantFailures.push({ name: skill.name, error: failureMessage(outcome) });
  }

  let soul = false;
  let soulError: string | undefined;
  if (input.soul) {
    const outcome = await deps.core("POST", "/v1/soul", {
      scopeId,
      content: input.soul,
      actorId: input.principalId,
    });
    if (outcome.ok && outcome.status === 200) soul = true;
    else soulError = failureMessage(outcome);
  }

  let standingOrders = false;
  let standingOrdersError: string | undefined;
  if (input.standingOrders) {
    const outcome = await deps.core("PUT", "/v1/contexts/policy", {
      principalId: input.principalId,
      scope: scopeId,
      orders: input.standingOrders,
    });
    if (outcome.ok && outcome.status === 200) standingOrders = true;
    else standingOrdersError = failureMessage(outcome);
  }

  return {
    status: "assembled",
    employee: { id: projectId, scopeId, name: input.name },
    granted,
    ...(grantFailures.length ? { grantFailures } : {}),
    soul,
    ...(soulError ? { soulError } : {}),
    standingOrders,
    ...(standingOrdersError ? { standingOrdersError } : {}),
  };
}

export async function handleAssemble(c: Ctx): Promise<void> {
  const parsed = parseAssembleBody(c.body);
  if (!parsed.ok) return sendProblem(c.res, parsed.problem);
  const outcome = await assembleEmployee(
    {
      core: c.core,
      libraryCore: c.libraryCore,
      libraries: c.libraries,
      libraryPrincipalId: c.libraryPrincipalId,
    },
    { principalId: c.principalId, ...parsed.request },
  );
  if (outcome.status === "failed") return sendProblem(c.res, outcome.problem);
  sendJson(c.res, 201, {
    employee: outcome.employee,
    granted: outcome.granted,
    ...(outcome.grantFailures ? { grantFailures: outcome.grantFailures } : {}),
    soul: outcome.soul,
    ...(outcome.soulError ? { soulError: outcome.soulError } : {}),
    standingOrders: outcome.standingOrders,
    ...(outcome.standingOrdersError ? { standingOrdersError: outcome.standingOrdersError } : {}),
  });
}
