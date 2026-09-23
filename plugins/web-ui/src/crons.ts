import { displayStatus } from "./display-labels";
import { html, nothing, render, type TemplateResult } from "lit";
import { Archive, Pause, Pencil, Play, Plus, RotateCcw, Trash2 } from "lucide";
import { api, userSendMessage } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { icon } from "./ui";
import { listBackLink, listPageTpl } from "./list-page";
import { contextsState, ensureContexts, scopeChip } from "./contexts";
import { scopedSession, scopedViewTopbar } from "./session-scope";
import { appState } from "./shell";
import { startNewChat } from "./sessions";
import { deepLinkPath, isPlainLeftClick, UI_BASE } from "./deep-link";
import {
  cronNextFire,
  cronRunSummary,
  cronRunSummaryTitle,
  cronScheduleDetail,
  cronScheduleSummary,
} from "./cron-format";
import { tip } from "./tooltip";

export interface CronView {
  id: string;
  ownerScopeId: string;
  owner: string;
  title?: string;
  action?: string;
  message?: string;
  schedule: { everyMs?: number; firstFireAt?: number; cron?: string; timezone?: string };
  destination?: { type: string; target: string } | null;
  enabled: boolean;
  archived?: boolean;
  createdAt: number;
  lastFiredAt?: number;
  nextFireAt?: number;
  lastFireNote?: { text: string; at: number; by?: string } | null;
  scopeName?: string;
  permission?: "read" | "manage";
}

interface CronRunView {
  fireKey: string;
  threadRef: string;
  firedAt: number;
  scheduledAt?: number;
  status?: string;
  endedAt?: number;
  note?: string;
  reply?: string;
  sessionId?: string;
}

function cronRunTiming(run: CronRunView): string {
  const fired = new Date(run.firedAt).toLocaleString("zh-CN");
  if (run.status === "running") {
    const min = Math.max(0, Math.round((Date.now() - run.firedAt) / 60_000));
    return `${fired} — 已运行 ${min} 分钟`;
  }
  if (run.endedAt === undefined) return fired;
  return `${fired} — 耗时 ${Math.max(0, Math.round((run.endedAt - run.firedAt) / 1000))} 秒`;
}

type CronTab = "yours" | "shared" | "archived";
const CRON_TABS: Array<{ value: CronTab; label: string }> = [
  { value: "yours", label: "我的" },
  { value: "shared", label: "共享" },
  { value: "archived", label: "已归档" },
];

let cronList: CronView[] = [];
let visibleCronList: CronView[] = [];
let cronsScope: string | null = null;
let cronTab: CronTab = "yours";
let showDisabledCrons = false;
let cronsPageHost: HTMLElement | null = null;
let cronsLoading = false;
let cronsNotice = "";
let cronRefreshSeq = 0;
let cronActionNotice = "";
let cronMutationInFlight = false;
let cronsSearch = "";
const cronRuns = new Map<string, CronRunView[]>();
const cronRunsLoading = new Set<string>();
let cronDialog: { kind: "rename" | "delete"; cron: CronView } | null = null;
let activeCronId: string | null = null;
let pendingCronId: string | null = null;

export function resetActiveCron(): void {
  cronsScope = null;
}

export function openCronById(id: string): void {
  pendingCronId = id;
}

function syncCronUrl(cronId: string | null, push = false): void {
  if (appState.currentView !== "crons") return;
  const next = deepLinkPath(UI_BASE, "crons", null, null, cronId);
  if (`${location.pathname}${location.search}` === next) return;
  if (push) history.pushState(null, "", next);
  else history.replaceState(null, "", next);
}

export function routeCronsHistory(cronId: string | null): void {
  if (appState.currentView !== "crons") return;
  const cron = cronId
    ? (cronList.find((c) => c.id === cronId) ?? visibleCronList.find((c) => c.id === cronId))
    : undefined;
  if (cron) openCron(cron);
  else drawCronsPage();
}

async function refreshCrons(opts: { showLoading?: boolean } = {}): Promise<boolean> {
  const seq = ++cronRefreshSeq;
  if (opts.showLoading) {
    cronsLoading = true;
    cronsNotice = "";
  }
  try {
    const r = await api<{ crons: CronView[]; visible?: CronView[] }>("/api/crons");
    if (seq !== cronRefreshSeq) return false;
    cronList = r.crons ?? [];
    visibleCronList = r.visible ?? [];
    cronsNotice = "";
    return true;
  } catch (e) {
    if (seq !== cronRefreshSeq) return false;
    cronsNotice = errMessage(e, "加载定时任务失败。");
    return false;
  } finally {
    if (seq === cronRefreshSeq) cronsLoading = false;
  }
}

