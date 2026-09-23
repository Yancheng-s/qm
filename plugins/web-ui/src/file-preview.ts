import { createElement, ChevronLeft, ChevronRight, Download } from "lucide";
import { writeClipboardText } from "./clipboard.ts";

export interface PreviewFile {
  href: string;
  name: string;
  mimeType?: string;
}

export interface PreviewRenderer {
  text?: string;
  destroy(): void;
}

export type MountPreview = (host: HTMLElement, file: PreviewFile, signal: AbortSignal) => Promise<PreviewRenderer>;

const HISTORY_KEY = "qmFilePreview";

export function isReadingPreview(file: PreviewFile): boolean {
  if (/\.(?:txt|md|markdown)$/i.test(file.name)) return true;
  return !/\.[^.]+$/.test(file.name) && /^text\/(?:plain|markdown)(?:;|$)/i.test(file.mimeType ?? "");
}

export function isImagePreview(file: PreviewFile): boolean {
  return (
    /^image\//i.test(file.mimeType ?? "") ||
    /\.(?:png|jpe?g|gif|webp|avif|svg|bmp|ico|tiff?|heic|heif)$/i.test(file.name)
  );
}

export function previewFileFromLink(link: HTMLAnchorElement, pageUrl: string): PreviewFile | null {
  if (link.hasAttribute("download") || link.closest(".file-preview-layer")) return null;
  const page = new URL(pageUrl);
  const url = new URL(link.href, page);
  const internal = url.origin === page.origin && /\/api\/files\/[^/]+\/content(?:\/[^/]+)?$/.test(url.pathname);
  const shared =
    url.origin === page.origin && url.pathname.startsWith(page.pathname + "/files/") && /\/share\//.test(page.pathname);
  const local =
    ((url.protocol === "blob:" && url.origin === page.origin) || url.protocol === "data:") &&
    link.matches(".file-image, .file-chip");
  if (!internal && !shared && !local) return null;
  let pathName = "";
  if (internal && !url.pathname.endsWith("/content")) {
    try {
      pathName = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    } catch {
      pathName = "";
    }
  }
  return {
    href: url.href,
    name:
      link.dataset.fileName ||
      link.querySelector("img")?.alt ||
      pathName ||
      link.querySelector(".list-row-title, span[dir]")?.textContent ||
      link.textContent?.trim() ||
      "附件",
    mimeType: link.dataset.mimeType,
  };
}

