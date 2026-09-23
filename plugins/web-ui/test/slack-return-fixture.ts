import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

export function slackReturnTest(outcome: "success" | "expired" | "cancelled" | "wrong-account", session = false) {
  test(`Slack callback survives real router boot: ${outcome}`, async () => {
    const h = await harness({
      welcome: session,
      path: `${session ? "/s/sess-deep?" : "/settings?"}slackReturn=qa-slack-nonce${outcome === "cancelled" ? "&error=access_denied" : ""}`,
      slackReturn: outcome,
    });
    try {
      h.releaseSessions();
      await h.boot();
      const expected = {
        success: /你的 Slack 账户已关联/,
        cancelled: /授权已取消/,
        expired: /已过期，或由另一个/,
        "wrong-account": /已过期，或由另一个/,
      }[outcome];
      for (let i = 0; i < 100 && !expected.test(h.mainText()); i++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.match(h.mainText(), expected);
      if (session) {
        assert.equal(location.pathname, "/s/sess-deep");
        assert.equal(h.visibleConversation().state.sessionId, "sess-deep");
      }
      assert.equal(
        h.requests.some((p) => p.includes("/api/composio/slack/complete")),
        outcome === "success",
      );
      if (outcome === "success") assert.equal(sessionStorage.getItem("qm-slack-account"), null);
    } finally {
      await h.close();
    }
  });
}
