import { displayStatus } from "./display-labels";
import { openDeploymentPermissions } from "./deploy-permissions";
import { html, nothing, render, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { Archive, Check, Copy, ExternalLink, RotateCcw, X } from "lucide";
import { api, withBase } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { copyText, icon, relTime } from "./ui";
import { listBackLink, listPageTpl } from "./list-page";
import { contextsState, ensureContexts, scopeChip } from "./contexts";
import { scopedSession, scopedViewTopbar } from "./session-scope";
import { appState } from "./shell";
import { focusDialogCancel, restoreDialogFocus, trapDialogFocus } from "./dialog-focus";
import {
  withDeploymentDetailNotice,
  withDeploymentListNotice,
  withoutDeploymentDetailNotice,
  type DeploymentNotices,
} from "./deploy-notices";
import {
  deploymentAfterRestore,
  deploymentActionView,
  deploymentArchiveUndoAvailable,
  deploymentCanManage as canManage,
  deploymentContextScope,
  deploymentInScope,
  deploymentListRefreshCanRedraw,
  deploymentListAfterRestoreRefresh,
  deploymentLatestAt,
  deploymentSlug,
  deploymentTab,
  deploymentTabEmptyMessage,
  deploymentTitle,
  filterDeployments,
  friendlyPrincipal,
  type DeploymentTab,
  type DeploymentView,
} from "./deploy-view";
import { tip } from "./tooltip";
import { deepLinkPath, UI_BASE } from "./deep-link";

const DEPLOY_TABS: Array<{ value: DeploymentTab; label: string }> = [
  { value: "yours", label: "我的" },
  { value: "shared", label: "共享" },
  { value: "archived", label: "已归档" },
];

let deployList: DeploymentView[] = [];
let deployNotices: DeploymentNotices = { list: "", detail: null };
let deployLoading = false;
let deployScope: string | null = null;
let deployQuery = "";
let deployTab: DeploymentTab = "yours";
let deployPageHost: HTMLElement | null = null;
let activeDeploy: DeploymentView | null = null;
let visibleVersionCount = 10;
let editingDeploy: { id: string; field: "displayName" | "name" } | null = null;
let deployDraft = "";
let deploySaving = false;
let archiveCandidate: DeploymentView | null = null;
let restoreArchiveFocus = false;
let deployToast: { deployment: DeploymentView; text: string; undo?: boolean } | null = null;
let deployRefreshSeq = 0;

function statusLabel(d: DeploymentView): string {
  if (
    d.status === "running" &&
    d.appliedVersion !== undefined &&
    d.currentVersion !== undefined &&
    d.appliedVersion !== d.currentVersion
  )
    return "正在部署";
  const status = d.status || "unknown";
  return displayStatus(status);
}

function statusClass(d: DeploymentView): string {
  if (
    d.status === "running" &&
    d.appliedVersion !== undefined &&
    d.currentVersion !== undefined &&
    d.appliedVersion !== d.currentVersion
  )
    return "deploying";
  if (d.status === "running") return "running";
  if (d.status === "archived") return "archived";
  return "stopped";
}

function permissionBadge(d: DeploymentView): TemplateResult {
  const manage = canManage(d);
  const title = manage
    ? "你是此应用的所有者，或拥有管理权限。"
    : "此应用已共享到你可访问的项目。你可以打开或克隆，但不能修改。";
  return html`<span class="deploy-permission ${manage ? "manage" : "view"}" ${tip(title)}
    >${manage ? "可管理" : "可查看"}</span
  >`;
}

function ownerLabel(d: DeploymentView): string {
  const me = appState.me?.user;
  if (d.ownerScopeId === `personal:${me}`) return "归你所有";
  if (d.ownerScopeId?.startsWith("personal:"))
    return `所有者：${friendlyPrincipal(d.ownerScopeId.slice("personal:".length))}`;
  if (d.ownerScopeId?.startsWith("org:")) return "组织";
  return "共享项目";
}

function deployTabs(): TemplateResult {
  const inContext = deployList.filter((d) => deploymentInScope(d, deployScope));
  const viewer = appState.me?.user;
  const counts = Object.fromEntries(
    DEPLOY_TABS.map((tab) => [tab.value, inContext.filter((d) => deploymentTab(d, viewer) === tab.value).length]),
  ) as Record<DeploymentTab, number>;
  const tabs = DEPLOY_TABS.filter((tab) => tab.value === "yours" || counts[tab.value] > 0 || deployTab === tab.value);
  return html`
    <div class="cron-list-controls" role="tablist" aria-label="应用视图">
      ${tabs.map(
        (tab) => html`
          <button
            type="button"
            role="tab"
            aria-selected=${deployTab === tab.value}
            class="cron-filter-chip ${deployTab === tab.value ? "active" : ""}"
            @click=${() => {
              deployTab = tab.value;
              drawDeploysPage();
            }}
          >
            <span>${tab.label}</span><span class="cron-filter-count">${counts[tab.value]}</span>
          </button>
        `,
      )}
    </div>
  `;
}

function deploymentRow(d: DeploymentView): TemplateResult {
  const running = d.status === "running";
  const title = html`
    <span class="deploy-row-title">
      <span class="list-row-title" dir="auto">${deploymentTitle(d)}</span>
    </span>
  `;
  return html`
    <div class="list-row deploy-row ${d.status === "archived" ? "deploy-row-archived" : ""}">
      ${
        running && d.webUrl
          ? html`<a
              class="deploy-row-main"
              href=${withBase(d.webUrl)}
              target="_blank"
              rel="noreferrer"
              aria-label=${`打开 ${deploymentTitle(d)}`}
              >${title}</a
            >`
          : html`<span class="deploy-row-main">${title}</span>`
      }
      <div class="deploy-row-actions" aria-label="应用状态和操作">
        <span class="deploy-status ${statusClass(d)}"><span></span>${statusLabel(d)}</span>
        <button
          class="btn deploy-manage"
          type="button"
          aria-label=${`管理 ${deploymentTitle(d)}`}
          @click=${() => void openDeploy(d)}
        >
          管理
        </button>
      </div>
    </div>
  `;
}

function drawDeploysPage(): void {
  if (appState.currentView !== "deploys" || !appState.mainEl) return;
  activeDeploy = null;
  if (!deployPageHost || deployPageHost.parentElement !== appState.mainEl) {
    deployPageHost = document.createElement("div");
    deployPageHost.className = "pane deploys-page";
    appState.mainEl.replaceChildren(deployPageHost);
  }
  const viewer = appState.me?.user;
  const rows = filterDeployments(deployList, {
    tab: deployTab,
    scope: deployScope,
    query: deployQuery,
    viewer,
    sort: "newest",
  });
  const allForTab = deployList.filter(
    (d) => deploymentTab(d, viewer) === deployTab && deploymentInScope(d, deployScope),
  );
  let empty = deploymentTabEmptyMessage(deployTab);
  if (!deployList.length && deployNotices.list) empty = deployNotices.list;
  else if (deployLoading && deployList.length === 0) empty = "正在加载应用…";
  else if (deployQuery && allForTab.length) empty = "没有匹配的应用。";
  else if (deployScope) empty = "当前项目中没有应用。";
  const content = deployList.length
    ? [
        deployTabs(),
        ...(deployNotices.list
          ? [html`<div class="status deploy-list-notice" role="status" aria-live="polite">${deployNotices.list}</div>`]
          : []),
        ...(rows.length
          ? rows.map(deploymentRow)
          : [html`<div class="empty compact cron-filter-empty">${empty}</div>`]),
      ]
    : [];
  const scoped = Boolean(scopedSession.active);
  deployPageHost.classList.toggle("scoped-view", scoped);
  render(
    html`
      ${scopedViewTopbar("apps", drawDeploysPage)}
      ${listPageTpl({
        title: "应用",
        search: {
          value: deployQuery,
          placeholder: "搜索应用",
          onInput: (value) => {
            deployQuery = value;
            drawDeploysPage();
          },
        },
        rows: content,
        empty,
      })}
      ${archiveCandidate ? archiveDialog(archiveCandidate) : nothing} ${deployToast ? undoToast(deployToast) : nothing}
    `,
    deployPageHost,
  );
}

let pendingDeployId: string | null = null;

export function openDeployById(id: string): void {
  pendingDeployId = id;
}

async function openDeploy(d: DeploymentView): Promise<void> {
  visibleVersionCount = 10;
  editingDeploy = null;
  deployDraft = "";
  deployNotices = withoutDeploymentDetailNotice(deployNotices);
  activeDeploy = d;
  history.replaceState(null, "", deepLinkPath(UI_BASE, "deploys", null, null, d.id));
  drawDeployDetail(d, true);
  try {
    const response = await api<{ deployment?: DeploymentView }>(`/api/deployments/${encodeURIComponent(d.id)}`);
    if (appState.currentView !== "deploys" || activeDeploy?.id !== d.id) return;
    activeDeploy = response.deployment ?? d;
    drawDeployDetail(activeDeploy);
  } catch (error) {
    if (activeDeploy?.id !== d.id) return;
    deployNotices = withDeploymentDetailNotice(deployNotices, d.id, errMessage(error, "无法加载应用详情。"));
    drawDeployDetail(d);
  }
}

function drawDeployDetail(d: DeploymentView, loading = false): void {
  if (appState.currentView !== "deploys" || !appState.mainEl || activeDeploy?.id !== d.id) return;
  const host = appState.mainEl.querySelector<HTMLElement>(".deploy-detail-pane") ?? document.createElement("div");
  host.className = "resource-pane deploy-detail-pane";
  const versions = [...(d.versions ?? [])].sort((a, b) => b.version - a.version);
  const running = d.status === "running";
  const contextScope = deploymentContextScope(d);
  const editingName = editingDeploy?.id === d.id && editingDeploy.field === "displayName";
  const editingSlug = editingDeploy?.id === d.id && editingDeploy.field === "name";
  render(
    html`
      <div class="resource-detail deploy-detail">
        ${listBackLink("应用", returnToDeploysList)}
        <div class="resource-heading deploy-detail-heading">
          <div>
            <div class="deploy-heading-title">
              <h2 dir="auto">${deploymentTitle(d)}</h2>
              <span class="deploy-status ${statusClass(d)}"><span></span>${statusLabel(d)}</span>
            </div>
            <div class="deploy-detail-url">/d/${deploymentSlug(d)}/</div>
          </div>
          <div class="actions">
            ${running && d.webUrl ? html`<a class="btn primary" href=${withBase(d.webUrl)} target="_blank" rel="noreferrer">打开应用 ${icon(ExternalLink, 14)}</a>` : nothing}
            ${d.webUrl ? html`<button class="btn" type="button" @click=${(event: Event) => void copyText(new URL(withBase(d.webUrl!), window.location.href).href, event.currentTarget as HTMLButtonElement)}>${icon(Copy, 14)}<span>复制网址</span></button>` : nothing}
          </div>
        </div>
        ${loading ? html`<div class="hint">正在加载应用最新详情…</div>` : nothing}
        ${deployNotices.detail?.id === d.id ? html`<div class="status">${deployNotices.detail.text}</div>` : nothing}

        <div class="deploy-summary">
          <span>已上线 v${d.appliedVersion ?? d.currentVersion ?? "—"}</span>
          ${d.currentVersion !== undefined && d.appliedVersion !== undefined && d.currentVersion !== d.appliedVersion ? html`<span>最新 v${d.currentVersion}</span>` : nothing}
          ${deploymentLatestAt(d) ? html`<span ${tip(new Date(deploymentLatestAt(d)).toLocaleString("zh-CN"))}>更新于 ${relTime(deploymentLatestAt(d))}</span>` : nothing}
        </div>
        <div class="deploy-access-line">
          <div>
            <span>${ownerLabel(d)}</span>
            ${contextScope && contextScope !== d.ownerScopeId ? html`<span class="deploy-secondary-context">创建于 ${scopeChip(contextScope)}</span>` : nothing}
            ${d.createdBy && d.ownerScopeId !== `personal:${d.createdBy}` ? html`<span class="deploy-secondary-context">创建者：${friendlyPrincipal(d.createdBy)}</span>` : nothing}
          </div>
          ${d.ownerScopeId === `personal:${appState.me?.user}` ? html`<button class="btn" type="button" @click=${() => void openDeploymentPermissions(d.id, deploymentTitle(d), d.ownerScopeId!)}>权限</button>` : permissionBadge(d)}
        </div>

        ${
          canManage(d)
            ? html`<section class="deploy-detail-section">
                <h3>设置</h3>
                <div class="deploy-setting-row">
                  <div><strong>显示名称</strong><span>显示在应用栏和应用列表中。</span></div>
                  ${editingName ? deployEditForm(d, "displayName") : html`<div class="deploy-setting-value"><span dir="auto">${deploymentTitle(d)}</span><button class="btn" type="button" @click=${() => startEditDeploy(d, "displayName")}>编辑</button></div>`}
                </div>
                <div class="deploy-setting-row">
                  <div><strong>应用网址</strong><span>修改应用网址，原有链接不会自动跳转。</span></div>
                  ${editingSlug ? deployEditForm(d, "name") : html`<div class="deploy-setting-value"><code>/d/${deploymentSlug(d)}/</code><button class="btn" type="button" @click=${() => startEditDeploy(d, "name")}>修改</button></div>`}
                </div>
                <div class="actions deploy-danger-actions">
                  ${
                    d.status === "archived"
                      ? html`<button class="btn" type="button" @click=${() => void restoreDeploy(d)}>
                          ${icon(RotateCcw, 14)}<span>恢复部署</span>
                        </button>`
                      : html`<button
                          class="btn danger deploy-archive-trigger"
                          data-deployment-id=${d.id}
                          type="button"
                          @click=${() => requestArchive(d)}
                        >
                          ${icon(Archive, 14)}<span>归档部署</span>
                        </button>`
                  }
                </div>
              </section>`
            : nothing
        }

        <section class="deploy-detail-section">
          <h3>版本历史</h3>
          ${
            versions.length
              ? html`<div class="deploy-version-list">
                  ${versions.slice(0, visibleVersionCount).map(
                    (version) => html`
                      <div class="deploy-version-row">
                        <div>
                          <strong>v${version.version}</strong
                          >${version.version === d.appliedVersion ? html`<span class="badge ok">已上线</span>` : nothing}${version.version === d.currentVersion && version.version !== d.appliedVersion ? html`<span class="badge">最新</span>` : nothing}
                        </div>
                        <div>
                          <span>${new Date(version.createdAt).toLocaleString("zh-CN")}</span>
                        </div>
                      </div>
                    `,
                  )}
                </div>`
              : html`<div class="empty compact">暂无版本历史。</div>`
          }
          ${
            versions.length > visibleVersionCount
              ? html`<button
                  class="btn"
                  type="button"
                  @click=${() => {
                    visibleVersionCount += 10;
                    drawDeployDetail(d);
                  }}
                >
                  显示更早版本
                </button>`
              : nothing
          }
        </section>
      </div>
      ${archiveCandidate ? archiveDialog(archiveCandidate) : nothing} ${deployToast ? undoToast(deployToast) : nothing}
    `,
    host,
  );
  if (host.parentElement !== appState.mainEl) appState.mainEl.replaceChildren(host);
}

function returnToDeploysList(): void {
  editingDeploy = null;
  deployDraft = "";
  deployNotices = withoutDeploymentDetailNotice(deployNotices);
  activeDeploy = null;
  history.replaceState(null, "", deepLinkPath(UI_BASE, "deploys", null));
  drawDeploysPage();
}

function deployEditForm(d: DeploymentView, field: "displayName" | "name"): TemplateResult {
  const slug = field === "name";
  return html`
    <form
      class="deploy-edit-form"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        void commitEditDeploy(d);
      }}
    >
      <label>
        <span class="deploy-slug-input ${slug ? "" : "name"}"
          >${slug ? html`<span>/d/</span>` : nothing}<input
            class="deploy-edit-input"
            aria-label=${slug ? "网址标识" : "显示名称"}
            ?disabled=${deploySaving}
            .value=${live(deployDraft)}
            @input=${(event: InputEvent) => {
              deployDraft = (event.currentTarget as HTMLInputElement).value;
            }}
            @keydown=${(event: KeyboardEvent) => event.key === "Escape" && cancelEditDeploy()}
          />${slug ? html`<span>/</span>` : nothing}</span
        >
      </label>
      <button class="icon-btn" type="submit" aria-label="保存" ${tip("保存")} ?disabled=${deploySaving}>
        ${icon(Check, 14)}
      </button>
      <button
        class="icon-btn"
        type="button"
        ${tip("取消")}
        aria-label="取消"
        ?disabled=${deploySaving}
        @click=${cancelEditDeploy}
      >
        ${icon(X, 14)}
      </button>
    </form>
  `;
}

function startEditDeploy(d: DeploymentView, field: "displayName" | "name"): void {
  editingDeploy = { id: d.id, field };
  deployDraft = field === "displayName" ? (d.displayName ?? "") : (d.name ?? "");
  deployNotices = withoutDeploymentDetailNotice(deployNotices);
  drawDeployDetail(d);
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLInputElement>(".deploy-edit-input");
    input?.focus();
    input?.select();
  });
}

