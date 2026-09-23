import { displayStatus } from "./display-labels";
import { peopleResults, type DirectoryMatch } from "./people-results";
import { html, nothing, render, type TemplateResult } from "lit";
import {
  ArrowLeft,
  Boxes,
  Folder,
  FolderPlus,
  Hash,
  Lock,
  Plus,
  Search,
  User,
  UserPlus,
  Users,
  X,
  type IconNode,
} from "lucide";
import {
  api,
  isContinuable,
  sharedContextLabel,
  type CoreContext,
  type CoreProject,
  type CoreSession,
  fileContentUrl,
} from "./core-bridge";
import { UI_BASE } from "./deep-link";
import { errMessage } from "../../chassis/src/errors";
import { actionSnippet, fieldSelect, formatBytes, icon, initials, menuSelect, relTime } from "./ui";
import { appState, replacePanePreservingFocus, switchView, syncUrlFromState } from "./shell";
import { startNewChat } from "./sessions";
import { groupDmTitle, openSession, refreshSessions, sessionsState, slackLogo, surfaceOf } from "./sessions";
import { activityOf } from "./session-list";
import type { WebhookView } from "./webhooks";
import type { CronView } from "./crons";
import { cronRunSummary, cronRunSummaryTitle, cronScheduleSummary } from "./cron-format";
import { restoreDialogFocus } from "./dialog-focus";
import { ambientPolicySection, loadAmbientPolicy, resetAmbientPolicy } from "./ambient-policy";
import { contextModelSection, loadContextModel, resetContextModel } from "./context-model";
import { channelHeaderSection, loadChannelHeader, resetChannelHeader } from "./channel-header";
import { tip } from "./tooltip";

interface ScopeFile {
  id: string;
  name: string;
  mimetype: string;
  sizeBytes: number;
  createdAt: number;
  openable: boolean;
}
interface ScopeDeployment {
  id: string;
  name: string;
  status: string;
  permission: "read" | "write";
  currentVersion: number;
}
interface ScopeSkill {
  id: string;
  name: string;
  description: string;
  status: string;
}
interface ScopeResourcesView {
  files: ScopeFile[];
  webhooks: WebhookView[];
  crons: CronView[];
  deployments: ScopeDeployment[];
  skills: ScopeSkill[];
  manageable: boolean;
}

export const contextsState = {
  list: [] as CoreContext[],
  loaded: false,
  loadedAt: 0,
  selected: null as string | null,
  resources: null as ScopeResourcesView | null,
  resourcesScope: null as string | null,
  resourcesLoading: false,
  resourcesNotice: "",
  createOpen: false,
  createName: "",
  createSaving: false,
  createError: "",
  memberProjectId: null as string | null,
  memberQuery: "",
  memberMatches: [] as DirectoryMatch[],
  memberSearching: false,
  memberBusy: false,
  memberError: "",
  memberSearchedQuery: "",
  slackEditing: false,
  slackValue: "",
  slackBusy: false,
  slackError: "",
};

let contextsLoading = false;
let contextsNotice = "";
let memberSearchSeq = 0;
const MEMBER_SEARCH_DEBOUNCE_MS = 300;
let memberSearchTimer: ReturnType<typeof setTimeout> | undefined;

function cancelMemberSearchTimer(): void {
  if (memberSearchTimer !== undefined) {
    clearTimeout(memberSearchTimer);
    memberSearchTimer = undefined;
  }
}
let createProjectOpener: HTMLElement | null = null;
let createProjectSeq = 0;
let contextsResetSeq = 0;
let contextsFetchSeq = 0;
let contextsQuery = "";
let contextsWorkspaceFilter: "active" | "all" = "active";

async function fetchContexts(): Promise<CoreContext[]> {
  const fetchSeq = ++contextsFetchSeq;
  const result = await api<{ contexts: CoreContext[] }>("/api/contexts").catch((error: unknown) => {
    if (fetchSeq !== contextsFetchSeq) return null;
    throw error;
  });
  if (!result || fetchSeq !== contextsFetchSeq) return contextsState.list;
  contextsState.list = result.contexts ?? [];
  contextsState.loaded = true;
  contextsState.loadedAt = Date.now();
  return contextsState.list;
}

export function resetContextsState(): void {
  contextsState.list = [];
  contextsState.loaded = false;
  contextsState.loadedAt = 0;
  contextsState.selected = null;
  contextsState.resources = null;
  contextsState.resourcesScope = null;
  contextsState.resourcesLoading = false;
  contextsState.resourcesNotice = "";
  contextsState.createOpen = false;
  contextsState.createName = "";
  contextsState.createSaving = false;
  contextsState.createError = "";
  contextsState.memberProjectId = null;
  contextsState.memberQuery = "";
  contextsState.memberMatches = [];
  contextsState.memberSearching = false;
  contextsState.memberBusy = false;
  contextsState.memberError = "";
  contextsState.memberSearchedQuery = "";
  contextsState.slackEditing = false;
  contextsState.slackValue = "";
  contextsState.slackBusy = false;
  contextsState.slackError = "";
  cancelMemberSearchTimer();
  contextsNotice = "";
  memberSearchSeq++;
  contextsFetchSeq++;
  createProjectSeq++;
  contextsResetSeq++;
  createProjectOpener = null;
  contextsQuery = "";
  contextsWorkspaceFilter = "active";
}

export async function renderContexts(): Promise<void> {
  if (appState.currentView !== "contexts") return;
  const seq = appState.viewRenderSeq;
  contextsNotice = "";
  contextsLoading = true;
  drawContexts();
  try {
    await Promise.all([fetchContexts(), refreshSessions({ silent: true })]);
    if (seq !== appState.viewRenderSeq || appState.currentView !== "contexts") return;
  } catch (e) {
    if (seq !== appState.viewRenderSeq || appState.currentView !== "contexts") return;
    contextsNotice = errMessage(e, "加载项目失败。");
  }
  contextsLoading = false;
  if (
    contextsState.selected &&
    contextsState.list.some((c) => c.scopeId === contextsState.selected) &&
    contextsState.resourcesScope !== contextsState.selected
  ) {
    void loadScopeResources(contextsState.selected);
    void loadAmbientPolicy(contextsState.selected, drawContexts);
    void loadContextModel(contextsState.selected, drawContexts);
    void loadChannelHeader(contextsState.selected, drawContexts);
  }
  drawContexts();
}

