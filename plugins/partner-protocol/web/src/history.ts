import { fetchSession } from "./api";

interface Entry {
  type?: string;
  payload?: Record<string, unknown>;
}

interface HistoryMessage {
  role: "user" | "ai";
  text: string;
}

function textFromEntry(entry: Entry): HistoryMessage | null {
  const payload = entry.payload;
  if (entry.type === "user" && typeof payload?.display === "string" && payload.display) {
    return { role: "user", text: payload.display };
  }
  if (entry.type === "assistant" && typeof payload?.text === "string" && payload.text) {
    return { role: "ai", text: payload.text };
  }
  if (
    entry.type === "tool_call" &&
    payload?.tool === "web" &&
    payload.action === "post" &&
    typeof payload.text === "string"
  ) {
    return { role: "ai", text: payload.text };
  }
  return null;
}

export async function loadHistory(sessionId: string, renderMessage: (role: "user" | "ai", text: string) => void) {
  if (!sessionId) return;
  const data = (await fetchSession(sessionId)) as { entries?: Entry[] } | null;
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  for (const entry of entries) {
    const message = textFromEntry(entry);
    if (message) renderMessage(message.role, message.text);
  }
}
