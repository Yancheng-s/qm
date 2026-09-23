import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

test("unavailable connections produce one setup message and recover together", async () => {
  const h = await harness({ path: "/", welcome: true });
  const previousFetch = globalThis.fetch;
  let unavailable = true;
  globalThis.fetch = async (input, init) => {
    if (unavailable && String(input).includes("/api/composio/"))
      return Response.json(
        { message: "App connections aren’t available for your account yet. Ask your administrator to enable them." },
        { status: 403 },
      );
    return previousFetch(input, init);
  };
  try {
    h.releaseSessions();
    await h.boot();
    for (let i = 0; i < 100 && !h.mainText().includes("App connections aren’t available"); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(h.mainText().split("App connections aren’t available").length - 1, 1);
    assert.doesNotMatch(h.mainText(), /无法检查已连接的应用|关联你的 Slack 账户/);
    unavailable = false;
    const retry = [...document.querySelectorAll<HTMLButtonElement>(".welcome-load button")][0];
    assert.ok(retry);
    retry.click();
    for (let i = 0; i < 100 && !h.mainText().includes("关联你的 Slack 账户"); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(h.mainText(), /关联你的 Slack 账户/);
    assert.doesNotMatch(h.mainText(), /App connections aren’t available|无法检查已连接的应用/);
  } finally {
    globalThis.fetch = previousFetch;
    await h.close();
  }
});