function contextMeta(c: CoreContext): { title: string; sub: string; glyph: IconNode } {
  if (c.project) {
    const memberCount = projectPeople(c).length;
    return {
      title: c.project.name,
      sub: `${memberCount} 位成员`,
      glyph: Folder,
    };
  }
  if (c.kind === "personal") {
    return { title: "个人", sub: "仅你可见。你的网页对话和与智能体的私聊都在这里。", glyph: User };
  }
  if (c.kind === "group") {
    return {
      title: sharedContextLabel(c.scopeId, c.name) ?? "群聊",
      sub: "与此群聊的所有成员共享。",
      glyph: Users,
    };
  }
  return {
    title: sharedContextLabel(c.scopeId, c.name) ?? "频道",
    sub: "与此频道的所有成员共享。",
    glyph: Hash,
  };
}

export async function ensureContexts(force = false): Promise<CoreContext[]> {
  if (contextsState.loaded && !force) return contextsState.list;
  try {
    await fetchContexts();
  } catch {
    void 0;
  }
  return contextsState.list;
}

export function personalScopeId(): string | null {
  return contextsState.list.find((c) => c.kind === "personal")?.scopeId ?? null;
}

export function resolveProjectScope(contexts: readonly CoreContext[], slug: string): string | null {
  if (slug.startsWith("channel:") || slug.startsWith("group:")) {
    return contexts.some((context) => context.scopeId === slug) ? slug : null;
  }
  const normalized = slug.toLowerCase();
  const matches = contexts.filter((context) => {
    const match = /^personal:([^@]+)@/.exec(context.scopeId);
    return match?.[1]?.toLowerCase() === normalized;
  });
  return matches.length === 1 ? matches[0]!.scopeId : null;
}

function metaForScope(scopeId: string | null, fallbackName?: string | null): { title: string; glyph: IconNode } {
  const c = scopeId ? contextsState.list.find((x) => x.scopeId === scopeId) : undefined;
  if (c) {
    const { title, glyph } = contextMeta(c);
    return { title, glyph };
  }
  const shared = sharedContextLabel(scopeId, fallbackName ?? null);
  if (shared) return { title: shared, glyph: scopeId?.startsWith("group:") ? Users : Hash };
  if (scopeId?.startsWith("personal:") && scopeId !== personalScopeId()) return { title: "共享个人空间", glyph: User };
  return { title: fallbackName?.trim() || "个人", glyph: User };
}

export function scopeTitle(scopeId: string | null, fallbackName?: string | null): string {
  return metaForScope(scopeId, fallbackName).title;
}

export function scopeChip(scopeId: string | null, fallbackName?: string | null): TemplateResult {
  const { title, glyph } = metaForScope(scopeId, fallbackName);
  return html`<span class="scope-chip" ${tip(`位于 ${title}`)}
    >${icon(glyph, 12)}<span dir="auto">${title.replace(/^#/, "")}</span></span
  >`;
}

export function scopeFilterControl(current: string | null, onSelect: (scopeId: string | null) => void): TemplateResult {
  return menuSelect({
    value: current,
    prefix: "筛选：",
    ariaLabel: "按项目筛选",
    className: "scope-filter",
    onSelect,
    options: [
      { value: null, label: "所有项目", glyph: Boxes },
      ...contextsState.list.map((c) => ({
        value: c.scopeId,
        label: contextMeta(c).title,
        glyph: contextMeta(c).glyph,
      })),
    ],
  });
}

function sessionsIn(scopeId: string): CoreSession[] {
  return sessionsState.list
    .filter((s) => s.scopeId === scopeId && !s.archived)
    .sort((a, b) => activityOf(b) - activityOf(a));
}

function drawContexts(): void {
  if (appState.currentView !== "contexts" || !appState.mainEl) return;
  const host = document.createElement("div");
  host.className = "pane contexts-pane";
  const selected = contextsState.selected
    ? contextsState.list.find((c) => c.scopeId === contextsState.selected)
    : undefined;
  render(selected ? detailTpl(selected) : gridTpl(), host);
  replacePanePreservingFocus(host);
  const dialog = host.querySelector<HTMLDialogElement>(".project-dialog");
  if (dialog && !dialog.open) dialog.showModal();
}

function gridTpl(): TemplateResult {
  const status = contextsNotice || (contextsLoading && contextsState.list.length === 0 ? "正在加载项目…" : "");
  const q = contextsQuery.trim().toLowerCase();
  const matches = (context: CoreContext) => {
    const meta = contextMeta(context);
    return (
      (!q || `${meta.title} ${meta.sub}`.toLowerCase().includes(q)) &&
      (contextsWorkspaceFilter === "all" ||
        context.kind === "personal" ||
        Boolean(context.project) ||
        Boolean(context.sessionCount))
    );
  };
  const projects = contextsState.list.filter(matches);
  const groupOf = (context: CoreContext) => {
    if (context.kind === "personal") return "personal";
    return context.project ? "web" : "slack";
  };
  const groups = [
    { key: "personal", label: "个人" },
    { key: "web", label: "网页" },
    { key: "slack", label: "Slack" },
  ]
    .map((g) => ({ ...g, items: projects.filter((context) => groupOf(context) === g.key) }))
    .filter((g) => g.items.length > 0);
  const projectsFiltered = Boolean(q);
  let projectList: TemplateResult | typeof nothing = nothing;
  if (projects.length)
    projectList = html`<div class="project-list">
      ${groups.map(
        (g) =>
          html`<section class="project-group">
            <div class="project-group-head">
              ${g.label} <span class="project-group-count">· ${g.items.length}</span>
            </div>
            ${g.items.map(contextRow)}
          </section>`,
      )}
    </div>`;
  else if (!contextsLoading) {
    projectList = html`<div class="empty compact project-empty">
      ${projectsFiltered ? "没有匹配的项目。" : "暂无项目。"}
    </div>`;
  }
  return html`
    <div class="project-grid-content">
      <div class="list-page-head">
        <h1 class="pane-title">项目</h1>
        <div class="list-page-actions">
          <button
            class="btn primary project-create-button"
            type="button"
            aria-label="新建项目"
            @click=${openCreateProject}
          >
            ${icon(FolderPlus, 15)}<span>新建项目</span>
          </button>
        </div>
        <label class="list-search"
          >${icon(Search, 16)}<span class="sr-only">搜索项目</span
          ><input
            data-focus-key="contexts-search"
            type="search"
            aria-label="搜索项目"
            placeholder="搜索项目…"
            .value=${contextsQuery}
            @input=${(event: InputEvent) => {
              contextsQuery = (event.currentTarget as HTMLInputElement).value;
              drawContexts();
            }}
        /></label>
      </div>
      <div class="list-toolbar">
        <label class="list-select"
          ><span>显示</span>${fieldSelect({
            compact: true,
            value: contextsWorkspaceFilter,
            onChange: (value) => {
              contextsWorkspaceFilter = value as typeof contextsWorkspaceFilter;
              drawContexts();
            },
            options: [html`<option value="active">仅未归档</option>`, html`<option value="all">全部</option>`],
          })}</label
        >
      </div>
      ${status ? html`<div class="status">${status}</div>` : nothing} ${projectList}
    </div>
    ${createProjectDialog()}
  `;
}

