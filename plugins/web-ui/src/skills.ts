import { scopeTypeLabel } from "./display-labels";
import { html, nothing, render, type TemplateResult } from "lit";
import { api, type CoreContext } from "./core-bridge";
import type { SkillItem } from "./composer";
import { errMessage } from "../../chassis/src/errors";
import { fieldSelect } from "./ui";
import { appState } from "./shell";
import { skillActions } from "./skill-actions";
import {
  createReviewMatches,
  isSharedSkillScope,
  reviewMatches,
  shouldBlockRepeatedPublishClick,
  type SkillCreateReview,
  type SkillEditReview,
} from "./skill-edit-review";
import {
  filterSkillGroups,
  groupSkills,
  isArchivedSkill,
  skillEmptyState,
  statusCounts,
  type SkillStatusFilter,
} from "./skill-registry";
import { listBackLink, listPageTpl } from "./list-page";
import { scopeTitle } from "./contexts";
import { scopedSession, scopedViewTopbar } from "./session-scope";
import { focusDialogCancel, restoreDialogFocus, trapDialogFocus } from "./dialog-focus";
import { SkillsRefreshSequence } from "./skills-refresh";
import { SkillsMutationSequence } from "./skills-mutation";
import { tip } from "./tooltip";
import { deepLinkPath, isPlainLeftClick, UI_BASE } from "./deep-link";

let skillRows: SkillItem[] = [];
let skillsNotice = "";
let skillSearch = "";
let scopeFilter = "all";
let sourceFilter = "all";
let statusFilter: SkillStatusFilter = "active";
let createScopes: Array<{ scopeId: string; name: string }> = [];
let skillsPageHost: HTMLElement | null = null;

let editing: {
  id: string;
  description: string;
  body: string;
  originalDescription: string;
  originalBody: string;
  scopeId?: string;
  name: string;
  review: SkillEditReview | null;
} | null = null;
let editingTarget: SkillItem | null = null;
let saving = false;
let editError = "";

let creating: {
  name: string;
  description: string;
  body: string;
  scopeId: string;
  review: SkillCreateReview | null;
} | null = null;
let creatingSaving = false;
let createError = "";

let deleting: string | null = null;
let archiveConfirmation: SkillItem | null = null;
let editRequestSeq = 0;
const skillsRefreshes = new SkillsRefreshSequence();
const skillMutations = new SkillsMutationSequence();
let flowFocusTarget: HTMLElement | null = null;
let archiveFocusTarget: HTMLElement | null = null;
let activeSkillId: string | null = null;
let pendingSkillId: string | null = null;

export function resetActiveSkill(): void {
  activeSkillId = null;
}

export function openSkillById(id: string): void {
  pendingSkillId = id;
}

function syncSkillUrl(skillId: string | null, push = false): void {
  if (appState.currentView !== "skills") return;
  const next = deepLinkPath(UI_BASE, "skills", null, null, skillId);
  if (`${location.pathname}${location.search}` === next) return;
  if (push) history.pushState(null, "", next);
  else history.replaceState(null, "", next);
}

export function routeSkillsHistory(skillId: string | null): void {
  if (appState.currentView !== "skills") return;
  const skill = skillId ? skillRows.find((candidate) => candidate.id === skillId) : undefined;
  if (skill) openSkill(skill);
  else drawSkills();
}

function scopeLabel(scope: string): string {
  return scopeTypeLabel(scope);
}

function editAudience(scopeId: string | undefined): string {
  if (scopeId?.startsWith("personal:")) return "仅自己";
  return scopeId ? scopeTitle(scopeId) : "当前项目";
}

