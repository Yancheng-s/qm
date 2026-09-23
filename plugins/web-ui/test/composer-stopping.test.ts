import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { Agent } from "@earendil-works/pi-agent-core";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { ComposerSurface, ConvCtx } from "../src/conv-types.ts";

test("one action button preserves drafts and blocks every submit path until stopping completes", async (t) => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><div id="composer"></div>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  let phone = false;
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({
      get matches() {
        return phone;
      },
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  let grantMicrophone: ((stream: MediaStream) => void) | undefined;
  let recognize: ((response: Response) => void) | undefined;
  Object.defineProperty(dom.window, "isSecureContext", { value: true });
  Object.defineProperty(dom.window.navigator, "mediaDevices", {
    value: {
      getUserMedia: () =>
        new Promise<MediaStream>((resolve) => {
          grantMicrophone = resolve;
        }),
    },
  });
  const requests: string[] = [];
  const globals = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    customElements: dom.window.customElements,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    MediaRecorder: class {
      static isTypeSupported() {
        return true;
      }
      mimeType = "audio/webm";
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: (() => void) | null = null;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"]) });
        this.onstop?.();
      }
    },
    fetch: async (input: RequestInfo | URL) => {
      if (String(input) === "/api/asr")
        return new Promise<Response>((resolve) => {
          recognize = resolve;
        });
      requests.push(String(input));
      return Response.json({ runId: "queued-test", sessions: [] });
    },
  };
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const vite = await createServer({
    configLoader: "runner",
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  let composer: ComposerSurface | undefined;
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { createComposerSurface } = await vite.ssrLoadModule("/src/composer.ts");
    const { seedRuntimeConfig } = await vite.ssrLoadModule("/src/runtime-config-store.ts");
    const { render } = await vite.ssrLoadModule("lit");
    appState.me = { user: "tester", org: "test" };
    const model = {
      id: "alpha",
      name: "Alpha",
      label: "Alpha",
      buttonLabel: "Alpha",
      provider: "openai",
      api: "openai-responses",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4096,
    };
    seedRuntimeConfig("personal:tester", {
      scopeId: "personal:tester",
      approvedHarnesses: ["pi"],
      modelsByHarness: { pi: ["alpha"] },
      modelCatalog: { alpha: model },
      orgDefault: { harnessId: "pi", modelId: "alpha", revision: 1 },
      effective: { harnessId: "pi", modelId: "alpha" },
      scopeOverride: null,
      upgradeAvailable: false,
    });
    const host = document.querySelector<HTMLElement>("#composer")!;
    let stopping = false;
    let prompts = 0;
    let stops = 0;
    const agentState = { isStreaming: true, model, messages: [] };
    const agent = {
      state: agentState,
      prompt: async () => {
        prompts++;
      },
    } as unknown as Agent;
    const draw = (): void => render(composer!.composerForm(agent), host);
    const ctx = {
      pane: false,
      chat: {
        state: {
          agent,
          host,
          threadRef: "web:tester:stopping",
          sessionId: "test-session",
          scopeId: null,
          resolvingApprovals: new Set<string>(),
        },
        activePendingApprovals: () => [],
        hasUnresolvedApproval: () => false,
        isStopping: () => stopping,
        drawActiveChat: draw,
        stopLiveRun: async () => {
          stops++;
          stopping = true;
          draw();
        },
        notePendingSessionOnSend() {},
        scrollToBottom() {},
      },
    } as unknown as ConvCtx;
    composer = createComposerSurface(ctx);
    ctx.composer = composer!;
    const button = (selector: string): HTMLButtonElement => host.querySelector<HTMLButtonElement>(selector)!;
    const type = (value: string): void => {
      const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
      input.value = value;
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    };
    composer!.state.draft = "Keep this draft";
    draw();
    assert.equal(button(".send-btn").disabled, false);
    assert.equal(host.querySelectorAll(".send-btn").length, 1);
    assert.equal(button(".send-btn").getAttribute("aria-label"), "停止生成");
    type("Keep this draft");
    assert.equal(button(".send-btn").disabled, false);
    button(".task-stop").click();
    assert.equal(stops, 1);
    assert.equal(host.querySelector(".stop-btn"), null);
    assert.equal(button(".send-btn").getAttribute("aria-label"), "正在停止任务");
    assert.equal(button(".send-btn").disabled, true);
    assert.ok(button(".send-btn").querySelector(".composer-action-spinner"));
    assert.equal(composer!.state.draft, "Keep this draft");
    assert.equal(agentState.isStreaming, true);
    for (const submit of ["enter", "ctrl-enter", "meta-enter", "form"]) {
      await t.test(`${submit} preserves the draft while stopping`, async () => {
        type(`Next instruction via ${submit}`);
        assert.equal(button(".send-btn").disabled, true);
        assert.equal(host.querySelector<HTMLTextAreaElement>("textarea")!.disabled, false);
        const before = requests.length;
        if (submit === "form") {
          host
            .querySelector("form")!
            .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
        } else {
          host.querySelector("textarea")!.dispatchEvent(
            new dom.window.KeyboardEvent("keydown", {
              key: "Enter",
              bubbles: true,
              cancelable: true,
              ctrlKey: submit === "ctrl-enter",
              metaKey: submit === "meta-enter",
            }),
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepEqual(requests.slice(before), []);
        assert.equal(prompts, 0);
        assert.equal(composer!.state.draft, `Next instruction via ${submit}`);
        assert.equal(agentState.isStreaming, true);
        assert.equal(stopping, true);
      });
    }
    const attachment = {
      id: "test-file",
      type: "document" as const,
      fileName: "draft.txt",
      mimeType: "text/plain",
      size: 1,
      content: "eA==",
    };
    composer!.state.attachments = [attachment];
    draw();
    assert.equal(button(".send-btn").disabled, true, "attachments remain staged while stopping");
    assert.deepEqual(composer!.state.attachments, [attachment]);
    composer!.state.attachments = [];
    stopping = false;
    agentState.isStreaming = false;
    composer!.state.draft = "Resume sending";
    draw();
    assert.equal(button(".send-btn").disabled, false, "sending recovers after stop completes");
    host.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(prompts, 1, "normal submission still works");
    agentState.isStreaming = true;
    composer!.state.draft = "Queue normally";
    draw();
    assert.equal(button(".send-btn").disabled, false);
    host.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(requests, [], "running tasks do not accept queued submissions");
    assert.equal(composer!.state.draft, "Queue normally");
    composer!.state.draft = "Preparing attachment";
    composer!.state.processingFiles = true;
    draw();
    assert.equal(button(".send-btn").disabled, false, "file processing does not disable stopping");
    agentState.isStreaming = false;
    draw();
    assert.equal(button(".send-btn").disabled, true, "file processing prevents sending");
    composer!.state.processingFiles = false;
    composer!.state.draft = "";
    phone = true;
    draw();
    assert.equal(button(".send-btn").getAttribute("aria-label"), "语音输入");
    button(".send-btn").click();
    assert.equal(button(".send-btn").getAttribute("aria-label"), "正在启动麦克风");
    assert.equal(button(".send-btn").disabled, true);
    grantMicrophone!({ getTracks: () => [{ stop() {} }] } as unknown as MediaStream);
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.equal(host.querySelectorAll(".send-btn").length, 1);
    assert.equal(button(".send-btn").getAttribute("aria-label"), "结束录音");
    assert.match(host.querySelector(".composer-voice-status")!.textContent!, /正在录音/);
    button(".send-btn").click();
    assert.equal(button(".send-btn").getAttribute("aria-label"), "正在识别语音");
    assert.equal(button(".send-btn").disabled, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    recognize!(Response.json({ text: "语音识别草稿" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(composer!.state.draft, "语音识别草稿");
    assert.equal(button(".send-btn").getAttribute("aria-label"), "发送");
    assert.equal(button(".send-btn").disabled, false);
    assert.equal(prompts, 1, "recognized text is not sent automatically");
    type("");
    assert.equal(button(".send-btn").getAttribute("aria-label"), "语音输入");
    composer!.state.attachments = [attachment];
    draw();
    assert.equal(button(".send-btn").getAttribute("aria-label"), "发送");
  } finally {
    composer?.dispose();
    await vite.close();
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

test("disabled Stop shares Send's muted styling", () => {
  const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
  assert.match(css, /\.send-btn:disabled,\s*\.stop-btn:disabled\s*\{[^}]*opacity: 0\.35;[^}]*cursor: not-allowed;/);
});
