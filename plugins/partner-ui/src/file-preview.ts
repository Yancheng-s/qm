import { X } from "lucide";
import { withBase } from "./core-bridge";
import { icon } from "./ui";

interface PreviewableFile {
  id: string;
  name: string;
  mimetype: string;
}

let layer: HTMLElement | null = null;
let content: HTMLElement | null = null;
let titleEl: HTMLElement | null = null;
let viewer: { destroy(): void } | null = null;
let loadSeq = 0;

export function openFilePreview(file: PreviewableFile): void {
  ensureLayer();
  if (titleEl) titleEl.textContent = file.name;
  void loadFile(file);
}

export function closeFilePreview(): void {
  viewer?.destroy();
  viewer = null;
  layer?.classList.remove("open");
  document.body.classList.remove("file-preview-open");
}

function ensureLayer(): void {
  if (layer) {
    layer.classList.add("open");
    document.body.classList.add("file-preview-open");
    if (content) content.replaceChildren();
    return;
  }
  layer = document.createElement("div");
  layer.className = "file-preview-layer";
  const head = document.createElement("div");
  head.className = "file-preview-head";
  titleEl = document.createElement("div");
  titleEl.className = "file-preview-title";
  const close = document.createElement("button");
  close.className = "file-preview-close";
  close.type = "button";
  close.setAttribute("aria-label", "关闭预览");
  close.appendChild(icon(X, 18));
  close.addEventListener("click", closeFilePreview);
  head.append(titleEl, close);
  content = document.createElement("div");
  content.className = "file-preview-content";
  layer.append(head, content);
  layer.addEventListener("click", (e) => {
    if (e.target === layer) closeFilePreview();
  });
  document.addEventListener("keydown", onKeydown);
  document.body.appendChild(layer);
  document.body.classList.add("file-preview-open");
  requestAnimationFrame(() => layer?.classList.add("open"));
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") closeFilePreview();
}

async function loadFile(file: PreviewableFile): Promise<void> {
  if (!content) return;
  const seq = ++loadSeq;
  content.replaceChildren();
  const note = document.createElement("div");
  note.className = "file-preview-note";
  note.textContent = "正在加载预览…";
  content.appendChild(note);
  let blob: Blob;
  try {
    const res = await fetch(withBase(`/api/files/${encodeURIComponent(file.id)}/content`));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    blob = await res.blob();
  } catch {
    if (seq !== loadSeq) return;
    note.textContent = "预览加载失败，请稍后重试。";
    return;
  }
  const mod = await import("@open-file-viewer/core");
  await import("@open-file-viewer/core/style.css");
  const workerSrc = (await import("pdfjs-dist/build/pdf.worker.mjs?url")).default;
  if (seq !== loadSeq || !content) return;
  note.remove();
  viewer?.destroy();
  viewer = mod.createViewer({
    container: content,
    file: blob,
    fileName: file.name,
    mimeType: file.mimetype,
    locale: "zh-CN",
    theme: "auto",
    toolbar: { search: false },
    fit: "contain",
    fallback: "download",
    plugins: [mod.imagePlugin(), mod.textPlugin(), mod.pdfPlugin({ workerSrc }), mod.officePlugin()],
  });
}