async function startEdit(s: SkillItem): Promise<void> {
  if (!s.id) return;
  const request = ++editRequestSeq;
  skillMutations.invalidate();
  flowFocusTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  creating = null;
  editing = null;
  editingTarget = s;
  editError = "";
  skillsNotice = "正在加载技能说明…";
  drawSkills();
  queueMicrotask(() => skillsPageHost?.querySelector<HTMLElement>(".context-back")?.focus());
  try {
    const r = await api<{ skill: SkillItem }>(`/api/skills/${encodeURIComponent(s.id)}`);
    if (request !== editRequestSeq) return;
    editing = {
      id: s.id,
      description: r.skill.description,
      body: r.skill.body ?? "",
      originalDescription: r.skill.description,
      originalBody: r.skill.body ?? "",
      scopeId: r.skill.scopeId,
      name: r.skill.name,
      review: null,
    };
    editingTarget = r.skill;
    skillsNotice = "";
  } catch (e) {
    if (request !== editRequestSeq) return;
    editError = errMessage(e, "加载技能详情失败。");
    skillsNotice = "";
  }
  drawSkills();
  queueMicrotask(() => {
    const target =
      skillsPageHost?.querySelector<HTMLElement>("#skill-edit-description") ??
      skillsPageHost?.querySelector<HTMLElement>(".context-back");
    target?.focus();
  });
}

function restoreFocusedFlow(target: HTMLElement | null): void {
  queueMicrotask(() => {
    if (creating || editingTarget || archiveConfirmation || appState.currentView !== "skills") return;
    const skillId = target?.dataset.skillId;
    const matchingEdit = skillId
      ? [...(skillsPageHost?.querySelectorAll<HTMLElement>(".skill-edit-trigger") ?? [])].find(
          (element) => element.dataset.skillId === skillId,
        )
      : null;
    const search = skillsPageHost?.querySelector<HTMLElement>(".list-search input") ?? null;
    const create = skillsPageHost?.querySelector<HTMLElement>(".list-page-action") ?? null;
    const fallback = skillId ? (matchingEdit ?? search ?? create) : (create ?? search);
    restoreDialogFocus(target, () => fallback ?? null);
  });
}

function closeFocusedFlow(): void {
  editRequestSeq += 1;
  skillMutations.invalidate();
  editing = null;
  editingTarget = null;
  creating = null;
  editError = "";
  createError = "";
  skillsNotice = "";
  saving = false;
  creatingSaving = false;
  const target = flowFocusTarget;
  flowFocusTarget = null;
  drawSkills();
  restoreFocusedFlow(target);
}

function startCreate(): void {
  if (creating) return;
  flowFocusTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  skillMutations.invalidate();
  editing = null;
  editingTarget = null;
  editRequestSeq += 1;
  creating = { name: "", description: "", body: "", scopeId: createScopes[0]?.scopeId ?? "", review: null };
  createError = "";
  creatingSaving = false;
  drawSkills();
  queueMicrotask(() => document.querySelector<HTMLInputElement>("#skill-create-name")?.focus());
}

function skillScopeTitle(s: SkillItem): string {
  if (s.scopeId && (s.scope === "personal" || s.scope === "channel" || s.scope === "group")) {
    return scopeTitle(s.scopeId);
  }
  return scopeLabel(s.scope);
}

function skillVariant(s: SkillItem, hasScopeVariants: boolean): TemplateResult {
  const actions = skillActions(s);
  const archived = isArchivedSkill(s);
  let archiveLabel = "归档";
  if (deleting === s.id) archiveLabel = "处理中…";
  else if (archived) archiveLabel = "恢复";
  return html`
    <div class="skill-variant ${archived ? "archived" : ""}">
      <a
        class="skill-variant-main"
        href=${deepLinkPath(UI_BASE, "skills", null, null, s.id ?? null)}
        aria-label=${`打开 /${s.name}`}
        @click=${(event: MouseEvent) => {
          if (!isPlainLeftClick(event)) return;
          event.preventDefault();
          openSkill(s, { push: true });
        }}
      >
        <code class="skill-variant-name" dir="auto">/${s.name}</code>
        <span class="skill-variant-description" ${tip(s.description)}>${s.description}</span>
      </a>
      <div class="skill-variant-state">
        ${archived ? html`<span class="badge">已归档</span>` : nothing}
        ${!archived && hasScopeVariants ? html`<span class="badge">作用域版本</span>` : nothing}
        ${actions.edit && !archived ? html`<button class="btn skill-edit-trigger" data-skill-id=${s.id ?? ""} type="button" ?disabled=${deleting === s.id} @click=${() => void startEdit(s)}>编辑</button>` : nothing}
        ${
          actions.delete
            ? html`<button
                class="btn skill-archive-trigger"
                data-skill-id=${s.id ?? ""}
                type="button"
                ?disabled=${deleting === s.id}
                @click=${(event: Event) => void deleteSkill(s, event.currentTarget as HTMLElement)}
              >
                ${archiveLabel}
              </button>`
            : nothing
        }
      </div>
    </div>
  `;
}

