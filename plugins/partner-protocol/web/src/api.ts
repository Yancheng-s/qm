export async function fetchSession(sessionId: string): Promise<unknown | null> {
  const response = await fetch(`/v1/sessions/${encodeURIComponent(sessionId)}?tailTurns=50`, {
    credentials: "same-origin",
  });
  if (!response.ok) return null;
  return response.json();
}

export async function postTurn(input: { scopeId: string; conversationId: string; text: string }): Promise<string> {
  const response = await fetch("/v1/turn", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await response.json().catch(() => ({}))) as { message?: string; error?: string; runId?: string };
  if (!response.ok) throw new Error(data.message || data.error || `HTTP ${response.status}`);
  if (!data.runId) throw new Error("未返回 runId");
  return data.runId;
}
