import assert from "node:assert/strict";
import test from "node:test";
import { harness, SESSION, type Harness } from "./deep-link-boot-fixture.ts";

test("a share link paints its conversation from the transcript, without waiting for the session list", async () => {
  const h = await harness({ path: "/s/sess-deep" });
  try {
    await h.boot();
    assert.equal(h.sessionsState.loaded, false, "the sidebar list must still be in flight");
    assert.equal(h.visibleConversation().state.sessionId, SESSION.id, "the linked chat is already mounted");
    assert.deepEqual(
      h.sessionsState.list.map((s) => s.id),
      [SESSION.id],
      "the row the transcript carried seeds the list, so the header has its title",
    );
    assert.match(h.mainText(), /Deep linked chat/);
    assert.equal(
      h.requests.filter((p) => p === "/api/sessions").length,
      1,
      "boot must not stampede the expensive list route",
    );
    assert.equal(
      h.requests.filter((p) => p === `/api/sessions/${SESSION.id}?tailTurns=25`).length,
      1,
      "the pane reuses the prefetched transcript",
    );
    const transcript = h.requests.indexOf(`/api/sessions/${SESSION.id}?tailTurns=25`);
    assert.ok(transcript >= 0, "the transcript is fetched with the tail window");
    assert.ok(transcript < h.requests.indexOf("/me"), "and is in flight before /me is even asked");
    const approvals = h.requests.indexOf(`/api/sessions/${SESSION.id}/approvals`);
    assert.ok(approvals >= 0, "the pending approvals the mount needs are fetched too");
    assert.ok(approvals < h.requests.indexOf("/me"), "…in the same first round trip, not a serial one after it");
    assert.ok(
      h.requests.indexOf("/api/runtime-config") < h.requests.indexOf("/me"),
      "runtime-config rides the same round trip rather than queueing behind /me",
    );
  } finally {
    await h.close();
  }
});

test("a share link whose transcript 404s falls back to the session list", async () => {
  const h = await harness({ path: "/s/sess-deep", transcriptStatus: 404 });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    assert.equal(h.sessionsState.loaded, true, "the fallback waits for the list");
    assert.equal(h.visibleConversation().state.sessionId, null, "no conversation is mounted");
    assert.match(h.mainText(), /找不到对话/);
    assert.match(h.mainText(), /404/);
    assert.match(h.mainText(), /返回对话列表/);
    assert.equal(location.pathname, "/s/sess-deep");
    assert.equal(document.querySelector("textarea"), null);
    assert.equal(document.activeElement?.id, "conversation-error-title");
  } finally {
    await h.close();
  }
});

test("a share link whose transcript fetch flakes still opens from the session list", async () => {
  const h = await harness({
    path: "/s/sess-deep",
    transcriptStatus: 503,
    transcriptFailures: 1,
    listSessions: [SESSION],
  });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    assert.equal(h.visibleConversation().state.sessionId, SESSION.id);
  } finally {
    await h.close();
  }
});

test("a session list that wins the race keeps its own decorated rows", async () => {
  const listed = { ...SESSION, working: true };
  const other = { id: "sess-other", threadRef: "web:tester:other", scopeId: "personal:tester", title: "其他" };
  const h = await harness({ path: "/s/sess-deep", holdTranscript: true, listSessions: [other, listed] });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await h.sessionsReady();
    h.releaseTranscript();
    await booted;
    assert.deepEqual(
      h.sessionsState.list.map((s) => s.id),
      [other.id, SESSION.id],
      "the list the server sent keeps its order — the transcript's copy must not jump the queue",
    );
    assert.equal(
      (h.sessionsState.list.find((s) => s.id === SESSION.id) as { working?: boolean }).working,
      true,
      "…nor strip the decorations only the list route computes",
    );
    assert.equal(h.visibleConversation().state.sessionId, SESSION.id);
  } finally {
    await h.close();
  }
});

test("a list that omits the open conversation does not drop its row", async () => {
  const other = { id: "sess-other", threadRef: "web:tester:other", scopeId: "personal:tester", title: "其他" };
  const h = await harness({ path: "/s/sess-deep", listSessions: [other] });
  try {
    await h.boot();
    h.releaseSessions();
    await h.sessionsReady();
    assert.equal(h.visibleConversation().state.sessionId, SESSION.id);
    assert.ok(
      h.sessionsState.list.some((s) => s.id === SESSION.id),
      "the conversation the user is reading must keep its sidebar row",
    );
  } finally {
    await h.close();
  }
});