function openSkill(s: SkillItem, opts: { push?: boolean } = {}): void {
  if (!appState.mainEl) return;
  activeSkillId = s.id ?? null;
  syncSkillUrl(activeSkillId, opts.push);
  const archived = isArchivedSkill(s);
  const host = document.createElement("div");
  host.className = "resource-pane skill-pane";
  render(
    html`<div class="resource-detail">
      ${listBackLink("技能", () => drawSkills())}
      <div class="resource-heading">
        <h2 dir="auto">/${s.name}</h2>
        ${archived ? html`<span class="badge">已归档</span>` : nothing}
      </div>
      <div class="field">
        <label>描述</label>
        <div class="value" dir="auto">${s.description}</div>
      </div>
      <div class="field">
        <label>作用域</label>
        <div class="value">${skillScopeTitle(s)}</div>
      </div>
      <div class="field">
        <label>版本</label>
        <div class="value">${s.version ?? 1}</div>
      </div>
      <div class="field">
        <label>来源</label>
        <div class="value">${s.source === "pack" ? `技能包 ${s.pack?.upstreamName ?? "来源"}` : "本地"}</div>
      </div>
      <div class="field">
        <label>能力</label>
        <div class="value">${s.requiredCapabilities?.length ? s.requiredCapabilities.join(", ") : "无需"}</div>
      </div>
      <div class="field">
        <label>资源</label>
        <div class="value">${s.assetCount ?? 0}</div>
      </div>
    </div>`,
    host,
  );
  appState.mainEl.replaceChildren(host);
}

function skillGroup(skills: SkillItem[]): TemplateResult {
  const activeVariants = skills.filter((skill) => !isArchivedSkill(skill)).length;
  const hasScopeVariants = activeVariants > 1;
  return html`<section class="skill-group" aria-label=${`/${skills[0]?.name ?? "skill"}`}>
    ${skills.map((skill) => skillVariant(skill, hasScopeVariants))}
  </section>`;
}