function contextRow(c: CoreContext): TemplateResult {
  const { title, sub, glyph } = contextMeta(c);
  const count = c.sessionCount === 1 ? "1 个对话" : `${c.sessionCount} 个对话`;
  const meta = [c.project ? sub : "", count, c.lastActivityAt ? `活跃于 ${relTime(c.lastActivityAt)}` : ""]
    .filter(Boolean)
    .join(" · ");
  return html`
    <button class="context-row" type="button" ${tip(sub)} @click=${() => selectContext(c.scopeId)}>
      <span class="context-glyph">${icon(glyph, 15)}</span>
      <span class="context-row-title" dir="auto">${title}</span>
      ${c.isPrivate ? html`<span class="context-lock" ${tip("私密频道")}>${icon(Lock, 12)}</span>` : nothing}
      <span class="context-row-meta">${meta}</span>
    </button>
  `;
}

function detailTpl(c: CoreContext): TemplateResult {
  const { title, sub, glyph } = contextMeta(c);
  const sessions = sessionsIn(c.scopeId);
  const completelyEmpty = sessions.length === 0 && scopeResourcesEmpty(c.scopeId);
  return html`
    <div class="context-detail">
      <button class="context-back" type="button" @click=${() => selectContext(null)}>
        ${icon(ArrowLeft, 15)}<span>项目</span>
      </button>
      <div class="context-detail-head">
        <span class="context-glyph large">${icon(glyph, 22)}</span>
        <div class="context-detail-titles">
          <h1 class="pane-title">
            ${title}
            ${c.isPrivate ? html`<span class="context-lock" ${tip("私密频道")}>${icon(Lock, 14)}</span>` : nothing}
          </h1>
          <div class="context-sub">${c.project ? sub : `${sub} 此处的智能体文件和记忆独立于其他项目。`}</div>
        </div>
        <div class="context-detail-actions">
          ${
            c.project
              ? html`<button class="btn context-add-member" type="button" @click=${() => toggleMemberPicker(c)}>
                  ${icon(UserPlus, 15)}<span>添加成员</span>
                </button>`
              : nothing
          }
          <button class="btn primary context-new-chat" type="button" @click=${() => startChatIn(c)}>
            ${icon(Plus, 15)}<span>新对话</span>
          </button>
        </div>
      </div>
      <div class="context-workspace has-settings">
        <div class="context-workspace-main">
          ${
            completelyEmpty
              ? html`
                  <section class="context-panel context-project-empty">
                    <span class="context-glyph large" aria-hidden="true">${icon(glyph, 22)}</span>
                    <h2>项目已准备就绪</h2>
                    <p>点击“新对话”开始。对话中创建的文件、自动化任务和其他工作都会保存在此项目下。</p>
                  </section>
                `
              : html`
                  <section class="context-panel context-conversations" aria-labelledby="context-conversations-title">
                    <div class="context-panel-heading">
                      <h2 class="context-panel-title" id="context-conversations-title">对话</h2>
                      ${sessions.length ? html`<span class="context-panel-count">${sessions.length}</span>` : nothing}
                    </div>
                    ${
                      sessions.length
                        ? html`<div class="context-session-list">${sessions.map((s) => contextSessionRow(s))}</div>`
                        : html`<div class="context-inline-empty">暂无对话。</div>`
                    }
                  </section>
                  ${resourceSections(c.scopeId)}
                `
          }
        </div>
        <aside class="context-settings" aria-label=${c.project ? "项目设置" : "上下文设置"}>
          ${c.project ? projectMembersSection(c) : nothing} ${c.project ? projectSlackSection(c) : nothing}
          ${contextModelSection(c.scopeId)} ${channelHeaderSection(c.scopeId)} ${ambientPolicySection(c.scopeId)}
        </aside>
      </div>
    </div>
  `;
}

function scopeResourcesEmpty(scopeId: string): boolean {
  const r = contextsState.resourcesScope === scopeId ? contextsState.resources : null;
  return Boolean(
    r &&
    r.files.length === 0 &&
    r.webhooks.length === 0 &&
    r.crons.length === 0 &&
    r.deployments.length === 0 &&
    r.skills.length === 0,
  );
}

function projectPeople(context: CoreContext): string[] {
  if (!context.project) return [];
  return [...new Set([context.project.ownerId, ...context.project.memberIds].filter(Boolean))];
}

function isProjectOwner(context: CoreContext): boolean {
  return context.project?.ownerId === appState.me?.user;
}

function memberLabel(context: CoreContext, principalId: string): string {
  if (principalId === appState.me?.user) return "你";
  return context.project?.members.find((member) => member.principalId === principalId)?.displayName || principalId;
}

