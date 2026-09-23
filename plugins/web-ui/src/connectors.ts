import { html, render, type TemplateResult } from "lit";
import { KeyRound, Link } from "lucide";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { icon } from "./ui";
import { connectorLogo } from "./connector-logo";
import { appState, replacePanePreservingFocus } from "./shell";
import { scopedSession, scopedViewTopbar } from "./session-scope";
import { focusDialogCancel, restoreDialogFocus, trapDialogFocus } from "./dialog-focus";
import { isActiveGrant, isExpiredCredential, KeychainOperations } from "./keychain-state";
import { listPageTpl } from "./list-page";

interface ConnectorProvider {
  connected?: boolean;
  needsReconnect?: boolean;
  refreshError?: string;
  available?: boolean;
  hosts?: Array<{ host?: string } | string>;
}

const CONNECTOR_LABELS: Record<string, { name: string; hosts: string }> = {
  google: {
    name: "Google Workspace",
    hosts: "Gmail、日历、云端硬盘、表格",
  },
  slack: {
    name: "Slack",
    hosts: "频道与消息",
  },
  notion: {
    name: "Notion",
    hosts: "页面与数据库",
  },
  linear: {
    name: "Linear",
    hosts: "议题与项目",
  },
  github: {
    name: "GitHub",
    hosts: "仓库、议题与 PR",
  },
  dropbox: {
    name: "Dropbox",
    hosts: "文件与文件夹",
  },
  x: {
    name: "X (Twitter)",
    hosts: "帖子与个人资料",
  },
};

interface KeychainCredential {
  id: string;
  service: string;
  kind?: string;
  envKey?: string;
  accountLabel?: string;
  host?: string;
  fingerprint?: string;
  expiresAt?: number;
  createdAt?: number;
}

interface KeychainConnectorCredential {
  credentialId: string;
  host: string;
  accountType?: string;
  expiresAt?: number;
  connected: boolean;
  needsReconnect?: boolean;
}

interface KeychainGrant {
  id: string;
  credentialId: string;
  audienceScopeId: string;
  mode: "once" | "standing";
  purpose: string;
  status: "active" | "revoked" | "used";
  expiresAt?: number;
}

interface KeychainAsk {
  id: string;
  credentialId: string;
  requesterId: string;
  requesterScopeId: string;
  purpose: string;
  requestedMode?: "once" | "standing";
  expiresAt: number;
}

let connectorProviders: Record<string, ConnectorProvider> = {};
let keychainCredentials: KeychainCredential[] = [];
let keychainConnectorCredentials: KeychainConnectorCredential[] = [];
let keychainGrants: KeychainGrant[] = [];
let keychainAsks: KeychainAsk[] = [];
let keychainScopeNames: Record<string, string> = {};
let connectorNotice = "";
let loadNotice = "";
let addingCredential: { service: string; envKey: string; purpose: string } | null = null;
let secureDropUrl: string | null = null;
let confirmation: { title: string; body: string; action: string; run: () => Promise<void> } | null = null;
let confirmationOpener: HTMLElement | null = null;
const keychainOperations = new KeychainOperations();

let connectorsLoading = false;
let keysLoading = false;
let connectorsEverLoaded = false;
let keysEverLoaded = false;

export function resetKeychainState(): void {
  keychainOperations.reset();
  connectorProviders = {};
  keychainCredentials = [];
  keychainConnectorCredentials = [];
  keychainGrants = [];
  keychainAsks = [];
  keychainScopeNames = {};
  connectorNotice = "";
  loadNotice = "";
  connectorsLoading = false;
  keysLoading = false;
  connectorsEverLoaded = false;
  keysEverLoaded = false;
  addingCredential = null;
  secureDropUrl = null;
  confirmation = null;
  confirmationOpener = null;
}

function fmtDate(ms?: number): string {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleDateString("zh-CN");
  } catch {
    return "";
  }
}

function accessModeLabel(mode?: "once" | "standing"): string {
  return mode === "standing" ? "长期" : "一次性";
}