export function installFilePreview(doc: Document, mount: MountPreview): () => void {
  const win = doc.defaultView!;
  let dialog: HTMLDialogElement | null = null;
  let controller: AbortController | null = null;
  let viewer: PreviewRenderer | null = null;
  let restoreFocus: HTMLElement | null = null;
  let closing = false;
  let previewPage = "";
  let generation = 0;
  const saved = win.history.state;
  if (saved?.[HISTORY_KEY]) {
    const { [HISTORY_KEY]: ignored, ...rest } = saved;
    void ignored;
    win.history.replaceState(rest, "");
  }

  function clear(): void {
    generation++;
    controller?.abort();
    controller = null;
    viewer?.destroy();
    viewer = null;
    dialog?.close();
    dialog?.remove();
    dialog = null;
    doc.body.classList.remove("file-preview-open");
    if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
    restoreFocus = null;
  }

  function close(): void {
    if (!dialog || closing) return;
    clear();
    if (win.history.state?.[HISTORY_KEY] && win.location.href === previewPage) {
      closing = true;
      win.history.back();
    }
  }

  function show(file: PreviewFile, push: boolean, images: PreviewFile[] = [file]): void {
    if (closing) return;
    const wasOpen = Boolean(dialog);
    const focused = restoreFocus ?? (doc.activeElement as HTMLElement | null);
    clear();
    restoreFocus = focused;
    previewPage = win.location.href;
    if (push) {
      const state = { ...win.history.state, [HISTORY_KEY]: { ...file, images } };
      if (wasOpen) win.history.replaceState(state, "");
      else win.history.pushState(state, "");
    }
    const seq = generation;
    controller = new AbortController();
    const signal = controller.signal;
    dialog = doc.createElement("dialog");
    dialog.className = "file-preview-layer";
    const image = isImagePreview(file);
    const reading = isReadingPreview(file);
    dialog.classList.toggle("file-preview-image", image);
    dialog.classList.toggle("file-preview-reading", reading);
    dialog.setAttribute("aria-label", "附件预览：" + file.name);
    const head = doc.createElement("header");
    head.className = "file-preview-head";
    const title = doc.createElement("strong");
    title.className = "file-preview-title";
    title.textContent = file.name;
    const download = doc.createElement("a");
    download.className = "file-preview-download";
    download.href = file.href;
    download.download = file.name;
    download.textContent = "下载";
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "file-preview-close";
    button.textContent = "关闭";
    button.addEventListener("click", close);
    const body = doc.createElement("div");
    body.className = "file-preview-content";
    body.setAttribute("aria-live", "polite");
    const note = doc.createElement("p");
    note.className = "file-preview-note";
    note.textContent = "正在加载预览…";
    body.append(note);
    let copy: HTMLButtonElement | undefined;
    if (image) {
      const index = Math.max(
        0,
        images.findIndex((entry) => entry.href === file.href),
      );
      const change = (next: number) => {
        if (next >= 0 && next < images.length) show(images[next]!, true, images);
      };
      for (const [label, icon, offset] of [
        ["上一张", ChevronLeft, -1],
        ["下一张", ChevronRight, 1],
      ] as const) {
        const arrow = doc.createElement("button");
        arrow.type = "button";
        arrow.className = "file-preview-arrow " + (offset < 0 ? "previous" : "next");
        arrow.setAttribute("aria-label", label);
        arrow.disabled = index + offset < 0 || index + offset >= images.length;
        arrow.hidden = images.length < 2;
        arrow.append(createElement(icon));
        arrow.addEventListener("click", () => change(index + offset));
        dialog.append(arrow);
      }
      const footer = doc.createElement("footer");
      footer.className = "file-preview-image-footer";
      const count = doc.createElement("span");
      count.className = "file-preview-count";
      count.setAttribute("role", "status");
      count.textContent = index + 1 + " / " + images.length;
      download.prepend(createElement(Download));
      download.setAttribute("aria-label", "下载当前图片");
      footer.append(count, download);
      dialog.append(body, footer);
      body.addEventListener("preview-image-close", close);
      dialog.addEventListener("keydown", (event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          change(index + (event.key === "ArrowLeft" ? -1 : 1));
        }
      });
    } else if (reading) {
      button.textContent = "关闭预览";
      const footer = doc.createElement("footer");
      footer.className = "file-preview-reading-footer";
      copy = doc.createElement("button");
      copy.type = "button";
      copy.textContent = "复制全文";
      copy.disabled = true;
      const status = doc.createElement("span");
      status.setAttribute("role", "status");
      copy.addEventListener("click", async () => {
        if (viewer?.text === undefined) return;
        try {
          await writeClipboardText(viewer.text);
          status.textContent = "已复制全文";
        } catch {
          status.textContent = "复制失败，请长按正文选择复制";
        }
      });
      footer.append(button, copy, download, status);
      dialog.append(body, footer);
    } else {
      head.append(title, download, button);
      dialog.append(head, body);
    }
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      close();
    });
    doc.body.append(dialog);
    doc.body.classList.add("file-preview-open");
    dialog.showModal();
    if (image) {
      dialog.tabIndex = -1;
      dialog.focus({ preventScroll: true });
    } else button.focus({ preventScroll: true });
    void mount(body, file, signal)
      .then((loaded) => {
        if (seq !== generation || signal.aborted) loaded.destroy();
        else {
          viewer = loaded;
          if (copy) copy.disabled = loaded.text === undefined;
        }
      })
      .catch((error: unknown) => {
        if (seq !== generation || signal.aborted) return;
        body.replaceChildren(note);
        note.textContent = error instanceof Error ? error.message : "预览失败，请重试或下载文件。";
        const retry = doc.createElement("button");
        retry.type = "button";
        retry.className = "btn";
        retry.textContent = "重试";
        retry.addEventListener("click", () => show(file, false, images));
        note.append(doc.createElement("br"), retry);
        if (image) note.append(button);
      });
  }

  function click(event: MouseEvent): void {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!link) return;
    const file = previewFileFromLink(link, win.location.href);
    if (!file) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const images = new Map<string, PreviewFile>();
    if (isImagePreview(file)) {
      const scope = link.closest(".chat-scroll, .shared-conversation") ?? doc;
      for (const candidate of scope.querySelectorAll<HTMLAnchorElement>("a[href]")) {
        if (candidate.closest("[hidden], [aria-hidden=true]")) continue;
        const entry = previewFileFromLink(candidate, win.location.href);
        if (entry && isImagePreview(entry)) images.set(entry.href, entry);
      }
      if (!images.has(file.href)) images.set(file.href, file);
    }
    show(file, true, images.size ? [...images.values()] : [file]);
  }

  function pop(event: PopStateEvent): void {
    const file = event.state?.[HISTORY_KEY] as (PreviewFile & { images?: PreviewFile[] }) | undefined;
    if (!dialog && !closing && !file) return;
    if (win.location.href !== previewPage) {
      closing = false;
      clear();
      return;
    }
    event.stopImmediatePropagation();
    closing = false;
    if (file) show(file, false, file.images);
    else clear();
  }

  doc.addEventListener("click", click, true);
  win.addEventListener("popstate", pop, true);
  return () => {
    clear();
    doc.removeEventListener("click", click, true);
    win.removeEventListener("popstate", pop, true);
  };
}