function editorPane() {
  const e = editing;
  if (!e) {
    return html`<section class="skill-form-page">
      ${listBackLink("返回技能列表", closeFocusedFlow)}
      <div class="skill-form-heading">
        <div>
          <h1 class="pane-title">编辑 <bdi>/${editingTarget?.name ?? "skill"}</bdi></h1>
          <p>${editError ? "说明不可用。" : "正在加载说明…"}</p>
        </div>
      </div>
      ${editError ? html`<div class="form-error" role="alert">${editError}</div>` : nothing}
    </section>`;
  }
  const reviewed = reviewMatches(e.review, e.description, e.body);
  let saveLabel = "保存";
  if (saving) saveLabel = "正在保存…";
  else if (reviewed) saveLabel = "发布修改";
  return html`
    <form
      class="skill-form-page"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        void saveEdit();
      }}
    >
      ${listBackLink("返回技能列表", closeFocusedFlow)}
      <div class="skill-form-heading">
        <div>
          <h1 class="pane-title">编辑 <bdi>/${e.name}</bdi></h1>
          <p>可用范围：${editAudience(e.scopeId)}</p>
        </div>
        <span class="badge">编辑中</span>
      </div>
      <label class="skill-field">
        <span>描述</span>
        <input
          id="skill-edit-description"
          class="skill-desc-input"
          type="text"
          .value=${e.description}
          data-focus-key="skill-edit-description"
          ?disabled=${saving}
          @input=${(ev: Event) => {
            e.description = (ev.target as HTMLInputElement).value;
            drawSkills();
          }}
        />
      </label>
      <label class="skill-field">
        <span>使用说明</span>
        <textarea
          class="skill-body-input"
          spellcheck="false"
          data-focus-key="skill-edit-body"
          ?disabled=${saving}
          @input=${(ev: Event) => {
            e.body = (ev.target as HTMLTextAreaElement).value;
            drawSkills();
          }}
          .value=${e.body}
        ></textarea>
      </label>
      ${editError ? html`<div class="card-meta skill-shadowed">${editError}</div>` : nothing}
      ${
        reviewed
          ? html`<div class="skill-impact" role="alert">
              <strong>将此修改发布到 <bdi>${scopeTitle(e.scopeId ?? null)}</bdi>?</strong>
              <div class="card-meta">
                当前项目的所有成员都可使用更新后的技能。描述${e.description === e.originalDescription ? "未修改" : "已修改"}；说明${e.body === e.originalBody ? "未修改" : "已修改"}。
              </div>
            </div>`
          : nothing
      }
      <div class="actions skill-form-actions">
        <button
          class="btn primary"
          type="submit"
          ?disabled=${saving}
          @click=${(event: MouseEvent) => {
            if (shouldBlockRepeatedPublishClick(reviewed, event.detail)) event.preventDefault();
          }}
        >
          ${saveLabel}
        </button>
        ${
          reviewed
            ? html`<button
                class="btn"
                type="button"
                ?disabled=${saving}
                @click=${() => {
                  e.review = null;
                  drawSkills();
                }}
              >
                重新审核
              </button>`
            : nothing
        }
        <button class="btn" type="button" ?disabled=${saving} @click=${closeFocusedFlow}>取消</button>
      </div>
    </form>
  `;
}