function credentialCard(c: KeychainCredential): TemplateResult {
  const subtitle = [c.accountLabel, c.host, c.envKey].filter(Boolean).join(" · ");
  const expired = isExpiredCredential(c);
  const grants = keychainGrants.filter((grant) => grant.credentialId === c.id && isActiveGrant(grant, c));
  const asks = keychainAsks.filter((ask) => ask.credentialId === c.id);
  return html`
    <article class="kc-resource kc-credential">
      <div class="kc-resource-main">
        <div class="kc-resource-icon">${icon(KeyRound, 18)}</div>
        <div class="kc-resource-copy">
          <div class="kc-resource-title-row">
            <h3>${c.service}</h3>
            ${expired ? html`<span class="kc-state warning">已过期</span>` : ""}
          </div>
          ${subtitle ? html`<div class="kc-resource-meta">${subtitle}</div>` : ""}
        </div>
        <button
          class="kc-text-action danger"
          type="button"
          data-confirm-key=${`delete:${c.id}`}
          ?disabled=${keychainOperations.mutationInFlight}
          @click=${() => void deleteCredential(c)}
        >
          删除
        </button>
      </div>
      ${
        asks.length
          ? html`<div class="kc-access-block pending">
              ${asks.map(
                (ask) =>
                  html`<div class="kc-access-row">
                    <div>
                      <span class="kc-access-label">待处理</span>
                      <bdi><strong>${scopeName(ask.requesterScopeId)}</strong></bdi>
                      <span
                        >· ${accessModeLabel(ask.requestedMode)} · ${ask.purpose} · 到期时间
                        ${fmtDate(ask.expiresAt)}</span
                      >
                    </div>
                  </div>`,
              )}
            </div>`
          : ""
      }
      ${
        grants.length
          ? html`<div class="kc-access-block">
              ${grants.map(
                (grant) =>
                  html` <div class="kc-access-row">
                    <div>
                      <span class="kc-access-label">访问权限</span>
                      <bdi><strong>${scopeName(grant.audienceScopeId)}</strong></bdi>
                      <span
                        >· ${accessModeLabel(grant.mode)} ·
                        ${grant.purpose}${grant.expiresAt ? ` · 到期时间 ${fmtDate(grant.expiresAt)}` : ""}</span
                      >
                    </div>
                    <button
                      class="kc-text-action"
                      type="button"
                      data-confirm-key=${`revoke:${grant.id}`}
                      ?disabled=${keychainOperations.mutationInFlight}
                      @click=${() => void revokeGrant(grant)}
                    >
                      撤销
                    </button>
                  </div>`,
              )}
            </div>`
          : ""
      }
    </article>
  `;
}

// Raw Slack IDs (C0…, G0…) mean nothing to people — always prefer a resolved
// name, and fall back to a human description. The raw ID appears only as a
// parenthetical of last resort, to disambiguate when no name is available.
function scopeName(scope: string): string {
  const resolved = keychainScopeNames[scope];
  if (resolved) return resolved;
  const [kind, ...rest] = scope.split(":");
  const ref = rest.join(":");
  switch (kind) {
    case "personal":
      return ref || "个人私聊";
    case "channel":
      return ref ? `Slack 频道（${ref}）` : "一个 Slack 频道";
    case "group":
      return "群聊";
    case "team":
      return ref ? `团队（${ref}）` : "团队";
    case "org":
      return "整个组织";
    default:
      return scope;
  }
}

