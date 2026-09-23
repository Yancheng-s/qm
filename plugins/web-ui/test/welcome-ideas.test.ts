import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

test("More ideas opens a fresh personal web chat and sends the examples once", async () => {
  const h = await harness({ path: "/", welcome: true, listSessions: [] });
  Object.defineProperty(window.Element.prototype, "getAnimations", { configurable: true, value: () => [] });
  Object.defineProperty(window.Element.prototype, "animate", {
    configurable: true,
    value: () => ({ cancel() {}, currentTime: 0 }),
  });
  const matrixDescriptor = Object.getOwnPropertyDescriptor(globalThis, "DOMMatrix");
  Object.defineProperty(globalThis, "DOMMatrix", { configurable: true, value: class {} });
  const previousFetch = globalThis.fetch;
  const turns: Record<string, unknown>[] = [];
  const realNow = Date.now;
  let holdRuntime = false;
  let releaseRuntime: () => void = () => {};
  const runtimeHeld = new Promise<void>((resolve) => {
    releaseRuntime = resolve;
  });
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith("/api/runtime-config")) {
      if (holdRuntime) await runtimeHeld;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return Response.json({
        scopeId: "personal:tester",
        approvedHarnesses: ["pi"],
        modelsByHarness: { pi: ["test-model"] },
        modelCatalog: {
          "test-model": {
            id: "test-model",
            name: "Test",
            label: "Test",
            buttonLabel: "Test",
            provider: "anthropic",
            api: "anthropic-messages",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 10000,
            maxTokens: 1000,
          },
        },
        effective: { harnessId: "pi", modelId: "test-model" },
        orgDefault: { harnessId: "pi", modelId: "test-model", revision: 1 },
        scopeOverride: null,
        upgradeAvailable: false,
      });
    }
    if (String(input) === "/api/turn") {
      turns.push(JSON.parse(String(init?.body)));
      return Response.json({ reply: "Let's explore ideas." });
    }
    return previousFetch(input, init);
  };
  try {
    h.releaseSessions();
    await h.boot();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const originalThread = h.visibleConversation().state.threadRef;
    const draft = document.querySelector<HTMLTextAreaElement>(".composer-input")!;
    draft.value = "Keep this draft";
    draft.dispatchEvent(new window.Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    document.querySelector<HTMLButtonElement>(".welcome-more-ideas")!.click();
    assert.equal(h.visibleConversation().state.threadRef, originalThread);
    assert.equal(turns.length, 0);
    draft.value = "";
    draft.dispatchEvent(new window.Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const more = document.querySelector<HTMLButtonElement>(".welcome-more-ideas")!;
    assert.ok(more);
    holdRuntime = true;
    Date.now = () => realNow() + 31_000;
    more.click();
    more.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(turns.length, 0);
    assert.notEqual(h.visibleConversation().state.threadRef, originalThread);
    releaseRuntime();
    for (let i = 0; i < 100 && !turns.length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(turns.length, 1, h.mainText());
    assert.notEqual(turns[0]!.threadRef, originalThread);
    assert.match(String(turns[0]!.threadRef), /^web:tester:ideas:/);
    assert.equal(turns[0]!.scopeId, undefined);
    assert.equal(turns[0]!.proactiveOpener, undefined);
    assert.match(String(turns[0]!.text), /Work at a Startup/);
    assert.match(String(turns[0]!.text), /Stripe/);
    assert.match(String(turns[0]!.text), /融资看板/);
    assert.match(String(turns[0]!.text), /跳过新手引导/);
    assert.match(String(turns[0]!.text), /yc 工具/);
    assert.match(String(turns[0]!.text), /工具可用且已获授权时，通过 company\.get/);
    assert.match(String(turns[0]!.text), /company\.goals 读取带日期的目标与进展/);
    assert.match(String(turns[0]!.text), /get_yc_application 可用且已获授权/);
    assert.match(String(turns[0]!.text), /另一家公司的最近申请或草稿.*确认它对应当前公司/);
    assert.match(String(turns[0]!.text), /优先采用我的近期表述和带日期的当前目标/);
    assert.match(String(turns[0]!.text), /不要把历史申请回答当作当前事实，也不要假设公司资料最近更新过/);
    assert.match(String(turns[0]!.text), /工具或记录不可用时，基于已知信息继续/);
  } finally {
    releaseRuntime();
    Date.now = realNow;
    await h.close();
    if (matrixDescriptor) Object.defineProperty(globalThis, "DOMMatrix", matrixDescriptor);
    else Reflect.deleteProperty(globalThis, "DOMMatrix");
  }
});
