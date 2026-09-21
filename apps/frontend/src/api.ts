export interface LibraryInfo {
  key: string;
  label: string;
  description: string;
  defaultEmployeeName: string;
  skills: string[];
}

export interface Employee {
  id: string;
  name: string;
  scopeId: string;
  library: string;
}

export interface EmployeeFile {
  id: string;
  name: string;
  mimetype: string;
  sizeBytes: number;
}

export interface EmployeeFileFailure {
  url: string;
  name?: string;
  error: string;
}

export interface Conversation {
  conversationId: string;
  scopeId: string;
  employeeName: string;
  library: string;
  updatedAt: number;
  title?: string | null;
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
  let json: unknown;
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
  listLibraries: () =>
    request<{ defaultLibrary: string; libraries: LibraryInfo[] }>("/api/libraries"),
  createEmployee: (input: { library: string; name?: string }) =>
    request<{
      employee: Employee;
      granted?: string[];
      soul?: boolean;
      files?: EmployeeFile[];
      fileFailures?: EmployeeFileFailure[];
    }>("/api/employees", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  openChatSession: (scopeId: string, conversationId?: string) =>
    request<{ chatUrl: string; conversationId: string }>("/api/chat-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(conversationId ? { scopeId, conversationId } : { scopeId }),
    }),
  listChatSessions: (scopeId?: string) =>
    request<{ conversations: Array<{ conversationId: string; scopeId: string; title: string | null }> }>(
      scopeId ? `/api/chat-sessions?scopeId=${encodeURIComponent(scopeId)}` : "/api/chat-sessions",
    ),
};

const EMPLOYEES_KEY = "employees";
const CONVERSATIONS_KEY = "conversations";
const LIBRARY_KEY = "activeLibrary";

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

export function getActiveLibrary(): string {
  return localStorage.getItem(LIBRARY_KEY) || "card";
}

export function setActiveLibrary(key: string): void {
  localStorage.setItem(LIBRARY_KEY, key.trim());
}

export function listEmployees(library?: string): Employee[] {
  const all = readList<Employee>(EMPLOYEES_KEY).map((item) => ({
    ...item,
    library: item.library || "card",
  }));
  return library ? all.filter((item) => item.library === library) : all;
}

export function rememberEmployee(employee: Employee): void {
  const rest = listEmployees().filter((item) => item.scopeId !== employee.scopeId);
  writeList(EMPLOYEES_KEY, [employee, ...rest]);
}

export function listConversations(): Conversation[] {
  return readList<Conversation>(CONVERSATIONS_KEY).map((item) => ({
    ...item,
    library: item.library || "card",
  }));
}

export function rememberConversation(conversation: Conversation): void {
  const rest = listConversations().filter(
    (item) => !(item.scopeId === conversation.scopeId && item.conversationId === conversation.conversationId),
  );
  writeList(CONVERSATIONS_KEY, [conversation, ...rest]);
}

export function saveConversations(list: Conversation[]): void {
  writeList(CONVERSATIONS_KEY, list);
}