test("a list landing mid-open still keeps the row of the conversation being opened", async () => {
  const other = { id: "sess-other", threadRef: "web:tester:other", scopeId: "personal:tester", title: "其他" };
  const h = await harness({ path: "/s/sess-deep", holdApprovals: true, listSessions: [other] });
  try {
    const booted = h.boot();
    while (!h.sessionsState.openingKey) await new Promise((resolve) => setTimeout(resolve, 0));
    h.releaseSessions();
    await h.sessionsReady();
    h.releaseApprovals();
    await booted;
    assert.ok(
      h.sessionsState.list.some((s) => s.id === SESSION.id),
      "the row must survive a refresh that lands between the open starting and the mount finishing",
    );
  } finally {
    await h.close();
  }
});

test("a bare entry still mints a new chat once the list lands", async () => {
  const h = await harness({ path: "/" });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    assert.equal(h.sessionsState.loaded, true);
    assert.equal(h.appState.currentView, "chats");
    assert.equal(h.visibleConversation().state.sessionId, null);
    assert.ok(h.visibleConversation().state.threadRef, "a fresh chat is mounted");
  } finally {
    await h.close();
  }
});

test("a view deep link still waits for the list and never fetches a transcript", async () => {
  const h = await harness({ path: "/crons" });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    assert.equal(h.appState.currentView, "crons");
    assert.equal(h.sessionsState.loaded, true);
    assert.equal(h.requests.filter((p) => p.startsWith(`/api/sessions/${SESSION.id}`)).length, 0);
  } finally {
    await h.close();
  }
});

test("a server failure shows a retry page rather than a missing conversation", async () => {
  const h = await harness({ path: "/s/sess-deep", transcriptStatus: 503 });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    assert.match(h.mainText(), /无法加载对话/);
    assert.match(h.mainText(), /重试/);
    assert.doesNotMatch(h.mainText(), /404/);
    assert.equal(location.pathname, "/s/sess-deep");
  } finally {
    await h.close();
  }
});

test("a missing share link keeps its error page instead of restoring the saved canvas", async () => {
  const h = await harness({ path: "/s/sess-deep", transcriptStatus: 404, savedCanvas: true });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(h.mainText(), /找不到对话/);
    assert.equal(location.pathname, "/s/sess-deep");
    assert.equal(document.querySelector(".dockview-theme-light"), null);
    assert.equal(document.querySelector("textarea"), null);
  } finally {
    await h.close();
  }
});

