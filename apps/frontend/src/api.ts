export interface Employee {
  id: string;
  name: string;
  scopeId: string;
  createdAt: number;
}

export interface RuntimeConfig {
  scopeId: string;
  harnesses: string[];
  modelsByHarness: Record<string, string[]>;
  modelCatalog: Record<string, { name?: string; provider?: string }>;
  effective: { harnessId?: string; modelId?: string } | null;
}

export interface SessionSummary {
  id: string;
  type?: string;
  scopeId?: string;
  threadRef?: string;
  title?: string;
  createdAt?: number;
  lastActivityAt?: number;
}

export interface TurnOutcome {
  runId?: string;
  status?: string;
  error?: string;
  message?: string;
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
    headers: { "x-user-id": userId, ...(init?.headers ?? {}) },
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
  listEmployees: () => request<{ employees: Employee[] }>("/api/employees"),
  createEmployee: (name?: string) =>
    request<{ employee: Employee; skills?: { name: string; ok: boolean; error?: string }[]; soul?: boolean }>(
      "/api/employees",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(name ? { name } : {}),
      },
    ),
  runtime: (scopeId: string) => request<RuntimeConfig>(`/api/runtime?scopeId=${encodeURIComponent(scopeId)}`),
  sendTurn: (body: Record<string, unknown>) =>
    request<TurnOutcome>("/api/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  listSessions: (scopeId?: string) =>
    request<{ sessions: SessionSummary[] }>(
      `/api/sessions${scopeId ? `?scopeId=${encodeURIComponent(scopeId)}` : ""}`,
    ),
  sessionHistory: (id: string, tailTurns = 20) =>
    request<{ session: SessionSummary; entries: unknown[]; earlierEntries?: number }>(
      `/api/sessions/${encodeURIComponent(id)}?tailTurns=${tailTurns}`,
    ),
  eventsUrl: (params: Record<string, string>) => {
    const query = new URLSearchParams(params);
    return `/api/events?${query.toString()}`;
  },
};
