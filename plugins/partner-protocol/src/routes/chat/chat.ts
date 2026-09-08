import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { escapeHtml } from "../../../../chassis/src/http.ts";
import { CHAT_COOKIE, CHAT_TOKEN_TTL_MS } from "../../auth.ts";
import { readConversationId, requireGroupScope, sendHtml, sendProblem } from "../../transport.ts";
import type { Ctx } from "../index.ts";

const CHAT_HTML = readFileSync(fileURLToPath(new URL("../../../web/chat.html", import.meta.url)), "utf8");
const COOKIE_MAX_AGE_S = Math.floor(CHAT_TOKEN_TTL_MS / 1000);

export async function handleChat(c: Ctx): Promise<void> {
  const scope = requireGroupScope(c.url.searchParams.get("scopeId"));
  if (!scope.ok) return sendProblem(c.res, scope.problem);
  const conversation = readConversationId(c.url.searchParams.get("conversationId") ?? undefined);
  if (!conversation.ok) return sendProblem(c.res, conversation.problem);
  const sessionId = c.url.searchParams.get("sessionId") ?? "";

  const cookie = [
    `${CHAT_COOKIE}=${c.chatToken}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${COOKIE_MAX_AGE_S}`,
    ...(c.chatCookieSecure ? ["Secure"] : []),
  ].join("; ");
  c.res.setHeader("set-cookie", cookie);

  const html = CHAT_HTML.replace("__SCOPE_ID__", escapeHtml(scope.scopeId))
    .replace("__CONVERSATION_ID__", escapeHtml(conversation.conversationId))
    .replace("__SESSION_ID__", escapeHtml(sessionId))
    .replace("__USER_ID__", escapeHtml(c.userId));
  sendHtml(c.res, 200, html);
}
