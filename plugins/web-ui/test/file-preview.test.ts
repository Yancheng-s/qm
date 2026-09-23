import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { installFilePreview, isReadingPreview, previewFileFromLink, type MountPreview } from "../src/file-preview.ts";
import { readPreviewBlob, MAX_PREVIEW_BYTES } from "../src/file-preview-fetch.ts";

function fixture(mount: MountPreview = async () => ({ destroy() {} })) {
  const dom = new JSDOM(
    '<a class="file-image" data-file-name="图片.png" href="/qm/api/files/abc/content/图片.png"><img alt="图片.png"></a><button id="outside">对话</button>',
    { url: "https://example.com/qm/chat/session" },
  );
  const { document } = dom.window;
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { value: document, configurable: true });
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  const uninstall = installFilePreview(document, mount);
  const dispose = () => {
    uninstall();
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
  };
  const link = document.querySelector("a")!;
  const click = () => link.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  return { dom, document, dispose, link, click };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

test("reading mode covers text and Markdown but leaves source files alone", () => {
  for (const name of ["文案.txt", "README.MD", "文档.markdown"]) {
    assert.ok(isReadingPreview({ name, href: "/file" }));
  }
  assert.equal(isReadingPreview({ name: "source.py", href: "/file", mimeType: "text/plain" }), false);
});

test("reading footer copies the complete source and back restores the conversation", async () => {
  const source = "# 标题\n\n完整正文\n\n- 项目一";
  const { dom, document, link, click, dispose } = fixture(async () => ({ text: source, destroy() {} }));
  link.dataset.fileName = "文案.md";
  let copied = "";
  Object.defineProperty(document, "execCommand", {
    value: () => {
      copied = document.querySelector("textarea")!.value;
      return true;
    },
  });
  click();
  assert.equal(document.querySelector(".file-preview-head"), null);
  const copy = document.querySelector<HTMLButtonElement>(
    ".file-preview-reading-footer button:not(.file-preview-close)",
  )!;
  assert.equal(copy.disabled, true);
  await tick();
  assert.equal(copy.disabled, false);
  copy.click();
  await tick();
  assert.equal(copied, source);
  assert.equal(document.querySelector('[role="status"]')!.textContent, "已复制全文");
  document.querySelector<HTMLButtonElement>(".file-preview-close")!.click();
  await tick();
  assert.equal(document.querySelector("dialog"), null);
  assert.equal(dom.window.location.pathname, "/qm/chat/session");
  dispose();
  dom.window.close();
});

test("file links preview in-page, downloads and external links keep their behavior", () => {
  const { dom, link, dispose } = fixture();
  assert.equal(previewFileFromLink(link, dom.window.location.href)?.name, "图片.png");
  link.setAttribute("download", "图片.png");
  assert.equal(previewFileFromLink(link, dom.window.location.href), null);
  link.removeAttribute("download");
  link.href = "https://external.example/api/files/abc/content";
  assert.equal(previewFileFromLink(link, dom.window.location.href), null);
  link.href = "https://example.com/qm/share/external/token/files/id";
  assert.ok(previewFileFromLink(link, "https://example.com/qm/share/external/token"));
  assert.equal(previewFileFromLink(link, "https://example.com/qm/share/external/other"), null);
  dispose();
  dom.window.close();
});

test("Back closes preview without routing away, forward restores it, close consumes only preview history", async () => {
  const { dom, document, click, dispose, link } = fixture();
  let routed = 0;
  dom.window.addEventListener("popstate", () => routed++);
  link.focus();
  assert.equal(click(), false);
  assert.equal(dom.window.history.length, 2);
  assert.ok(document.querySelector("dialog[open]"));
  dom.window.history.back();
  await tick();
  assert.equal(document.querySelector("dialog"), null);
  assert.equal(document.activeElement, link);
  assert.equal(routed, 0);
  assert.equal(dom.window.location.pathname, "/qm/chat/session");
  dom.window.history.forward();
  await tick();
  assert.ok(document.querySelector("dialog[open]"));
  document
    .querySelector(".file-preview-content")!
    .dispatchEvent(new dom.window.Event("preview-image-close", { bubbles: true }));
  await tick();
  assert.equal(document.querySelector("dialog"), null);
  assert.equal(dom.window.history.state?.qmFilePreview, undefined);
  dispose();
  dom.window.close();
});