async function waitForText(h: Harness, text: RegExp): Promise<void> {
  for (let i = 0; i < 100 && !text.test(h.mainText()); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.match(h.mainText(), text);
}

test("saved empty welcome stays an empty chat and doesn't show another starter heading", async () => {
  const h = await harness({ path: "/s/sess-deep", welcome: true });
  try {
    await h.boot();
    await waitForText(h, /连接你的应用/);
    assert.ok(document.querySelector(".empty-chat qm-onboarding-welcome"));
    assert.equal(document.querySelector(".chat-cta"), null);
  } finally {
    await h.close();
  }
});

test("a failed connection refresh removes previously verified badges", async () => {
  const h = await harness({ path: "/s/sess-deep", welcome: true });
  try {
    h.setConnections([{ id: "ca_test", toolkit: "gmail" }]);
    await h.boot();
    await waitForText(h, /Gmail 已连接/);
    h.setConnections([], 503);
    window.dispatchEvent(new Event("focus"));
    await waitForText(h, /无法检查已连接的应用/);
    assert.doesNotMatch(h.mainText(), /Gmail 已连接/);
  } finally {
    await h.close();
  }
});

test("a message link loads older history and highlights the addressed row", async () => {
  const h = await harness({ path: "/s/sess-deep?seq=10", messageLink: true });
  try {
    await h.boot();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(h.requests.some((p) => p.includes("beforeSeq=80")));
    assert.ok(document.querySelector('[data-entry-seqs="10"]'));
    assert.equal(document.querySelector(".linked-message")?.getAttribute("data-entry-seqs"), "10");
    assert.equal(document.querySelector(".linked-message")?.getAttribute("data-scrolled"), "true");
  } finally {
    await h.close();
  }
});

const PROJECT = { scopeId: "group:project-004", kind: "group", name: "004", sessionCount: 0, lastActivityAt: null };
const PROJECT_SESSION = { ...SESSION, scopeId: PROJECT.scopeId };

for (const phone of [true, false]) {
  test(`an apps link opens a new project chat and preserves its identity on ${phone ? "mobile" : "desktop"}`, async () => {
    const h = await harness({
      path: "/chat/?scopeId=group%3Aproject-004&conversationId=new-chat",
      contexts: [PROJECT],
      phone,
      savedCanvas: true,
    });
    try {
      h.releaseSessions();
      await h.boot();
      const state = h.visibleConversation().state;
      assert.equal(state.sessionId, null);
      assert.equal(state.threadRef, "web:tester:new-chat");
      assert.equal(state.scopeId, PROJECT.scopeId);
      assert.equal(new URLSearchParams(location.search).get("scopeId"), PROJECT.scopeId);
      assert.equal(new URLSearchParams(location.search).get("conversationId"), "new-chat");
      assert.ok(document.querySelector(".composer-wrap"));
      assert.equal(
        h.requests.some((path) => path.includes("old-a") || path.includes("old-b")),
        false,
      );
    } finally {
      await h.close();
    }
  });

  test(`an apps history link opens the requested session on ${phone ? "mobile" : "desktop"}`, async () => {
    const h = await harness({
      path: "/chat/?scopeId=group%3Aproject-004&conversationId=deep&session=sess-deep",
      session: PROJECT_SESSION,
      contexts: [PROJECT],
      phone,
      savedCanvas: true,
    });
    try {
      await h.boot();
      assert.equal(h.visibleConversation().state.sessionId, SESSION.id);
      assert.equal(h.visibleConversation().state.scopeId, PROJECT.scopeId);
      assert.equal(location.pathname, "/s/sess-deep");
      assert.equal(h.sessionsState.loaded, false);
    } finally {
      await h.close();
    }
  });
}

test("an apps conversation id resolves its history without a session id", async () => {
  const h = await harness({
    path: "/chat/?scopeId=group%3Aproject-004&conversationId=deep",
    listSessions: [PROJECT_SESSION],
    session: PROJECT_SESSION,
    contexts: [PROJECT],
    phone: true,
  });
  try {
    h.releaseSessions();
    await h.boot();
    assert.equal(h.visibleConversation().state.sessionId, SESSION.id);
    assert.equal(h.visibleConversation().state.scopeId, PROJECT.scopeId);
  } finally {
    await h.close();
  }
});

test("an apps project link without a conversation id creates a refreshable project chat", async () => {
  const h = await harness({ path: "/?scopeId=group%3Aproject-004", contexts: [PROJECT], phone: true });
  try {
    h.releaseSessions();
    await h.boot();
    const id = new URLSearchParams(location.search).get("conversationId");
    assert.ok(id);
    assert.equal(h.visibleConversation().state.threadRef, `web:tester:${id}`);
    assert.equal(h.visibleConversation().state.scopeId, PROJECT.scopeId);
  } finally {
    await h.close();
  }
});

for (const options of [
  { path: "/chat/?scopeId=group%3Aproject-004&conversationId=deep", sessionsStatus: 503 },
  { path: "/chat/?scopeId=group%3Aproject-004&conversationId=deep" },
  { path: "/chat/?scopeId=&conversationId=deep" },
  { path: "/chat/?scopeId=group%3Aproject-004&conversationId=bad%3Avalue" },
  { path: "/chat/?scopeId=group%3Aproject-004&conversationId=deep", listSessions: [SESSION] },
  { path: "/chat/?scopeId=group%3Aproject-004&conversationId=deep&session=sess-deep" },
]) {
  test(`an invalid or unavailable apps target never opens a personal chat: ${JSON.stringify(options)}`, async () => {
    const h = await harness({ ...options, phone: true, savedCanvas: true });
    try {
      h.releaseSessions();
      await h.boot();
      assert.equal(h.visibleConversation().state.threadRef, null);
      assert.equal(document.querySelector("textarea"), null);
      assert.equal(
        new URLSearchParams(location.search).get("scopeId"),
        new URLSearchParams(options.path.split("?")[1]).get("scopeId"),
      );
    } finally {
      await h.close();
    }
  });
}
