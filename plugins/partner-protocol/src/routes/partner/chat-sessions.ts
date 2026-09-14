import { mintPartnerAssertion, threadRefFor } from "../../auth.ts";
import { asObject, stringField } from "../../core-client.ts";
import { readConversationId, requireGroupScope, sendJson, sendProblem } from "../../transport.ts";
import type { Ctx } from "../index.ts";

async function listSessions(c: Ctx): Promise<Record<string, unknown>[]> {
  const listed = await c.core("GET", `/v1/sessions?principalId=${encodeURIComponent(c.principalId)}`);
  if (!listed.ok || listed.status !== 200) return [];
  const sessions = asObject(listed.json)?.sessions;
  return Array.isArray(sessions)
    ? sessions.flatMap((entry): Record<string, unknown>[] => {
        const item = asObject(entry);
        return item ? [item] : [];
      })
    : [];
}

async function resolveSessionId(c: Ctx, threadRef: string): Promise<string> {
  for (const item of await listSessions(c)) {
    if (stringField(item, "threadRef") === threadRef) return stringField(item, "id");
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

export async function handleListChatSessions(c: Ctx): Promise<void> {
  const scoped = c.url.searchParams.get("scopeId");
  const scope = scoped ? requireGroupScope(scoped) : { ok: true as const, scopeId: "" };
  if (!scope.ok) return sendProblem(c.res, scope.problem);
  const prefix = `web:${c.principalId}:`;
  const conversations = (await listSessions(c)).flatMap((item) => {
    const threadRef = stringField(item, "threadRef");
    const scopeId = stringField(item, "scopeId");
    if (!threadRef?.startsWith(prefix) || !scopeId.startsWith("group:")) return [];
    if (scope.scopeId && scopeId !== scope.scopeId) return [];
    return [{ conversationId: threadRef.slice(prefix.length), scopeId, title: stringField(item, "title") || null }];
  });
  sendJson(c.res, 200, { conversations });
}