function creatorPane() {
  const c = creating!;
  const ready = c.name.trim() !== "" && c.description.trim() !== "" && c.body.trim() !== "";
  const reviewed = createReviewMatches(c.review, c.name.trim(), c.description.trim(), c.body.trim(), c.scopeId);
  let createLabel = "创建技能";
  if (creatingSaving) createLabel = "正在保存…";
  else if (reviewed) createLabel = "发布技能";
  return html`
    <form
      class="skill-form-page"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        void saveCreate();
      }}
    >
      ${listBackLink("返回技能列表", closeFocusedFlow)}
      <div class="skill-form-heading">
        <div>
          <h1 class="pane-title">新建技能</h1>
          <p>为自己或共享项目创建可复用的操作流程。</p>
        </div>
        <span class="badge">新建</span>
      </div>
      <label class="skill-field">
        <span>名称</span>
        <input
          id="skill-create-name"
          class="skill-desc-input"
          type="text"
          placeholder="watch-pipeline"
          data-focus-key="skill-create-name"
          .value=${c.name}
          ?disabled=${creatingSaving}
          @input=${(ev: Event) => {
            c.name = (ev.target as HTMLInputElement).value;
            drawSkills();
          }}
        />
      </label>
      <label class="skill-field">
        <span>可用范围</span>
        ${fieldSelect({
          className: "skill-scope-select",
          value: c.scopeId,
          disabled: creatingSaving,
          onChange: (value) => {
            c.scopeId = value;
            c.review = null;
            drawSkills();
          },
          options: createScopes.map((scope) => html`<option value=${scope.scopeId}>${scope.name}</option>`),
        })}
        <small class="card-meta">共享项目的所有成员都可使用和编辑此技能。</small>
      </label>
      <label class="skill-field">
        <span>描述</span>
        <input
          class="skill-desc-input"
          type="text"
          placeholder="用一句话说明功能及使用场景"
          data-focus-key="skill-create-description"
          .value=${c.description}
          ?disabled=${creatingSaving}
          @input=${(ev: Event) => {
            c.description = (ev.target as HTMLInputElement).value;
            drawSkills();
          }}
        />
      </label>
      <label class="skill-field">
        <span>使用说明</span>
        <textarea
          class="skill-body-input"
          spellcheck="false"
          placeholder="SKILL.md 内容：使用此技能时应遵循的步骤。"
          data-focus-key="skill-create-body"
          ?disabled=${creatingSaving}
          @input=${(ev: Event) => {
            c.body = (ev.target as HTMLTextAreaElement).value;
            drawSkills();
          }}
          .value=${c.body}
        ></textarea>
      </label>
      ${createError ? html`<div class="card-meta skill-shadowed">${createError}</div>` : nothing}
      ${
        reviewed
          ? html`<div class="skill-impact" role="alert">
              <strong>发布 <bdi>/${c.name.trim()}</bdi> 到 <bdi>${scopeTitle(c.scopeId)}</bdi>?</strong>
              <div class="card-meta">当前项目的所有成员都可使用和编辑这些说明。</div>
            </div>`
          : nothing
      }
      <div class="actions skill-form-actions">
        <button
          class="btn primary"
          type="submit"
          ?disabled=${creatingSaving || !ready}
          @click=${(event: MouseEvent) => {
            if (shouldBlockRepeatedPublishClick(reviewed, event.detail)) event.preventDefault();
          }}
        >
          ${createLabel}
        </button>
        ${
          reviewed
            ? html`<button
                class="btn"
                type="button"
                ?disabled=${creatingSaving}
                @click=${() => {
                  c.review = null;
                  drawSkills();
                }}
              >
                重新审核
              </button>`
            : nothing
        }
        <button class="btn" type="button" ?disabled=${creatingSaving} @click=${closeFocusedFlow}>取消</button>
      </div>
    </form>
  `;
}

