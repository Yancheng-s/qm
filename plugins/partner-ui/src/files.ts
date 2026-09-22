import { html, nothing, render } from "lit";
import { File, Image } from "lucide";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { browserRenderableImage, formatBytes, icon, relTime } from "./ui";
import { contextsState, ensureContexts, personalScopeId } from "./contexts";
import { appState } from "./shell";
import { fileListNeedsAllPages } from "./file-list";
import { openFilePreview } from "./file-preview";
import { scopedSession, scopedViewTopbar } from "./session-scope";

interface FileItem {
  id: string;
  name: string;
  mimetype: string;
  sizeBytes: number;
  direction: "in" | "out";
  createdAt: number;
  createdInScope?: string;
  ownerScopeId?: string;
  openable: boolean;
}
interface FileRow extends FileItem {
  kind: "Created" | "Uploaded" | "Shared";
}

const PAGE_SIZE = 60;
let fileRows: FileRow[] = [];
let filesNotice = "";
let filesScope: string | null = null;
let filesQuery = "";
let filesType: "all" | "image" | "document" | "other" = "all";
let filesOwnership: "all" | "owned" | "shared" = "all";
let filesSort: "newest" | "oldest" | "name" = "newest";
let filesLoadingMore = false;
let filesNextCursor: string | null = null;
let filesHost: HTMLElement | null = null;
let filesRequestSeq = 0;
let filesLoadAllQueued = false;

function fileScope(f: FileItem): string | null {
  return f.createdInScope ?? (f.ownerScopeId?.startsWith("personal:") ? f.ownerScopeId : null) ?? personalScopeId();
}

function typeOf(f: FileItem): "image" | "document" | "other" {
  if (browserRenderableImage(f.mimetype)) return "image";
  if (f.mimetype.startsWith("text/") || /(?:pdf|document|sheet|presentation|json|xml|csv)/i.test(f.mimetype))
    return "document";
  return "other";
}

function visibleFiles(): FileRow[] {
  const q = filesQuery.trim().toLowerCase();
  return fileRows
    .filter((f) => !filesScope || fileScope(f) === filesScope)
    .filter((f) => filesOwnership === "all" || (filesOwnership === "shared") === (f.kind === "Shared"))
    .filter((f) => filesType === "all" || typeOf(f) === filesType)
    .filter((f) => !q || `${f.name} ${f.mimetype}`.toLowerCase().includes(q))
    .sort((a, b) => {
      if (filesSort === "name") return a.name.localeCompare(b.name);
      if (filesSort === "oldest") return a.createdAt - b.createdAt;
      return b.createdAt - a.createdAt;
    });
}

function drawFiles(loading = false): void {
  if (appState.currentView !== "files" || !appState.mainEl) return;
  if (!filesHost || filesHost.parentElement !== appState.mainEl) {
    filesHost = document.createElement("div");
    filesHost.className = "pane files-page";
    appState.mainEl.replaceChildren(filesHost);
  }
  const visible = visibleFiles();
  const status = filesNotice || (loading && !fileRows.length ? "正在加载文件…" : "");
  const scoped = Boolean(scopedSession.active);
  filesHost.classList.toggle("scoped-view", scoped);
  render(
    html`
      ${scopedViewTopbar("files", drawFiles)}
      <div class="list-page-head">
        <div>
          <h1 class="pane-title">文件</h1>
          <div class="pane-subtitle">助手创建或与你共享的文件</div>
        </div>
      </div>
      ${status ? html`<div class="status" aria-live="polite">${status}</div>` : nothing}
      ${visible.length ? html`<div class="list-rows file-list">${visible.map(fileRow)}</div>` : html`<div class="empty compact">${filtered() ? "没有符合筛选条件的文件。" : "还没有文件。让助手帮你创建即可。"}</div>`}
      ${filesNextCursor ? html`<div class="list-footer"><button class="btn" type="button" ?disabled=${filesLoadingMore} @click=${() => void loadMoreFiles()}>${filesLoadingMore ? "加载中…" : "加载更多"}</button></div>` : nothing}
    `,
    filesHost,
  );
}

function filtered(): boolean {
  return Boolean(filesScope || filesQuery.trim() || filesType !== "all" || filesOwnership !== "all");
}

function fileRow(f: FileRow) {
  const isImage = f.openable && browserRenderableImage(f.mimetype);
  return html`<article class="list-row file-row">
    <span class="file-row-icon">${icon(isImage ? Image : File, 17)}</span>
    <span class="list-row-title"
      ><span>${f.name}</span
      ><span class="file-row-type">${formatBytes(f.sizeBytes)} · ${relTime(f.createdAt)}</span></span
    >
    <span class="list-row-meta"
      >${f.openable ? html`<button class="btn compact" type="button" @click=${() => openFilePreview(f)}>预览</button>` : html`<span>暂不可用</span>`}</span
    >
  </article>`;
}

