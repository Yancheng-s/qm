import { asObject, relayProblem, stringField, upstreamProblem } from "../core-client.ts";
import { problem, requireGroupScope, sendJson, sendProblem, type Problem } from "../transport.ts";
import type { Ctx } from "./index.ts";

const SKILL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_DESCRIPTION_CHARS = 500;
export const MAX_SKILL_BODY_BYTES = 128 * 1024;

export interface SkillInput {
  name: string;
  description: string;
  body: string;
}

export type SkillFields = { ok: true; skill: SkillInput } | { ok: false; problem: Problem };

export function parseSkillFields(source: unknown, label: string): SkillFields {
  const item = asObject(source);
  if (!item) return { ok: false, problem: problem(400, "bad_request", `${label} must be an object`) };
  const name = typeof item.name === "string" ? item.name.trim() : "";
  if (!SKILL_NAME.test(name))
    return {
      ok: false,
      problem: problem(400, "bad_request", `${label} name must match ${SKILL_NAME.source}`),
    };
  const description = typeof item.description === "string" ? item.description.trim() : "";
  if (!description || description.length > MAX_DESCRIPTION_CHARS)
    return {
      ok: false,
      problem: problem(
        400,
        "bad_request",
        `${label} "${name}" needs a description (max ${MAX_DESCRIPTION_CHARS} chars)`,
      ),
    };
  const body = typeof item.body === "string" ? item.body : "";
  if (!body.trim()) return { ok: false, problem: problem(400, "bad_request", `${label} "${name}" needs a body`) };
  if (Buffer.byteLength(body, "utf8") > MAX_SKILL_BODY_BYTES)
    return {
      ok: false,
      problem: problem(400, "bad_request", `${label} "${name}" body exceeds ${MAX_SKILL_BODY_BYTES} bytes`),
    };
  return { ok: true, skill: { name, description, body } };
}

export async function handleSkillCreate(c: Ctx): Promise<void> {
  const scope = requireGroupScope(c.body.scopeId);
  if (!scope.ok) return sendProblem(c.res, scope.problem);
  const parsed = parseSkillFields(c.body, "skill");
  if (!parsed.ok) return sendProblem(c.res, parsed.problem);

  const outcome = await c.core("POST", "/v1/skills", {
    principalId: c.principalId,
    scopeId: scope.scopeId,
    name: parsed.skill.name,
    description: parsed.skill.description,
    body: parsed.skill.body,
  });
  if (!outcome.ok) return sendProblem(c.res, outcome.problem);
  if (outcome.status === 201) {
    const skill = asObject(outcome.json)?.skill;
    return sendJson(c.res, 201, {
      skill: { id: stringField(skill, "id"), name: stringField(skill, "name") || parsed.skill.name },
    });
  }
  if (outcome.status === 400 || outcome.status === 403 || outcome.status === 409)
    return sendProblem(c.res, relayProblem(outcome.status, outcome.json));
  return sendProblem(c.res, upstreamProblem(outcome.status, outcome.json, "skill creation failed"));
}