function cancelEditDeploy(): void {
  editingDeploy = null;
  deployDraft = "";
  if (activeDeploy) drawDeployDetail(activeDeploy);
  else drawDeploysPage();
}

async function commitEditDeploy(d: DeploymentView): Promise<void> {
  if (!editingDeploy || deploySaving) return;
  const field = editingDeploy.field;
  const value = deployDraft.trim();
  const current = field === "displayName" ? (d.displayName ?? "") : (d.name ?? "");
  if (value === current) return cancelEditDeploy();
  if (field === "name" && !value) {
    deployNotices = withDeploymentDetailNotice(deployNotices, d.id, "请填写网址标识。");
    return drawDeployDetail(d);
  }
  deploySaving = true;
  drawDeployDetail(d);
  try {
    const endpoint = field === "displayName" ? "display-name" : "name";
    const payload = field === "displayName" ? { displayName: value } : { name: value };
    await api(`/api/deployments/${encodeURIComponent(d.id)}/${endpoint}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    editingDeploy = null;
    deployDraft = "";
    deploySaving = false;
    await refreshDeployments();
    const updated = deployList.find((item) => item.id === d.id) ?? d;
    if (currentDeployActionView(d.id) === "target") {
      await openDeploy(updated);
    } else {
      deployToast = { deployment: updated, text: `${deploymentTitle(updated)} 设置已保存。` };
      drawCurrentDeployView();
    }
  } catch (error) {
    deploySaving = false;
    const message = errMessage(error, "无法保存应用设置。");
    if (currentDeployActionView(d.id) === "target") {
      deployNotices = withDeploymentDetailNotice(deployNotices, d.id, message);
      drawDeployDetail(activeDeploy!);
    } else {
      deployNotices = withDeploymentListNotice(deployNotices, "");
      deployToast = { deployment: d, text: message };
      drawCurrentDeployView();
    }
  }
}

function requestArchive(d: DeploymentView): void {
  restoreArchiveFocus = true;
  archiveCandidate = d;
  drawCurrentDeployView();
  setDeployBackgroundInert(true);
  requestAnimationFrame(() => {
    if (appState.currentView !== "deploys" || archiveCandidate?.id !== d.id) return;
    focusDialogCancel(document);
  });
}

function closeArchiveDialog(): void {
  const restoreFocus = restoreArchiveFocus;
  setDeployBackgroundInert(false);
  archiveCandidate = null;
  restoreArchiveFocus = false;
  drawCurrentDeployView();
  requestAnimationFrame(() => {
    if (!restoreFocus || appState.currentView !== "deploys" || archiveCandidate) return;
    restoreDialogFocus(null, () => document.querySelector<HTMLElement>(".deploy-archive-trigger"));
  });
}

function setDeployBackgroundInert(inert: boolean): void {
  if (inert && appState.currentView !== "deploys") return;
  const roots = new Set<HTMLElement>();
  if (deployPageHost) roots.add(deployPageHost);
  if (appState.currentView === "deploys" && appState.mainEl) roots.add(appState.mainEl);
  roots.forEach((root) =>
    root
      .querySelectorAll<HTMLElement>(".list-page-head, .list-search, .list-rows, .deploy-detail, .deploy-toast")
      .forEach((element) => {
        element.inert = inert;
      }),
  );
}

function drawCurrentDeployView(): void {
  if (appState.currentView !== "deploys") return;
  if (activeDeploy) drawDeployDetail(activeDeploy);
  else drawDeploysPage();
}

function currentDeployActionView(targetId: string): ReturnType<typeof deploymentActionView> {
  return deploymentActionView(targetId, appState.currentView, activeDeploy?.id);
}

function archiveDialog(d: DeploymentView): TemplateResult {
  return html`
    <div
      class="project-dialog-backdrop"
      @click=${(event: MouseEvent) => event.target === event.currentTarget && closeArchiveDialog()}
    >
      <div
        class="project-dialog deploy-archive-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="deploy-archive-title"
        @keydown=${(event: KeyboardEvent) => trapDialogFocus(event, closeArchiveDialog)}
      >
        <div class="project-dialog-head">
          <div>
            <h2 id="deploy-archive-title">归档 <bdi>${deploymentTitle(d)}</bdi>?</h2>
          </div>
        </div>
        <p>此操作将立即下线应用，当前网址将无法访问。源代码和版本历史会保留，你可以稍后恢复。</p>
        <div class="project-dialog-actions actions">
          <button class="btn" type="button" data-dialog-cancel @click=${closeArchiveDialog}>取消</button>
          <button
            class="btn danger deploy-archive-confirm"
            type="button"
            ?disabled=${deploySaving}
            @click=${() => void archiveDeploy(d)}
          >
            归档并下线
          </button>
        </div>
      </div>
    </div>
  `;
}

async function archiveDeploy(d: DeploymentView): Promise<void> {
  if (deploySaving) return;
  deploySaving = true;
  if (activeDeploy?.id === d.id) deployNotices = withDeploymentDetailNotice(deployNotices, d.id, "正在归档部署…");
  else deployNotices = withDeploymentListNotice(deployNotices, "正在归档部署…");
  setDeployBackgroundInert(false);
  archiveCandidate = null;
  drawCurrentDeployView();
  try {
    await api(`/api/deployments/${encodeURIComponent(d.id)}/archive`, { method: "POST" });
    deploySaving = false;
    deployToast = {
      deployment: { ...d, status: "archived" },
      text: `${deploymentTitle(d)} 已下线并归档。`,
      undo: true,
    };
    await refreshDeployments();
    const destination = currentDeployActionView(d.id);
    if (destination === "target" || destination === "list") {
      activeDeploy = null;
      deployTab = "yours";
      drawDeploysPage();
    } else {
      drawCurrentDeployView();
    }
  } catch (error) {
    deploySaving = false;
    const message = errMessage(error, "无法归档部署。");
    if (currentDeployActionView(d.id) === "target") {
      deployNotices = withDeploymentDetailNotice(deployNotices, d.id, message);
      drawDeployDetail(activeDeploy!);
    } else {
      deployNotices = withDeploymentListNotice(deployNotices, "");
      deployToast = { deployment: d, text: message };
      drawCurrentDeployView();
    }
  }
}

async function restoreDeploy(d: DeploymentView): Promise<void> {
  if (deploySaving) return;
  const restoringActive = activeDeploy?.id === d.id;
  deploySaving = true;
  if (restoringActive) deployNotices = withDeploymentDetailNotice(deployNotices, d.id, "正在恢复部署…");
  else if (!activeDeploy) deployNotices = withDeploymentListNotice(deployNotices, "正在恢复部署…");
  if (restoringActive || !activeDeploy) drawCurrentDeployView();
  try {
    const response = await api<{ deployment?: DeploymentView }>(
      `/api/deployments/${encodeURIComponent(d.id)}/restore`,
      { method: "POST" },
    );
    deploySaving = false;
    const restoredResponse = deploymentAfterRestore(d, response.deployment);
    deployToast = { deployment: restoredResponse, text: `${deploymentTitle(d)} 已恢复运行。` };
    const refreshResult = await refreshDeployments();
    const authoritative = refreshResult === "failed" ? undefined : deployList.find((item) => item.id === d.id);
    const restored = deploymentAfterRestore(d, response.deployment, authoritative);
    deployList = deploymentListAfterRestoreRefresh(deployList, restored, refreshResult);
    const destination = currentDeployActionView(d.id);
    if (destination === "target") {
      deployTab = deploymentTab(restored, appState.me?.user);
      activeDeploy = restored;
      await openDeploy(restored);
    } else if (destination === "list") {
      deployTab = deploymentTab(restored, appState.me?.user);
      activeDeploy = null;
      drawDeploysPage();
    } else {
      drawCurrentDeployView();
    }
  } catch (error) {
    deploySaving = false;
    const message = errMessage(error, "无法恢复部署。");
    if (currentDeployActionView(d.id) === "target") {
      deployNotices = withDeploymentDetailNotice(deployNotices, d.id, message);
      drawDeployDetail(activeDeploy!);
    } else {
      deployNotices = withDeploymentListNotice(deployNotices, "");
      deployToast = { deployment: d, text: message };
      drawCurrentDeployView();
    }
  }
}

function undoToast(toast: { deployment: DeploymentView; text: string; undo?: boolean }): TemplateResult {
  const archived = toast.undo && deploymentArchiveUndoAvailable(toast.deployment);
  return html`<div class="deploy-toast" role="status">
    <span>${toast.text}</span
    >${archived ? html`<button type="button" ?disabled=${deploySaving} @click=${() => void restoreDeploy(toast.deployment)}>撤销</button>` : nothing}<button
      class="icon-btn"
      type="button"
      ${tip("关闭")}
      aria-label="关闭通知"
      @click=${() => {
        deployToast = null;
        drawCurrentDeployView();
      }}
    >
      ${icon(X, 14)}
    </button>
  </div>`;
}

async function refreshDeployments(): Promise<"updated" | "failed" | "superseded"> {
  const seq = ++deployRefreshSeq;
  try {
    const response = await api<{ deployments?: DeploymentView[] }>("/api/deployments");
    if (seq !== deployRefreshSeq) return "superseded";
    deployList = response.deployments ?? [];
    deployNotices = withDeploymentListNotice(deployNotices, "");
    return "updated";
  } catch (error) {
    if (seq !== deployRefreshSeq) return "superseded";
    deployNotices = withDeploymentListNotice(deployNotices, errMessage(error, "加载应用失败。"));
    return "failed";
  } finally {
    if (seq === deployRefreshSeq) deployLoading = false;
  }
}

export async function renderDeploys(): Promise<void> {
  if (appState.currentView !== "deploys") return;
  const requestedId = pendingDeployId;
  pendingDeployId = null;
  archiveCandidate = null;
  restoreArchiveFocus = false;
  setDeployBackgroundInert(false);
  if (scopedSession.active) {
    deployScope = scopedSession.active.scopeId;
    contextsState.selected = null;
  } else if (contextsState.selected) {
    deployScope = contextsState.selected;
    contextsState.selected = null;
  } else {
    deployScope = null;
  }
  const seq = appState.viewRenderSeq;
  await ensureContexts();
  deployLoading = deployList.length === 0;
  deployNotices = withDeploymentListNotice(deployNotices, "");
  drawDeploysPage();
  await refreshDeployments();
  if (seq !== appState.viewRenderSeq || appState.currentView !== "deploys") return;
  if (requestedId) {
    await openDeploy(deployList.find((d) => d.id === requestedId) ?? { id: requestedId });
  } else if (deploymentListRefreshCanRedraw(activeDeploy?.id)) drawDeploysPage();
}
