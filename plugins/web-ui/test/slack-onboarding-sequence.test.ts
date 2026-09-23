import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

test("personal Slack linking appears beneath the confirmed company installation", async () => {
  const h = await harness({ path: "/", welcome: true });
  const previousFetch = globalThis.fetch;
  let installed = false;
  globalThis.fetch = async (input, init) => {
    if (String(input) === "/me")
      return Response.json({ user: "tester", org: "test", welcomeCohort: "F26", permissions: ["admin"] });
    if (String(input) === "/admin/api/slack-installation")
      return Response.json({ configured: installed, installAvailable: true, setup: { connected: installed } });
    return previousFetch(input, init);
  };
  try {
    h.releaseSessions();
    await h.boot();
    for (let i = 0; i < 100 && !h.mainText().includes("添加到 Slack"); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(h.mainText(), /添加到 Slack/);
    assert.equal(document.querySelector("qm-slack-account"), null);
    installed = true;
    window.dispatchEvent(new window.Event("focus"));
    for (let i = 0; i < 100 && !h.mainText().includes("关联你的 Slack 账户"); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(h.mainText(), /已将 QM 添加到 Slack/);
    assert.match(h.mainText(), /关联你的 Slack 账户/);
    assert.ok(h.mainText().indexOf("已将 QM 添加到 Slack") < h.mainText().indexOf("关联你的 Slack 账户"));
    assert.equal(document.querySelector("qm-onboarding-slack button.welcome-slack"), null);
    installed = false;
    window.dispatchEvent(new window.Event("focus"));
    for (let i = 0; i < 100 && document.querySelector("qm-slack-account"); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(document.querySelector("qm-slack-account"), null);
  } finally {
    globalThis.fetch = previousFetch;
    await h.close();
  }
});