function drawSkills(loading = false): void {
  if (appState.currentView !== "skills" || !appState.mainEl) return;
  activeSkillId = null;
  syncSkillUrl(null);
  if (!skillsPageHost || skillsPageHost.parentElement !== appState.mainEl) {
    skillsPageHost = document.createElement("div");
    skillsPageHost.className = "pane skills-page";
    appState.mainEl.replaceChildren(skillsPageHost);
  }
  if (creating || editingTarget) {
    render(creating ? creatorPane() : editorPane(), skillsPageHost);
    return;
  }
  const filters = { query: skillSearch, scope: scopeFilter, source: sourceFilter, status: statusFilter };
  const scopedScope = scopedSession.active?.scopeId ?? null;
  skillsPageHost.classList.toggle("scoped-view", Boolean(scopedScope));
  let groups = filterSkillGroups(groupSkills(skillRows), filters);
  if (scopedScope)
    groups = groups
      .map((group) => ({
        ...group,
        skills: group.skills.filter((skill) => skill.scopeId === scopedScope),
      }))
      .filter((group) => group.skills.length > 0);
  const filtered = groups.flatMap((group) => group.skills);
  const counts = statusCounts(skillRows);
  const rows: TemplateResult[] = groups.map((group) => skillGroup(group.skills));
  const clearFilters = () => {
    skillSearch = "";
    scopeFilter = "all";
    sourceFilter = "all";
    statusFilter = "all";
    drawSkills();
  };
  const emptyState = skillEmptyState(skillRows.length, filtered.length, loading);
  let empty: string | TemplateResult = scopedScope ? "当前项目中没有技能。" : "暂无可用技能。";
  if (emptyState === "filtered") {
    empty = html`<div class="skill-empty">
      <span>没有符合筛选条件的技能。</span><button class="btn" type="button" @click=${clearFilters}>清除筛选</button>
    </div>`;
  } else if (emptyState === "loading") {
    empty = "正在加载技能…";
  }
  render(
    html`${scopedViewTopbar("skills", () => drawSkills())}${listPageTpl({
      title: "技能",
      action: { label: "新建技能", onClick: startCreate },
      search: {
        value: skillSearch,
        placeholder: "搜索技能…",
        onInput: (value) => {
          skillSearch = value;
          drawSkills();
        },
      },
      filters: html`<div class="skill-registry-controls">
          <div class="resource-tabs" role="group" aria-label="按技能状态筛选">
            ${(
              [
                ["active", "进行中", counts.active],
                ["archived", "已归档", counts.archived],
                ["all", "全部", counts.all],
              ] as const
            ).map(
              ([value, label, count]) =>
                html`<button
                  type="button"
                  aria-pressed=${statusFilter === value}
                  class=${statusFilter === value ? "active" : ""}
                  @click=${() => {
                    statusFilter = value;
                    drawSkills();
                  }}
                >
                  ${label}<span>${count}</span>
                </button>`,
            )}
          </div>
          <div class="skill-filter-fields">
            <label class="list-select"
              ><span>作用域</span>${fieldSelect({
                compact: true,
                ariaLabel: "按技能作用域筛选",
                value: scopeFilter,
                onChange: (value) => {
                  scopeFilter = value;
                  drawSkills();
                },
                options: [
                  html`<option value="all">所有作用域</option>`,
                  html`<option value="personal">个人</option>`,
                  html`<option value="channel">频道</option>`,
                  html`<option value="group">项目 / 群组</option>`,
                  html`<option value="team">团队</option>`,
                  html`<option value="org">组织</option>`,
                ],
              })}</label
            >
            <label class="list-select"
              ><span>来源</span>${fieldSelect({
                compact: true,
                ariaLabel: "按技能来源筛选",
                value: sourceFilter,
                onChange: (value) => {
                  sourceFilter = value;
                  drawSkills();
                },
                options: [
                  html`<option value="all">所有来源</option>`,
                  html`<option value="native">本地</option>`,
                  html`<option value="pack">技能包</option>`,
                  html`<option value="overrides">覆盖版本</option>`,
                ],
              })}</label
            >
          </div>
        </div>
        <div class="skill-result-count" aria-live="polite">
          ${loading ? "加载中…" : `${filtered.length} 个技能，位于 ${groups.length} 个分组`}
        </div>
        ${skillsNotice ? html`<div class="status">${skillsNotice}</div>` : nothing}`,
      rows,
      empty,
    })}${archiveConfirmation ? archiveDialog(archiveConfirmation) : nothing}`,
    skillsPageHost,
  );
}

function setSkillsBackgroundInert(inert: boolean): void {
  skillsPageHost?.querySelectorAll<HTMLElement>(":scope > :not(.project-dialog-backdrop)").forEach((element) => {
    element.inert = inert;
  });
}

function closeArchiveDialog(): void {
  if (deleting) return;
  const target = archiveFocusTarget;
  archiveConfirmation = null;
  archiveFocusTarget = null;
  drawSkills();
  setSkillsBackgroundInert(false);
  queueMicrotask(() => {
    if (archiveConfirmation || appState.currentView !== "skills") return;
    const fallback = target?.dataset.skillId
      ? [...document.querySelectorAll<HTMLElement>(".skill-archive-trigger")].find(
          (element) => element.dataset.skillId === target.dataset.skillId,
        )
      : null;
    restoreDialogFocus(target, () => fallback);
  });
}

