import { loadPiWebUi } from "./component-language";
import { loadMessageTranscript, messageLinkSeq } from "./message-link.ts";
import { initializeBrowserErrors, stopBrowserErrors } from "./browser-errors";
import { initializeAnalytics, capturePageview, stopAnalytics } from "./product-analytics";
import { captureSlackReturn } from "./slack-account";
import { captureConnectionReturn } from "./connection-return";
import { renderModelConnectGate } from "./model-connect";
import { html, nothing, render, type TemplateResult } from "lit";
import {
  Box,
  Brain,
  CalendarDays,
  Clock,
  Files,
  Folder,
  House,
  Inbox as InboxGlyph,
  KeyRound,
  LayoutGrid,
  LogOut,
  MessageSquare,
  PanelLeft,
  Plus,
  Repeat,
  Rocket,
  Search,
  Settings,
  ShieldUser,
  Webhook,
  type IconNode,
} from "lucide";
import {
  api,
  ApiError,
  setSigninRequiredHandler,
  type SigninRequired,
  fetchRuntimeConfig,
  fetchSessionApprovals,
  fetchTranscript,
  TAIL_TURNS,
  webFetch,
  withBase,
} from "./core-bridge";
import { seedRuntimeConfig } from "./runtime-config-store";
import { errMessage, swallow } from "../../chassis/src/errors";
import { randomUuid } from "./random-uuid";
import { brandMark, brandName, icon } from "./ui";
import { trackVisualViewport } from "./viewport";
import { markConnectorConnected } from "./chat";
import { clearSkillsCache, resyncModelSelection } from "./composer";
import { allConversations, ensureDeliveryStream, mainConversation, onExitCanvas } from "./conversations";
import { clearAllDrafts, saveDraft, storedDraft } from "./drafts";
import { deepLinkPath, isPlainLeftClick, parseDeepLink, UI_BASE } from "./deep-link";
import {
  adoptRemoteSplit,
  beginPaneKindDrag,
  drawCanvas,
  endPaneDrag,
  exitSplitIfActive,
  fetchRemoteSplit,
  focusedPaneSession,
  loadPersistedSplit,
  mountRestoredCanvas,
  restoredCanvasNeedsSessionList,
  splitState,
  singlePaneSessionId,
} from "./split";
import { activityOf } from "./session-list";
import { replaceChildrenPreservingFocus } from "./pane-focus";
import {
  openSession,
  refreshSessions,
  renderChatsPage,
  renderList,
  resetSessionsState,
  sessionTitle,
  sessionsState,
  sessionSelectionBar,
  revealSessionSurface,
  startNewChatInLastScope,
  startNewChat,
} from "./sessions";
import { openCronById, renderCronsPage, resetActiveCron, routeCronsHistory } from "./crons";
import { renderLoopsPage, resetActiveLoop } from "./loops";
import { openWebhookById, renderWebhooksPage, resetActiveWebhook, routeWebhooksHistory } from "./webhooks";
import { renderFiles } from "./files";
import { setScopedSession } from "./session-scope";
import { openChatSearch } from "./search";
import { closeBrowse, openBrowse } from "./browse";
import { attachTooltip, hideTooltip, tip } from "./tooltip";
import { clearConnectorNotice, noteConnectorResult, renderConnectors, resetKeychainState } from "./connectors";
import { openDeployById, renderDeploys } from "./deploys";
import { renderMemory, resetMemoryState } from "./memory";
import { renderCalendar } from "./calendar";
import {
  inboxOpenCount,
  refreshInbox,
  renderInbox,
  resetActiveInboxItem,
  resetInboxState,
  routeInboxHistory,
} from "./inbox";
import { openSkillById, renderSkills, resetActiveSkill, routeSkillsHistory } from "./skills";
import { applyTheme, renderSettings, watchSystemTheme } from "./settings";
import { contextsState, ensureContexts, renderContexts, resetContextsState, resolveProjectScope } from "./contexts";
import { appState, can, canView, isView, type AuthMode, type Me, type View } from "./shell-state";
import { activeSessionForDocumentTitle, updateDocumentTitle } from "./document-title";
export { appState, can, type Me, type View } from "./shell-state";

let userMenuOpen = false;
let footerEl: HTMLElement | null = null;

applyTheme();
watchSystemTheme();

function toggleUserMenu(e: Event): void {
  e.stopPropagation();
  userMenuOpen = !userMenuOpen;
  renderSidebarFooter();
}

export function closeUserMenu(): void {
  if (!userMenuOpen) return;
  userMenuOpen = false;
  renderSidebarFooter();
}

function signOutFromMenu(): void {
  userMenuOpen = false;
  renderSidebarFooter();
  void signOut();
}

