import { mintChatToken, threadRefFor } from "../../auth.ts";
import { asObject, stringField } from "../../core-client.ts";
import { readConversationId, requireGroupScope, sendJson, sendProblem } from "../../transport.ts";
import type { Ctx } from "../index.ts";

async function resolveSessionId(c: Ctx, threadRef: string): Promise<string> {
  const listed = await c.core("GET", `/v1/sessions?principalId=${encodeURIComponent(c.principalId)}`);
  if (!listed.ok || listed.status !== 200) return "";
  const sessions = asObject(listed.json)?.sessions;
  if (!Array.isArray(sessions)) return "";
  for (const entry of sessions) {
    const item = asObject(entry);
    if (item && stringField(item, "threadRef") === threadRef) return stringField(item, "id");
  }
  return "";
}

export async function handleChatSessions(c: Ctx): Promise<void> {
  const scope = requireGroupScope(c.body.scopeId);
  if (!scope.ok) return sendProblem(c.res, scope.problem);
  const conversation = readConversationId(c.body.conversationId);
  if (!conversation.ok) return sendProblem(c.res, conversation.problem);

  const token = mintChatToken(c.principalId, c.identitySecret);
  const sessionId = await resolveSessionId(c, threadRefFor(c.principalId, conversation.conversationId));

  const query = new URLSearchParams({
    token,
    scopeId: scope.scopeId,
    conversationId: conversation.conversationId,
  });
  if (sessionId) query.set("sessionId", sessionId);
  sendJson(c.res, 200, { chatUrl: `/chat?${query.toString()}` });
}