function addCredentialCard(): TemplateResult {
  const draft = addingCredential!;
  return html`<section class="kc-add-card" aria-labelledby="kc-add-title">
    <div class="kc-panel-head">
      <div>
        <h2 id="kc-add-title">添加凭据</h2>
        <p>接下来请在加密的一次性页面中粘贴密钥。</p>
      </div>
    </div>
    ${
      secureDropUrl
        ? html`
            <div class="kc-success" role="status">
              <strong>你的一次性页面已就绪</strong><span>请在新标签页中打开，并在那里粘贴密钥。</span>
            </div>
            <div class="kc-form-actions">
              <a class="btn primary" href=${secureDropUrl} target="_blank" rel="noopener noreferrer">打开一次性页面</a
              ><button
                class="btn"
                type="button"
                @click=${() => {
                  addingCredential = null;
                  secureDropUrl = null;
                  drawConnectors();
                }}
              >
                完成
              </button>
            </div>
          `
        : html`
            <div class="kc-form-grid">
              <label class="skill-field"
                ><span>服务</span
                ><input
                  class="skill-desc-input"
                  placeholder="Stripe"
                  autocomplete="off"
                  ?disabled=${keychainOperations.dropInFlight}
                  .value=${draft.service}
                  @input=${(e: Event) => {
                    draft.service = (e.target as HTMLInputElement).value;
                  }}
              /></label>
              <label class="skill-field"
                ><span>环境变量 <em>可选</em></span
                ><input
                  class="skill-desc-input"
                  placeholder="STRIPE_API_KEY"
                  autocapitalize="characters"
                  autocomplete="off"
                  ?disabled=${keychainOperations.dropInFlight}
                  .value=${draft.envKey}
                  @input=${(e: Event) => {
                    draft.envKey = (e.target as HTMLInputElement).value;
                  }}
              /></label>
              <label class="skill-field kc-purpose-field"
                ><span>用途</span
                ><input
                  class="skill-desc-input"
                  placeholder="允许智能体将此凭据用于什么？"
                  ?disabled=${keychainOperations.dropInFlight}
                  .value=${draft.purpose}
                  @input=${(e: Event) => {
                    draft.purpose = (e.target as HTMLInputElement).value;
                  }}
              /></label>
            </div>
            <div class="kc-form-actions">
              <button
                class="btn"
                type="button"
                ?disabled=${keychainOperations.dropInFlight}
                @click=${() => {
                  addingCredential = null;
                  secureDropUrl = null;
                  drawConnectors();
                }}
              >
                取消</button
              ><button
                class="btn primary"
                type="button"
                ?disabled=${keychainOperations.dropInFlight}
                @click=${() => void createDrop()}
              >
                ${keychainOperations.dropInFlight ? "准备中…" : "继续"}
              </button>
            </div>
          `
    }
  </section>`;
}

function confirmationCard(): TemplateResult {
  const pending = confirmation!;
  return html`<div
    class="kc-dialog-scrim"
    @click=${(event: MouseEvent) => event.target === event.currentTarget && closeConfirmation()}
  >
    <article
      class="kc-confirm"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="kc-confirm-title"
      aria-describedby="kc-confirm-body"
      @keydown=${(event: KeyboardEvent) => trapDialogFocus(event, closeConfirmation)}
    >
      <span class="kc-eyebrow danger">检查影响</span>
      <h2 id="kc-confirm-title">${pending.title}</h2>
      <p id="kc-confirm-body">${pending.body}</p>
      <div class="kc-form-actions">
        <button class="btn" type="button" data-dialog-cancel @click=${closeConfirmation}>取消</button
        ><button class="btn danger" type="button" @click=${() => void pending.run()}>${pending.action}</button>
      </div>
    </article>
  </div>`;
}

function closeConfirmation(): void {
  const opener = confirmationOpener;
  const key = opener?.dataset.confirmKey;
  confirmation = null;
  confirmationOpener = null;
  drawConnectors();
  restoreDialogFocus(opener, () =>
    key
      ? [...document.querySelectorAll<HTMLElement>("[data-confirm-key]")].find(
          (element) => element.dataset.confirmKey === key,
        )
      : null,
  );
}

export function clearConnectorNotice(): void {
  connectorNotice = "";
}

export function noteConnectorResult(provider: string, status: string): void {
  const name = CONNECTOR_LABELS[provider]?.name ?? provider;
  connectorNotice = status === "connected" ? `${name}：已连接。` : `${name}：连接失败。`;
}