function channelNameOptions(): string[] {
  return [
    ...new Set(
      contextsState.list
        .filter((c) => c.kind === "channel" && c.name)
        .map((c) => c.name!.replace(/^#/, ""))
        .sort(),
    ),
  ];
}

async function linkProjectSlackChannel(context: CoreContext): Promise<void> {
  const channel = contextsState.slackValue.trim().replace(/^#/, "");
  if (!context.project || contextsState.slackBusy || !channel) return;
  const resetSeq = contextsResetSeq;
  contextsState.slackBusy = true;
  contextsState.slackError = "";
  drawContexts();
  try {
    const response = await api(`/api/projects/${encodeURIComponent(context.project.id)}/slack-channel`, {
      method: "PUT",
      body: JSON.stringify({ channel }),
    });
    if (resetSeq !== contextsResetSeq) return;
    const project = projectFromResponse(response);
    if (!project) throw new Error("服务器返回的项目无效");
    upsertProject(project);
    contextsState.slackEditing = false;
    contextsState.slackValue = "";
  } catch (error) {
    if (resetSeq !== contextsResetSeq) return;
    contextsState.slackError = errMessage(error, "无法关联该频道，请确保你是频道成员。");
  } finally {
    if (resetSeq === contextsResetSeq) {
      contextsState.slackBusy = false;
      drawContexts();
    }
  }
}

async function unlinkProjectSlackChannel(context: CoreContext): Promise<void> {
  const linked = context.project?.slackChannel;
  if (!context.project || !linked || contextsState.slackBusy) return;
  if (!window.confirm(`取消 #${linked.channelName} 与 ${context.name || "此项目"} 的关联？`)) return;
  const resetSeq = contextsResetSeq;
  contextsState.slackBusy = true;
  contextsState.slackError = "";
  drawContexts();
  try {
    const response = await api(`/api/projects/${encodeURIComponent(context.project.id)}/slack-channel`, {
      method: "DELETE",
    });
    if (resetSeq !== contextsResetSeq) return;
    const project = projectFromResponse(response);
    if (!project) throw new Error("服务器返回的项目无效");
    upsertProject(project);
  } catch (error) {
    if (resetSeq !== contextsResetSeq) return;
    contextsState.slackError = errMessage(error, "无法取消频道关联。");
  } finally {
    if (resetSeq === contextsResetSeq) {
      contextsState.slackBusy = false;
      drawContexts();
    }
  }
}

function projectSlackLinked(context: CoreContext): TemplateResult {
  const linked = context.project!.slackChannel!;
  return html`
    <div class="project-member-row">
      <span class="context-glyph" aria-hidden="true">${icon(Hash, 15)}</span>
      <span class="project-member-name" dir="auto">${linked.channelName}</span>
      <button
        class="project-icon-button danger"
        type="button"
        aria-label=${`取消关联 #${linked.channelName}`}
        ${tip(`取消关联 #${linked.channelName}`)}
        ?disabled=${contextsState.slackBusy}
        @click=${() => void unlinkProjectSlackChannel(context)}
      >
        ${icon(X, 15)}
      </button>
    </div>
    <p class="context-hint">智能体会将项目更新发送到 #${linked.channelName}，频道内的所有成员都属于此项目。</p>
  `;
}

function projectSlackEditor(context: CoreContext): TemplateResult {
  const options = channelNameOptions();
  return html`
    <form
      class="project-slack-form"
      @submit=${(e: Event) => {
        e.preventDefault();
        void linkProjectSlackChannel(context);
      }}
    >
      <div class="project-member-search-row">
        ${icon(Hash, 16)}
        <input
          type="text"
          data-focus-key="project-slack-channel"
          autocomplete="off"
          maxlength="200"
          placeholder="频道名称"
          list="project-slack-channels"
          aria-label="要关联的 Slack 频道"
          .value=${contextsState.slackValue}
          ?disabled=${contextsState.slackBusy}
          @input=${(e: Event) => {
            contextsState.slackValue = (e.target as HTMLInputElement).value;
          }}
        />
      </div>
      <datalist id="project-slack-channels">${options.map((name) => html`<option value=${name}></option>`)}</datalist>
      <div class="project-slack-actions">
        <button class="btn primary" type="submit" ?disabled=${contextsState.slackBusy}>关联</button>
        <button
          class="btn"
          type="button"
          ?disabled=${contextsState.slackBusy}
          @click=${() => {
            contextsState.slackEditing = false;
            contextsState.slackValue = "";
            contextsState.slackError = "";
            drawContexts();
          }}
        >
          取消
        </button>
      </div>
    </form>
  `;
}

function projectSlackIdle(): TemplateResult {
  return html`
    <button
      class="btn project-slack-link"
      type="button"
      ?disabled=${contextsState.slackBusy}
      @click=${() => {
        contextsState.slackEditing = true;
        contextsState.slackError = "";
        drawContexts();
      }}
    >
      ${icon(Hash, 15)}<span>关联频道</span>
    </button>
    <p class="context-hint">为项目关联一个 Slack 频道。智能体将在其中发送更新，频道内的所有成员都会加入项目。</p>
  `;
}

function projectSlackSection(context: CoreContext): TemplateResult {
  const project = context.project!;
  let body: TemplateResult;
  if (project.slackChannel) body = projectSlackLinked(context);
  else if (contextsState.slackEditing) body = projectSlackEditor(context);
  else body = projectSlackIdle();
  return html`
    <section class="context-panel project-slack" aria-labelledby="project-slack-title">
      <div class="context-panel-heading">
        <h2 class="context-panel-title" id="project-slack-title">Slack 频道</h2>
      </div>
      ${body}
      ${contextsState.slackError ? html`<div class="project-member-status error" aria-live="polite">${contextsState.slackError}</div>` : nothing}
    </section>
  `;
}

function projectMembersSection(context: CoreContext): TemplateResult {
  const project = context.project!;
  const pickerOpen = contextsState.memberProjectId === project.id;
  return html`
    <section class="context-panel project-members" aria-labelledby="project-people-title">
      <div class="context-panel-heading">
        <h2 class="context-panel-title" id="project-people-title">成员</h2>
        <span class="context-panel-count">${projectPeople(context).length}</span>
      </div>
      <div class="project-member-list">
        ${projectPeople(context).map((principalId) => {
          const label = memberLabel(context, principalId);
          const viaChannel = Boolean(project.members.find((member) => member.principalId === principalId)?.viaChannel);
          return html`
            <div class="project-member-row">
              <span class="project-member-avatar" aria-hidden="true">${initials(label)}</span>
              <span class="project-member-name" dir="auto">${label}</span>
              ${principalId === project.ownerId ? html`<span class="badge">所有者</span>` : nothing}
              ${
                viaChannel && project.slackChannel
                  ? html`<span class="badge" ${tip("通过关联的 Slack 频道加入")}
                      ><bdi>#${project.slackChannel.channelName}</bdi></span
                    >`
                  : nothing
              }
              ${
                isProjectOwner(context) && principalId !== project.ownerId && !viaChannel
                  ? html`<button
                      class="project-icon-button danger"
                      type="button"
                      aria-label=${`移除 ${label}`}
                      ${tip(`移除 ${label}`)}
                      ?disabled=${contextsState.memberSearching || contextsState.memberBusy}
                      @click=${() => void removeProjectMember(context, principalId)}
                    >
                      ${icon(X, 15)}
                    </button>`
                  : nothing
              }
            </div>
          `;
        })}
      </div>
      ${pickerOpen ? memberPicker(context) : nothing}
      ${contextsState.memberError ? html`<div class="project-member-status error" aria-live="polite">${contextsState.memberError}</div>` : nothing}
    </section>
  `;
}

function memberPicker(context: CoreContext): TemplateResult {
  const members = new Set(projectPeople(context));
  const matches = contextsState.memberMatches.filter((match) => !members.has(match.principalId)).slice(0, 8);
  const idle = !contextsState.memberSearching && !contextsState.memberBusy && !contextsState.memberError;
  let emptyNote = "";
  if (idle && contextsState.memberSearchedQuery && matches.length === 0) {
    emptyNote = contextsState.memberMatches.length
      ? "匹配的人员都已加入此项目。"
      : `没有与“${contextsState.memberSearchedQuery}”匹配的结果。`;
  }
  let memberStatus = emptyNote;
  if (contextsState.memberSearching) memberStatus = "正在搜索…";
  else if (contextsState.memberBusy) memberStatus = "处理中…";
  return html`
    <form class="project-member-picker" @submit=${(event: SubmitEvent) => void searchProjectMembers(event, context)}>
      <label for="project-member-search">添加成员</label>
      <div class="project-member-search-row">
        ${icon(Search, 16)}
        <input
          id="project-member-search"
          data-focus-key="project-member-search"
          name="query"
          type="search"
          autocomplete="off"
          maxlength="80"
          placeholder="按姓名或账户名搜索"
          .value=${contextsState.memberQuery}
          ?disabled=${contextsState.memberBusy}
          @input=${(event: InputEvent) => {
            contextsState.memberQuery = (event.currentTarget as HTMLInputElement).value;
            scheduleMemberSearch(context);
          }}
        />
        <button
          class="project-icon-button"
          type="submit"
          aria-label="搜索"
          ${tip("搜索")}
          ?disabled=${contextsState.memberSearching || contextsState.memberBusy}
        >
          ${icon(Search, 15)}
        </button>
        <button
          class="project-icon-button"
          type="button"
          aria-label="关闭"
          ${tip("关闭")}
          ?disabled=${contextsState.memberBusy}
          @click=${closeMemberPicker}
        >
          ${icon(X, 15)}
        </button>
      </div>
      ${peopleResults(matches, contextsState.memberSearching || contextsState.memberBusy, (match) => void addProjectMember(context, match))}
      <div class="project-member-status" aria-live="polite">${memberStatus}</div>
    </form>
  `;
}

function resourceSections(scopeId: string): TemplateResult | typeof nothing {
  if (contextsState.resourcesScope !== scopeId) return html``;
  if (contextsState.resourcesNotice) return html`<div class="status">${contextsState.resourcesNotice}</div>`;
  const r = contextsState.resources;
  if (!r) {
    return contextsState.resourcesLoading
      ? html`<div class="empty compact">正在加载此项目的文件、Webhook、定时任务、应用和技能…</div>`
      : html``;
  }
  if (
    r.files.length === 0 &&
    r.webhooks.length === 0 &&
    r.crons.length === 0 &&
    r.deployments.length === 0 &&
    r.skills.length === 0
  ) {
    return nothing;
  }
  const manage = r.manageable;
  return html`
    ${r.files.length ? resourceGroup("files", "文件", r.files.map(fileRow)) : nothing}
    ${
      r.skills.length
        ? resourceGroup(
            "skills",
            "技能",
            r.skills.map((s) => skillRow(s, manage)),
          )
        : nothing
    }
    ${
      r.crons.length
        ? resourceGroup(
            "crons",
            "定时任务",
            r.crons.map((c) => cronRow(c, manage)),
          )
        : nothing
    }
    ${r.webhooks.length ? resourceGroup("webhooks", "Webhook", r.webhooks.map(webhookRow)) : nothing}
    ${r.deployments.length ? resourceGroup("deploys", "应用", r.deployments.map(deploymentRow)) : nothing}
  `;
}

const resourceBusy = new Set<string>();

async function manageCron(id: string, action: "enable" | "disable" | "delete"): Promise<void> {
  const key = `cron:${id}`;
  if (resourceBusy.has(key)) return;
  if (action === "delete" && !confirm("确定删除此定时任务吗？此操作无法撤销。")) return;
  resourceBusy.add(key);
  drawContexts();
  try {
    if (action === "delete") await api(`/api/crons/${encodeURIComponent(id)}`, { method: "DELETE" });
    else await api(`/api/crons/${encodeURIComponent(id)}/${action}`, { method: "POST" });
    const scope = contextsState.resourcesScope;
    if (scope) await loadScopeResources(scope);
  } catch (e) {
    contextsState.resourcesNotice = errMessage(e, "无法更新该定时任务。");
  } finally {
    resourceBusy.delete(key);
    drawContexts();
  }
}

async function deleteScopeSkill(id: string): Promise<void> {
  const key = `skill:${id}`;
  if (resourceBusy.has(key)) return;
  if (!confirm("确定删除此技能吗？此操作无法撤销。")) return;
  resourceBusy.add(key);
  drawContexts();
  try {
    await api(`/api/skills/${encodeURIComponent(id)}`, { method: "DELETE" });
    const scope = contextsState.resourcesScope;
    if (scope) await loadScopeResources(scope);
  } catch (e) {
    contextsState.resourcesNotice = errMessage(e, "无法删除该技能。");
  } finally {
    resourceBusy.delete(key);
    drawContexts();
  }
}

function resourceGroup(
  view: "files" | "skills" | "crons" | "webhooks" | "deploys",
  label: string,
  rows: TemplateResult[],
): TemplateResult {
  const scope = contextsState.resourcesScope;
  const supportsScopeLink = view === "files" || view === "deploys";
  const href = `${UI_BASE}/${encodeURIComponent(view)}${scope && supportsScopeLink ? `?scope=${encodeURIComponent(scope)}` : ""}`;
  return html`
    <section class="context-panel context-resource-group">
      <div class="context-panel-heading context-resource-heading">
        <h2 class="context-panel-title">${label}</h2>
        <a href=${href}>查看全部</a>
      </div>
      <div class="context-session-list">${rows}</div>
    </section>
  `;
}

function fileRow(f: ScopeFile): TemplateResult {
  return html`
    <div class="context-session-row context-resource-row">
      <span class="context-session-title" dir="auto">${f.name}</span>
      <span class="context-session-meta">
        <span>${formatBytes(f.sizeBytes)}</span>
        <span>${relTime(f.createdAt)}</span>
        ${
          f.openable
            ? html`<a
                class="context-resource-link"
                href=${fileContentUrl(f.id, f.name)}
                target="_blank"
                rel="noreferrer"
                >打开</a
              >`
            : nothing
        }
      </span>
    </div>
  `;
}

function webhookRow(w: WebhookView): TemplateResult {
  let lastRun = "从未触发";
  if (w.lastError) lastRun = "出错";
  else if (w.lastFiredAt) lastRun = relTime(w.lastFiredAt);
  return html`
    <div class="context-session-row context-resource-row">
      <span class="context-session-title">${actionSnippet(w.action)}</span>
      <span class="context-session-meta">
        <span class="badge">${w.verification.scheme}</span>
        <span class="badge">${w.enabled ? "已启用" : "已停用"}</span>
        <span>${lastRun}</span>
      </span>
    </div>
  `;
}

function cronRow(c: CronView, manage = false): TemplateResult {
  let status = "disabled";
  if (c.archived) status = "archived";
  else if (c.enabled) status = "enabled";
  const busy = resourceBusy.has(`cron:${c.id}`);
  return html`
    <div class="context-session-row context-resource-row">
      <span class="context-session-title" dir="auto">${c.title ?? actionSnippet(c.message ?? c.action ?? "")}</span>
      <span class="context-session-meta">
        <span class="badge">${cronScheduleSummary(c)}</span>
        <span class="badge">${displayStatus(status)}</span>
        <span ${tip(cronRunSummaryTitle(c))}>${cronRunSummary(c)}</span>
        ${
          manage && !c.archived
            ? html`
                <button
                  class="context-resource-action"
                  type="button"
                  ?disabled=${busy}
                  @click=${() => void manageCron(c.id, c.enabled ? "disable" : "enable")}
                >
                  ${c.enabled ? "停用" : "启用"}
                </button>
                <button
                  class="context-resource-action danger"
                  type="button"
                  ?disabled=${busy}
                  @click=${() => void manageCron(c.id, "delete")}
                >
                  删除
                </button>
              `
            : nothing
        }
      </span>
    </div>
  `;
}

function skillRow(s: ScopeSkill, manage = false): TemplateResult {
  const busy = resourceBusy.has(`skill:${s.id}`);
  return html`
    <div class="context-session-row context-resource-row">
      <span class="context-session-title" dir="auto">${s.name}</span>
      <span class="context-session-meta">
        ${s.description ? html`<span class="context-resource-desc">${s.description}</span>` : nothing}
        <span class="badge">${displayStatus(s.status)}</span>
        ${
          manage
            ? html`<button
                class="context-resource-action danger"
                type="button"
                ?disabled=${busy}
                @click=${() => void deleteScopeSkill(s.id)}
              >
                删除
              </button>`
            : nothing
        }
      </span>
    </div>
  `;
}

function deploymentRow(d: ScopeDeployment): TemplateResult {
  return html`
    <div class="context-session-row context-resource-row">
      <span class="context-session-title" dir="auto">${d.name}</span>
      <span class="context-session-meta">
        <span class="badge">v${d.currentVersion}</span>
        <span class="badge">${displayStatus(d.status)}</span>
        <span class="badge">${d.permission === "write" ? "管理" : "只读"}</span>
      </span>
    </div>
  `;
}

function openCreateProject(): void {
  createProjectOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  contextsState.createOpen = true;
  contextsState.createName = "";
  contextsState.createError = "";
  drawContexts();
  queueMicrotask(() => document.querySelector<HTMLInputElement>("#project-name")?.focus());
}

function closeCreateProject(): void {
  createProjectSeq++;
  contextsState.createOpen = false;
  contextsState.createSaving = false;
  contextsState.createName = "";
  contextsState.createError = "";
  drawContexts();
  queueMicrotask(() => {
    const target = createProjectOpener;
    createProjectOpener = null;
    restoreDialogFocus(target, () => document.querySelector<HTMLElement>(".project-create-button"));
  });
}

function createProjectDialog(): TemplateResult | typeof nothing {
  if (!contextsState.createOpen) return nothing;
  return html`
    <dialog
      class="project-dialog"
      aria-labelledby="project-dialog-title"
      @close=${closeCreateProject}
      @click=${(event: MouseEvent) => event.target === event.currentTarget && (event.currentTarget as HTMLDialogElement).close()}
    >
      <form @submit=${(event: SubmitEvent) => void createProject(event)}>
        <div class="project-dialog-head">
          <span class="context-glyph large">${icon(FolderPlus, 21)}</span>
          <div><h2 id="project-dialog-title">新建项目</h2></div>
          <button
            class="project-icon-button"
            type="button"
            aria-label="关闭新建项目"
            ${tip("关闭")}
            @click=${closeCreateProject}
          >
            ${icon(X, 16)}
          </button>
        </div>
        <label class="project-name-field" for="project-name">
          <span>名称</span>
          <input
            id="project-name"
            data-focus-key="project-name"
            name="name"
            maxlength="200"
            autocomplete="off"
            placeholder="例如：产品发布"
            .value=${contextsState.createName}
            ?disabled=${contextsState.createSaving}
            @input=${(event: InputEvent) => {
              contextsState.createName = (event.currentTarget as HTMLInputElement).value;
              contextsState.createError = "";
            }}
          />
        </label>
        <div class="form-error" aria-live="polite">${contextsState.createError}</div>
        <div class="project-dialog-actions">
          <button class="btn" type="button" @click=${closeCreateProject}>
            ${contextsState.createSaving ? "关闭" : "取消"}
          </button>
          <button class="btn primary" type="submit" ?disabled=${contextsState.createSaving}>
            ${icon(FolderPlus, 15)}<span>${contextsState.createSaving ? "正在创建…" : "创建项目"}</span>
          </button>
        </div>
      </form>
    </dialog>
  `;
}

export function openProjectDetail(scopeId: string): void {
  switchView("contexts");
  selectContext(scopeId);
}

export async function renameProject(project: CoreProject, name: string): Promise<boolean> {
  try {
    const updated = projectFromResponse(
      await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: "PATCH", body: JSON.stringify({ name }) }),
    );
    if (!updated) return false;
    upsertProject(updated);
    if (appState.currentView === "contexts") drawContexts();
    return true;
  } catch {
    return false;
  }
}

function projectFromResponse(response: unknown): CoreProject | null {
  const project = (response as { project?: CoreProject } | null)?.project;
  if (
    !project ||
    !project.id ||
    !project.name ||
    !project.ownerId ||
    !project.scopeId?.trim() ||
    !Array.isArray(project.memberIds) ||
    !Array.isArray(project.members) ||
    project.members.some((member) => !member?.principalId || !member.displayName)
  )
    return null;
  return project;
}

function upsertProject(project: CoreProject): CoreContext {
  const loaded = contextsState.loaded;
  contextsFetchSeq++;
  const scopeId = project.scopeId;
  const current = contextsState.list.find((context) => context.scopeId === scopeId);
  const next: CoreContext = {
    ...current,
    scopeId,
    kind: "group",
    name: project.name,
    sessionCount: current?.sessionCount ?? 0,
    lastActivityAt: current?.lastActivityAt ?? null,
    project,
  };
  contextsState.list = [next, ...contextsState.list.filter((context) => context.scopeId !== scopeId)];
  contextsState.loaded = loaded;
  if (loaded) contextsState.loadedAt = Date.now();
  return next;
}

async function createProject(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (contextsState.createSaving) return;
  const name = contextsState.createName.trim();
  if (!name) {
    contextsState.createError = "请输入项目名称。";
    drawContexts();
    queueMicrotask(() => document.querySelector<HTMLInputElement>("#project-name")?.focus());
    return;
  }
  const seq = ++createProjectSeq;
  const resetSeq = contextsResetSeq;
  contextsState.createSaving = true;
  drawContexts();
  try {
    const project = projectFromResponse(await api("/api/projects", { method: "POST", body: JSON.stringify({ name }) }));
    if (resetSeq !== contextsResetSeq) return;
    if (!project) throw new Error("服务器返回的项目无效");
    const loaded = contextsState.loaded;
    let context = upsertProject(project);
    if (!loaded) {
      await fetchContexts().catch(() => contextsState.list);
      if (resetSeq !== contextsResetSeq) return;
      context = upsertProject(project);
    }
    if (seq !== createProjectSeq) {
      if (appState.currentView === "contexts") drawContexts();
      return;
    }
    contextsState.createOpen = false;
    contextsState.createSaving = false;
    contextsState.createName = "";
    selectContext(context.scopeId);
  } catch (error) {
    if (seq !== createProjectSeq || resetSeq !== contextsResetSeq) return;
    contextsState.createSaving = false;
    contextsState.createError = errMessage(error, "无法创建该项目。");
    drawContexts();
    queueMicrotask(() => document.querySelector<HTMLInputElement>("#project-name")?.focus());
  }
}

function toggleMemberPicker(context: CoreContext): void {
  memberSearchSeq++;
  cancelMemberSearchTimer();
  contextsState.memberProjectId =
    contextsState.memberProjectId === context.project?.id ? null : (context.project?.id ?? null);
  contextsState.memberQuery = "";
  contextsState.memberMatches = [];
  contextsState.memberSearching = false;
  contextsState.memberError = "";
  contextsState.memberSearchedQuery = "";
  contextsState.slackEditing = false;
  contextsState.slackValue = "";
  contextsState.slackBusy = false;
  contextsState.slackError = "";
  drawContexts();
  if (contextsState.memberProjectId)
    queueMicrotask(() => document.querySelector<HTMLInputElement>("#project-member-search")?.focus());
}

function closeMemberPicker(): void {
  memberSearchSeq++;
  cancelMemberSearchTimer();
  contextsState.memberProjectId = null;
  contextsState.memberQuery = "";
  contextsState.memberMatches = [];
  contextsState.memberSearching = false;
  contextsState.memberError = "";
  contextsState.memberSearchedQuery = "";
  contextsState.slackEditing = false;
  contextsState.slackValue = "";
  contextsState.slackBusy = false;
  contextsState.slackError = "";
  drawContexts();
}

function scheduleMemberSearch(context: CoreContext): void {
  cancelMemberSearchTimer();
  memberSearchSeq++;
  const hadVisibleState =
    contextsState.memberSearching || contextsState.memberError !== "" || contextsState.memberSearchedQuery !== "";
  contextsState.memberSearching = false;
  contextsState.memberError = "";
  contextsState.memberSearchedQuery = "";
  contextsState.slackEditing = false;
  contextsState.slackValue = "";
  contextsState.slackBusy = false;
  contextsState.slackError = "";
  const query = contextsState.memberQuery.trim();
  if (query.length < 2) {
    if (hadVisibleState || contextsState.memberMatches.length) {
      contextsState.memberMatches = [];
      drawContexts();
    }
    return;
  }
  memberSearchTimer = setTimeout(() => {
    memberSearchTimer = undefined;
    void runMemberSearch(context, query);
  }, MEMBER_SEARCH_DEBOUNCE_MS);
  if (hadVisibleState) drawContexts();
}

async function searchProjectMembers(event: SubmitEvent, context: CoreContext): Promise<void> {
  event.preventDefault();
  if (!context.project || contextsState.memberBusy) return;
  cancelMemberSearchTimer();
  const input = (event.currentTarget as HTMLFormElement).elements.namedItem("query") as HTMLInputElement | null;
  const query = input?.value.trim() ?? "";
  contextsState.memberQuery = query;
  contextsState.memberError = "";
  if (query.length < 2) {
    contextsState.memberMatches = [];
    contextsState.memberSearchedQuery = "";
    contextsState.memberError = "请输入至少两个字符。";
    drawContexts();
    return;
  }
  await runMemberSearch(context, query);
}

async function runMemberSearch(context: CoreContext, query: string): Promise<void> {
  if (!context.project || contextsState.memberBusy) return;
  if (contextsState.memberProjectId !== context.project.id) return;
  const projectId = context.project.id;
  const searchSeq = ++memberSearchSeq;
  contextsState.memberSearching = true;
  drawContexts();
  try {
    const response = await api<{ matches?: DirectoryMatch[] }>(`/api/directory/resolve?q=${encodeURIComponent(query)}`);
    if (searchSeq !== memberSearchSeq || contextsState.memberProjectId !== projectId) return;
    contextsState.memberMatches = (response.matches ?? []).filter((match) => match.type === "internal");
    contextsState.memberSearchedQuery = query;
  } catch (error) {
    if (searchSeq !== memberSearchSeq || contextsState.memberProjectId !== projectId) return;
    contextsState.memberSearchedQuery = "";
    contextsState.memberError = errMessage(error, "无法搜索人员。");
  } finally {
    if (searchSeq === memberSearchSeq) {
      contextsState.memberSearching = false;
      drawContexts();
    }
  }
}

async function addProjectMember(context: CoreContext, member: DirectoryMatch): Promise<void> {
  if (!context.project || contextsState.memberBusy) return;
  const resetSeq = contextsResetSeq;
  memberSearchSeq++;
  cancelMemberSearchTimer();
  contextsState.memberSearching = false;
  contextsState.memberBusy = true;
  contextsState.memberError = "";
  drawContexts();
  try {
    const response = await api(`/api/projects/${encodeURIComponent(context.project.id)}/members`, {
      method: "POST",
      body: JSON.stringify({ memberId: member.principalId }),
    });
    if (resetSeq !== contextsResetSeq) return;
    const project = projectFromResponse(response);
    if (!project) throw new Error("服务器返回的项目无效");
    upsertProject(project);
    contextsState.memberQuery = "";
    contextsState.memberMatches = [];
    contextsState.memberSearchedQuery = "";
  } catch (error) {
    if (resetSeq !== contextsResetSeq) return;
    contextsState.memberError = errMessage(error, "无法添加该成员。");
  } finally {
    if (resetSeq === contextsResetSeq) {
      contextsState.memberBusy = false;
      drawContexts();
    }
  }
}

async function removeProjectMember(context: CoreContext, principalId: string): Promise<void> {
  if (!context.project || contextsState.memberBusy) return;
  const label = memberLabel(context, principalId);
  if (!window.confirm(`将 ${label} 从 ${context.name || "此项目"} 中移除？`)) return;
  const resetSeq = contextsResetSeq;
  memberSearchSeq++;
  cancelMemberSearchTimer();
  contextsState.memberSearching = false;
  contextsState.memberBusy = true;
  contextsState.memberError = "";
  drawContexts();
  try {
    const response = await api(
      `/api/projects/${encodeURIComponent(context.project.id)}/members/${encodeURIComponent(principalId)}`,
      { method: "DELETE" },
    );
    if (resetSeq !== contextsResetSeq) return;
    const project = projectFromResponse(response);
    if (!project) throw new Error("服务器返回的项目无效");
    upsertProject(project);
  } catch (error) {
    if (resetSeq !== contextsResetSeq) return;
    contextsState.memberError = errMessage(error, "无法移除该成员。");
  } finally {
    if (resetSeq === contextsResetSeq) {
      contextsState.memberBusy = false;
      drawContexts();
    }
  }
}

async function loadScopeResources(scopeId: string): Promise<void> {
  contextsState.resources = null;
  contextsState.resourcesScope = scopeId;
  contextsState.resourcesLoading = true;
  contextsState.resourcesNotice = "";
  drawContexts();
  const seq = appState.viewRenderSeq;
  const stale = () =>
    seq !== appState.viewRenderSeq || appState.currentView !== "contexts" || contextsState.selected !== scopeId;
  try {
    const r = await api<ScopeResourcesView>(`/api/scope-resources?scope=${encodeURIComponent(scopeId)}`);
    if (stale()) return;
    contextsState.resources = {
      files: r.files ?? [],
      webhooks: r.webhooks ?? [],
      crons: r.crons ?? [],
      deployments: r.deployments ?? [],
      skills: r.skills ?? [],
      manageable: r.manageable === true,
    };
  } catch (e) {
    if (stale()) return;
    contextsState.resourcesNotice = errMessage(e, "加载此项目的资源失败。");
  } finally {
    if (!stale()) {
      contextsState.resourcesLoading = false;
      drawContexts();
    }
  }
}

function contextSessionRow(s: CoreSession): TemplateResult {
  const surface = surfaceOf(s);
  const readOnly = !isContinuable(s, appState.me?.user ?? "");
  return html`
    <button class="context-session-row" type="button" @click=${() => void openFromContext(s)}>
      <span class="context-session-title" dir="auto">${groupDmTitle(s)}</span>
      <span class="context-session-meta">
        ${surface === "slack" ? html`<span class="surface surface-slack">${slackLogo(13)}</span>` : html`<span class="badge">${surface}</span>`}
        ${readOnly ? html`<span class="ro-lock" ${tip("此处只读，请在原平台回复")}>${icon(Lock, 12)}</span>` : nothing}
        <span>${relTime(activityOf(s))}</span>
      </span>
    </button>
  `;
}

function selectContext(scopeId: string | null): void {
  memberSearchSeq++;
  cancelMemberSearchTimer();
  contextsState.memberProjectId = null;
  contextsState.memberQuery = "";
  contextsState.memberMatches = [];
  contextsState.memberSearching = false;
  contextsState.memberError = "";
  contextsState.memberSearchedQuery = "";
  contextsState.slackEditing = false;
  contextsState.slackValue = "";
  contextsState.slackBusy = false;
  contextsState.slackError = "";
  contextsState.selected = scopeId;
  contextsState.resources = null;
  contextsState.resourcesScope = null;
  contextsState.resourcesNotice = "";
  contextsState.resourcesLoading = false;
  resetAmbientPolicy();
  resetContextModel();
  resetChannelHeader();
  syncUrlFromState();
  drawContexts();
  if (scopeId) {
    void loadScopeResources(scopeId);
    void loadAmbientPolicy(scopeId, drawContexts);
    void loadContextModel(scopeId, drawContexts);
    void loadChannelHeader(scopeId, drawContexts);
  }
}

function startChatIn(c: CoreContext): void {
  startNewChat(c.kind === "personal" ? null : c.scopeId, c.name);
}

async function openFromContext(s: CoreSession): Promise<void> {
  await openSession(s);
}
