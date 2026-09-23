import { html, nothing, render } from "lit";
import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Presentation,
  Search,
  Upload,
  type IconNode,
} from "lucide";
import { api, fileContentUrl, webFetch, withBase } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { browserRenderableImage, fieldSelect, formatBytes, icon, relTime } from "./ui";
import { contextsState, ensureContexts, personalScopeId, scopeTitle } from "./contexts";
import { appState } from "./shell";
import { fileListNeedsAllPages } from "./file-list";
import { scopedSession, scopedViewTopbar } from "./session-scope";
import { listRowsTpl } from "./list-page";
import { isTouch } from "./viewport";
import { sha256Hex } from "./sha256";

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
let filesDragActive = false;
let filesUploading = false;
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

type FileVisualKind =
  "image" | "pdf" | "spreadsheet" | "presentation" | "code" | "archive" | "audio" | "video" | "document" | "generic";

function fileVisual(f: FileItem): { glyph: IconNode; kind: FileVisualKind } {
  const name = f.name.toLowerCase();
  const mime = f.mimetype.toLowerCase();
  if (browserRenderableImage(mime)) return { glyph: FileImage, kind: "image" };
  if (mime.includes("pdf") || name.endsWith(".pdf")) return { glyph: FileText, kind: "pdf" };
  if (/(?:spreadsheet|excel|csv|tab-separated)/.test(mime) || /\.(?:csv|tsv|xls|xlsx|ods)$/.test(name))
    return { glyph: FileSpreadsheet, kind: "spreadsheet" };
  if (/(?:presentation|powerpoint)/.test(mime) || /\.(?:ppt|pptx|key|odp)$/.test(name))
    return { glyph: Presentation, kind: "presentation" };
  if (mime.includes("json") || name.endsWith(".json")) return { glyph: FileJson, kind: "code" };
  if (/(?:zip|archive|compressed|tar|gzip)/.test(mime) || /\.(?:zip|tar|gz|tgz|rar|7z)$/.test(name))
    return { glyph: FileArchive, kind: "archive" };
  if (mime.startsWith("audio/")) return { glyph: FileAudio, kind: "audio" };
  if (mime.startsWith("video/")) return { glyph: FileVideo, kind: "video" };
  if (
    /(?:javascript|typescript|xml|html|css|shell|python)/.test(mime) ||
    /\.(?:js|ts|tsx|jsx|html|css|py|sh|sql|xml|yaml|yml)$/.test(name)
  )
    return { glyph: FileCode, kind: "code" };
  if (mime.startsWith("text/") || typeOf(f) === "document") return { glyph: FileText, kind: "document" };
  return { glyph: File, kind: "generic" };
}