function loadingPlaceholder(label: string): TemplateResult {
  return html`<div class="kc-loading"><span class="spinner"></span>${label}</div>`;
}

function drawConnectors(): void {
  if (appState.currentView !== "keychain") return;
  const accountsLoading = connectorsLoading && !connectorsEverLoaded;
  const keysLoadingFresh = keysLoading && !keysEverLoaded;
  const loading = accountsLoading || keysLoadingFresh;
  const entries = Object.entries(connectorProviders);
  const connectorCards = entries.map(([id, p]) => {
    const meta = CONNECTOR_LABELS[id] ?? { name: id, hosts: "" };
    const connected = Boolean(p.connected);
    const needsReconnect = Boolean(p.needsReconnect);
    const available = Boolean(p.available);
    const hosts = new Set(
      (p.hosts ?? [])
        .map((entry) => (typeof entry === "string" ? entry : entry.host))
        .filter((host): host is string => Boolean(host)),
    );
    const credentials = keychainConnectorCredentials.filter((credential) => hosts.has(credential.host));
    const credentialsById = new Map(
      credentials.map((credential) => [credential.credentialId, { id: credential.credentialId, kind: "connector" }]),
    );
    const grants = keychainGrants.filter((grant) => isActiveGrant(grant, credentialsById.get(grant.credentialId)));
    let connectionState: TemplateResult | string = html`<span class="kc-state neutral">未连接</span>`;
    if (needsReconnect) connectionState = html`<span class="kc-state warning">需要重新连接</span>`;
    else if (connected) connectionState = "";
    return html`
      <article class="kc-resource kc-account">
        <div class="kc-resource-main">
          ${connectorLogo(id)}
          <div class="kc-resource-copy">
            <div class="kc-resource-title-row">
              <h3>${meta.name}</h3>
              ${connectionState}
            </div>
            ${meta.hosts ? html`<div class="kc-resource-meta">${meta.hosts}</div>` : ""}
          </div>
          <div class="kc-resource-actions">
            ${available ? html`<button class="btn" type="button" @click=${() => void startConnector(id)}>${connected || needsReconnect ? "重新连接" : "连接账户"}</button>` : ""}
            ${connected || needsReconnect ? html`<button class="kc-text-action danger" type="button" data-confirm-key=${`disconnect:${id}`} ?disabled=${keychainOperations.mutationInFlight} @click=${() => void revokeConnector(id)}>断开连接</button>` : ""}
          </div>
        </div>
        ${needsReconnect && p.refreshError ? html`<div class="kc-inline-warning" role="status">刷新失败：${p.refreshError}</div>` : ""}
        ${
          grants.length
            ? html`<div class="kc-access-block">
                ${grants.map(
                  (grant) =>
                    html` <div class="kc-access-row">
                      <div>
                        <span class="kc-access-label">访问权限</span>
                        <bdi><strong>${scopeName(grant.audienceScopeId)}</strong></bdi>
                        <span
                          >· ${accessModeLabel(grant.mode)} ·
                          ${grant.purpose}${grant.expiresAt ? ` · 到期时间 ${fmtDate(grant.expiresAt)}` : ""}</span
                        >
                      </div>
                      <button
                        class="kc-text-action"
                        type="button"
                        data-confirm-key=${`revoke:${grant.id}`}
                        ?disabled=${keychainOperations.mutationInFlight}
                        @click=${() => void revokeGrant(grant)}
                      >
                        撤销
                      </button>
                    </div>`,
                )}
              </div>`
            : ""
        }
      </article>
    `;
  });
  let accountsContent: TemplateResult | TemplateResult[] = connectorCards;
  if (accountsLoading) accountsContent = loadingPlaceholder("正在加载账户…");
  else if (!connectorCards.length)
    accountsContent = html`<div class="kc-empty">
      ${icon(Link, 20)}
      <div><strong>暂无可用账户</strong><span>工作区尚未配置任何账户服务商。</span></div>
    </div>`;
  let credentialsContent: TemplateResult | TemplateResult[] = keychainCredentials.map(credentialCard);
  if (keysLoadingFresh) credentialsContent = loadingPlaceholder("正在加载凭据…");
  else if (!keychainCredentials.length)
    credentialsContent = html`<div class="kc-empty">
      ${icon(KeyRound, 20)}
      <div><strong>暂无已存储凭据</strong><span>可以直接添加，无需将密钥粘贴到对话中。</span></div>
      <button
        class="btn"
        type="button"
        @click=${() => {
          addingCredential = { service: "", envKey: "", purpose: "" };
          secureDropUrl = null;
          drawConnectors();
        }}
      >
        添加凭据
      </button>
    </div>`;
  if (!appState.mainEl) return;
  const section = (
    id: string,
    heading: string,
    count: number,
    content: TemplateResult | TemplateResult[],
    sectionLoading: boolean,
  ) =>
    html`<section class="kc-section" aria-labelledby=${id}>
      <div class="kc-section-head">
        <div class="kc-section-title">
          <h2 id=${id}>${heading}</h2>
          <span>${sectionLoading ? "…" : count}</span>
        </div>
      </div>
      <div class="kc-resource-list">${content}</div>
    </section>`;
  const rows: TemplateResult[] = [];
  const notice = [connectorNotice, loadNotice].filter(Boolean).join(" ");
  if (notice || loading)
    rows.push(html`<div class="status" role="status">${loading ? "正在加载你的密钥库…" : notice}</div>`);
  if (addingCredential) rows.push(addCredentialCard());
  rows.push(
    section("kc-accounts-title", "已关联账户", entries.length, accountsContent, accountsLoading),
    section("kc-credentials-title", "已存储凭据", keychainCredentials.length, credentialsContent, keysLoadingFresh),
  );
  const host = document.createElement("div");
  host.className = scopedSession.active ? "pane keychain-page scoped-view" : "pane keychain-page";
  render(
    html`
      ${scopedViewTopbar("keychain", () => drawConnectors())}
      <div class="kc-page-content" ?inert=${Boolean(confirmation)}>
        ${listPageTpl({
          title: "密钥库",
          action: {
            label: "添加凭据",
            onClick: () => {
              addingCredential = { service: "", envKey: "", purpose: "" };
              secureDropUrl = null;
              drawConnectors();
            },
          },
          rows,
          empty: "你的密钥库暂无内容。",
        })}
      </div>
      ${confirmation ? confirmationCard() : ""}
    `,
    host,
  );
  replacePanePreservingFocus(host);
  if (confirmation) focusDialogCancel(host);
}

