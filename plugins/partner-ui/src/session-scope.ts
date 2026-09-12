import { html, nothing, type TemplateResult } from "lit";
import { ChevronLeft, GitFork, PanelRight, X } from "lucide";
import { api } from "./core-bridge";
import { appState } from "./shell-state";
import { icon } from "./ui";

/** A session's context carried into the crons/files/memory views so the whole
 * view stays scoped to that project and keeps the session top bar. */
export interface ScopedSessionInfo {
  scopeId: string;
  sessionId: string | null;
  threadRef: string | null;
  title: string;
  crumb: string | null;
}

export const scopedSession: { active: ScopedSessionInfo | null } = { active: null };

export function setScopedSession(info: ScopedSessionInfo | null): void {
  scopedSession.active = info;
}

interface CronLite {
  id: string;
  ownerScopeId: string;
  enabled: boolean;
  archived?: boolean;
}

const toolCountCache = new Map<string, { count: number; at: number }>();
const toolCountInFlight = new Set<string>();

const TOOL_COUNTERS: Partial<Record<SessionTool, (scope: string) => Promise<number>>> = {
  crons: async (scope) => {
    const r = await api<{ crons?: CronLite[]; visible?: CronLite[] }>("/api/crons");
    const seen = new Set<string>();
    let count = 0;
    for (const c of [...(r.crons ?? []), ...(r.visible ?? [])]) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      if (c.ownerScopeId === scope && c.enabled && !c.archived) count++;
    }
    return count;
  },
  files: async (scope) => {
    const q = new URLSearchParams({ limit: "100", scope });
    const r = await api<{ owned?: unknown[]; shared?: unknown[] }>(`/api/files?${q.toString()}`);
    return (r.owned?.length ?? 0) + (r.shared?.length ?? 0);
  },
  apps: async (scope) => {
    const r = await api<{ deployments?: Array<{ status?: string; ownerScopeId?: string; createdInScope?: string }> }>(
      "/api/deployments",
    );
    return (r.deployments ?? []).filter(
      (d) => d.status !== "archived" && (d.createdInScope === scope || d.ownerScopeId === scope),
    ).length;
  },
  skills: async (scope) => {
    const r = await api<{ skills?: Array<{ scopeId?: string; status?: string }> }>("/api/skills?includeShadowed=1");
    return (r.skills ?? []).filter((sk) => sk.scopeId === scope && sk.status !== "archived").length;
  },
};

/** Cached count of a tool's items in a scope; kicks off a refresh and calls
 * onReady when a fresh count lands. Tools without a counter return null. */
export function scopeToolCount(tool: SessionTool, scope: string, onReady: () => void): number | null {
  const counter = TOOL_COUNTERS[tool];
  if (!counter || !scope) return null;
  const key = `${tool}:${scope}`;
  const hit = toolCountCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.count;
  if (!toolCountInFlight.has(key)) {
    toolCountInFlight.add(key);
    void counter(scope)
      .then((count) => toolCountCache.set(key, { count, at: Date.now() }))
      .catch(() => toolCountCache.set(key, { count: hit?.count ?? 0, at: Date.now() }))
      .finally(() => {
        toolCountInFlight.delete(key);
        onReady();
      });
  }
  return hit?.count ?? null;
}

export type SessionTool = "crons" | "files" | "memory" | "apps" | "skills" | "keychain";

export interface SessionTopbarOpts {
  crumb: string | null;
  title: string;
  activeTool?: SessionTool | null;
  toolCount?: ((tool: SessionTool) => number | null) | null;
  fork?: { title: string; onClick?: (() => void) | null } | null;
  onTitle?: (() => void) | null;
  onCrumb?: (() => void) | null;
  onTool: (tool: SessionTool) => void;
}

export function sessionTopbarTpl(o: SessionTopbarOpts): TemplateResult {
  const crumbTpl = ((): TemplateResult | typeof nothing => {
    if (!o.crumb) return nothing;
    if (!o.onCrumb) return html`<span class="session-crumb">${o.crumb}</span><span class="session-crumb-sep">/</span>`;
    return html`<button
        class="session-crumb as-link"
        type="button"
        title="Open the ${o.crumb} project"
        @click=${(e: Event) => {
          e.stopPropagation();
          o.onCrumb!();
        }}
      >
        ${o.crumb}</button
      ><span class="session-crumb-sep">/</span>`;
  })();
  const heading = html`
    ${crumbTpl}
    <span class="session-title">${o.title}</span>
    ${
      o.fork
        ? html`<button
            class="session-fork-badge"
            type="button"
            title="Forked from ${o.fork.title}${o.fork.onClick ? " — open the original" : ""}"
            ?disabled=${!o.fork.onClick}
            @click=${(e: Event) => {
              e.stopPropagation();
              o.fork?.onClick?.();
            }}
          >
            ${icon(GitFork, 12)}<span>fork</span>
          </button>`
        : nothing
    }
  `;
  const headingTitle = o.crumb
    ? `This chat runs in the ${o.crumb} context — the agent works with that context's files and memory, separate from your personal context.`
    : o.title;
  return html`
    <header class="chat-topbar session-topbar">
      <button class="session-back" type="button" aria-label="Back">${icon(ChevronLeft, 18)}</button>
      ${
        o.onTitle
          ? html`<button class="session-heading as-link" type="button" title="Back to this chat" @click=${o.onTitle}>
              ${heading}
            </button>`
          : html`<div class="session-heading" title=${headingTitle}>${heading}</div>`
      }
      <div class="topbar-actions session-tools">
        <button class="tools-entry" type="button" aria-label="Toggle tools" @click=${toggleToolsDrawer}>
          <span class="tools-entry-icon tools-entry-open">${icon(PanelRight, 18)}</span>
          <span class="tools-entry-icon tools-entry-close">${icon(X, 18)}</span>
        </button>
      </div>
    </header>
  `;
}