function cronText(c: CronView): string {
  return c.message ?? c.action ?? "";
}

function cleanCronText(text: string): string {
  return text
    .trim()
    .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clipWords(text: string, max = 64): string {
  const clean = cleanCronText(text);
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const wordCut = cut.replace(/\s+\S*$/, "");
  return `${(wordCut.length >= max * 0.55 ? wordCut : cut).trim()}…`;
}

function suggestedCronTitle(text: string): string {
  const clean = cleanCronText(text);
  if (!clean) return "（未命名定时任务）";
  const candidate = clean
    .replace(/^(please\s+)?(run|generate|create|send|post|deliver|summarize|check)\s+(the\s+)?/i, "")
    .replace(/\s*[:;.!?]\s+.*$/, "")
    .trim();
  const clipped = clipWords(candidate || clean, 58);
  return clipped.replace(/^[a-z]/, (ch) => ch.toUpperCase());
}

function cronTitle(c: CronView): string {
  return c.title?.trim() || suggestedCronTitle(cronText(c));
}

function cronScopeLabel(c: CronView): string {
  const sep = c.ownerScopeId.indexOf(":");
  const kind = sep === -1 ? c.ownerScopeId : c.ownerScopeId.slice(0, sep);
  if (kind === "channel") return c.scopeName ? `#${c.scopeName}` : "一个 Slack 频道";
  if (kind === "org") return "整个组织";
  if (kind === "group") return "群组";
  return c.owner;
}

function isPersonalScope(c: CronView): boolean {
  const kind = c.ownerScopeId.split(":", 1)[0];
  return kind !== "channel" && kind !== "org" && kind !== "group";
}

function cronStatusLabel(c: CronView): "enabled" | "disabled" | "archived" {
  if (c.archived) return "archived";
  return c.enabled ? "enabled" : "disabled";
}

function cronStatusText(c: CronView): string {
  const status = cronStatusLabel(c);
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export async function renderCronsPage(): Promise<void> {
  if (appState.currentView !== "crons") return;
  if (scopedSession.active) cronsScope = scopedSession.active.scopeId;
  else if (contextsState.selected) {
    cronsScope = contextsState.selected;
    contextsState.selected = null;
  } else cronsScope = null;
  await ensureContexts();
  drawCronsPage();
  const loaded = await refreshCrons({ showLoading: cronList.length === 0 && visibleCronList.length === 0 });
  const wanted = pendingCronId;
  pendingCronId = null;
  if (appState.currentView !== "crons") return;
  if (!loaded) return drawCronsPage();
  const cron = wanted
    ? (cronList.find((c) => c.id === wanted) ?? visibleCronList.find((c) => c.id === wanted))
    : undefined;
  if (wanted && !cron) {
    cronActionNotice = "找不到该定时任务，或你没有访问权限。";
  }
  if (cron) openCron(cron);
  else drawCronsPage();
}

function drawCronsPage(): void {
  if (appState.currentView !== "crons" || !appState.mainEl) return;
  activeCronId = null;
  syncCronUrl(null);
  if (!cronsPageHost || cronsPageHost.parentElement !== appState.mainEl) {
    cronsPageHost = document.createElement("div");
    cronsPageHost.className = "pane crons-page";
    appState.mainEl.replaceChildren(cronsPageHost);
  }
  const all = [...cronList.map((c) => ({ c, mine: true })), ...visibleCronList.map((c) => ({ c, mine: false }))]
    .filter(({ c }) => (cronsScope ? c.ownerScopeId === cronsScope : true))
    .filter(
      ({ c }) =>
        !cronsSearch.trim() ||
        `${cronTitle(c)} ${cronText(c)} ${c.scopeName ?? ""}`.toLowerCase().includes(cronsSearch.trim().toLowerCase()),
    )
    .sort((a, b) => b.c.createdAt - a.c.createdAt);
  const archived = all.filter(({ c }) => c.archived);
  const yours = all.filter(({ c, mine }) => mine && !c.archived);
  const yoursEnabled = yours.filter(({ c }) => c.enabled);
  const yoursDisabled = yours.filter(({ c }) => !c.enabled);
  const shared = all.filter(({ c, mine }) => !mine && !c.archived);
  const ownsAny = all.some(({ mine }) => mine);
  const counts: Record<CronTab, number> = {
    yours: yoursEnabled.length,
    shared: shared.filter(({ c }) => c.enabled).length,
    archived: archived.length,
  };

  const rows: TemplateResult[] = [];
  if (cronActionNotice) {
    rows.push(html`<div class="action-notice">${cronActionNotice}</div>`);
    cronActionNotice = "";
  }
  if (all.length) rows.push(cronTabs(counts, shared.length > 0));
  if (cronTab === "yours") {
    rows.push(...yoursEnabled.map(({ c }) => cronPageRow(c, true)));
    if (all.length && !yoursEnabled.length)
      rows.push(cronEmptyRow(ownsAny ? "暂无启用的定时任务。" : "你还没有自己的定时任务。"));
    if (yoursDisabled.length) {
      rows.push(cronDisabledToggle(yoursDisabled.length));
      if (showDisabledCrons) rows.push(...yoursDisabled.map(({ c }) => cronPageRow(c, true)));
    }
  } else if (cronTab === "shared") {
    rows.push(...shared.map(({ c }) => cronPageRow(c, false)));
    if (!shared.length) rows.push(cronEmptyRow("暂无与你共享的定时任务。"));
  } else {
    rows.push(...archived.map(({ c, mine }) => cronPageRow(c, mine)));
    if (!archived.length) rows.push(cronEmptyRow("暂无归档内容。"));
  }
  let empty = "暂无定时任务。";
  if (cronsNotice) empty = cronsNotice;
  else if (cronsLoading && cronList.length === 0 && visibleCronList.length === 0) empty = "正在加载定时任务…";
  else if (cronsScope) empty = "当前项目中没有定时任务。";
  const scoped = Boolean(scopedSession.active);
  cronsPageHost.classList.toggle("scoped-view", scoped);
  render(
    html`${scopedViewTopbar("crons", drawCronsPage)}
    ${listPageTpl({
      title: "定时任务",
      search: {
        value: cronsSearch,
        placeholder: "搜索定时任务",
        onInput: (value) => {
          cronsSearch = value;
          drawCronsPage();
        },
      },
      rows,
      empty,
    })}`,
    cronsPageHost,
  );
}

function setCronTab(tab: CronTab): void {
  cronTab = tab;
  drawCronsPage();
}

function toggleDisabledCrons(): void {
  showDisabledCrons = !showDisabledCrons;
  drawCronsPage();
}

function cronEmptyRow(text: string): TemplateResult {
  return html`<div class="empty compact cron-filter-empty">${text}</div>`;
}

function cronTabs(counts: Record<CronTab, number>, hasShared: boolean): TemplateResult {
  const tabs = CRON_TABS.filter(
    (t) => t.value === "yours" || (t.value === "shared" && hasShared) || counts[t.value] > 0 || cronTab === t.value,
  );
  return html`
    <div class="cron-list-controls" role="tablist" aria-label="定时任务视图">
      ${tabs.map(
        (t) => html`
          <button
            type="button"
            role="tab"
            aria-selected=${cronTab === t.value}
            class="cron-filter-chip ${cronTab === t.value ? "active" : ""}"
            @click=${() => setCronTab(t.value)}
          >
            <span>${t.label}</span>
            <span class="cron-filter-count">${counts[t.value]}</span>
          </button>
        `,
      )}
    </div>
  `;
}

function cronDisabledToggle(count: number): TemplateResult {
  return html`
    <button class="archived-toggle cron-disabled-toggle" type="button" @click=${toggleDisabledCrons}>
      <span>${showDisabledCrons ? "隐藏已停用" : "显示已停用"}</span>
      <span class="archived-count">${count}</span>
    </button>
  `;
}

function canManageCron(c: CronView, mine: boolean): boolean {
  return c.permission ? c.permission === "manage" : mine;
}

function cronPageRow(c: CronView, mine: boolean): TemplateResult {
  const status = cronStatusLabel(c);
  return html`
    <div class="list-row cron-row cron-${status}">
      <a
        class="cron-row-main"
        href=${deepLinkPath(UI_BASE, "crons", null, null, c.id)}
        @click=${(event: MouseEvent) => {
          if (!isPlainLeftClick(event)) return;
          event.preventDefault();
          openCron(c, { push: true });
        }}
      >
        <span class="list-row-title cron-title-line"><span dir="auto">${cronTitle(c)}</span></span>
        <span class="list-row-meta">
          ${isPersonalScope(c) ? nothing : scopeChip(c.ownerScopeId, c.scopeName ?? null)}
          <span class="cron-meta-line" ${tip(cronRunSummaryTitle(c))}>${cronRunSummary(c)}</span>
        </span>
      </a>
      ${canManageCron(c, mine) ? cronRowActions(c) : nothing}
    </div>
  `;
}

function cronRowActions(c: CronView): TemplateResult {
  let stateAction = html`
    <button
      class="icon-btn subtle compact"
      type="button"
      ${tip("启用")}
      aria-label="启用定时任务"
      @click=${() => void setCronEnabled(c.id, true)}
    >
      ${icon(Play, 14)}
    </button>
  `;
  if (c.archived) {
    stateAction = html`
      <button
        class="icon-btn subtle compact"
        type="button"
        ${tip("取消归档")}
        aria-label="取消定时任务归档"
        @click=${() => void archiveCron(c.id, false)}
      >
        ${icon(RotateCcw, 14)}
      </button>
    `;
  } else if (c.enabled) {
    stateAction = html`
      <button
        class="icon-btn subtle compact"
        type="button"
        ${tip("停用")}
        aria-label="停用定时任务"
        @click=${() => void setCronEnabled(c.id, false)}
      >
        ${icon(Pause, 14)}
      </button>
    `;
  }
  return html`
    <div class="cron-row-actions" aria-label="定时任务操作">
      <button
        class="icon-btn subtle compact"
        type="button"
        ${tip("编辑")}
        aria-label="编辑定时任务"
        @click=${() => {
          openCron(c);
          showCronDialog("rename", c);
        }}
      >
        ${icon(Pencil, 14)}
      </button>
      ${stateAction}
      ${
        c.archived
          ? nothing
          : html`
              <button
                class="icon-btn subtle compact"
                type="button"
                ${tip("归档")}
                aria-label="归档定时任务"
                @click=${() => void archiveCron(c.id, true)}
              >
                ${icon(Archive, 14)}
              </button>
            `
      }
    </div>
  `;
}

function openCron(c: CronView, opts: { push?: boolean; refreshRuns?: boolean } = {}): void {
  if (!appState.mainEl) return;
  const shouldRefreshRuns = opts.refreshRuns || activeCronId !== c.id;
  activeCronId = c.id;
  syncCronUrl(c.id, opts.push);
  const mine = cronList.some((x) => x.id === c.id);
  const manageable = canManageCron(c, mine);
  const notice = cronActionNotice;
  cronActionNotice = "";
  const next = cronNextFire(c);
  let stateActions = html`
    <button class="btn" @click=${() => void setCronEnabled(c.id, true)}>${icon(Play, 15)}<span>启用</span></button>
    <button class="btn" @click=${() => void archiveCron(c.id, true)}>${icon(Archive, 15)}<span>归档</span></button>
  `;
  if (c.archived) {
    stateActions = html`<button class="btn" @click=${() => void archiveCron(c.id, false)}>
      ${icon(RotateCcw, 15)}<span>取消归档</span>
    </button>`;
  } else if (c.enabled) {
    stateActions = html`
      <button class="btn" @click=${() => void runCronNow(c.id)}>${icon(Play, 15)}<span>立即运行</span></button>
      <button class="btn" @click=${() => void setCronEnabled(c.id, false)}>${icon(Pause, 15)}<span>停用</span></button>
      <button class="btn" @click=${() => void archiveCron(c.id, true)}>${icon(Archive, 15)}<span>归档</span></button>
    `;
  }
  const host = document.createElement("div");
  host.className = "resource-pane cron-pane";
  render(
    html`
      <div class="resource-detail">
        ${listBackLink("定时任务", drawCronsPage)}
        <div class="resource-heading">
          <h2 dir="auto">${cronTitle(c)}</h2>
          <button class="btn" @click=${showNewCron}>${icon(Plus, 15)}<span>新建定时任务</span></button>
        </div>
        ${notice ? html`<div class="hint">${notice}</div>` : ""}
        <div class="field">
          <label>上下文</label>
          <div class="value">${scopeChip(c.ownerScopeId, c.scopeName ?? null)}</div>
        </div>
        ${
          c.title
            ? html`<div class="field">
                <label>标题</label>
                <div class="value" dir="auto">${c.title}</div>
              </div>`
            : nothing
        }
        <div class="field">
          <label>${c.message !== undefined ? "消息" : "任务"}</label>
          <div class="value pre">${cronText(c)}</div>
        </div>
        <div class="field">
          <label>时间安排</label>
          <div class="value">${cronScheduleDetail(c)}</div>
        </div>
        ${
          mine
            ? ""
            : html`<div class="field">
                <label>所有者</label>
                <div class="value">${c.owner}</div>
              </div>`
        }
        ${
          mine
            ? ""
            : html`<div class="field">
                <label>作用域</label>
                <div class="value">${cronScopeLabel(c)}</div>
              </div>`
        }
        <div class="field">
          <label>状态</label>
          <div class="value">${cronStatusText(c)}</div>
        </div>
        ${
          c.destination
            ? html`<div class="field">
                <label>发送目标</label>
                <div class="value">${c.destination.type} → ${c.destination.target}</div>
              </div>`
            : ""
        }
        <div class="field">
          <label>下次运行</label>
          <div class="value">${next != null ? new Date(next).toLocaleString("zh-CN") : "从未"}</div>
        </div>
        <div class="field">
          <label>上次触发</label>
          <div class="value">${c.lastFiredAt ? new Date(c.lastFiredAt).toLocaleString("zh-CN") : "从未"}</div>
        </div>
        ${
          c.lastFireNote
            ? html`<div class="field">
                <label>
                  ${c.lastFireNote.by ? `${c.lastFireNote.by} 留下的备注` : "上次触发备注"}
                  (${new Date(c.lastFireNote.at).toLocaleString("zh-CN")})
                </label>
                <div class="value" dir="auto">${c.lastFireNote.text}</div>
              </div>`
            : nothing
        }
        ${manageable ? cronRunHistory(c) : nothing}
        ${
          manageable
            ? html`
                <div class="actions">
                  <button class="btn" @click=${() => showCronDialog("rename", c)}>
                    ${icon(Pencil, 15)}<span>编辑</span>
                  </button>
                  ${stateActions}
                  <button class="btn danger" @click=${() => showCronDialog("delete", c)}>
                    ${icon(Trash2, 15)}<span>删除</span>
                  </button>
                </div>
              `
            : html`<div class="hint">由 ${cronScopeLabel(c)} 共享。你可以查看，但不能修改。</div>`
        }
        ${cronDialog?.cron.id === c.id ? cronDialogTpl(cronDialog) : nothing}
      </div>
    `,
    host,
  );
  appState.mainEl.replaceChildren(host);
  if (manageable && (shouldRefreshRuns || !cronRuns.has(c.id)) && !cronRunsLoading.has(c.id)) void loadCronRuns(c.id);
}

function cronRunHistory(c: CronView): TemplateResult {
  const runs = cronRuns.get(c.id);
  const heading = html`<div class="cron-run-heading">
    <label>最近运行</label>
  </div>`;
  if (!runs)
    return html`<div class="field">
      ${heading}
      <div class="hint">加载中…</div>
    </div>`;
  if (!runs.length)
    return html`<div class="field">
      ${heading}
      <div class="hint">暂无运行记录。</div>
    </div>`;
  return html` <div class="field">
    ${heading}
    <div class="cron-run-list">
      ${[...runs].reverse().map((run) => {
        const detail = run.note ?? (run.reply ? clipWords(run.reply, 120) : "");
        return html` <div class="cron-run-row">
          <span class="badge">${displayStatus(run.status ?? "completed")}</span>
          <span class="cron-run-time">${cronRunTiming(run)}</span>
          <span class=${run.note ? "cron-run-detail cron-run-error" : "cron-run-detail"} ${tip(detail)}>
            ${detail}
          </span>
          ${
            run.sessionId
              ? html`<a class="cron-run-link" href=${deepLinkPath(UI_BASE, "chats", run.sessionId)}>工作日志</a>`
              : nothing
          }
        </div>`;
      })}
    </div>
  </div>`;
}

async function loadCronRuns(id: string): Promise<void> {
  cronRunsLoading.add(id);
  try {
    const result = await api<{ runs: CronRunView[] }>(`/api/crons/${encodeURIComponent(id)}/runs`);
    cronRuns.set(id, result.runs ?? []);
  } catch (error) {
    cronActionNotice = errMessage(error, "无法加载运行历史。");
    cronRuns.set(id, []);
  } finally {
    cronRunsLoading.delete(id);
  }
  if (activeCronId !== id || appState.currentView !== "crons") return;
  const current =
    cronList.find((candidate) => candidate.id === id) ?? visibleCronList.find((candidate) => candidate.id === id);
  if (current) openCron(current);
}

async function reopenCron(id: string): Promise<void> {
  await refreshCrons();
  const c = cronList.find((x) => x.id === id) ?? visibleCronList.find((x) => x.id === id);
  if (c) openCron(c, { refreshRuns: true });
  else drawCronsPage();
}

async function cronMutate<T>(fn: () => Promise<T>, busyValue: T): Promise<T> {
  if (cronMutationInFlight) return busyValue;
  cronMutationInFlight = true;
  try {
    return await fn();
  } finally {
    cronMutationInFlight = false;
  }
}

function runCronNow(id: string): Promise<void> {
  return cronMutate(async () => {
    try {
      await api(`/api/crons/${encodeURIComponent(id)}/run`, { method: "POST" });
      cronActionNotice = "任务已启动，完成后可刷新查看最近运行记录。";
    } catch (e) {
      cronActionNotice = errMessage(e, "运行失败");
    }
    await reopenCron(id);
  }, undefined);
}

function patchCron(
  id: string,
  patch: { title?: string; task?: string; schedule?: CronView["schedule"]; enabled?: boolean; archived?: boolean },
  errorLabel: string,
): Promise<boolean> {
  return cronMutate(async () => {
    try {
      await api(`/api/crons/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
      return true;
    } catch (e) {
      cronActionNotice = errMessage(e, errorLabel);
      await reopenCron(id);
      return false;
    }
  }, false);
}

function showCronDialog(kind: "rename" | "delete", cron: CronView): void {
  cronDialog = { kind, cron };
  openCron(cron);
  queueMicrotask(() => document.querySelector<HTMLInputElement>(".cron-edit-dialog input")?.focus());
}

function closeCronDialog(c: CronView): void {
  cronDialog = null;
  openCron(c);
}

function cronDialogTpl(dialog: { kind: "rename" | "delete"; cron: CronView }): TemplateResult {
  const c = dialog.cron;
  if (dialog.kind === "delete") {
    return html` <div
      class="project-dialog-backdrop"
      @click=${(event: MouseEvent) => event.target === event.currentTarget && closeCronDialog(c)}
    >
      <div class="project-dialog cron-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="cron-delete-title">
        <div class="project-dialog-head">
          <div>
            <h2 id="cron-delete-title">删除 <bdi>${cronTitle(c)}</bdi>?</h2>
          </div>
        </div>
        <p>此操作会永久删除时间安排及保留的运行历史。如果以后可能需要，请改用归档。</p>
        <div class="project-dialog-actions">
          <button class="btn" type="button" @click=${() => closeCronDialog(c)}>取消</button>
          <button class="btn danger" type="button" @click=${() => void confirmDeleteCron(c.id)}>永久删除</button>
        </div>
      </div>
    </div>`;
  }
  return html` <div
    class="project-dialog-backdrop"
    @click=${(event: MouseEvent) => event.target === event.currentTarget && closeCronDialog(c)}
  >
    <form
      class="project-dialog cron-edit-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cron-edit-title"
      @submit=${(event: SubmitEvent) => void saveCronEdit(event, c)}
    >
      <div class="project-dialog-head">
        <div><h2 id="cron-edit-title">编辑定时任务</h2></div>
      </div>
      <label>标题<input name="title" maxlength="80" value=${c.title ?? cronTitle(c)} required /></label>
      ${
        c.message === undefined
          ? html`<label>任务<textarea name="task" rows="5" required>${cronText(c)}</textarea></label>`
          : html`<div class="field">
              <label>消息</label>
              <div class="value pre">${c.message}</div>
            </div>`
      }
      <p class="hint">
        如需修改${c.message === undefined ? "时间安排、时区、发送目标或运行模式" : "消息、时间安排、时区、发送目标或运行模式"}，请让智能体操作，以便核对最终行为和权限。
      </p>
      <div class="form-error"></div>
      <div class="project-dialog-actions">
        <button class="btn" type="button" @click=${() => editCronWithAgent(c)}>让智能体修改任务</button>
        <button class="btn" type="button" @click=${() => closeCronDialog(c)}>取消</button>
        <button class="btn primary" type="submit">保存</button>
      </div>
    </form>
  </div>`;
}

async function saveCronEdit(event: SubmitEvent, c: CronView): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const title = (form.elements.namedItem("title") as HTMLInputElement).value.trim();
  const taskControl = form.elements.namedItem("task") as HTMLTextAreaElement | null;
  const task = taskControl?.value.trim();
  const error = form.querySelector<HTMLElement>(".form-error");
  if (!title || (taskControl && !task)) {
    if (error) error.textContent = taskControl ? "请填写标题和任务内容。" : "请填写标题。";
    return;
  }
  const ok = await patchCron(c.id, { title, ...(task ? { task } : {}) }, "编辑失败");
  if (!ok) return;
  cronDialog = null;
  cronActionNotice = "定时任务已更新。";
  await reopenCron(c.id);
}

function editCronWithAgent(c: CronView): void {
  cronDialog = null;
  const conv = startNewChat();
  void conv?.state.agent?.prompt(
    userSendMessage(
      `帮我编辑定时任务 ${c.id}（“${cronTitle(c)}”）。当前时间安排为 ${cronScheduleSummary(c)}。请先询问我想修改什么，再按要求更新任务内容、时间安排、时区、发送目标或运行模式。`,
    ),
  );
}

async function archiveCron(id: string, archived: boolean): Promise<void> {
  const ok = await patchCron(id, { archived }, archived ? "归档失败" : "取消归档失败");
  if (!ok) return;
  await refreshCrons();
  if (archived) {
    cronTab = "yours";
    drawCronsPage();
    return;
  }
  cronTab = "yours";
  showDisabledCrons = true;
  await reopenCron(id);
}

function setCronEnabled(id: string, enabled: boolean): Promise<void> {
  return cronMutate(async () => {
    try {
      await api(`/api/crons/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`, { method: "POST" });
      cronTab = "yours";
      if (!enabled) showDisabledCrons = true;
    } catch (e) {
      cronActionNotice = errMessage(e, enabled ? "启用失败" : "停用失败");
    }
    await reopenCron(id);
  }, undefined);
}

async function confirmDeleteCron(id: string): Promise<void> {
  await cronMutate(async () => {
    cronDialog = null;
    try {
      await api(`/api/crons/${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch (e) {
      cronActionNotice = errMessage(e, "删除失败");
    }
    await reopenCron(id);
  }, undefined);
}

function cronForm() {
  return html`
    <form class="resource-form cron-form" @submit=${onCreateCron}>
      ${listBackLink("定时任务", drawCronsPage)}
      <h2>新建定时任务</h2>
      <p class="hint">
        描述你想安排的任务：要做什么、执行频率和结果发送位置。智能体会在对话中完成设置和确认，并询问不清楚的部分。请为任务起一个简短、易区分的用途名称，例如
        <code>Gmail 未读邮件摘要</code> 或 <code>GitLab CI 监控</code>.
      </p>
      <label>
        <textarea
          name="text"
          rows="4"
          placeholder="每个工作日上午 9 点，总结我的未读邮件，并私信我重点内容。"
          required
        ></textarea>
      </label>
      <div class="form-error"></div>
      <div class="actions"><button class="btn primary" type="submit">让智能体设置</button></div>
    </form>
  `;
}

function showNewCron(): void {
  if (!appState.mainEl) return;
  activeCronId = null;
  const host = document.createElement("div");
  host.className = "resource-pane cron-pane";
  render(cronForm(), host);
  appState.mainEl.replaceChildren(host);
}

function onCreateCron(e: Event): void {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  const errSlot = form.querySelector(".form-error") as HTMLElement | null;
  const text = (form.querySelector('textarea[name="text"]') as HTMLTextAreaElement | null)?.value.trim() ?? "";
  if (!text) {
    if (errSlot) errSlot.textContent = "请描述你想创建的定时任务。";
    return;
  }
  const conv = startNewChat();
  void conv?.state.agent?.prompt(
    userSendMessage(
      `请为我设置定时任务：${text}

（来自网页端“新建定时任务”面板：请立即使用调度 API 创建。每日、每周或每月任务使用包含时区的日历时间安排；起一个简短、易于区分、体现用途的标题，例如“Gmail 未读邮件摘要”或“GitLab CI 监控”，不要用命令或泛泛的名称。创建后请确认结果。）`,
    ),
  );
}
