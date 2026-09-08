export interface Employee {
  id: string;
  name: string;
  scopeId: string;
}

export interface Conversation {
  conversationId: string;
  scopeId: string;
  employeeName: string;
  updatedAt: number;
}

let userId = localStorage.getItem("userId") || "";

export function getUserId(): string {
  return userId;
}

export function setUserId(next: string): void {
  userId = next.trim();
  localStorage.setItem("userId", userId);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "x-user-id": userId, ...init?.headers },
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!response.ok) {
    const body = (json ?? {}) as { message?: string; error?: string };
    throw new Error(body.message || body.error || `HTTP ${response.status}`);
  }
  return json as T;
}

export const api = {
  createEmployee: (name?: string) =>
    request<{ employee: Employee; granted?: string[]; soul?: boolean }>("/api/employees", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(name ? { name } : {}),
    }),
  openChatSession: (scopeId: string, conversationId?: string) =>
    request<{ chatUrl: string; conversationId: string }>("/api/chat-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(conversationId ? { scopeId, conversationId } : { scopeId }),
    }),
};

const EMPLOYEES_KEY = "employees";
const CONVERSATIONS_KEY = "conversations";

function readList<T>(key: string): T[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function writeList<T>(key: string, list: T[]): void {
  localStorage.setItem(key, JSON.stringify(list));
}

export function listEmployees(): Employee[] {
  return readList<Employee>(EMPLOYEES_KEY);
}

export function rememberEmployee(employee: Employee): void {
  const rest = listEmployees().filter((item) => item.scopeId !== employee.scopeId);
  writeList(EMPLOYEES_KEY, [employee, ...rest]);
}

export function listConversations(): Conversation[] {
  return readList<Conversation>(CONVERSATIONS_KEY);
}

export function rememberConversation(conversation: Conversation): void {
  const rest = listConversations().filter(
    (item) => !(item.scopeId === conversation.scopeId && item.conversationId === conversation.conversationId),
  );
  writeList(CONVERSATIONS_KEY, [conversation, ...rest]);
}
