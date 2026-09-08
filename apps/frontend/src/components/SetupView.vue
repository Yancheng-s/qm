<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api, getUserId, setUserId, type Employee } from "../api.ts";

const emit = defineEmits<{ enter: [userId: string, employee: Employee] }>();

const userId = ref(getUserId());
const employees = ref<Employee[]>([]);
const newName = ref("");
const busy = ref(false);
const error = ref("");

async function refresh(): Promise<void> {
  if (!userId.value.trim()) return;
  setUserId(userId.value);
  try {
    const listed = await api.listEmployees();
    employees.value = listed.employees ?? [];
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function create(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    setUserId(userId.value);
    const result = await api.createEmployee(newName.value.trim() || undefined);
    emit("enter", userId.value.trim(), result.employee);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    await refresh();
  } finally {
    busy.value = false;
  }
}

onMounted(refresh);
</script>

<template>
  <div class="wrap">
    <div class="card">
      <h1>数字员工工作台</h1>
      <p class="hint">输入你的用户 id，选择已有员工或创建新员工（装配技能与人格）。</p>
      <div class="row">
        <input v-model="userId" class="field" placeholder="用户 id（userId）" @input="refresh" />
      </div>
      <div class="row">
        <input v-model="newName" class="field" placeholder="员工名（可选）" />
        <button class="btn" :disabled="busy || !userId.trim()" @click="create">
          {{ busy ? "装配中…" : "创建新员工" }}
        </button>
      </div>
      <div v-if="error" class="err">{{ error }}</div>
      <div v-if="employees.length" class="list">
        <div v-for="e in employees" :key="e.id" class="emp" @click="emit('enter', userId.trim(), e)">
          <div class="name">{{ e.name }}</div>
          <div class="meta">{{ e.scopeId }}</div>
        </div>
      </div>
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
  max-width: 460px;
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
  max-height: 280px;
  overflow-y: auto;
}
.emp {
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  border: 1px solid transparent;
}
.emp:hover {
  background: var(--panel2);
  border-color: var(--line);
}
.name {
  font-weight: 600;
}
.meta {
  color: var(--muted);
  font-size: 12px;
}
</style>