test("closing while loading aborts fetch and destroys a late renderer", async () => {
  let finish!: (viewer: { destroy(): void }) => void;
  let signal!: AbortSignal;
  let destroyed = 0;
  const { dom, document, click, dispose } = fixture(async (_host, _file, current) => {
    signal = current;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  click();
  document
    .querySelector(".file-preview-content")!
    .dispatchEvent(new dom.window.Event("preview-image-close", { bubbles: true }));
  assert.equal(signal.aborted, true);
  finish({
    destroy() {
      destroyed++;
    },
  });
  await tick();
  assert.equal(destroyed, 1);
  assert.equal(document.querySelector("dialog"), null);
  dispose();
  dom.window.close();
});

test("failed preview stays in the modal and can retry", async () => {
  let tries = 0;
  const { dom, document, click, dispose } = fixture(async () => {
    tries++;
    throw new Error("文件已失效");
  });
  click();
  await tick();
  assert.match(document.querySelector("dialog")!.textContent!, /文件已失效/);
  document.querySelector<HTMLButtonElement>(".file-preview-note button")!.click();
  await tick();
  assert.equal(tries, 2);
  assert.equal(dom.window.history.length, 2);
  dispose();
  dom.window.close();
});

test("fetch preserves cookie auth and rejects unauthorized and oversized files", async () => {
  const signal = new AbortController().signal;
  const blob = await readPreviewBlob("https://example.com/api/files/a/content", signal, async (_input, init) => {
    assert.equal(init?.credentials, "same-origin");
    assert.equal(init?.redirect, "error");
    return new Response("hello", { headers: { "content-type": "text/plain; charset=utf-8" } });
  });
  assert.equal(await blob.text(), "hello");
  assert.equal(blob.type, "text/plain");
  await assert.rejects(
    readPreviewBlob("/file", signal, async () => new Response("", { status: 403 })),
    /访问权限/,
  );
  await assert.rejects(
    readPreviewBlob(
      "/file",
      signal,
      async () => new Response("", { headers: { "content-length": String(MAX_PREVIEW_BYTES + 1) } }),
    ),
    /50 MB/,
  );
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(MAX_PREVIEW_BYTES + 1));
      c.close();
    },
  });
  await assert.rejects(
    readPreviewBlob("/file", signal, async () => new Response(stream)),
    /50 MB/,
  );
});

test("image gallery stays within the conversation, deduplicates and replaces preview history", async () => {
  const { dom, document, link, click, dispose } = fixture();
  const conversation = document.createElement("section");
  conversation.className = "chat-scroll";
  document.body.append(conversation);
  conversation.append(link);
  const second = link.cloneNode(true) as HTMLAnchorElement;
  second.href = "/qm/api/files/second/content/第二张.png";
  second.dataset.fileName = "第二张.png";
  conversation.append(second, second.cloneNode(true));
  const other = second.cloneNode(true) as HTMLAnchorElement;
  other.href = "/qm/api/files/other/content/其他对话.png";
  document.body.append(other);
  click();
  assert.equal(document.querySelector(".file-preview-head"), null);
  assert.equal(document.querySelector(".file-preview-count")!.textContent, "1 / 2");
  assert.equal(document.querySelector<HTMLButtonElement>(".previous")!.disabled, true);
  document.querySelector<HTMLButtonElement>(".next")!.click();
  assert.equal(document.querySelector(".file-preview-count")!.textContent, "2 / 2");
  assert.equal(document.querySelector<HTMLAnchorElement>(".file-preview-download")!.href, second.href);
  assert.equal(document.querySelector<HTMLButtonElement>(".next")!.disabled, true);
  assert.equal(dom.window.history.length, 2);
  dom.window.history.back();
  await tick();
  assert.equal(document.querySelector("dialog"), null);
  assert.equal(dom.window.location.pathname, "/qm/chat/session");
  dispose();
  dom.window.close();
});
