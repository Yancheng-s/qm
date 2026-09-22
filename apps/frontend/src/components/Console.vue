<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  api,
  getActiveLibrary,
  getUserId,
  setActiveLibrary,
  setUserId,
  listEmployees,
  rememberEmployee,
  listConversations,
  rememberConversation,
  saveConversations,
  type Conversation,
  type Employee,
  type LibraryInfo,
} from "../api.ts";

const userId = ref(getUserId());
const libraries = ref<LibraryInfo[]>([]);
const activeLibrary = ref(getActiveLibrary());
const employees = ref<Employee[]>([]);
const conversations = ref<Conversation[]>([]);
const newName = ref("");
const busy = ref(false);
const error = ref("");
const notice = ref("");

const currentLibrary = computed(() => libraries.value.find((item) => item.key === activeLibrary.value));

function selectLibrary(key: string): void {
  activeLibrary.value = key;
  setActiveLibrary(key);
  newName.value = "";
  reload();
}

async function reload(): Promise<void> {
  employees.value = listEmployees(activeLibrary.value);
  conversations.value = listConversations().filter((item) => item.library === activeLibrary.value);
  if (!userId.value.trim() || !employees.value.length) return;
  try {
    const result = await api.listChatSessions();
    const titles = new Map<string, string>();
    for (const row of result.conversations) {
      if (row.title) titles.set(row.conversationId, row.title);
    }
    if (!titles.size) return;
    const merged = conversations.value.map((conv) => {
      const title = titles.get(conv.conversationId);
      return title && title !== conv.title ? { ...conv, title } : conv;
    });
    conversations.value = merged;
    saveConversations([
      ...merged,
      ...listConversations().filter((item) => item.library !== activeLibrary.value),
    ]);
  } catch {
    void 0;
  }
}

function conversationsFor(scopeId: string): Conversation[] {
  return conversations.value.filter((item) => item.scopeId === scopeId);
}

async function create(): Promise<void> {
  if (busy.value || !userId.value.trim() || !activeLibrary.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    setUserId(userId.value);
    const result = await api.createEmployee({
      library: activeLibrary.value,
      ...(newName.value.trim() ? { name: newName.value.trim() } : {}),
    });
    rememberEmployee({ ...result.employee, library: activeLibrary.value });
    if (result.fileFailures?.length) {
      notice.value = `默认文件导入失败：${result.fileFailures.map((item) => item.name || item.url).join("、")}`;
    } else if (result.files?.length) {
      notice.value = `已导入默认文件：${result.files.map((item) => item.name).join("、")}`;
    }
    newName.value = "";
    reload();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function openChat(employee: Employee, conversationId?: string): Promise<void> {
  if (!userId.value.trim()) {
    error.value = "请先输入用户 id";
    return;
  }
  error.value = "";
  try {
    setUserId(userId.value);
    const result = await api.openChatSession(employee.scopeId, conversationId);
    rememberConversation({
      conversationId: result.conversationId,
      scopeId: employee.scopeId,
      employeeName: employee.name,
      library: employee.library,
      updatedAt: Date.now(),
    });
    reload();
    window.location.href = result.chatUrl;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    void reload();
  }
}

onMounted(async () => {
  try {
    const result = await api.listLibraries();
    libraries.value = result.libraries;
    if (!libraries.value.some((item) => item.key === activeLibrary.value)) {
      activeLibrary.value = result.defaultLibrary;
      setActiveLibrary(activeLibrary.value);
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
  reload();
});
</script>

<template>
  <div class="wrap">
    <div class="card">
      <h1>数字员工工作台</h1>
      <p class="hint">选择产品库，创建数字员工并进入对话。技能与 MCP 由 Partner 桥梁装配。</p>

      <div v-if="libraries.length" class="tabs">
        <button
          v-for="library in libraries"
          :key="library.key"
          class="tab"
          :class="{ active: library.key === activeLibrary }"
          @click="selectLibrary(library.key)"
        >
          {{ library.label }}
        </button>
      </div>

      <p v-if="currentLibrary" class="product-hint">{{ currentLibrary.description }}</p>

      <div class="row">
        <input v-model="userId" class="field" placeholder="用户 id（userId）" @change="reload" />
      </div>

      <div class="row">
        <input
          v-model="newName"
          class="field"
          :placeholder="currentLibrary ? `助手名（默认：${currentLibrary.defaultEmployeeName}）` : '助手名（可选）'"
        />
        <button class="btn" :disabled="busy || !userId.trim()" @click="create">
          {{ busy ? "装配中…" : `创建${currentLibrary?.label ?? ""}助手` }}
        </button>
      </div>

      <div v-if="error" class="err">{{ error }}</div>
      <div v-if="notice" class="notice">{{ notice }}</div>

      <div v-if="employees.length" class="list">
        <div v-for="employee in employees" :key="employee.scopeId" class="emp">
          <div class="emp-head">
            <div>
              <div class="name">{{ employee.name }}</div>
              <div class="meta">{{ employee.scopeId }}</div>
            </div>
            <button class="btn ghost" @click="openChat(employee)">新对话</button>
          </div>
          <div v-if="conversationsFor(employee.scopeId).length" class="convs">
            <button
              v-for="conv in conversationsFor(employee.scopeId)"
              :key="conv.conversationId"
              class="conv"
              @click="openChat(employee, conv.conversationId)"
            >
              {{ conv.title || conv.conversationId }}
            </button>
          </div>
        </div>
      </div>
      <p v-else class="empty">
        还没有{{ currentLibrary?.label ?? "该" }}助手，先创建一个。
      </p>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  height: 100%;
  display: grid;
  place-items: center;
  padding: 20px;
  overflow-y: auto;
}
.card {
  width: 100%;
  max-width: 560px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 26px;
}
h1 {
  margin: 0 0 6px;
  font-size: 20px;
}
.hint {
  color: var(--muted);
  margin: 0 0 14px;
}
.product-hint {
  color: var(--muted);
  margin: 0 0 16px;
  font-size: 13px;
}
.tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
.tab {
  background: var(--panel2);
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  padding: 6px 14px;
}
.tab.active {
  color: var(--text);
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, var(--panel2));
}
.row {
  display: flex;
  gap: 10px;
  margin-bottom: 12px;
}
.row .field {
  flex: 1;
}
.err {
  color: var(--err);
  margin: 6px 0;
  font-size: 13px;
}
.notice {
  color: var(--muted);
  margin: 6px 0;
  font-size: 13px;
}
.list {
  margin-top: 16px;
  border-top: 1px solid var(--line);
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.emp {
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 12px;
  background: var(--panel2);
}
.emp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.name {
  font-weight: 600;
}
.meta {
  color: var(--muted);
  font-size: 12px;
}
.btn.ghost {
  background: transparent;
  border: 1px solid var(--accent);
  color: var(--accent);
  padding: 6px 12px;
}
.convs {
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.conv {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  padding: 4px 12px;
  font-size: 12px;
}
.conv:hover {
  color: var(--text);
  border-color: var(--accent);
}
.empty {
  color: var(--muted);
  margin-top: 16px;
}
</style>