function groupFilesByScope(files: FileRow[]): Array<{ scope: string | null; files: FileRow[] }> {
  const groups = new Map<string, { scope: string | null; files: FileRow[] }>();
  for (const file of files) {
    const scope = fileScope(file);
    const key = scope ?? "";
    const group = groups.get(key) ?? { scope, files: [] };
    group.files.push(file);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function selectControl(
  label: string,
  value: string,
  options: Array<[string, string]>,
  onChange: (value: string) => void,
) {
  return html`<label class="list-select"
    ><span>${label}</span>${fieldSelect({
      compact: true,
      value,
      onChange,
      options: options.map(([v, text]) => html`<option value=${v}>${text}</option>`),
    })}</label
  >`;
}

function visibleFiles(): FileRow[] {
  const q = filesQuery.trim().toLowerCase();
  return fileRows
    .filter((f) => !filesScope || fileScope(f) === filesScope)
    .filter((f) => filesOwnership === "all" || (filesOwnership === "shared") === (f.kind === "Shared"))
    .filter((f) => filesType === "all" || typeOf(f) === filesType)
    .filter((f) => !q || `${f.name} ${f.mimetype}`.toLowerCase().includes(q))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function drawFiles(loading = false): void {
  if (appState.currentView !== "files" || !appState.mainEl) return;
  if (!filesHost || filesHost.parentElement !== appState.mainEl) {
    filesHost = document.createElement("div");
    filesHost.className = "pane files-page";
    appState.mainEl.replaceChildren(filesHost);
  }
  const visible = visibleFiles();
  const groups = groupFilesByScope(visible);
  const filtered = Boolean(filesScope || filesQuery.trim() || filesType !== "all" || filesOwnership !== "all");
  let dropLabel = isTouch() ? "选择要上传的文件" : "将文件拖到此处，或选择文件";
  if (filesDragActive) dropLabel = "拖入文件";
  else if (filesUploading) dropLabel = "正在上传…";
  const status = filesNotice || (loading && !fileRows.length ? "正在加载文件…" : "");
  const scoped = Boolean(scopedSession.active);
  filesHost.classList.toggle("scoped-view", scoped);
  render(
    html`
      ${scopedViewTopbar("files", drawFiles)}
      <div class="list-page-head">
        <h1 class="pane-title">文件</h1>
        <label class="list-search"
          >${icon(Search, 16)}<span class="sr-only">搜索文件</span
          ><input
            type="search"
            aria-label="搜索文件"
            placeholder="搜索文件名和类型…"
            .value=${filesQuery}
            @input=${(e: Event) => {
              filesQuery = (e.currentTarget as HTMLInputElement).value;
              drawFiles();
              void loadAllFiles();
            }}
        /></label>
      </div>
      <div class="list-toolbar">
        ${selectControl(
          "归属",
          filesOwnership,
          [
            ["all", "所有文件"],
            ["owned", "我的"],
            ["shared", "共享"],
          ],
          (v) => {
            filesOwnership = v as typeof filesOwnership;
            drawFiles();
            void loadAllFiles();
          },
        )}
        ${selectControl(
          "类型",
          filesType,
          [
            ["all", "所有类型"],
            ["image", "图片"],
            ["document", "文档"],
            ["other", "其他"],
          ],
          (v) => {
            filesType = v as typeof filesType;
            drawFiles();
            void loadAllFiles();
          },
        )}
      </div>
      ${status ? html`<div class="status" aria-live="polite">${status}</div>` : nothing}
      <button
        class="file-drop ${filesDragActive ? "dragging" : ""}"
        type="button"
        ?disabled=${filesUploading}
        @click=${pickFiles}
        @dragenter=${onFileDrag}
        @dragover=${onFileDrag}
        @dragleave=${onFileDragLeave}
        @drop=${onFileDrop}
      >
        ${icon(Upload, 16)}<span>${dropLabel}</span>
      </button>
      ${
        visible.length
          ? html`<div class="file-groups">
              ${groups.map(
                (group) =>
                  html`<section class="file-scope-group">
                    <h2>${scopeTitle(group.scope)}</h2>
                    ${listRowsTpl(group.files.map(fileRow), "file-list")}
                  </section>`,
              )}
            </div>`
          : html`<div class="empty compact">${filtered ? "没有符合筛选条件的文件。" : "暂无文件。"}</div>`
      }
      ${filesNextCursor ? html`<div class="list-footer"><button class="btn" type="button" ?disabled=${filesLoadingMore} @click=${() => void loadMoreFiles()}>${filesLoadingMore ? "加载中…" : "加载更多"}</button></div>` : nothing}
    `,
    filesHost,
  );
}

function fileRow(f: FileRow) {
  const contentUrl = fileContentUrl(f.id, f.name);
  const visual = fileVisual(f);
  const content = html`
    <span class="file-row-icon ${visual.kind}">${icon(visual.glyph, 18)}</span>
    <span class="list-row-title" dir="auto">${f.name}</span>
    <span class="list-row-meta"
      ><span>${formatBytes(f.sizeBytes)}</span><span>${relTime(f.createdAt)}</span>${
        f.openable ? nothing : html`<span>不可用</span>`
      }</span
    >
  `;
  return f.openable
    ? html`<a
        class="list-row file-row"
        data-file-name=${f.name}
        data-mime-type=${f.mimetype}
        href=${contentUrl}
        target="_blank"
        rel="noreferrer"
        >${content}</a
      >`
    : html`<article class="list-row file-row">${content}</article>`;
}

async function fileSha256(file: globalThis.File): Promise<string> {
  return sha256Hex(new Uint8Array(await file.arrayBuffer()));
}

async function uploadOne(file: globalThis.File): Promise<void> {
  const scope = filesScope ?? personalScopeId();
  const q = new URLSearchParams();
  if (scope) q.set("scope", scope);
  q.set("sha", await fileSha256(file));
  q.set("name", file.name || "file");
  const r = await webFetch(withBase(`/api/files/upload?${q.toString()}`), {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!r.ok) {
    const text = await r.text();
    let message = `上传失败（${r.status}）`;
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: string };
      message = parsed.message ?? parsed.error ?? message;
    } catch {
      if (text.trim()) message = text.trim();
    }
    throw new Error(message);
  }
}

async function uploadFiles(files: globalThis.File[]): Promise<void> {
  const picked = files.filter((f) => f.size >= 0);
  if (!picked.length || filesUploading) return;
  filesUploading = true;
  filesNotice = `正在上传 ${picked.length} ${"个文件"}…`;
  drawFiles();
  let uploaded = 0;
  try {
    for (const file of picked) {
      await uploadOne(file);
      uploaded++;
    }
    filesNotice = `已上传 ${picked.length} ${"个文件"}。`;
    await loadFiles(appState.viewRenderSeq);
  } catch (e) {
    filesNotice = `${uploaded ? `已上传 ${uploaded} / ${picked.length}。` : ""}${errMessage(e, "上传失败。")}`;
    if (uploaded) await loadFiles(appState.viewRenderSeq);
    else drawFiles();
  } finally {
    filesUploading = false;
    filesDragActive = false;
    drawFiles();
  }
}

function pickFiles(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.onchange = () => void uploadFiles(Array.from(input.files ?? []));
  input.click();
}

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

function onFileDrag(e: DragEvent): void {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (!filesDragActive) {
    filesDragActive = true;
    drawFiles();
  }
}

function onFileDragLeave(e: DragEvent): void {
  if (!hasFiles(e)) return;
  const current = e.currentTarget as HTMLElement;
  if (e.relatedTarget instanceof Node && current.contains(e.relatedTarget)) return;
  filesDragActive = false;
  drawFiles();
}

function onFileDrop(e: DragEvent): void {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.stopPropagation();
  filesDragActive = false;
  void uploadFiles(Array.from(e.dataTransfer?.files ?? []));
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
  if (!fileListNeedsAllPages({ query: filesQuery, type: filesType, ownership: filesOwnership, sort: "newest" })) return;
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
    filesNotice = errMessage(e, "加载所有匹配文件失败。");
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
    filesNotice = errMessage(e, "加载文件失败。");
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
  } else if (filesScope) {
    filesScope = null;
    fileRows = [];
    filesNextCursor = null;
  }
  const seq = appState.viewRenderSeq;
  filesNotice = "";
  filesNextCursor = null;
  await loadFiles(seq);
}
