import { html, nothing, render } from "lit";
import { Clock3, Pencil, Search, Trash2 } from "lucide";
import { api, ApiError } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { icon } from "./ui";
import { appState, replacePanePreservingFocus } from "./shell";
import { scopedSession, scopedViewTopbar } from "./session-scope";
import { tip } from "./tooltip";

interface RevisionRow {
  revision: string;
  content: string;
  operation: string;
  author?: string;
  at: number;
}

let memoryDraft = "";
let memorySaved = "";
let memoryRevision = "";
let memoryNotice = "";
let memorySaving = false;
let memoryLoaded = false;
let rawEditing = true;
let search = "";
let historyOpen = false;
let history: RevisionRow[] = [];
let memoryConfirmation: { title: string; body: string; action: string; run: () => Promise<void> } | null = null;

export function resetMemoryState(): void {
  memoryDraft = "";
  memorySaved = "";
  memoryRevision = "";
  memoryNotice = "";
  memorySaving = false;
  memoryLoaded = false;
  rawEditing = true;
  search = "";
  historyOpen = false;
  history = [];
  memoryConfirmation = null;
}

function facts(content: string): Array<{ line: number; text: string; date?: string }> {
  return content.split("\n").flatMap((row, line) => {
    const match = row.match(/^\s*[-*]\s+(?:\((\d{4}-\d{2}-\d{2})\)\s*)?(.*\S)\s*$/);
    return match ? [{ line, ...(match[1] ? { date: match[1] } : {}), text: match[2]! }] : [];
  });
}

function removeFact(line: number): void {
  const lines = memoryDraft.split("\n");
  lines.splice(line, 1);
  memoryDraft = lines.join("\n");
  drawMemory();
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}

function drawMemory(loading = false): void {
  if (appState.currentView !== "memory" || !appState.mainEl) return;
  const dirty = memoryDraft !== memorySaved;
  const visible = facts(memoryDraft).filter(
    (fact) => !search || fact.text.toLowerCase().includes(search.toLowerCase()),
  );
  const host = document.createElement("div");
  host.className = scopedSession.active ? "pane scoped-view" : "pane";
  render(
    html`
      ${scopedViewTopbar("memory", () => drawMemory())}
      <div class="list-page-head">
        <div>
          <h1 class="pane-title">记忆</h1>
        </div>
        <div class="list-page-actions">
          <button
            class="btn"
            type="button"
            @click=${() => {
              rawEditing = !rawEditing;
              drawMemory();
            }}
          >
            ${icon(Pencil, 15)} ${rawEditing ? "事实列表" : "编辑记忆笔记"}
          </button>
          <button class="btn" type="button" @click=${() => void toggleHistory()}>${icon(Clock3, 15)} 历史记录</button>
        </div>
        ${
          !rawEditing
            ? html`<label class="list-search"
                >${icon(Search, 16)}<input
                  data-focus-key="memory-search"
                  aria-label="搜索记忆"
                  type="search"
                  placeholder="搜索已记住的事实"
                  .value=${search}
                  @input=${(e: Event) => {
                    search = (e.target as HTMLInputElement).value;
                    drawMemory();
                  }}
              /></label>`
            : nothing
        }
      </div>
      ${memoryNotice || loading ? html`<div class="status">${memoryNotice || "加载中…"}</div>` : nothing}
      <div class="memory-editor">
        ${
          rawEditing
            ? html`<textarea
                class="memory-text"
                data-focus-key="memory-raw"
                spellcheck="false"
                ?disabled=${loading || memorySaving}
                @input=${(e: Event) => {
                  memoryDraft = (e.target as HTMLTextAreaElement).value;
                  drawMemory();
                }}
                .value=${memoryDraft}
              ></textarea>`
            : html` <div class="memory-facts">
                ${
                  visible.length
                    ? visible.map(
                        (fact) =>
                          html`<div class="memory-fact">
                            <div>
                              <div>${fact.text}</div>
                              ${fact.date ? html`<div class="card-meta">记录于 ${fact.date}</div>` : nothing}
                            </div>
                            <button
                              class="icon-btn"
                              type="button"
                              aria-label="忘记这条事实"
                              ${tip("忘记这条事实")}
                              @click=${() => removeFact(fact.line)}
                            >
                              ${icon(Trash2, 15)}
                            </button>
                          </div>`,
                      )
                    : html`<div class="empty-state">
                        ${search ? "没有匹配的记忆事实。" : "智能体尚未记录任何事实。"}
                      </div>`
                }
              </div>`
        }
        <div class="memory-actions">
          <button
            class="btn primary memory-save"
            type="button"
            ?disabled=${loading || memorySaving || !dirty}
            @click=${() => void saveMemory()}
          >
            ${memorySaving ? "正在保存…" : "保存更改"}
          </button>
          <span class="memory-hint">${dirty && !memorySaving ? "有未保存的更改" : ""}</span>
        </div>
        ${
          historyOpen
            ? html` <section class="memory-history">
                <h2>版本历史</h2>
                ${
                  history.length
                    ? history.map(
                        (row, i) =>
                          html` <div class="memory-revision">
                            <div>
                              <strong>${i === 0 ? "当前版本" : `版本 ${row.revision}`}</strong>
                              <div class="card-meta">
                                ${fmtDate(row.at)} · ${row.author || "自动记录"} · ${row.operation}
                              </div>
                            </div>
                            ${i ? html`<button class="btn" type="button" @click=${() => requestRestoreRevision(row)}>恢复</button>` : nothing}
                          </div>`,
                      )
                    : html`<div class="empty-state">当前记忆存储不支持版本历史。</div>`
                }
              </section>`
            : nothing
        }
        ${
          memoryConfirmation
            ? html` <section class="card memory-confirm" role="alertdialog" aria-labelledby="memory-confirm-title">
                <div class="card-head">
                  <h2 class="card-title" id="memory-confirm-title">${memoryConfirmation.title}</h2>
                  <span class="badge warn">检查影响</span>
                </div>
                <p class="memory-help">${memoryConfirmation.body}</p>
                <div class="actions">
                  <button class="btn danger" type="button" @click=${() => void memoryConfirmation?.run()}>
                    ${memoryConfirmation.action}</button
                  ><button
                    class="btn"
                    type="button"
                    @click=${() => {
                      memoryConfirmation = null;
                      drawMemory();
                    }}
                  >
                    取消
                  </button>
                </div>
              </section>`
            : nothing
        }
      </div>
    `,
    host,
  );
  replacePanePreservingFocus(host);
}

