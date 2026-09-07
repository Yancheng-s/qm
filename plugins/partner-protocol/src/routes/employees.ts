import { asObject, numberField, stringField, upstreamProblem } from "../core-client.ts";
import { sendJson, sendProblem } from "../transport.ts";
import type { Ctx } from "./index.ts";

export async function handleEmployees(c: Ctx): Promise<void> {
  const outcome = await c.core("GET", `/v1/projects?principalId=${encodeURIComponent(c.principalId)}`);
  if (!outcome.ok) return sendProblem(c.res, outcome.problem);
  if (outcome.status !== 200)
    return sendProblem(c.res, upstreamProblem(outcome.status, outcome.json, "employee listing failed"));

  const listed = asObject(outcome.json)?.projects;
  if (!Array.isArray(listed))
    return sendProblem(c.res, upstreamProblem(outcome.status, outcome.json, "core returned an unexpected listing"));

  const employees = listed
    .map((entry) => asObject(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => ({
      id: stringField(entry, "id"),
      name: stringField(entry, "name"),
      scopeId: stringField(entry, "scopeId"),
      createdAt: numberField(entry, "createdAt") ?? 0,
    }))
    .filter((employee) => employee.id !== "" && employee.scopeId !== "");

  sendJson(c.res, 200, { employees });
}
