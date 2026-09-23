import type { View } from "./shell-state";

interface TitledSession {
  id: string;
  threadRef: string;
}

interface ActiveConversation {
  openingKey: string | null;
  sessionId: string | null;
  threadRef: string | null;
}

export const PRODUCT_TITLE = "QM · 网页端";

const VIEW_TITLES: Record<View, string> = {
  chats: "对话",
  inbox: "收件箱",
  calendar: "日历",
  contexts: "项目",
  crons: "定时任务",
  loops: "持续工作流",
  webhooks: "Webhook",
  files: "文件",
  keychain: "密钥库",
  deploys: "应用",
  memory: "记忆",
  skills: "技能",
  settings: "设置",
};

export function documentTitle(view?: View, conversationTitle?: string | null, conversationOpen = false): string {
  const title =
    view === "chats" && conversationOpen ? conversationTitle?.trim() || "新对话" : view && VIEW_TITLES[view];
  return title ? `${title} · ${PRODUCT_TITLE}` : PRODUCT_TITLE;
}

export function updateDocumentTitle(view?: View, conversationTitle?: string | null, conversationOpen = false): void {
  document.title = documentTitle(view, conversationTitle, conversationOpen);
}

export function activeSessionForDocumentTitle<T extends TitledSession>(
  sessions: T[],
  active: ActiveConversation,
): T | undefined {
  if (active.openingKey) return sessions.find((session) => session.id === active.openingKey);
  return sessions.find(
    (session) => session.id === active.sessionId || (!active.sessionId && session.threadRef === active.threadRef),
  );
}