export function openProjectPage(scopeId: string): void {
  setScopedSession(null);
  void import("./contexts").then(({ openProjectDetail }) => openProjectDetail(scopeId));
}

/** Top bar for the scoped crons/files/memory views: same bar, title links back
 * to the session, tools swap views while keeping the scope. */
export function scopedViewTopbar(current: SessionTool, redraw: () => void): TemplateResult | typeof nothing {
  const active = scopedSession.active;
  if (!active) return nothing;
  return sessionTopbarTpl({
    crumb: active.crumb,
    title: active.title,
    onCrumb: active.crumb ? () => openProjectPage(active.scopeId) : null,
    activeTool: current,
    toolCount: (t) => scopeToolCount(t, active.scopeId, redraw),
    onTitle: () => {
      setScopedSession(null);
      void Promise.all([import("./shell"), import("./sessions")]).then(
        ([{ appState, renderSidebarTop }, { sessionsState, openSession }]) => {
          const s = sessionsState.list.find(
            (row) => (active.sessionId && row.id === active.sessionId) || row.threadRef === active.threadRef,
          );
          if (!s) return;
          appState.currentView = "chats";
          renderSidebarTop();
          void openSession(s);
        },
      );
    },
    onTool: (t) => {
      if (t === current) return;
      void import("./shell").then(({ switchView }) => switchView(t === "apps" ? "deploys" : t));
    },
  });
}

const DRAWER_TABS: Array<{ tool: SessionTool; label: string }> = [
  { tool: "files", label: "Files" },
  { tool: "skills", label: "Skills" },
  { tool: "memory", label: "Memory" },
];
let drawerOpen = false;
let drawerTab: SessionTool = "files";
let drawerEls: { root: HTMLElement; tabs: HTMLElement; content: HTMLElement } | null = null;
let savedMainEl: HTMLElement | null = null;

function toggleToolsDrawer(): void {
  if (drawerOpen) closeToolsDrawer();
  else openToolsDrawer();
}

function openToolsDrawer(): void {
  drawerOpen = true;
  const els = ensureDrawer();
  els.root.classList.add("open");
  document.body.classList.add("tools-drawer-open");
  void setToolsTab(drawerTab);
}

function closeToolsDrawer(): void {
  drawerOpen = false;
  drawerEls?.root.classList.remove("open");
  document.body.classList.remove("tools-drawer-open");
  if (savedMainEl) {
    appState.mainEl = savedMainEl;
    savedMainEl = null;
  }
  appState.currentView = "chats";
}

function ensureDrawer() {
  if (drawerEls) return drawerEls;
  const root = document.createElement("div");
  root.className = "tools-drawer-root";
  const mask = document.createElement("div");
  mask.className = "tools-drawer-mask";
  mask.addEventListener("click", () => closeToolsDrawer());
  const panel = document.createElement("aside");
  panel.className = "tools-drawer-panel";
  const tabs = document.createElement("div");
  tabs.className = "tools-drawer-tabs";
  for (const t of DRAWER_TABS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tools-drawer-tab";
    b.dataset.tool = t.tool;
    b.textContent = t.label;
    b.addEventListener("click", () => void setToolsTab(t.tool));
    tabs.appendChild(b);
  }
  const content = document.createElement("div");
  content.className = "tools-drawer-content";
  let touch: { x: number; y: number } | null = null;
  content.addEventListener(
    "touchstart",
    (e) => {
      const t0 = e.touches[0];
      touch = t0 ? { x: t0.clientX, y: t0.clientY } : null;
    },
    { passive: true },
  );
  content.addEventListener(
    "touchend",
    (e) => {
      if (!touch) return;
      const t0 = e.changedTouches[0];
      const dx = t0.clientX - touch.x;
      const dy = t0.clientY - touch.y;
      touch = null;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy)) return;
      const idx = DRAWER_TABS.findIndex((t) => t.tool === drawerTab);
      const next = DRAWER_TABS[idx + (dx < 0 ? 1 : -1)];
      if (next) void setToolsTab(next.tool);
    },
    { passive: true },
  );
  panel.append(tabs, content);
  root.append(mask, panel);
  document.body.appendChild(root);
  drawerEls = { root, tabs, content };
  return drawerEls;
}

async function setToolsTab(tab: SessionTool): Promise<void> {
  drawerTab = tab;
  if (!drawerEls) return;
  for (const b of drawerEls.tabs.children) {
    b.classList.toggle("active", (b as HTMLElement).dataset.tool === tab);
  }
  if (!savedMainEl) savedMainEl = appState.mainEl;
  appState.currentView = tab === "apps" ? "deploys" : tab;
  appState.mainEl = drawerEls.content;
  if (tab === "files") {
    const m = await import("./files");
    m.renderFiles();
  } else if (tab === "skills") {
    const m = await import("./skills");
    m.renderSkills();
  } else {
    const m = await import("./memory");
    await m.renderMemory();
  }
}
