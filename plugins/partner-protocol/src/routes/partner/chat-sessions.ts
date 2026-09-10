import { mintPartnerAssertion, threadRefFor } from "../../auth.ts";
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

function chatSessionUrl(c: Ctx, sessionId: string, scopeId: string, conversationId: string): string {
  const landing = new URL("/chat/", c.partnerWebRedirectUrl);
  landing.searchParams.set("scopeId", scopeId);
  landing.searchParams.set("conversationId", conversationId);
  if (sessionId) landing.searchParams.set("session", sessionId);
  const query = new URLSearchParams({
    returnTo: `${landing.pathname}${landing.search}`,
    assertion: mintPartnerAssertion(c.principalId, c.identitySecret),
  });
  return `/auth/login?${query.toString()}`;
}

export async function handleChatSessions(c: Ctx): Promise<void> {
  const scope = requireGroupScope(c.body.scopeId);
  if (!scope.ok) return sendProblem(c.res, scope.problem);
  const conversation = readConversationId(c.body.conversationId);
  if (!conversation.ok) return sendProblem(c.res, conversation.problem);

  const sessionId = await resolveSessionId(c, threadRefFor(c.principalId, conversation.conversationId));
  sendJson(c.res, 200, {
    chatUrl: chatSessionUrl(c, sessionId, scope.scopeId, conversation.conversationId),
  });
}
