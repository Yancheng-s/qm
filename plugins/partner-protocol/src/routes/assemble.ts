import { asObject, stringField, upstreamProblem, type CoreCall, type CoreOutcome } from "../core-client.ts";
import { problem, sendJson, sendProblem, type Problem } from "../transport.ts";
import { parseSkillFields, type SkillInput } from "./skills.ts";
import type { Ctx } from "./index.ts";

export const MAX_NAME_CHARS = 200;
export const MAX_SKILLS = 20;
export const MAX_SOUL_BYTES = 8 * 1024;

interface AssembleRequest {
  name: string;
  skills: readonly SkillInput[];
  soul?: string;
}

export interface AssembleInput extends AssembleRequest {
  principalId: string;
}

interface SkillOutcome {
  name: string;
  ok: boolean;
  error?: string;
}

export type AssembleOutcome =
  | {
      status: "assembled";
      employee: { id: string; scopeId: string; name: string };
      skills: readonly SkillOutcome[];
      soul: boolean;
      soulError?: string;
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

  let soul: string | undefined;
  if (body.soul !== undefined && body.soul !== null && body.soul !== "") {
    if (typeof body.soul !== "string")
      return { ok: false, problem: problem(400, "bad_request", "soul must be a string") };
    if (Buffer.byteLength(body.soul, "utf8") > MAX_SOUL_BYTES)
      return { ok: false, problem: problem(400, "bad_request", `soul exceeds ${MAX_SOUL_BYTES} bytes`) };
    soul = body.soul;
  }

  const listed = body.skills ?? [];
  if (!Array.isArray(listed)) return { ok: false, problem: problem(400, "bad_request", "skills must be an array") };
  if (listed.length > MAX_SKILLS)
    return { ok: false, problem: problem(400, "bad_request", `skills accepts at most ${MAX_SKILLS} entries`) };

  const skills: SkillInput[] = [];
  const seen = new Set<string>();
  for (const entry of listed) {
    const parsed = parseSkillFields(entry, "skill");
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.skill.name))
      return {
        ok: false,
        problem: problem(400, "bad_request", `skill "${parsed.skill.name}" appears twice in this request`),
      };
    seen.add(parsed.skill.name);
    skills.push(parsed.skill);
  }

  return { ok: true, request: { name, skills, ...(soul ? { soul } : {}) } };
}

function failureMessage(outcome: CoreOutcome): string {
  if (!outcome.ok) return "core unreachable";
  return stringField(outcome.json, "error") || `core replied ${outcome.status}`;
}

function skillOutcome(name: string, outcome: CoreOutcome): SkillOutcome {
  if (outcome.ok && outcome.status === 201) return { name, ok: true };
  return { name, ok: false, error: failureMessage(outcome) };
}

export async function assembleEmployee(core: CoreCall, input: AssembleInput): Promise<AssembleOutcome> {
  const created = await core("POST", "/v1/projects", { principalId: input.principalId, name: input.name });
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

  const skills: SkillOutcome[] = [];
  for (const skill of input.skills) {
    const outcome = await core("POST", "/v1/skills", {
      principalId: input.principalId,
      scopeId,
      name: skill.name,
      description: skill.description,
      body: skill.body,
    });
    skills.push(skillOutcome(skill.name, outcome));
  }

  let soul = false;
  let soulError: string | undefined;
  if (input.soul) {
    const outcome = await core("POST", "/v1/soul", {
      scopeId,
      content: input.soul,
      actorId: input.principalId,
    });
    if (outcome.ok && outcome.status === 200) soul = true;
    else soulError = failureMessage(outcome);
  }

  return {
    status: "assembled",
    employee: { id: projectId, scopeId, name: input.name },
    skills,
    soul,
    ...(soulError ? { soulError } : {}),
  };
}

export async function handleAssemble(c: Ctx): Promise<void> {
  const parsed = parseAssembleBody(c.body);
  if (!parsed.ok) return sendProblem(c.res, parsed.problem);
  const outcome = await assembleEmployee(c.core, { principalId: c.principalId, ...parsed.request });
  if (outcome.status === "failed") return sendProblem(c.res, outcome.problem);
  sendJson(c.res, 201, {
    employee: outcome.employee,
    skills: outcome.skills,
    soul: outcome.soul,
    ...(outcome.soulError ? { soulError: outcome.soulError } : {}),
  });
}