let authMode: AuthMode = "portal";
let shellMounted = false;

setSigninRequiredHandler((detail) => {
  authMode = detail.mode ?? authMode;
  renderAuthGate(gateFor(authMode, detail.reason));
});

onExitCanvas(() => exitSplitIfActive());

export const ADMIN_BASE = (() => {
  const base = ((import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/").replace(/\/$/, "");
  return base ? base.replace(/\/[^/]+$/, "/admin") : "/admin";
})();
export const ADMIN_HOME_URL = `${ADMIN_BASE}/`;

export function syncUrlFromState(sessionOverride?: string | null): void {
  const chatState = mainConversation().state;
  const fromState =
    sessionOverride !== undefined ? sessionOverride : (chatState.sessionId ?? chatState.rememberedSessionId);
  const sessionId = splitState.active ? singlePaneSessionId() : fromState;
  let next = deepLinkPath(UI_BASE, appState.currentView, sessionId, contextsState.selected);
  const threadPrefix = `web:${appState.me?.user}:`;
  if (
    appState.currentView === "chats" &&
    !splitState.active &&
    !sessionId &&
    chatState.scopeId?.startsWith("group:") &&
    chatState.threadRef?.startsWith(threadPrefix)
  ) {
    const params = new URLSearchParams({
      scopeId: chatState.scopeId,
      conversationId: chatState.threadRef.slice(threadPrefix.length),
    });
    next += `?${params}`;
  }
  const linked = parseDeepLink(UI_BASE, location.pathname, location.search);
  const seq = messageLinkSeq(location.search);
  if (appState.currentView === "chats" && sessionId && linked.session === sessionId && seq !== null)
    next += `?seq=${seq}`;
  if (`${location.pathname}${location.search}` !== next) history.replaceState(null, "", next);
}

const appEl = document.getElementById("app");
if (!appEl) throw new Error("missing #app");

let sidebarOpen = true;
trackVisualViewport();

const SIDEBAR_MIN_W = 200;
const SIDEBAR_MAX_W = 520;
const SIDEBAR_W_KEY = "webui:sidebar-w";

function applySavedSidebarWidth(): void {
  const saved = Number(localStorage.getItem(SIDEBAR_W_KEY));
  if (Number.isFinite(saved) && saved >= SIDEBAR_MIN_W && saved <= SIDEBAR_MAX_W) {
    document.documentElement.style.setProperty("--sidebar-w", `${saved}px`);
  }
}

function startSidebarResize(e: PointerEvent): void {
  e.preventDefault();
  const handle = e.currentTarget as HTMLElement;
  const startX = e.clientX;
  const sidebar = (appEl as HTMLElement).querySelector<HTMLElement>(".sidebar");
  if (!sidebar) return;
  const startW = sidebar.getBoundingClientRect().width;
  handle.setPointerCapture(e.pointerId);
  document.body.classList.add("resizing-sidebar");
  let w = startW;
  const onMove = (ev: PointerEvent) => {
    w = Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, startW + (ev.clientX - startX)));
    document.documentElement.style.setProperty("--sidebar-w", `${w}px`);
  };
  const onUp = () => {
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("lostpointercapture", onUp);
    document.body.classList.remove("resizing-sidebar");
    localStorage.setItem(SIDEBAR_W_KEY, String(Math.round(w)));
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("lostpointercapture", onUp);
}

function resetSidebarWidth(): void {
  document.documentElement.style.removeProperty("--sidebar-w");
  localStorage.removeItem(SIDEBAR_W_KEY);
}

const ICON = {
  newChat: Plus,
  inbox: InboxGlyph,
  calendar: CalendarDays,
  chats: MessageSquare,
  contexts: Folder,
  files: Files,
  keychain: KeyRound,
  deploys: Rocket,
  webhooks: Webhook,
  crons: Clock,
  loops: Repeat,
  memory: Brain,
  skills: Box,
  home: House,
  browse: LayoutGrid,
};

export async function signOut(): Promise<void> {
  stopAnalytics();
  stopBrowserErrors();
  const portal = authMode === "portal";
  if (!portal) {
    try {
      await api("/signout", { method: "POST" });
    } catch {
      void 0;
    }
  }
  appState.me = null;
  closeBrowse();
  resetInboxState();
  clearAllDrafts();
  exitSplitIfActive();
  mainConversation().resetChatState();
  resetSessionsState();
  appState.currentView = "chats";
  clearSkillsCache();
  resetMemoryState();
  resetContextsState();
  resetKeychainState();
  mainConversation().composer.resetComposer();
  updateDocumentTitle();
  if (!portal) {
    renderAuthGate({ kind: "dev" });
    return;
  }
  let endedSession: boolean;
  try {
    const r = await fetch("/auth/logout", { method: "POST", headers: { accept: "application/json" } });
    endedSession = r.ok;
  } catch {
    endedSession = false;
  }
  if (!endedSession) {
    renderAuthGate({ kind: "portal" });
    return;
  }
  clearPortalAttempt();
  location.href = "/";
}

export async function exitImpersonation(): Promise<void> {
  try {
    await fetch("/auth/impersonate/stop", { method: "POST", headers: { accept: "application/json" } });
  } catch {
    void 0;
  }
  window.location.href = ADMIN_HOME_URL;
}

function impersonationBanner(by: string) {
  return html`
    <div class="impersonation-banner" role="status">
      <span class="impersonation-banner-text"
        >正在以此身份查看助手： <b>${appState.me?.user ?? ""}</b>。你的身份是 <b>${by}</b></span
      >
      <button class="impersonation-banner-exit" type="button" @click=${exitImpersonation}>退出身份模拟</button>
    </div>
  `;
}

function devBanner(user: string) {
  return html`
    <div class="top-banner dev" role="status">
      <span><b>开发模式</b> — 未配置身份提供方，当前登录身份：${user}</span>
      <button class="top-banner-action" type="button" @click=${signOut}>退出登录</button>
    </div>
  `;
}

function gateShell(body: unknown) {
  return html`
    <div class="signin">
      <div class="signin-panel">
        <div class="signin-brand">
          ${brandMark()}<span>${brandName()}</span>
          ${authMode === "dev" ? html`<span class="dev-chip">开发</span>` : nothing}
        </div>
        ${body}
      </div>
    </div>
  `;
}

const PORTAL_ATTEMPT_KEY = "qm.portal.signin.attempt";
const PORTAL_ATTEMPT_WINDOW_MS = 20_000;

function portalAttemptedRecently(): boolean {
  try {
    const at = Number(sessionStorage.getItem(PORTAL_ATTEMPT_KEY) ?? "");
    return Number.isFinite(at) && Date.now() - at < PORTAL_ATTEMPT_WINDOW_MS;
  } catch {
    return false;
  }
}

function signInWithPortal(): void {
  try {
    sessionStorage.setItem(PORTAL_ATTEMPT_KEY, String(Date.now()));
  } catch {
    void 0;
  }
  const returnTo = `${location.pathname}${location.search}`;
  location.href = `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

function clearPortalAttempt(): void {
  try {
    sessionStorage.removeItem(PORTAL_ATTEMPT_KEY);
  } catch {
    void 0;
  }
}

function portalGate() {
  if (portalAttemptedRecently())
    return gateShell(html`
      <h1>通过门户登录</h1>
      <p class="signin-body">此页面通过门户访问，但门户登录尚未为它创建会话。请直接打开门户地址。</p>
      <div class="hint">如果你打开的是此服务自身的地址，就会出现此问题：该服务无法独立完成身份验证。</div>
    `);
  return gateShell(html`
    <h1>登录会话已结束</h1>
    <p class="signin-body">你已退出登录。重新登录后将返回此页面。</p>
    <button class="btn primary" type="button" @click=${signInWithPortal}>登录</button>
  `);
}

function deniedGate() {
  return gateShell(html`
    <h1>你没有访问权限</h1>
    <p class="signin-body">你的账户已登录并通过验证，但尚未获准访问此实例，请联系管理员添加权限。</p>
    <button class="btn" type="button" @click=${signOut}>退出登录</button>
    ${authMode === "dev" ? html`<div class="hint">此实例的允许访问账户配置在 <b>WEB_UI_PRINCIPALS</b>.</div>` : nothing}
  `);
}

function retryBoot(): void {
  void bootSafely();
}

function unreachableGate() {
  return gateShell(html`
    <h1>无法连接助手</h1>
    <p class="signin-body">服务未响应，通常是暂时性问题。</p>
    <button class="btn primary" type="button" @click=${retryBoot}>重试</button>
    <div class="hint">如果问题持续出现，核心服务可能已停止运行。</div>
  `);
}

async function submitDevSignin(user: string): Promise<void> {
  renderAuthGate({ kind: "dev", value: user, pending: true });
  try {
    await api("/signin", { method: "POST", body: JSON.stringify({ user }) });
  } catch (err) {
    renderAuthGate({ kind: "dev", value: user, error: errMessage(err, "登录失败。") });
    return;
  }
  await bootSafely();
}

function devGate(gate: { value?: string; error?: string; pending?: boolean }) {
  return gateShell(html`
    <form
      @submit=${(e: Event) => {
        e.preventDefault();
        if (gate.pending) return;
        const input = (e.target as HTMLFormElement).querySelector("input") as HTMLInputElement | null;
        const user = input?.value.trim();
        if (user) void submitDevSignin(user);
      }}
    >
      <h1>开发登录</h1>
      <p class="signin-body">
        当前未配置身份提供方，因此此实例信任本地 Cookie。设置
        <b>CORE_SIGNING_SECRET</b> 并启动门户即可使用正式登录。
      </p>
      <label for="dev-principal">账户标识</label>
      <input
        id="dev-principal"
        name="principal"
        type="text"
        inputmode="email"
        autocomplete="username"
        spellcheck="false"
        required
        autofocus
        placeholder="you@org.com"
        .value=${gate.value ?? ""}
        ?disabled=${gate.pending === true}
      />
      <button class="btn primary" type="submit" ?disabled=${gate.pending === true}>
        ${gate.pending ? "正在登录…" : "继续"}
      </button>
      ${gate.error ? html`<div class="hint error" role="alert">${gate.error}</div>` : nothing}
    </form>
  `);
}

export type AuthGate =
  | { kind: "portal" }
  | { kind: "denied" }
  | { kind: "unreachable" }
  | { kind: "dev"; value?: string; error?: string; pending?: boolean };

export function renderAuthGate(gate: AuthGate): void {
  stopAnalytics();
  stopBrowserErrors();
  shellMounted = false;
  const body = (() => {
    switch (gate.kind) {
      case "portal":
        return portalGate();
      case "denied":
        return deniedGate();
      case "unreachable":
        return unreachableGate();
      default:
        return devGate(gate);
    }
  })();
  render(body, appEl as HTMLElement);
}

function gateFor(mode: AuthMode, reason: "unauthenticated" | "not_allowed" | undefined): AuthGate {
  if (reason === "not_allowed") return { kind: "denied" };
  return mode === "dev" ? { kind: "dev" } : { kind: "portal" };
}

export function mountShell(): void {
  applySavedSidebarWidth();
  const impersonatedBy = appState.me?.impersonatedBy ?? null;
  let banner: TemplateResult | typeof nothing = nothing;
  if (impersonatedBy) banner = impersonationBanner(impersonatedBy);
  else if (authMode === "dev") banner = devBanner(appState.me?.user ?? "");
  render(
    html`
      ${banner}
      <div class="layout ${sidebarOpen ? "" : "sidebar-closed"} ${banner !== nothing ? "bannered" : ""}">
        <aside class="sidebar" role="navigation" aria-label="导航" data-tip-placement=${sidebarOpen ? "top" : "right"}>
          <div class="brand">
            <div class="brand-lockup">${brandMark()}<span class="brand-name">${brandName()}</span></div>
            <button
              class="icon-btn sidebar-toggle sidebar-collapse-toggle"
              type="button"
              aria-label=${sidebarToggleLabel()}
              ${tip(sidebarToggleLabel())}
              @click=${toggleSidebar}
            >
              ${icon(PanelLeft, 17)}
            </button>
          </div>
          <div id="sidebar-top"></div>
          <div class="list" id="sidebar-body"></div>
          <div class="sidebar-footer" id="sidebar-footer"></div>
        </aside>
        <div
          class="sidebar-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整侧边栏宽度"
          @pointerdown=${startSidebarResize}
          @dblclick=${resetSidebarWidth}
        ></div>
        <section class="main" id="main" tabindex="-1">
          <div class="empty">选择一个对话，或开始新对话。</div>
        </section>
      </div>
    `,
    appEl as HTMLElement,
  );
  appState.topEl = (appEl as HTMLElement).querySelector("#sidebar-top");
  appState.listEl = (appEl as HTMLElement).querySelector("#sidebar-body");
  appState.mainEl = (appEl as HTMLElement).querySelector("#main");
  footerEl = (appEl as HTMLElement).querySelector("#sidebar-footer");
  renderSidebarFooter();
  renderSidebarTop();
  updateSidebarToggleLabels();
}

function inboxNavRow(): TemplateResult {
  const count = inboxOpenCount();
  return html`<a
    class="navrow ${appState.currentView === "inbox" ? "active" : ""}"
    href=${deepLinkPath(UI_BASE, "inbox", null)}
    data-view="inbox"
    draggable="true"
    @dragstart=${(e: DragEvent) => {
      e.dataTransfer?.setData("application/x-webui-inbox", "all");
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
      beginPaneKindDrag("inboxView", "all");
    }}
    @dragend=${() => endPaneDrag()}
  >
    ${icon(ICON.inbox, 17)}<span>收件箱</span>${count > 0 ? html`<span class="nav-badge" aria-label=${`${count} 项等待你处理`}>${count > 99 ? "99+" : count}</span>` : nothing}
  </a>`;
}

export function renderSidebarFooter(): void {
  if (!footerEl) return;
  render(
    html`
      <div class="user-menu ${userMenuOpen ? "menu-open" : ""}">
        <button
          class="user-pill"
          type="button"
          aria-haspopup="menu"
          aria-expanded=${userMenuOpen ? "true" : "false"}
          @click=${toggleUserMenu}
        >
          <span class="user-name">${appState.me?.displayName?.trim() || appState.me?.user || ""}</span>
        </button>
        ${
          userMenuOpen
            ? html`<div class="session-menu-popover user-menu-popover" role="menu">
                <button class="session-menu-option" type="button" role="menuitem" @click=${signOutFromMenu}>
                  ${icon(LogOut, 15)}<span>退出登录</span>
                </button>
              </div>`
            : nothing
        }
      </div>
      ${
        can("admin")
          ? html`<a class="icon-btn subtle" href=${ADMIN_HOME_URL} aria-label="管理后台" ${tip("管理后台")}>
              ${icon(ShieldUser, 17)}
            </a>`
          : nothing
      }
      <button class="icon-btn subtle" aria-label="设置" ${tip("设置")} @click=${() => switchView("settings")}>
        ${icon(Settings, 17)}
      </button>
    `,
    footerEl,
  );
}

export function renderSidebarTop(): void {
  syncDocumentTitle();
  if (!appState.topEl) return;
  const highlighted = (v: View) => v !== "chats" && appState.currentView === v;
  const navRow = (v: View, glyph: IconNode, label: string) =>
    html`<a
      class="navrow ${highlighted(v) ? "active" : ""}"
      href=${deepLinkPath(UI_BASE, v, null)}
      data-view=${v}
      aria-label=${label}
      ${tip(sidebarOpen ? "" : label)}
    >
      ${icon(glyph, 17)}<span>${label}</span>
    </a>`;
  const actionRow = (glyph: IconNode, label: string, run: () => void) =>
    html`<button class="navrow" type="button" aria-label=${label} ${tip(sidebarOpen ? "" : label)} @click=${run}>
      ${icon(glyph, 17)}<span>${label}</span>
    </button>`;
  const newChatLabel = splitState.active ? "新会话" : "新建对话";
  render(
    html`
      <nav class="nav quick-nav" @click=${onNavClick}>
        ${navRow("chats", ICON.home, "首页")}
        ${can("inbox") ? html`${inboxNavRow()} ${navRow("calendar", ICON.calendar, "日历")}` : nothing}
        ${actionRow(Search, "搜索", () => {
          hideTooltip();
          openChatSearch();
        })}
        ${actionRow(ICON.browse, "浏览", () => {
          hideTooltip();
          openBrowse();
        })}
      </nav>
      <div class="nav new-chat-nav">
        ${actionRow(ICON.newChat, newChatLabel, () => {
          hideTooltip();
          startNewChatInLastScope();
        })}
      </div>
      ${sessionSelectionBar() ?? nothing}
    `,
    appState.topEl,
  );
}

export function syncDocumentTitle(): void {
  if (!appState.me) {
    updateDocumentTitle();
    return;
  }
  const state = mainConversation().state;
  const active = splitState.active
    ? focusedPaneSession()
    : activeSessionForDocumentTitle(sessionsState.list, {
        openingKey: sessionsState.openingKey,
        sessionId: state.sessionId,
        threadRef: state.threadRef,
      });
  updateDocumentTitle(
    appState.currentView,
    active ? sessionTitle(active) : null,
    Boolean(active || (!splitState.active && state.threadRef)),
  );
}

function onNavClick(e: Event): void {
  const target = e.target as Element | null;
  const row = target?.closest<HTMLAnchorElement>(".navrow[data-view]");
  const view = row?.dataset.view;
  if (!isView(view)) return;
  if (e instanceof MouseEvent && !isPlainLeftClick(e)) return;
  e.preventDefault();
  setScopedSession(null);
  switchView(view);
}

export function switchView(v: View): void {
  if (!canView(v)) v = "chats";
  if (appState.currentView === v) {
    refreshActiveView(v);
    return;
  }
  appState.currentView = v;
  capturePageview(v);
  appState.viewRenderSeq++;
  sessionsState.openMenuId = null;
  sessionsState.renamingId = null;
  if (v !== "chats") {
    mainConversation().teardown();
    mainConversation().composer.resetComposer();
  }
  renderSidebarTop();
  syncUrlFromState();
  resetActiveDetail(v);
  switch (v) {
    case "chats":
      if (mountRestoredCanvas()) drawCanvas();
      else void renderChatsPage();
      renderList();
      break;
    case "inbox":
      void renderInbox();
      break;
    case "calendar":
      renderCalendar();
      break;
    case "webhooks":
      void renderWebhooksPage();
      break;
    case "crons":
      void renderCronsPage();
      break;
    case "loops":
      void renderLoopsPage();
      break;
    case "contexts":
      void renderContexts();
      break;
    case "files":
      void renderFiles();
      break;
    case "keychain":
      void renderConnectors();
      break;
    case "deploys":
      void renderDeploys();
      break;
    case "memory":
      void renderMemory();
      break;
    case "skills":
      void renderSkills();
      break;
    case "settings":
      renderSettings();
      break;
  }
}

function resetActiveDetail(v: View): void {
  switch (v) {
    case "inbox":
      resetActiveInboxItem();
      break;
    case "webhooks":
      resetActiveWebhook();
      break;
    case "crons":
      resetActiveCron();
      break;
    case "loops":
      resetActiveLoop();
      break;
    case "skills":
      resetActiveSkill();
      break;
  }
}

function refreshActiveView(v: View): void {
  resetActiveDetail(v);
  syncUrlFromState();
  switch (v) {
    case "chats":
      if (splitState.active) void refreshSessions({ silent: true, refreshContexts: true });
      else void renderChatsPage();
      break;
    case "inbox":
      void renderInbox();
      break;
    case "calendar":
      renderCalendar();
      break;
    case "contexts":
      void renderContexts();
      break;
    case "webhooks":
      void renderWebhooksPage();
      break;
    case "crons":
      void renderCronsPage();
      break;
    case "loops":
      void renderLoopsPage();
      break;
    case "files":
      void renderFiles();
      break;
    case "keychain":
      clearConnectorNotice();
      void renderConnectors();
      break;
    case "deploys":
      void renderDeploys();
      break;
    case "memory":
      void renderMemory();
      break;
    case "skills":
      void renderSkills();
      break;
    case "settings":
      renderSettings();
      break;
  }
}

export function showMainEmpty(text: string): void {
  exitSplitIfActive();
  mainConversation().state.host = null;
  if (appState.mainEl)
    appState.mainEl.replaceChildren(
      Object.assign(document.createElement("div"), { className: "empty", textContent: text }),
    );
}

function showConversationError(unavailable: boolean): void {
  showMainEmpty("");
  if (!appState.mainEl) return;
  render(
    html`
      <section class="conversation-error" aria-labelledby="conversation-error-title">
        <span class="conversation-error-code">${unavailable ? "连接异常" : "404"}</span>
        <h1 id="conversation-error-title" tabindex="-1">${unavailable ? "无法加载对话" : "找不到对话"}</h1>
        <p>${unavailable ? "加载对话时出错，请重试。" : "对话可能已删除，或当前登录账户没有访问权限。"}</p>
        <div class="conversation-error-actions">
          <a class="btn" href=${withBase("/")}>返回对话列表</a>
          ${unavailable ? html`<button class="btn" @click=${() => location.reload()}>重试</button>` : nothing}
        </div>
      </section>
    `,
    appState.mainEl,
  );
  appState.mainEl.querySelector<HTMLElement>("h1")?.focus();
  renderList();
  document.title = `${unavailable ? "无法加载对话" : "找不到对话"} · ${brandName()}`;
}

function toggleSidebar(): void {
  setSidebarOpen(!sidebarOpen);
}

function setSidebarOpen(open: boolean): void {
  sidebarOpen = open;
  (appEl as HTMLElement).querySelector(".layout")?.classList.toggle("sidebar-closed", !sidebarOpen);
  (appEl as HTMLElement).querySelector(".sidebar")?.setAttribute("data-tip-placement", open ? "top" : "right");
  updateSidebarToggleLabels();
  renderSidebarTop();
}

function sidebarToggleLabel(): string {
  return sidebarOpen ? "收起侧边栏" : "展开侧边栏";
}

function updateSidebarToggleLabels(): void {
  const collapseLabel = sidebarToggleLabel();
  (appEl as HTMLElement).querySelectorAll<HTMLButtonElement>(".sidebar-toggle").forEach((btn) => {
    btn.setAttribute("aria-expanded", sidebarOpen ? "true" : "false");
    btn.setAttribute("aria-label", collapseLabel);
    attachTooltip(btn, collapseLabel);
  });
}

export function replacePanePreservingFocus(host: HTMLElement): void {
  if (!appState.mainEl) return;
  replaceChildrenPreservingFocus(appState.mainEl, host);
}

window.addEventListener("popstate", () => {
  const routed = ["crons", "webhooks", "inbox", "skills"];
  if (!routed.includes(appState.currentView)) return;
  const { view, item } = parseDeepLink(UI_BASE, location.pathname, location.search);
  if (view !== appState.currentView) return;
  if (view === "crons") routeCronsHistory(item);
  else if (view === "webhooks") routeWebhooksHistory(item);
  else if (view === "skills") routeSkillsHistory(item);
  else routeInboxHistory(item);
});

window.addEventListener("focus", () => {
  if (!appState.me) return;
  if (appState.currentView === "contexts") void renderContexts();
  else if (appState.currentView === "chats") void refreshSessions({ silent: true, refreshContexts: true });
});

function warmDeferredChunks(): void {
  const warm = (): void => void loadPiWebUi().catch(() => {});
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
  if (ric) ric(warm);
  else setTimeout(warm, 1500);
}

function openAppEditChat(slug: string): void {
  const user = appState.me?.user ?? "anon";
  const threadRef = `web:${user}:app-edit:${slug}`;
  if (storedDraft(threadRef) === `更新我已部署的应用“${slug}”：`) saveDraft(threadRef, "");
  const existing = sessionsState.list.find((s) => s.threadRef === threadRef);
  if (existing) {
    void openSession(existing);
    return;
  }
  startNewChat(null, null, threadRef);
  renderList();
}

export async function bootSafely(): Promise<void> {
  try {
    await boot();
  } catch (e) {
    if (shellMounted) swallow("web-ui: boot", e);
    else renderAuthGate({ kind: "unreachable" });
  }
}

export async function boot(): Promise<void> {
  if (new URLSearchParams(location.search).get("themeOnly") === "1") return;
  captureConnectionReturn(location.href);
  captureSlackReturn(location.href);
  const params = new URLSearchParams(location.search);
  const {
    view: wanted,
    session: wantedSession,
    item: wantedItem,
  } = parseDeepLink(UI_BASE, location.pathname, location.search);
  document.body.classList.toggle("app-edit-embed", wanted === "app-edit" && params.get("embed") === "1");
  const chatsLink = wanted === null || wanted === "chats";
  const projectEntry = chatsLink && params.has("scopeId");
  const wantedScope = projectEntry ? params.get("scopeId")!.trim() : null;
  const wantedConversation = projectEntry ? params.get("conversationId")?.trim() || null : null;
  const linkedId = wantedSession && chatsLink ? wantedSession : null;
  let transcriptUnavailable = false;
  const wantedSeq = messageLinkSeq(location.search);
  const loadLinkedTranscript = (id: string) =>
    loadMessageTranscript((window) => fetchTranscript(id, window), wantedSeq, TAIL_TURNS).catch((error: unknown) => {
      transcriptUnavailable = !(error instanceof ApiError && (error.status === 404 || error.status === 403));
      return null;
    });
  const entriesPrefetch = linkedId ? loadLinkedTranscript(linkedId) : null;
  const approvalsPrefetch = linkedId ? fetchSessionApprovals(linkedId) : null;
  const runtimeConfigFetch = fetchRuntimeConfig();
  const remoteSplitFetch = projectEntry ? null : fetchRemoteSplit();

  let r: Response;
  try {
    r = await webFetch(withBase("/me"));
  } catch {
    renderAuthGate({ kind: "unreachable" });
    return;
  }
  if (r.status === 401) {
    const body = (await r.json().catch(() => ({}))) as SigninRequired;
    authMode = body.mode ?? "portal";
    renderAuthGate(gateFor(authMode, body.reason));
    return;
  }
  if (!r.ok) {
    renderAuthGate({ kind: "unreachable" });
    return;
  }
  resetKeychainState();
  appState.me = (await r.json()) as Me;
  void initializeBrowserErrors(appState.me);
  void initializeAnalytics(appState.me, isView(wanted) && canView(wanted) ? wanted : "chats");
  authMode = appState.me.mode ?? "portal";
  clearPortalAttempt();
  if (appState.me.individualModelAuth && !appState.me.modelAuthConnected) {
    shellMounted = false;
    renderModelConnectGate();
    return;
  }
  const personalScope = `personal:${appState.me.user}`;
  const prefetchedConfig = await runtimeConfigFetch;
  const runtimeConfig =
    prefetchedConfig?.scopeId === personalScope ? prefetchedConfig : await fetchRuntimeConfig(personalScope);
  if (runtimeConfig) {
    seedRuntimeConfig(personalScope, runtimeConfig);
  }
  resyncModelSelection();
  mountShell();
  shellMounted = true;
  ensureDeliveryStream();
  warmDeferredChunks();
  void refreshInbox({ silent: true });
  if (remoteSplitFetch) {
    loadPersistedSplit();
    await adoptRemoteSplit(remoteSplitFetch);
  }
  if (
    projectEntry &&
    (!wantedScope?.startsWith("group:") ||
      !wantedScope.slice("group:".length).trim() ||
      (wantedConversation !== null && !/^[A-Za-z0-9._-]{1,120}$/.test(wantedConversation)))
  ) {
    showMainEmpty("此对话链接缺少有效的项目或对话信息。");
    return;
  }

  const connectedProvider = params.get("status") === "connected" ? params.get("connector") : null;
  if (connectedProvider) markConnectorConnected(connectedProvider);
  const viewIntent = isView(wanted) && canView(wanted) && wanted !== "chats";

  const bareEntry = !viewIntent && !wantedSession && !projectEntry && wanted !== "app-edit" && !connectedProvider;
  if (bareEntry && !restoredCanvasNeedsSessionList()) mountRestoredCanvas(true);

  const sessions = refreshSessions({ showLoading: true });

  if (wantedSession && !viewIntent && wanted !== "app-edit") {
    const transcript = entriesPrefetch ?? loadLinkedTranscript(wantedSession);
    const linked = (await transcript)?.session;
    if (linked) {
      if (
        projectEntry &&
        (linked.scopeId !== wantedScope ||
          (wantedConversation && linked.threadRef !== `web:${appState.me.user}:${wantedConversation}`))
      ) {
        showConversationError(false);
        return;
      }
      exitSplitIfActive();
      if (!sessionsState.list.some((s) => s.id === linked.id)) sessionsState.list = [linked, ...sessionsState.list];
      revealSessionSurface(linked);
      await openSession(linked, transcript, approvalsPrefetch ?? undefined);
      if (wantedSeq !== null)
        requestAnimationFrame(() => {
          for (const conversation of allConversations())
            if (conversation.state.sessionId === linked.id) conversation.revealEntry(wantedSeq);
        });
      return;
    }
    await sessions;
    const match = sessionsState.list.find((s) => s.id === wantedSession);
    if (
      match &&
      (!projectEntry ||
        (match.scopeId === wantedScope &&
          (!wantedConversation || match.threadRef === `web:${appState.me.user}:${wantedConversation}`)))
    ) {
      exitSplitIfActive();
      revealSessionSurface(match);
      await openSession(match);
    } else {
      showConversationError(transcriptUnavailable);
    }
    return;
  }

  const sessionsLoaded = await sessions;

  if (projectEntry && wantedScope) {
    if (!sessionsLoaded) {
      showConversationError(true);
      return;
    }
    const threadRef = `web:${appState.me.user}:${wantedConversation ?? randomUuid()}`;
    const existing = sessionsState.list.find((session) => session.threadRef === threadRef);
    if (existing) {
      if (existing.scopeId !== wantedScope) {
        showConversationError(false);
        return;
      }
      revealSessionSurface(existing);
      await openSession(existing);
      return;
    }
    const context = (await ensureContexts()).find((context) => context.scopeId === wantedScope);
    if (!context) {
      showMainEmpty("该项目不可用，请检查访问权限或重试。");
      return;
    }
    mainConversation().mountContinuable(threadRef, null, wantedScope, [], context.project?.name ?? context.name);
    renderList();
    return;
  }

  if (wanted === "app-edit") {
    const slug = (params.get("slug") ?? "").toLowerCase();
    if (/^[a-z0-9-]{1,63}$/.test(slug)) {
      openAppEditChat(slug);
      return;
    }
    showMainEmpty("此编辑链接缺少有效的应用名称。");
    return;
  }

  if (wanted === "keychain") {
    const provider = params.get("connector");
    const status = params.get("status");
    if (provider && status) noteConnectorResult(provider, status);
    switchView("keychain");
  } else if (viewIntent) {
    if (wanted === "contexts" || wanted === "files" || wanted === "deploys") {
      const scope =
        params.get("scope") ?? (wantedItem ? resolveProjectScope(await ensureContexts(), wantedItem) : null);
      if (scope) contextsState.selected = scope;
    }
    if (wanted === "deploys" && wantedItem) openDeployById(wantedItem);
    if (wanted === "crons" && wantedItem) openCronById(wantedItem);
    if (wanted === "webhooks" && wantedItem) openWebhookById(wantedItem);
    if (wanted === "skills" && wantedItem) openSkillById(wantedItem);
    switchView(wanted as View);
    if (wanted === "inbox") routeInboxHistory(wantedItem);
  } else if (connectedProvider && sessionsState.list.length) {
    const recent = [...sessionsState.list].sort((a, b) => activityOf(b) - activityOf(a))[0]!;
    exitSplitIfActive();
    await openSession(recent);
  } else if (!mountRestoredCanvas() && !mainConversation().state.threadRef) {
    mainConversation().newChat();
  }
}