export async function renderConnectors(): Promise<void> {
  if (appState.currentView !== "keychain") return;
  const seq = appState.viewRenderSeq;
  const load = keychainOperations.beginLoad();
  connectorsLoading = true;
  keysLoading = true;
  drawConnectors();
  const fresh = () =>
    seq === appState.viewRenderSeq && keychainOperations.isCurrentLoad(load) && appState.currentView === "keychain";
  const notices: string[] = [];
  loadNotice = "";
  const applyNotices = () => {
    loadNotice = notices.join(" ");
  };

  const connDone = api<{ providers?: Record<string, ConnectorProvider> }>("/api/connectors").then(
    (value) => {
      if (!fresh()) return;
      connectorProviders = Object.fromEntries(
        Object.entries(value.providers ?? {}).filter(([, p]) => p.available || p.connected || p.needsReconnect),
      );
      connectorsEverLoaded = true;
      connectorsLoading = false;
      applyNotices();
      drawConnectors();
    },
    (reason) => {
      if (!fresh()) return;
      notices.push(errMessage(reason, "加载连接器失败。"));
      connectorsLoading = false;
      applyNotices();
      drawConnectors();
    },
  );
  const keysDone = api<{
    credentials?: KeychainCredential[];
    connectorCredentials?: KeychainConnectorCredential[];
    grants?: KeychainGrant[];
    asks?: KeychainAsk[];
    scopeNames?: Record<string, string>;
  }>("/api/keychain/overview").then(
    (value) => {
      if (!fresh()) return;
      keychainCredentials = (value.credentials ?? []).slice().sort((a, b) => a.service.localeCompare(b.service));
      keychainConnectorCredentials = value.connectorCredentials ?? [];
      keychainGrants = value.grants ?? [];
      keychainAsks = value.asks ?? [];
      keychainScopeNames = value.scopeNames ?? {};
      keysEverLoaded = true;
      keysLoading = false;
      applyNotices();
      drawConnectors();
    },
    (reason) => {
      if (!fresh()) return;
      notices.push(errMessage(reason, "加载已存储密钥失败。"));
      keysLoading = false;
      applyNotices();
      drawConnectors();
    },
  );
  await Promise.all([connDone, keysDone]);
}