function archiveDialog(skill: SkillItem): TemplateResult {
  const audience =
    skill.scope === "personal"
      ? "you"
      : `${skill.scopeId ? scopeTitle(skill.scopeId) : `此${skill.scope}`} 中的所有成员`;
  return html`<div
    class="project-dialog-backdrop"
    @click=${(event: MouseEvent) => event.target === event.currentTarget && closeArchiveDialog()}
  >
    <div
      class="project-dialog skill-archive-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="skill-archive-title"
      aria-describedby="skill-archive-impact"
      @keydown=${(event: KeyboardEvent) => trapDialogFocus(event, closeArchiveDialog)}
    >
      <div class="project-dialog-head">
        <div>
          <h2 id="skill-archive-title">归档 <bdi>/${skill.name}</bdi>?</h2>
        </div>
      </div>
      <p id="skill-archive-impact">
        此版本将不再对${audience}可用。如果它覆盖了更大范围的
        <bdi>/${skill.name}</bdi>，则该版本将生效。历史记录和资源会保留，你可以稍后恢复。
      </p>
      <div class="project-dialog-actions actions">
        <button
          class="btn"
          type="button"
          data-dialog-cancel
          ?disabled=${deleting === skill.id}
          @click=${closeArchiveDialog}
        >
          取消</button
        ><button
          class="btn danger skill-archive-confirm"
          type="button"
          ?disabled=${deleting === skill.id}
          @click=${() => void performArchive(skill)}
        >
          ${deleting === skill.id ? "正在归档…" : "归档技能"}
        </button>
      </div>
    </div>
  </div>`;
}

async function saveEdit(): Promise<void> {
  if (!editing || saving) return;
  if (isSharedSkillScope(editing.scopeId) && !reviewMatches(editing.review, editing.description, editing.body)) {
    editing.review = { description: editing.description, body: editing.body };
    return drawSkills();
  }
  const operation = skillMutations.begin();
  saving = true;
  editError = "";
  drawSkills();
  try {
    await api(`/api/skills/${encodeURIComponent(editing.id)}`, {
      method: "PUT",
      body: JSON.stringify({ description: editing.description, body: editing.body }),
    });
    if (!skillMutations.isCurrent(operation)) {
      await renderSkills();
      return;
    }
    const returnTarget = flowFocusTarget;
    flowFocusTarget = null;
    editing = null;
    editingTarget = null;
    saving = false;
    await renderSkills();
    if (!skillMutations.isCurrent(operation)) return;
    restoreFocusedFlow(returnTarget);
  } catch (e) {
    if (!skillMutations.isCurrent(operation)) return;
    editError = errMessage(e, "保存技能失败。");
    saving = false;
    drawSkills();
  }
}

async function saveCreate(): Promise<void> {
  if (!creating || creatingSaving) return;
  const name = creating.name.trim();
  const description = creating.description.trim();
  const body = creating.body.trim();
  if (!name || !description || !body) {
    createError = "名称、描述和说明均为必填项。";
    drawSkills();
    return;
  }
  if (
    isSharedSkillScope(creating.scopeId) &&
    !createReviewMatches(creating.review, name, description, body, creating.scopeId)
  ) {
    creating.review = { name, description, body, scopeId: creating.scopeId };
    return drawSkills();
  }
  const operation = skillMutations.begin();
  creatingSaving = true;
  createError = "";
  drawSkills();
  try {
    await api("/api/skills", {
      method: "POST",
      body: JSON.stringify({ name, description, body, scopeId: creating.scopeId }),
    });
    if (!skillMutations.isCurrent(operation)) {
      await renderSkills();
      return;
    }
    const returnTarget = flowFocusTarget;
    flowFocusTarget = null;
    creating = null;
    creatingSaving = false;
    await renderSkills();
    if (!skillMutations.isCurrent(operation)) return;
    restoreFocusedFlow(returnTarget);
  } catch (e) {
    if (!skillMutations.isCurrent(operation)) return;
    createError = errMessage(e, "创建技能失败。");
    creatingSaving = false;
    drawSkills();
  }
}

