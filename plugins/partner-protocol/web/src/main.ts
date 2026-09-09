import { postTurn } from "./api";
import { loadHistory } from "./history";
import { createRenderer } from "./render";
import { followRun } from "./sse";
import { readBootState, setBusy } from "./state";
import "./styles.css";

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
