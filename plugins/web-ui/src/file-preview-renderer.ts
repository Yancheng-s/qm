import {
  createViewer,
  imagePlugin,
  officePlugin,
  pdfPlugin,
  textPlugin,
  audioPlugin,
  videoPlugin,
  type PreviewPlugin,
} from "@open-file-viewer/core";
import "@open-file-viewer/core/style.css";
import "katex/dist/katex.css";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerSrc from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import { isImagePreview, isReadingPreview, type MountPreview } from "./file-preview";
import { readPreviewBlob } from "./file-preview-fetch";
import { installImageGestures } from "./image-preview-gestures";

const base = (import.meta as unknown as { env: { BASE_URL: string } }).env.BASE_URL;
const pdfOptions = {
  pdfjs,
  workerSrc,
  compatibilityMode: "legacy" as const,
  cMapUrl: base + "pdfjs/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: base + "pdfjs/standard_fonts/",
  wasmUrl: base + "pdfjs/wasm/",
  webFallbackScripts: "never" as const,
};

function interactiveImagePlugin(): PreviewPlugin {
  const plugin = imagePlugin();
  return {
    ...plugin,
    async render(ctx) {
      const instance = await plugin.render(ctx);
      const stage = ctx.viewport.querySelector<HTMLElement>(".ofv-image-stage:not(.ofv-image-stage-pages)");
      const visual = stage?.querySelector<HTMLElement>(".ofv-image-content");
      const dispose = stage && visual ? installImageGestures(stage, visual) : undefined;
      return {
        ...instance,
        canCommand: dispose ? () => false : instance.canCommand,
        destroy() {
          dispose?.();
          instance.destroy();
        },
      };
    },
  };
}

function readingTextPlugin(): PreviewPlugin {
  const plugin = textPlugin();
  return {
    ...plugin,
    async render(ctx) {
      const instance = await plugin.render(ctx);
      if (isReadingPreview({ name: ctx.file.name, href: "", mimeType: ctx.file.mimeType })) {
        const article = ctx.viewport.querySelector(".ofv-code-container, .ofv-markdown-body");
        if (article) {
          const filename = ctx.viewport.ownerDocument.createElement("p");
          filename.className = "file-preview-reading-filename";
          filename.textContent = ctx.file.name;
          article.prepend(filename);
        }
      }
      return instance;
    },
  };
}

export const mountPreview: MountPreview = async (host, file, signal) => {
  const blob = await readPreviewBlob(file.href, signal);
  const reading = isReadingPreview(file);
  const text = reading ? await blob.text() : undefined;
  signal.throwIfAborted();
  host.replaceChildren();
  const viewer = createViewer({
    container: host,
    file: blob,
    fileName: file.name,
    mimeType: file.mimeType || blob.type,
    locale: "zh-CN",
    theme: isImagePreview(file) ? "dark" : "auto",
    height: "100%",
    width: "100%",
    fit: /\.(?:pdf|docx?|rtf|odt)$/i.test(file.name) ? "width" : "contain",
    toolbar:
      reading || isImagePreview(file)
        ? { render: () => host.ownerDocument.createElement("div") }
        : { zoom: true, rotate: true, fullscreen: false, download: false, print: false, search: false },
    fallback: "download",
    plugins: [
      interactiveImagePlugin(),
      pdfPlugin(pdfOptions),
      officePlugin({ docx: { renderAltChunks: false }, pdf: pdfOptions }),
      readingTextPlugin(),
      audioPlugin(),
      videoPlugin(),
    ],
  });
  return { ...viewer, text };
};
