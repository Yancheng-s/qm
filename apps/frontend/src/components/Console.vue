<script setup lang="ts">
import { onMounted, ref } from "vue";
import {
  api,
  getUserId,
  setUserId,
  listEmployees,
  rememberEmployee,
  listConversations,
  rememberConversation,
  type Conversation,
  type Employee,
} from "../api.ts";

const userId = ref(getUserId());
const employees = ref<Employee[]>([]);
const conversations = ref<Conversation[]>([]);
const newName = ref("");
const busy = ref(false);
const error = ref("");

function reload(): void {
  employees.value = listEmployees();
  conversations.value = listConversations();
}

function conversationsFor(scopeId: string): Conversation[] {
  return conversations.value.filter((item) => item.scopeId === scopeId);
}

async function create(): Promise<void> {
  if (busy.value || !userId.value.trim()) return;
  busy.value = true;
  error.value = "";
  try {
    setUserId(userId.value);
    const result = await api.createEmployee(newName.value.trim() || undefined);
    rememberEmployee(result.employee);
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
      updatedAt: Date.now(),
    });
    reload();
    window.location.href = result.chatUrl;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

onMounted(reload);
</script>

<template>
  <div class="wrap">
    <div class="card">
      <h1>数字员工控制台</h1>
      <p class="hint">
        甲方业务系统：登录、维护数字员工与会话列表。创建员工经桥梁装配，点击会话跳转到桥梁提供的对话页面。
      </p>

      <div class="row">
        <input v-model="userId" class="field" placeholder="用户 id（userId）" @change="reload" />
      </div>

      <div class="row">
        <input v-model="newName" class="field" placeholder="员工名（可选）" />
        <button class="btn" :disabled="busy || !userId.trim()" @click="create">
          {{ busy ? "装配中…" : "创建数字员工" }}
        </button>
      </div>

      <div v-if="error" class="err">{{ error }}</div>

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
              {{ conv.conversationId }}
            </button>
          </div>
        </div>
      </div>
      <p v-else class="empty">还没有数字员工，先创建一个。</p>
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
  max-width: 520px;
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
  margin: 0 0 18px;
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
