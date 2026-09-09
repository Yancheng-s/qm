(function polyfill() {
  const relList = document.createElement("link").relList;
  if (relList && relList.supports && relList.supports("modulepreload")) return;
  for (const link of document.querySelectorAll('link[rel="modulepreload"]')) processPreload(link);
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type !== "childList") continue;
      for (const node of mutation.addedNodes) if (node.tagName === "LINK" && node.rel === "modulepreload") processPreload(node);
    }
  }).observe(document, {
    childList: true,
    subtree: true
  });
  function getFetchOpts(link) {
    const fetchOpts = {};
    if (link.integrity) fetchOpts.integrity = link.integrity;
    if (link.referrerPolicy) fetchOpts.referrerPolicy = link.referrerPolicy;
    if (link.crossOrigin === "use-credentials") fetchOpts.credentials = "include";
    else if (link.crossOrigin === "anonymous") fetchOpts.credentials = "omit";
    else fetchOpts.credentials = "same-origin";
    return fetchOpts;
  }
  function processPreload(link) {
    if (link.ep) return;
    link.ep = true;
    const fetchOpts = getFetchOpts(link);
    fetch(link.href, fetchOpts);
  }
})();
async function fetchSession(sessionId) {
  const response = await fetch(`/v1/sessions/${encodeURIComponent(sessionId)}?tailTurns=50`, {
    credentials: "same-origin"
  });
  if (!response.ok) return null;
  return response.json();
}
async function postTurn(input2) {
  const response = await fetch("/v1/turn", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input2)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || `HTTP ${response.status}`);
  if (!data.runId) throw new Error("未返回 runId");
  return data.runId;
}
function textFromEntry(entry) {
  const payload = entry.payload;
  if (entry.type === "user" && typeof payload?.display === "string" && payload.display) {
    return { role: "user", text: payload.display };
  }
  if (entry.type === "assistant" && typeof payload?.text === "string" && payload.text) {
    return { role: "ai", text: payload.text };
  }
  if (entry.type === "tool_call" && payload?.tool === "web" && payload.action === "post" && typeof payload.text === "string") {
    return { role: "ai", text: payload.text };
  }
  return null;
}
async function loadHistory(sessionId, renderMessage) {
  if (!sessionId) return;
  const data = await fetchSession(sessionId);
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  for (const entry of entries) {
    const message = textFromEntry(entry);
    if (message) renderMessage(message.role, message.text);
  }
}
function createRenderer(msgs2) {
  const scrollBottom = () => {
    msgs2.scrollTop = msgs2.scrollHeight;
  };
  const addBubble = (role, text, pending = false) => {
    const div = document.createElement("div");
    div.className = `bub ${role}${pending ? " pending" : ""}`;
    const span = document.createElement("span");
    span.className = "txt";
    span.textContent = text;
    div.appendChild(span);
    msgs2.appendChild(div);
    scrollBottom();
    return span;
  };
  const markError = (span, text) => {
    span.textContent = text;
    span.parentElement?.setAttribute("data-err", "1");
    span.parentElement?.classList.remove("pending");
  };
  const update = (span, text) => {
    span.textContent = text;
    span.parentElement?.classList.remove("pending");
    scrollBottom();
  };
  return { addBubble, markError, scrollBottom, update };
}
const MAX_RUN_MS = 24e4;
function extractReply(activity) {
  for (const item of activity) {
    if (item.type === "tool_call" && item.payload?.tool === "web" && item.payload.action === "post" && typeof item.payload.text === "string") {
      return item.payload.text;
    }
  }
  return "";
}
function readJson(event) {
  try {
    return JSON.parse(event.data);
  } catch {
    return {};
  }
}
function followRun(runId, renderer2, aiSpan, state2) {
  return new Promise((resolve) => {
    let partial = "";
    let reply = "";
    let settled = false;
    const source = new EventSource(`/v1/events?runId=${encodeURIComponent(runId)}`);
    state2.source = source;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      source.close();
      if (state2.source === source) state2.source = null;
      resolve(reply || partial);
    };
    const guard = setTimeout(() => {
      renderer2.markError(aiSpan, reply || partial || "运行超时");
      finish();
    }, MAX_RUN_MS);
    source.addEventListener("partial", (event) => {
      const data = readJson(event);
      if (typeof data.partial === "string") {
        partial = data.partial;
        renderer2.update(aiSpan, partial);
      }
    });
    source.addEventListener("activity", (event) => {
      const data = readJson(event);
      const activity = data.activity;
      if (Array.isArray(activity)) {
        reply = extractReply(activity) || reply;
        if (reply) renderer2.update(aiSpan, reply);
      }
    });
    source.addEventListener("done", (event) => {
      const data = readJson(event);
      const activity = data.activity;
      reply = Array.isArray(activity) ? extractReply(activity) || partial || reply : partial || reply;
      if (reply) renderer2.update(aiSpan, reply);
      finish();
    });
    source.addEventListener("failed", (event) => {
      const data = readJson(event);
      renderer2.markError(aiSpan, reply || partial || `运行失败：${String(data.reason || "")}`);
      finish();
    });
    source.onerror = () => {
      if (settled) return;
      renderer2.markError(aiSpan, reply || partial || "事件流中断");
      finish();
    };
  });
}
function readBootState() {
  const ds = document.body.dataset;
  return {
    scopeId: ds.scopeId || "",
    conversationId: ds.conversationId || "default",
    sessionId: ds.sessionId || "",
    busy: false,
    source: null
  };
}
function setBusy(state2, sendBtn2, busy) {
  state2.busy = busy;
  sendBtn2.disabled = busy;
}
const state = readBootState();
const msgsEl = document.getElementById("msgs");
const inputEl = document.getElementById("input");
const sendBtnEl = document.getElementById("send");
const composerEl = document.getElementById("composer");
if (!(msgsEl instanceof HTMLElement)) throw new Error("msgs element is missing");
if (!(inputEl instanceof HTMLTextAreaElement)) throw new Error("input element is missing");
if (!(sendBtnEl instanceof HTMLButtonElement)) throw new Error("send button is missing");
if (!(composerEl instanceof HTMLFormElement)) throw new Error("composer form is missing");
const msgs = msgsEl;
const input = inputEl;
const sendBtn = sendBtnEl;
const composer = composerEl;
const renderer = createRenderer(msgs);
async function send() {
  const text = input.value.trim();
  if (!text || state.busy) return;
  input.value = "";
  setBusy(state, sendBtn, true);
  renderer.addBubble("user", text);
  const aiSpan = renderer.addBubble("ai", "...", true);
  try {
    const runId = await postTurn({ scopeId: state.scopeId, conversationId: state.conversationId, text });
    await followRun(runId, renderer, aiSpan, state);
  } catch (e) {
    renderer.markError(aiSpan, `发送失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    setBusy(state, sendBtn, false);
    renderer.scrollBottom();
    input.focus();
  }
}
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
});
composer.addEventListener("submit", (e) => {
  e.preventDefault();
  void send();
});
void loadHistory(state.sessionId, renderer.addBubble).finally(() => input.focus());