function rowsFromPage(r: { owned?: FileItem[]; shared?: FileItem[] }): FileRow[] {
  return [
    ...(r.owned ?? []).map((f): FileRow => ({ ...f, kind: f.direction === "out" ? "Created" : "Uploaded" })),
    ...(r.shared ?? []).map((f): FileRow => ({ ...f, kind: "Shared" })),
  ];
}

async function fetchFilePage(
  cursor?: string,
  scope = filesScope,
): Promise<{ rows: FileRow[]; nextCursor: string | null }> {
  const q = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor) q.set("cursor", cursor);
  if (scope) q.set("scope", scope);
  const r = await api<{ owned?: FileItem[]; shared?: FileItem[]; nextCursor?: string }>(`/api/files?${q.toString()}`);
  return { rows: rowsFromPage(r), nextCursor: r.nextCursor ?? null };
}

async function loadMoreFiles(): Promise<void> {
  if (!filesNextCursor || filesLoadingMore) return;
  const requestSeq = filesRequestSeq;
  const scope = filesScope;
  filesLoadingMore = true;
  drawFiles();
  try {
    const page = await fetchFilePage(filesNextCursor, scope);
    if (requestSeq !== filesRequestSeq) return;
    const byId = new Map(fileRows.map((f) => [f.id, f]));
    for (const row of page.rows) byId.set(row.id, row);
    fileRows = [...byId.values()];
    filesNextCursor = page.nextCursor;
  } catch (e) {
    if (requestSeq !== filesRequestSeq) return;
    filesNotice = errMessage(e, "加载更多文件失败。");
  }
  if (requestSeq !== filesRequestSeq) return;
  filesLoadingMore = false;
  drawFiles();
  if (filesLoadAllQueued) {
    filesLoadAllQueued = false;
    void loadAllFiles();
  }
}

async function loadAllFiles(): Promise<void> {
  if (!fileListNeedsAllPages({ query: filesQuery, type: filesType, ownership: filesOwnership, sort: filesSort }))
    return;
  if (filesLoadingMore) {
    filesLoadAllQueued = true;
    return;
  }
  const requestSeq = filesRequestSeq;
  const scope = filesScope;
  filesLoadingMore = true;
  drawFiles();
  try {
    while (filesNextCursor && requestSeq === filesRequestSeq) {
      const page = await fetchFilePage(filesNextCursor, scope);
      if (requestSeq !== filesRequestSeq) return;
      const byId = new Map(fileRows.map((file) => [file.id, file]));
      for (const row of page.rows) byId.set(row.id, row);
      fileRows = [...byId.values()];
      filesNextCursor = page.nextCursor;
    }
  } catch (e) {
    if (requestSeq !== filesRequestSeq) return;
    filesNotice = errMessage(e, "加载匹配文件失败。");
  }
  if (requestSeq !== filesRequestSeq) return;
  filesLoadAllQueued = false;
  filesLoadingMore = false;
  drawFiles();
}

async function loadFiles(seq: number): Promise<void> {
  const requestSeq = ++filesRequestSeq;
  filesLoadAllQueued = false;
  filesLoadingMore = false;
  await ensureContexts();
  drawFiles(true);
  try {
    const page = await fetchFilePage();
    if (requestSeq !== filesRequestSeq || seq !== appState.viewRenderSeq || appState.currentView !== "files") return;
    fileRows = page.rows;
    filesNextCursor = page.nextCursor;
    void loadAllFiles();
  } catch (e) {
    if (requestSeq !== filesRequestSeq || seq !== appState.viewRenderSeq || appState.currentView !== "files") return;
    filesNotice = errMessage(e, "文件加载失败。");
  }
  drawFiles();
}

export async function renderFiles(): Promise<void> {
  if (appState.currentView !== "files") return;
  if (scopedSession.active) {
    if (filesScope !== scopedSession.active.scopeId) {
      filesScope = scopedSession.active.scopeId;
      fileRows = [];
      filesNextCursor = null;
    }
    contextsState.selected = null;
  } else if (contextsState.selected) {
    filesScope = contextsState.selected;
    fileRows = [];
    filesNextCursor = null;
    contextsState.selected = null;
  }
  const seq = appState.viewRenderSeq;
  filesNotice = "";
  filesNextCursor = null;
  await loadFiles(seq);
}