async function deleteSkill(s: SkillItem, trigger?: HTMLElement): Promise<void> {
  if (!s.id || deleting) return;
  if (s.status === "archived") {
    deleting = s.id;
    try {
      await api(`/api/skills/${encodeURIComponent(s.id)}/restore`, { method: "POST", body: "{}" });
      deleting = null;
      return void renderSkills();
    } catch (e) {
      deleting = null;
      skillsNotice = errMessage(e, "恢复技能失败。");
      return drawSkills();
    }
  }
  archiveFocusTarget = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  archiveConfirmation = s;
  drawSkills();
  setSkillsBackgroundInert(true);
  queueMicrotask(() => {
    if (archiveConfirmation?.id !== s.id || appState.currentView !== "skills") return;
    if (skillsPageHost) focusDialogCancel(skillsPageHost);
  });
}

async function performArchive(s: SkillItem): Promise<void> {
  if (!s.id || deleting) return;
  const focusTarget = archiveFocusTarget;
  archiveConfirmation = null;
  archiveFocusTarget = null;
  deleting = s.id;
  skillsNotice = "";
  drawSkills();
  setSkillsBackgroundInert(false);
  queueMicrotask(() => {
    const target =
      skillsPageHost?.querySelector<HTMLElement>(".list-search input") ??
      skillsPageHost?.querySelector<HTMLElement>(".list-page-action");
    target?.focus();
  });
  try {
    await api(`/api/skills/${encodeURIComponent(s.id)}`, { method: "DELETE" });
    deleting = null;
    await renderSkills();
  } catch (e) {
    deleting = null;
    skillsNotice = errMessage(e, "归档技能失败。");
    drawSkills();
    requestAnimationFrame(() => {
      const fallback = focusTarget?.dataset.skillId
        ? [...(skillsPageHost?.querySelectorAll<HTMLElement>(".skill-archive-trigger") ?? [])].find(
            (element) => element.dataset.skillId === focusTarget.dataset.skillId,
          )
        : null;
      restoreDialogFocus(
        focusTarget,
        () => fallback ?? skillsPageHost?.querySelector<HTMLElement>(".list-search input") ?? null,
      );
    });
  }
}

export async function renderSkills(): Promise<void> {
  if (appState.currentView !== "skills") return;
  if (!skillsPageHost || skillsPageHost.parentElement !== appState.mainEl) {
    archiveConfirmation = null;
    archiveFocusTarget = null;
    setSkillsBackgroundInert(false);
  }
  const seq = appState.viewRenderSeq;
  const request = skillsRefreshes.begin();
  const wanted = pendingSkillId;
  pendingSkillId = null;
  skillsNotice = "";
  drawSkills(true);
  try {
    const [r, contexts] = await Promise.all([
      api<{ skills: SkillItem[] }>("/api/skills?includeShadowed=1"),
      api<{ contexts?: CoreContext[] }>("/api/contexts").catch(() => ({ contexts: [] })),
    ]);
    if (!skillsRefreshes.isCurrent(request) || seq !== appState.viewRenderSeq || appState.currentView !== "skills")
      return;
    skillRows = (r.skills ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
    const personal = appState.me ? `personal:${appState.me.user}` : "";
    createScopes = [
      { scopeId: personal, name: "个人（仅自己）" },
      ...(contexts.contexts ?? [])
        .filter(
          (context) =>
            context.scopeId !== personal &&
            (context.kind === "group" || (context.kind === "channel" && context.isPrivate)),
        )
        .map((context) => ({ scopeId: context.scopeId, name: context.name || context.scopeId })),
    ].filter((scope) => scope.scopeId);
  } catch (e) {
    if (!skillsRefreshes.isCurrent(request) || seq !== appState.viewRenderSeq || appState.currentView !== "skills")
      return;
    skillsNotice = errMessage(e, "加载技能失败。");
  }
  if (!skillsRefreshes.isCurrent(request)) return;
  const skill = wanted ? skillRows.find((candidate) => candidate.id === wanted) : undefined;
  if (wanted && !skill) skillsNotice = "找不到该技能，或你没有访问权限。";
  if (skill) openSkill(skill);
  else drawSkills(false);
}