async function deleteCredential(credential: KeychainCredential): Promise<void> {
  const active = keychainGrants.filter(
    (grant) => grant.credentialId === credential.id && isActiveGrant(grant, credential),
  );
  const impact = active.length
    ? `这将立即撤销 ${active.length} 项有效授权：${active.map((grant) => scopeName(grant.audienceScopeId)).join(", ")}。`
    : "";
  confirmationOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  confirmation = {
    title: `删除 ${credential.service}？`,
    body: `${impact} 使用它的自动化任务可能停止运行，凭据无法恢复。`.trim(),
    action: "删除凭据",
    run: async () => {
      const operation = beginKeychainMutation();
      if (!operation) return;
      confirmation = null;
      confirmationOpener = null;
      drawConnectors();
      try {
        await performDeleteCredential(credential, operation.epoch);
      } finally {
        if (keychainOperations.finishMutation(operation)) drawConnectors();
      }
    },
  };
  drawConnectors();
}

function beginKeychainMutation() {
  const operation = keychainOperations.beginMutation();
  if (operation) return operation;
  confirmation = null;
  confirmationOpener = null;
  connectorNotice = "另一项密钥库操作仍在进行。";
  drawConnectors();
  return null;
}

async function performDeleteCredential(credential: KeychainCredential, stateEpoch: number): Promise<void> {
  connectorNotice = "";
  try {
    await api(`/api/keychain/credentials/${encodeURIComponent(credential.id)}`, { method: "DELETE" });
  } catch (e) {
    if (keychainOperations.isCurrentEpoch(stateEpoch)) connectorNotice = errMessage(e, "无法删除密钥。");
  }
  if (keychainOperations.isCurrentEpoch(stateEpoch)) await renderConnectors();
}

async function revokeGrant(grant: KeychainGrant): Promise<void> {
  confirmationOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  confirmation = {
    title: `撤销 ${scopeName(grant.audienceScopeId)} 的访问权限？`,
    body: `此 ${grant.mode === "standing" ? "长期" : "一次性"} 访问权限将立即终止，使用它的自动化任务可能停止运行。`,
    action: "撤销访问权限",
    run: async () => {
      const operation = beginKeychainMutation();
      if (!operation) return;
      confirmation = null;
      confirmationOpener = null;
      drawConnectors();
      try {
        await performRevokeGrant(grant.id, operation.epoch);
      } finally {
        if (keychainOperations.finishMutation(operation)) drawConnectors();
      }
    },
  };
  drawConnectors();
}

async function performRevokeGrant(id: string, stateEpoch: number): Promise<void> {
  try {
    await api(`/api/keychain/grants/${encodeURIComponent(id)}/revoke`, { method: "POST", body: "{}" });
    if (keychainOperations.isCurrentEpoch(stateEpoch)) connectorNotice = "访问权限已撤销 ✓";
  } catch (e) {
    if (keychainOperations.isCurrentEpoch(stateEpoch)) connectorNotice = errMessage(e, "无法撤销访问权限。");
  }
  if (keychainOperations.isCurrentEpoch(stateEpoch)) await renderConnectors();
}

