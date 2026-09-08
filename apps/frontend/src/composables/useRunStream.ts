import { ref } from "vue";
import { api, getUserId } from "../api.ts";

export interface ActivityItem {
  type: string;
  payload?: Record<string, unknown> | null;
}

export interface RunStreamState {
  partial: string;
  reply: string;
  activities: ActivityItem[];
  status: string;
  error: string;
  finished: boolean;
}

const MAX_RUN_MS = 240_000;

export function extractReply(activities: readonly ActivityItem[]): string {
  for (const a of activities) {
    if (a.type === "tool_call" && a.payload?.tool === "web" && a.payload?.action === "post" && typeof a.payload.text === "string")
      return a.payload.text;
  }
  return "";
}

export function useRunStream() {
  const state = ref<RunStreamState>({ partial: "", reply: "", activities: [], status: "", error: "", finished: false });
  let source: EventSource | null = null;

  function close(): void {
    source?.close();
    source = null;
  }

  function follow(runId: string): Promise<void> {
    return new Promise((resolve) => {
      state.value = { partial: "", reply: "", activities: [], status: "running", error: "", finished: false };
      const url = api.eventsUrl({ userId: getUserId(), runId });
      source = new EventSource(url);
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        state.value.finished = true;
        close();
        resolve();
      };
      const guard = setTimeout(() => {
        if (settled) return;
        state.value.status = "timeout";
        state.value.error = "运行超时";
        finish();
      }, MAX_RUN_MS);

      source.addEventListener("partial", (e) => {
        const data = JSON.parse((e as MessageEvent).data) as { partial?: string };
        if (typeof data.partial === "string") state.value.partial = data.partial;
      });
      source.addEventListener("activity", (e) => {
        const data = JSON.parse((e as MessageEvent).data) as { activity?: ActivityItem[] };
        if (Array.isArray(data.activity)) {
          state.value.activities = data.activity;
          state.value.reply = extractReply(data.activity) || state.value.reply;
        }
      });
      source.addEventListener("done", (e) => {
        const data = JSON.parse((e as MessageEvent).data) as {
          status?: string;
          result?: unknown;
          activity?: ActivityItem[];
        };
        state.value.status = data.status || "done";
        if (Array.isArray(data.activity)) {
          state.value.activities = data.activity;
          state.value.reply = extractReply(data.activity) || state.value.partial || state.value.reply;
        } else {
          state.value.reply = state.value.partial || state.value.reply;
        }
        finish();
      });
      source.addEventListener("failed", (e) => {
        const data = JSON.parse((e as MessageEvent).data) as { reason?: string };
        state.value.status = "failed";
        state.value.error = data.reason || "运行失败";
        finish();
      });
      source.onerror = () => {
        if (settled) return;
        state.value.status = "failed";
        state.value.error = "事件流中断";
        finish();
      };
    });
  }

  return { state, follow, close };
}
