<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { api, getUserId, type RuntimeConfig, type SessionSummary } from "../api.ts";
import { useRunStream, type ActivityItem } from "../composables/useRunStream.ts";
import type { Employee } from "../api.ts";

const props = defineProps<{ employee: Employee }>();
const emit = defineEmits<{ switch: [] }>();

interface Msg {
  role: "user" | "ai";
  text: string;
  error?: boolean;
}

const messages = ref<Msg[]>([]);
const sessions = ref<SessionSummary[]>([]);
const conversationId = ref(uuid());
const input = ref("");
const busy = ref(false);
const runtime = ref<RuntimeConfig | null>(null);
const harness = ref("");
const model = ref("");
const { state: stream, follow, close } = useRunStream();

function uuid(): string {
  return crypto.randomUUID ? crypto.randomUUID() : "c" + Date.now() + Math.random().toString(16).slice(2);
}

const modelOptions = computed(() => (runtime.value?.modelsByHarness?.[harness.value] ?? []) as string[]);

async function loadRuntime(): Promise<void> {
  try {
    runtime.value = await api.runtime(props.employee.scopeId);
    const eff = runtime.value.effective ?? {};
    harness.value = eff.harnessId && (runtime.value.harnesses ?? []).includes(eff.harnessId) ? eff.harnessId : "";
    model.value = eff.modelId ?? "";
  } catch {
    runtime.value = null;
  }
}

async function refreshSessions(): Promise<void> {
  try {
    const listed = await api.listSessions(props.employee.scopeId);
    sessions.value = (listed.sessions ?? []).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  } catch {
    sessions.value = [];
  }
}

function newChat(): void {
  conversationId.value = uuid();
  messages.value = [];
}

async function openSession(s: SessionSummary): Promise<void> {
  const ref = s.threadRef ?? "";
  const parts = ref.split(":");
  conversationId.value = parts.length >= 3 ? parts.slice(2).join(":") : uuid();
  try {
    const detail = await api.sessionHistory(s.id);
    const entries = Array.isArray(detail.entries) ? detail.entries : [];
    const rendered: Msg[] = [];
    for (const entry of entries) {
      const item = entry as { type?: string; payload?: Record<string, unknown> | null };
      if (item.type === "user") {
        const display = typeof item.payload?.display === "string" ? item.payload.display : "";
        if (display) rendered.push({ role: "user", text: display });
      }
      if (item.type === "assistant") {
        const text = typeof item.payload?.text === "string" ? item.payload.text : "";
        if (text) rendered.push({ role: "ai", text });
      }
      if (item.type === "tool_call") {
        const payload = item.payload as { tool?: string; action?: string; text?: string } | null;
        if (payload?.tool === "web" && payload.action === "post" && typeof payload.text === "string")
          rendered.push({ role: "ai", text: payload.text });
      }
    }
    messages.value = rendered;
    scrollBottom();
  } catch {
    messages.value = [];
  }
}

function scrollBottom(): void {
  void nextTick(() => {
    const box = document.getElementById("msgs");
    if (box) box.scrollTop = box.scrollHeight;
  });
}

async function latestAssistantReply(): Promise<string> {
  try {
    const listed = await api.listSessions(props.employee.scopeId);
    const newest = (listed.sessions ?? [])
      .filter((s) => s.threadRef?.endsWith(conversationId.value))
      .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0];
    if (!newest) return "";
    const detail = await api.sessionHistory(newest.id, 2);
    const entries = Array.isArray(detail.entries) ? detail.entries : [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const item = entries[i] as { type?: string; payload?: Record<string, unknown> | null };
      if (item.type === "assistant" && typeof item.payload?.text === "string" && item.payload.text.trim())
        return item.payload.text;
    }
  } catch {
    return "";
  }
  return "";
}

async function send(): Promise<void> {
  const text = input.value.trim();
  if (!text || busy.value) return;
  input.value = "";
  busy.value = true;
  messages.value.push({ role: "user", text });
  messages.value.push({ role: "ai", text: "" });
  scrollBottom();
  try {
    const body: Record<string, unknown> = { scopeId: props.employee.scopeId, conversationId: conversationId.value, text };
    if (harness.value) body.harness = harness.value;
    if (model.value) body.model = model.value;
    const outcome = await api.sendTurn(body);
    if (!outcome.runId) throw new Error("未返回 runId");
    await follow(outcome.runId);
    const last = messages.value[messages.value.length - 1];
    if (last && last.role === "ai") {
      last.text = stream.value.reply || stream.value.partial || (await latestAssistantReply()) || last.text;
      if (stream.value.error) last.error = true;
    }
  } catch (e) {
    const last = messages.value[messages.value.length - 1];
    if (last && last.role === "ai") {
      last.text = "发送失败：" + (e instanceof Error ? e.message : String(e));
      last.error = true;
    }
  } finally {
    busy.value = false;
    scrollBottom();
    await refreshSessions();
  }
}

