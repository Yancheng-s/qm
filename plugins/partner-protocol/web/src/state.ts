export interface ChatState {
  scopeId: string;
  conversationId: string;
  sessionId: string;
  busy: boolean;
  source: EventSource | null;
}

export function readBootState(): ChatState {
  const ds = document.body.dataset;
  return {
    scopeId: ds.scopeId || "",
    conversationId: ds.conversationId || "default",
    sessionId: ds.sessionId || "",
    busy: false,
    source: null,
  };
}

export function setBusy(state: ChatState, sendBtn: HTMLButtonElement, busy: boolean) {
  state.busy = busy;
  sendBtn.disabled = busy;
}
