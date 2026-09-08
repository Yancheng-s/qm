import { asObject, relayProblem, upstreamProblem } from "../core-client.ts";
import { requireGroupScope, sendJson, sendProblem } from "../transport.ts";
import type { Ctx } from "./index.ts";

export async function handleRuntime(c: Ctx): Promise<void> {
  const scope = requireGroupScope(c.url.searchParams.get("scopeId"));
  if (!scope.ok) return sendProblem(c.res, scope.problem);

  const query = `principalId=${encodeURIComponent(c.principalId)}&scopeId=${encodeURIComponent(scope.scopeId)}`;
  const outcome = await c.core("GET", `/v1/runtime-config?${query}`);
  if (!outcome.ok) return sendProblem(c.res, outcome.problem);
  if (outcome.status === 403) return sendProblem(c.res, relayProblem(outcome.status, outcome.json, "refused"));
  if (outcome.status !== 200)
    return sendProblem(c.res, upstreamProblem(outcome.status, outcome.json, "runtime lookup failed"));

  const body = asObject(outcome.json);
  if (!body)
    return sendProblem(c.res, upstreamProblem(outcome.status, outcome.json, "core returned an unexpected runtime"));

  sendJson(c.res, 200, {
    scopeId: scope.scopeId,
    harnesses: body.approvedHarnesses ?? [],
    modelsByHarness: body.modelsByHarness ?? {},
    modelCatalog: body.modelCatalog ?? {},
    effective: body.effective ?? null,
  });
}