const activityLines = computed(() =>
  stream.value.activities
    .filter((a: ActivityItem) => a.type === "tool_call")
    .map((a: ActivityItem) => `🔧 ${String(a.payload?.tool ?? "")}`)
    .slice(-2),
);

onMounted(() => {
  void loadRuntime();
  void refreshSessions();
});

onUnmounted(close);
</script>

<template>
  <div class="layout">
    <aside class="side">
      <div class="who">
        <div class="avatar">{{ employee.name.slice(0, 1) }}</div>
        <div>
          <div class="name">{{ employee.name }}</div>
          <div class="meta">{{ employee.scopeId }} · {{ getUserId() }}</div>
        </div>
      </div>
      <button class="btn ghost" @click="newChat">+ 新会话</button>
      <div class="sess-list">
        <div v-for="s in sessions" :key="s.id" class="sess" @click="openSession(s)">
          <div class="t">{{ s.title || "会话" }}</div>
          <div class="m">{{ s.lastActivityAt ? new Date(s.lastActivityAt).toLocaleString("zh-CN", { hour12: false }) : "" }}</div>
        </div>
        <div v-if="!sessions.length" class="empty-sess">暂无历史会话</div>
      </div>
      <button class="btn ghost" @click="emit('switch')">切换员工</button>
    </aside>
    <section class="chat">
      <div id="msgs" class="msgs">
        <div v-for="(m, i) in messages" :key="i" class="bub" :class="m.role" :data-err="m.error || undefined">
          <span class="txt">{{ m.text || "…" }}</span>
        </div>
        <div v-if="busy" class="act">
          <span v-for="(line, i) in activityLines" :key="i" class="tool">{{ line }}</span>
          <span v-if="!activityLines.length">思考中…</span>
        </div>
      </div>
      <div class="composer">
        <div class="picks">
          <select v-model="harness" class="field" @change="model = ''">
            <option value="">默认 harness</option>
            <option v-for="h in runtime?.harnesses ?? []" :key="h" :value="h">{{ h }}</option>
          </select>
          <select v-model="model" class="field">
            <option value="">默认模型</option>
            <option v-for="m in modelOptions" :key="m" :value="m">
              {{ runtime?.modelCatalog?.[m]?.name || m }}
            </option>
          </select>
        </div>
        <div class="composer-in">
          <textarea
            v-model="input"
            class="field"
            placeholder="输入消息，Enter 发送 / Shift+Enter 换行"
            @keydown.enter.exact.prevent="send"
          ></textarea>
          <button class="btn" :disabled="busy" @click="send">发送</button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.layout {
  height: 100%;
  display: grid;
  grid-template-columns: 260px 1fr;
}
.side {
  background: var(--panel);
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
}
.who {
  display: flex;
  gap: 10px;
  align-items: center;
}
.avatar {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: var(--accent);
  display: grid;
  place-items: center;
  font-weight: 700;
}
.name {
  font-weight: 600;
}
.meta {
  color: var(--muted);
  font-size: 11px;
  word-break: break-all;
}
.btn.ghost {
  background: var(--panel2);
  border: 1px solid var(--line);
  color: var(--text);
}
.sess-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sess {
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
}
.sess:hover {
  background: var(--panel2);
}
.sess .t {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sess .m {
  color: var(--muted);
  font-size: 11px;
}
.empty-sess {
  color: var(--muted);
  font-size: 12px;
  padding: 8px;
}
.chat {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.msgs {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bub {
  max-width: 76%;
  padding: 10px 14px;
  border-radius: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}
.bub.user {
  align-self: flex-end;
  background: var(--user);
}
.bub.ai {
  align-self: flex-start;
  background: var(--ai);
  border: 1px solid var(--line);
}
.bub[data-err] {
  color: var(--err);
}
.act {
  align-self: center;
  color: var(--muted);
  font-size: 12px;
  display: flex;
  gap: 10px;
}
.composer {
  border-top: 1px solid var(--line);
  background: var(--panel);
  padding: 12px 16px;
}
.picks {
  display: flex;
  gap: 10px;
  margin-bottom: 8px;
}
.picks .field {
  flex: 0 0 200px;
  padding: 6px 10px;
  font-size: 13px;
}
.composer-in {
  display: flex;
  gap: 10px;
  align-items: flex-end;
}
.composer-in textarea {
  flex: 1;
  resize: none;
  min-height: 44px;
  max-height: 160px;
}
</style>