async function createDrop(): Promise<void> {
  if (keychainOperations.dropInFlight) return;
  if (!addingCredential?.service.trim() || !addingCredential.purpose.trim()) {
    connectorNotice = "请填写服务名称和用途。";
    return drawConnectors();
  }
  const submittedDraft = { ...addingCredential };
  const stateEpoch = keychainOperations.beginDrop();
  if (stateEpoch === null) return;
  drawConnectors();
  try {
    const result = await api<{ url?: string }>("/api/keychain/drops", {
      method: "POST",
      body: JSON.stringify(submittedDraft),
    });
    if (!keychainOperations.isCurrentEpoch(stateEpoch)) return;
    if (!result.url) throw new Error("未返回一次性页面链接。");
    secureDropUrl = result.url;
    connectorNotice = "你的一次性页面已就绪。";
  } catch (e) {
    if (!keychainOperations.isCurrentEpoch(stateEpoch)) return;
    connectorNotice = errMessage(e, "无法创建一次性页面。");
  } finally {
    if (keychainOperations.isCurrentEpoch(stateEpoch)) {
      keychainOperations.finishDrop(stateEpoch);
      drawConnectors();
    }
  }
}

async function startConnector(provider: string): Promise<void> {
  const stateEpoch = keychainOperations.captureEpoch();
  connectorNotice = "";
  try {
    const r = await api<{ authorizeUrl?: string }>(`/api/connectors/${encodeURIComponent(provider)}/start`, {
      method: "POST",
    });
    if (!keychainOperations.isCurrentEpoch(stateEpoch)) return;
    if (r.authorizeUrl) {
      location.href = r.authorizeUrl;
      return;
    }
    connectorNotice = "未返回授权链接。";
  } catch (e) {
    if (!keychainOperations.isCurrentEpoch(stateEpoch)) return;
    connectorNotice = errMessage(e, "无法启动连接器。");
  }
  drawConnectors();
}

async function revokeConnector(provider: string): Promise<void> {
  const hosts = new Set(
    (connectorProviders[provider]?.hosts ?? [])
      .map((entry) => (typeof entry === "string" ? entry : entry.host))
      .filter((host): host is string => Boolean(host)),
  );
  const providerCredentials = keychainConnectorCredentials.filter((credential) => hosts.has(credential.host));
  const credentialIds = new Set(providerCredentials.map((credential) => credential.credentialId));
  const credentialsById = new Map(
    providerCredentials.map((credential) => [
      credential.credentialId,
      { id: credential.credentialId, kind: "connector" },
    ]),
  );
  const active = keychainGrants.filter(
    (grant) => credentialIds.has(grant.credentialId) && isActiveGrant(grant, credentialsById.get(grant.credentialId)),
  );
  const impact = active.length ? `这还将停用此账户的 ${active.length} 项有效凭据授权。` : "";
  confirmationOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  confirmation = {
    title: `断开 ${CONNECTOR_LABELS[provider]?.name ?? provider} 的连接？`,
    body: `${impact} 使用此账户的自动化任务可能停止运行。`.trim(),
    action: "断开账户连接",
    run: async () => {
      const operation = beginKeychainMutation();
      if (!operation) return;
      confirmation = null;
      confirmationOpener = null;
      drawConnectors();
      try {
        await performRevokeConnector(provider, operation.epoch);
      } finally {
        if (keychainOperations.finishMutation(operation)) drawConnectors();
      }
    },
  };
  drawConnectors();
}

async function performRevokeConnector(provider: string, stateEpoch: number): Promise<void> {
  connectorNotice = "";
  try {
    await api("/api/connectors/revoke", { method: "POST", body: JSON.stringify({ provider }) });
  } catch (e) {
    if (keychainOperations.isCurrentEpoch(stateEpoch)) connectorNotice = errMessage(e, "无法断开连接。");
  }
  if (keychainOperations.isCurrentEpoch(stateEpoch)) await renderConnectors();
}