export async function renderMemory(force = false): Promise<void> {
  if (appState.currentView !== "memory") return;
  const dirty = memoryLoaded && memoryDraft !== memorySaved;
  if (dirty && !force) return void drawMemory();
  if (dirty && force) {
    memoryConfirmation = {
      title: "放弃未保存的记忆修改？",
      body: "刷新会用最新记忆替换当前草稿，请先复制需要保留的内容。",
      action: "放弃并刷新",
      run: async () => {
        memoryConfirmation = null;
        memoryDraft = memorySaved;
        await renderMemory(true);
      },
    };
    return void drawMemory();
  }
  const seq = appState.viewRenderSeq;
  memoryNotice = "";
  drawMemory(true);
  try {
    const r = await api<{ content?: string; revision?: string }>("/api/memory");
    if (seq !== appState.viewRenderSeq || appState.currentView !== "memory") return;
    memorySaved = r.content ?? "";
    memoryDraft = memorySaved;
    memoryRevision = r.revision ?? "";
    memoryLoaded = true;
  } catch (e) {
    if (seq !== appState.viewRenderSeq || appState.currentView !== "memory") return;
    memoryNotice = errMessage(e, "加载记忆失败。");
  }
  drawMemory();
}

async function saveMemory(): Promise<void> {
  if (memorySaving) return;
  memorySaving = true;
  memoryNotice = "";
  drawMemory();
  try {
    const r = await api<{ content?: string; revision?: string }>("/api/memory", {
      method: "PUT",
      body: JSON.stringify({ content: memoryDraft, revision: memoryRevision }),
    });
    memorySaved = r.content ?? memoryDraft;
    memoryDraft = memorySaved;
    memoryRevision = r.revision ?? memoryRevision;
    memoryNotice = "已保存 ✓";
    if (historyOpen) {
      try {
        await loadHistory();
      } catch {
        memoryNotice = "已保存 ✓，但历史记录刷新失败。";
      }
    }
  } catch (e) {
    memoryNotice =
      e instanceof ApiError && e.status === 409
        ? "其他对话已修改记忆。你的草稿仍保留在此，可先复制备份，再刷新并合并最新内容。"
        : errMessage(e, "保存记忆失败。");
  } finally {
    memorySaving = false;
    drawMemory();
  }
}

async function loadHistory(): Promise<void> {
  const r = await api<{ revisions?: RevisionRow[] }>("/api/memory/history");
  history = r.revisions ?? [];
}

async function toggleHistory(): Promise<void> {
  historyOpen = !historyOpen;
  if (historyOpen) {
    try {
      await loadHistory();
    } catch (e) {
      memoryNotice = errMessage(e, "加载记忆历史失败。");
    }
  }
  drawMemory();
}

function requestRestoreRevision(row: RevisionRow): void {
  memoryConfirmation = {
    title: `恢复 ${fmtDate(row.at)} 的记忆版本？`,
    body: "所选笔记将成为当前版本。现有版本仍保留在历史记录中。",
    action: "恢复版本",
    run: async () => {
      memoryConfirmation = null;
      await restoreRevision(row);
    },
  };
  drawMemory();
}

async function restoreRevision(row: RevisionRow): Promise<void> {
  try {
    const r = await api<{ content?: string; revision?: string }>("/api/memory/restore", {
      method: "POST",
      body: JSON.stringify({ revision: row.revision, expectedRevision: memoryRevision }),
    });
    memorySaved = r.content ?? "";
    memoryDraft = memorySaved;
    memoryRevision = r.revision ?? memoryRevision;
    memoryNotice = "版本已恢复 ✓";
    try {
      await loadHistory();
    } catch {
      memoryNotice = "版本已恢复 ✓，但历史记录刷新失败。";
    }
  } catch (e) {
    memoryNotice = errMessage(e, "无法恢复该版本。");
  }
  drawMemory();
}
