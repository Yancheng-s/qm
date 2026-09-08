import { threadRefFor } from "../../auth.ts";
import { asObject, relayProblem, upstreamProblem } from "../../core-client.ts";
import { problem, readConversationId, requireGroupScope, sendJson, sendProblem, type Problem } from "../../transport.ts";
import type { Ctx } from "../index.ts";

const OPTIONAL_STRINGS = ["model", "harness", "thinkingLevel", "timezone"] as const;
const APPROVAL_SCOPES = ["once", "session", "always"] as const;

interface Approval {
  requestId: string;
  approved: boolean;
  scope?: (typeof APPROVAL_SCOPES)[number];
}

type ApprovalRead = { ok: true; approval?: Approval } | { ok: false; problem: Problem };

function readApproval(candidate: unknown): ApprovalRead {
  if (candidate === undefined || candidate === null) return { ok: true };
  const item = asObject(candidate);
  if (!item) return { ok: false, problem: problem(400, "bad_request", "approval must be an object") };
  const requestId = typeof item.requestId === "string" ? item.requestId.trim() : "";
  if (!requestId || typeof item.approved !== "boolean")
    return {
      ok: false,
      problem: problem(400, "bad_request", "approval requires requestId and a boolean approved"),
    };
  const scope = APPROVAL_SCOPES.find((allowed) => allowed === item.scope);
  return { ok: true, approval: { requestId, approved: item.approved, ...(scope ? { scope } : {}) } };
}

export async function handleTurn(c: Ctx): Promise<void> {
  const scope = requireGroupScope(c.body.scopeId);
  if (!scope.ok) return sendProblem(c.res, scope.problem);
  const conversation = readConversationId(c.body.conversationId);
  if (!conversation.ok) return sendProblem(c.res, conversation.problem);
  const approvalRead = readApproval(c.body.approval);
  if (!approvalRead.ok) return sendProblem(c.res, approvalRead.problem);

  const text = typeof c.body.text === "string" ? c.body.text : "";
  if (!text.trim() && !approvalRead.approval)
    return sendProblem(c.res, problem(400, "bad_request", "text is required"));

  const threadRef = threadRefFor(c.principalId, conversation.conversationId);
  const turn: Record<string, unknown> = {
    surface: "web",
    actor: { externalId: c.principalId },
    conversation: { kind: "group", channelRef: scope.ref, threadRef },
    liveActor: true,
    deliveryTarget: threadRef,
    text,
  };
  for (const key of OPTIONAL_STRINGS) {
    const value = c.body[key];
    if (typeof value === "string" && value.trim()) turn[key] = value;
  }
  if (approvalRead.approval) turn.approval = approvalRead.approval;

  const outcome = await c.core("POST", "/v1/turns?async=1", turn);
  if (!outcome.ok) return sendProblem(c.res, outcome.problem);
  if (outcome.status === 200 || outcome.status === 202)
    return sendJson(c.res, outcome.status, { ...asObject(outcome.json), threadRef });
  if (outcome.status === 400 || outcome.status === 403) {
    const refused = outcome.status === 403 ? "refused" : undefined;
    return sendProblem(c.res, relayProblem(outcome.status, outcome.json, refused));
  }
  return sendProblem(c.res, upstreamProblem(outcome.status, outcome.json, "core rejected the turn"));
}
