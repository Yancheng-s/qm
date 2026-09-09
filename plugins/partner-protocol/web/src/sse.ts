import type { Renderer } from "./render";
import type { ChatState } from "./state";

const MAX_RUN_MS = 240000;

interface ActivityItem {
  type?: string;
  payload?: {
    tool?: string;
    action?: string;
    text?: unknown;
  };
}

function extractReply(activity: ActivityItem[]): string {
  for (const item of activity) {
    if (
      item.type === "tool_call" &&
      item.payload?.tool === "web" &&
      item.payload.action === "post" &&
      typeof item.payload.text === "string"
    ) {
      return item.payload.text;
    }
  }
  return "";
}

function readJson(event: MessageEvent): Record<string, unknown> {
  try {
    return JSON.parse(event.data) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function followRun(
  runId: string,
  renderer: Renderer,
  aiSpan: HTMLSpanElement,
  state: ChatState,
): Promise<string> {
  return new Promise((resolve) => {
    let partial = "";
    let reply = "";
    let settled = false;
    const source = new EventSource(`/v1/events?runId=${encodeURIComponent(runId)}`);
    state.source = source;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      source.close();
      if (state.source === source) state.source = null;
      resolve(reply || partial);
    };
    const guard = setTimeout(() => {
      renderer.markError(aiSpan, reply || partial || "运行超时");
      finish();
    }, MAX_RUN_MS);
    source.addEventListener("partial", (event) => {
      const data = readJson(event);
      if (typeof data.partial === "string") {
        partial = data.partial;
        renderer.update(aiSpan, partial);
      }
    });
    source.addEventListener("activity", (event) => {
      const data = readJson(event);
      const activity = data.activity;
      if (Array.isArray(activity)) {
        reply = extractReply(activity as ActivityItem[]) || reply;
        if (reply) renderer.update(aiSpan, reply);
      }
    });
    source.addEventListener("done", (event) => {
      const data = readJson(event);
      const activity = data.activity;
      reply = Array.isArray(activity) ? extractReply(activity as ActivityItem[]) || partial || reply : partial || reply;
      if (reply) renderer.update(aiSpan, reply);
      finish();
    });
    source.addEventListener("failed", (event) => {
      const data = readJson(event);
      renderer.markError(aiSpan, reply || partial || `运行失败：${String(data.reason || "")}`);
      finish();
    });
    source.onerror = () => {
      if (settled) return;
      renderer.markError(aiSpan, reply || partial || "事件流中断");
      finish();
    };
  });
}
