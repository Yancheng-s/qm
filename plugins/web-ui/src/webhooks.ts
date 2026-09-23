import { html, nothing, render, type TemplateResult } from "lit";
import { Check, ChevronDown, Plus } from "lucide";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { actionSnippet, closeFormMenus, copyText, icon, relTime, setFormMenuValue, toggleFormMenu } from "./ui";
import { listBackLink, listPageTpl } from "./list-page";
import { ensureContexts, scopeChip } from "./contexts";
import { appState } from "./shell";
import { deepLinkPath, isPlainLeftClick, UI_BASE } from "./deep-link";

export interface WebhookView {
  id: string;
  ownerScopeId: string;
  owner: string;
  action: string;
  verification: { scheme: string; secret?: string };
  filters?: Array<{ path: string; in: string[] }>;
  destination?: { type: string; target: string } | null;
  enabled: boolean;
  createdAt: number;
  lastFiredAt?: number;
  lastDeliveryId?: string;
  lastError?: string;
  url: string;
}

type WebhookScheme = "hmac-sha256" | "github" | "slack" | "stripe" | "linear";

const WEBHOOK_SCHEMES: Array<{ value: WebhookScheme; label: string; guidance: string }> = [
  {
    value: "hmac-sha256",
    label: "通用 HMAC-SHA256",
    guidance: "Send the digest in X-Signature as hex or sha256=<hex>.",
  },
  {
    value: "github",
    label: "GitHub",
    guidance: "将此地址用作 GitHub Webhook 的载荷地址，并将签名密钥填入 secret。",
  },
  {
    value: "slack",
    label: "Slack",
    guidance: "使用 Slack 应用签名密钥，超过五分钟的请求将被拒绝。",
  },
  {
    value: "stripe",
    label: "Stripe",
    guidance: "使用 Stripe 为此目标提供的接口签名密钥。",
  },
  {
    value: "linear",
    label: "Linear",
    guidance: "使用 Linear 提供的 Webhook 签名密钥，超过一分钟的载荷将被拒绝。",
  },
];

let webhookList: WebhookView[] = [];
let webhooksScope: string | null = null;
let webhooksPageHost: HTMLElement | null = null;
let webhooksLoading = false;
let webhooksNotice = "";
let webhooksSearch = "";
let webhookRefreshSeq = 0;
let pendingWebhookId: string | null = null;
let webhooksNoticeSticky = "";

export function resetActiveWebhook(): void {
  webhooksScope = null;
}

export function openWebhookById(id: string): void {
  pendingWebhookId = id;
}

function syncWebhookUrl(webhookId: string | null, push = false): void {
  if (appState.currentView !== "webhooks") return;
  const next = deepLinkPath(UI_BASE, "webhooks", null, null, webhookId);
  if (`${location.pathname}${location.search}` === next) return;
  if (push) history.pushState(null, "", next);
  else history.replaceState(null, "", next);
}

export function routeWebhooksHistory(webhookId: string | null): void {
  if (appState.currentView !== "webhooks") return;
  const webhook = webhookId ? webhookList.find((w) => w.id === webhookId) : undefined;
  if (webhook) openWebhook(webhook);
  else drawWebhooksPage();
}

async function refreshWebhooks(opts: { showLoading?: boolean } = {}): Promise<boolean> {
  const seq = ++webhookRefreshSeq;
  if (opts.showLoading) {
    webhooksLoading = true;
    webhooksNotice = "";
  }
  try {
    const r = await api<{ webhooks: WebhookView[] }>("/api/webhooks");
    if (seq !== webhookRefreshSeq) return false;
    webhookList = r.webhooks ?? [];
    webhooksNotice = "";
    return true;
  } catch (e) {
    if (seq !== webhookRefreshSeq) return false;
    webhooksNotice = errMessage(e, "加载 Webhook 失败。");
    return false;
  } finally {
    if (seq === webhookRefreshSeq) webhooksLoading = false;
  }
}

export async function renderWebhooksPage(): Promise<void> {
  if (appState.currentView !== "webhooks") return;
  await ensureContexts();
  drawWebhooksPage();
  const loaded = await refreshWebhooks({ showLoading: webhookList.length === 0 });
  const wanted = pendingWebhookId;
  pendingWebhookId = null;
  if (appState.currentView !== "webhooks") return;
  if (!loaded) return drawWebhooksPage();
  const webhook = wanted ? webhookList.find((w) => w.id === wanted) : undefined;
  if (wanted && !webhook) {
    webhooksNoticeSticky = "找不到该 Webhook，或你没有访问权限。";
  }
  if (webhook) openWebhook(webhook);
  else drawWebhooksPage();
}

function drawWebhooksPage(): void {
  if (appState.currentView !== "webhooks" || !appState.mainEl) return;
  syncWebhookUrl(null);
  if (!webhooksPageHost || webhooksPageHost.parentElement !== appState.mainEl) {
    webhooksPageHost = document.createElement("div");
    webhooksPageHost.className = "pane webhooks-page";
    appState.mainEl.replaceChildren(webhooksPageHost);
  }
  const rows = [...webhookList]
    .filter((w) => (webhooksScope ? w.ownerScopeId === webhooksScope : true))
    .filter(
      (w) =>
        !webhooksSearch.trim() ||
        `${w.action} ${w.verification.scheme}`.toLowerCase().includes(webhooksSearch.trim().toLowerCase()),
    )
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((w) => webhookPageRow(w));
  let empty = "暂无 Webhook。";
  if (webhooksNotice) empty = webhooksNotice;
  else if (webhooksLoading && webhookList.length === 0) empty = "正在加载 Webhook…";
  else if (webhooksScope) empty = "当前项目中没有 Webhook。";
  const noticeRow = webhooksNoticeSticky ? [html`<div class="action-notice">${webhooksNoticeSticky}</div>`] : [];
  webhooksNoticeSticky = "";
  render(
    listPageTpl({
      title: "Webhook",
      scope: webhooksScope,
      onScope: (s) => {
        webhooksScope = s;
        drawWebhooksPage();
      },
      action: { label: "新建 Webhook", onClick: showNewWebhook },
      search: {
        value: webhooksSearch,
        placeholder: "搜索 Webhook",
        onInput: (value) => {
          webhooksSearch = value;
          drawWebhooksPage();
        },
      },
      rows: [...noticeRow, ...rows],
      empty,
    }),
    webhooksPageHost,
  );
}

function webhookPageRow(w: WebhookView): TemplateResult {
  let lastRun = "从未触发";
  if (w.lastError) lastRun = "error";
  else if (w.lastFiredAt) lastRun = relTime(w.lastFiredAt);
  return html`
    <a
      class="list-row"
      href=${deepLinkPath(UI_BASE, "webhooks", null, null, w.id)}
      @click=${(event: MouseEvent) => {
        if (!isPlainLeftClick(event)) return;
        event.preventDefault();
        openWebhook(w, { push: true });
      }}
    >
      <span class="list-row-title" dir="auto">${actionSnippet(w.action)}</span>
      <span class="list-row-meta">
        ${scopeChip(w.ownerScopeId)}
        <span class="badge">${w.verification.scheme}</span>
        <span class="badge">${w.enabled ? "已启用" : "已停用"}</span>
        <span class="list-row-date">${lastRun}</span>
      </span>
    </a>
  `;
}

function copyRow(text: string) {
  return html`
    <div class="copyrow">
      <code class="mono">${text}</code>
      <button class="btn" @click=${(e: Event) => void copyText(text, e.currentTarget as HTMLButtonElement)}>
        <span>复制</span>
      </button>
    </div>
  `;
}

function openWebhook(w: WebhookView, opts: { push?: boolean } = {}): void {
  if (!appState.mainEl) return;
  syncWebhookUrl(w.id, opts.push);
  const eventsHost = document.createElement("section");
  const notice = webhooksNotice || webhooksNoticeSticky;
  webhooksNotice = "";
  webhooksNoticeSticky = "";
  const host = document.createElement("div");
  host.className = "resource-pane";
  render(
    html`
      <div class="resource-detail">
        ${listBackLink("Webhook", drawWebhooksPage)}
        <div class="resource-heading">
          <h2>Webhook</h2>
          <button class="btn" @click=${showNewWebhook}>${icon(Plus, 15)}<span>新建 Webhook</span></button>
        </div>
        ${notice ? html`<div class="action-notice">${notice}</div>` : nothing}
        <div class="field">
          <label>上下文</label>
          <div class="value">${scopeChip(w.ownerScopeId)}</div>
        </div>
        <div class="field">
          <label>执行操作</label>
          <div class="value pre">${w.action}</div>
        </div>
        <div class="field">
          <label>验证方式</label>
          <div class="value">${w.verification.scheme}</div>
        </div>
        <div class="field">
          <label>状态</label>
          <div class="value">${w.enabled ? "已启用" : "已停用"}</div>
        </div>
        <div class="field">
          <label>接收地址</label>
          ${copyRow(w.url)}
          <div class="hint">将事件发送方（GitHub / Stripe / Slack 等）配置为向此地址 POST 事件。</div>
        </div>
        ${
          w.filters?.length
            ? html`<div class="field">
                <label>筛选条件</label>
                <div class="value pre">${w.filters.map((f) => `${f.path} ∈ [${f.in.join(", ")}]`).join("\n")}</div>
              </div>`
            : ""
        }
        ${
          w.destination
            ? html`<div class="field">
                <label>发送目标</label>
                <div class="value">${w.destination.type} → ${w.destination.target}</div>
              </div>`
            : ""
        }
        <div class="field">
          <label>上次触发</label>
          <div class="value">${w.lastFiredAt ? new Date(w.lastFiredAt).toLocaleString("zh-CN") : "从未"}</div>
        </div>
        ${
          w.lastDeliveryId
            ? html`<div class="field">
                <label>最近投递 ID</label>
                <div class="value mono">${w.lastDeliveryId}</div>
              </div>`
            : nothing
        }
        ${
          w.lastError
            ? html`<div class="field">
                <label>最近错误</label>
                <div class="value" style="color:var(--destructive,#c00)">${w.lastError}</div>
              </div>`
            : ""
        }
        ${eventsHost}
        <div class="actions">
          ${
            w.enabled
              ? html`<button class="btn danger" @click=${() => void setWebhookEnabled(w.id, false)}>停用</button>`
              : html`<button class="btn" @click=${() => void setWebhookEnabled(w.id, true)}>重新启用</button>`
          }
        </div>
      </div>
    `,
    host,
  );
  appState.mainEl.replaceChildren(host);
  void loadWebhookEvents(w.id, eventsHost);
}

interface WebhookEventView {
  receivedAt: number;
  payload: string;
  sessionId?: string;
}

async function loadWebhookEvents(id: string, host: HTMLElement): Promise<void> {
  render(
    html`<h3>消息历史</h3>
      <p class="hint" role="status">正在加载消息…</p>`,
    host,
  );
  try {
    const { events } = await api<{ events: WebhookEventView[] }>(`/api/webhooks/${encodeURIComponent(id)}/events`);
    if (!host.isConnected) return;
    render(
      html`
        <h3>消息历史</h3>
        <p class="hint">显示最近 50 条已接收事件，载荷为传递给智能体的内容，最多 16,000 个字符。更早的事件不会补录。</p>
        ${
          events.length
            ? events.map(
                (event) => html`
                  <details class="code-card">
                    <summary class="tool-payload-label">
                      <time datetime=${new Date(event.receivedAt).toISOString()}
                        >${new Date(event.receivedAt).toLocaleString("zh-CN")}</time
                      >
                    </summary>
                    <pre class="tool-payload-body">${event.payload}</pre>
                    <div class="code-card-foot">
                      ${event.sessionId ? html`<a class="btn" href=${deepLinkPath(UI_BASE, "chats", event.sessionId)}>打开会话</a>` : html`<span class="hint">暂无可用会话。</span>`}
                    </div>
                  </details>
                `,
              )
            : html`<p class="hint">暂无消息记录。</p>`
        }
      `,
      host,
    );
  } catch (error) {
    if (!host.isConnected) return;
    render(
      html`<h3>消息历史</h3>
        <p role="alert">${errMessage(error, "无法加载消息。")}</p>
        <button class="btn" @click=${() => void loadWebhookEvents(id, host)}>重试</button>`,
      host,
    );
  }
}

async function setWebhookEnabled(id: string, enabled: boolean): Promise<void> {
  let notice: string;
  try {
    await api(`/api/webhooks/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`, { method: "POST" });
    notice = enabled ? "Webhook 已重新启用。" : "Webhook 已停用。";
  } catch (e) {
    notice = errMessage(e, enabled ? "无法重新启用 Webhook。" : "无法停用 Webhook。");
  }
  await refreshWebhooks();
  webhooksNotice = notice;
  const w = webhookList.find((x) => x.id === id);
  if (w) openWebhook(w);
  else drawWebhooksPage();
}

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

function webhookForm() {
  return html`
    <form class="resource-form" @submit=${onCreateWebhook}>
      ${listBackLink("Webhook", drawWebhooksPage)}
      <h2>新建 Webhook</h2>
      <label
        >执行操作 <span class="hint">（每次收到事件后，智能体需要执行的操作）</span>
        <textarea
          name="action"
          rows="4"
          placeholder="当 GitHub 创建新 issue 时，对其分类并发送一段摘要。"
          required
        ></textarea>
      </label>
      <label>
        验证方案
        <div class="menu-control form-menu-control scheme-control">
          <input type="hidden" name="scheme" value="hmac-sha256" />
          <button class="menu-button" type="button" aria-haspopup="menu" aria-expanded="false" @click=${toggleFormMenu}>
            <span class="menu-label">hmac-sha256</span>
            ${icon(ChevronDown, 14)}
          </button>
          <div class="menu-popover" role="menu" hidden>
            <div class="menu-title">验证方式</div>
            ${WEBHOOK_SCHEMES.map(
              (scheme) => html`
                <button
                  class="menu-option ${scheme.value === "hmac-sha256" ? "active" : ""}"
                  type="button"
                  data-value=${scheme.value}
                  role="menuitemradio"
                  aria-checked=${scheme.value === "hmac-sha256" ? "true" : "false"}
                  @click=${(e: Event) => selectWebhookScheme(e, scheme.value)}
                >
                  <span>${scheme.label}</span>
                  ${scheme.value === "hmac-sha256" ? icon(Check, 15) : nothing}
                </button>
              `,
            )}
          </div>
        </div>
        <span class="hint webhook-scheme-guidance">${WEBHOOK_SCHEMES[0]!.guidance}</span>
      </label>
      <label
        >签名密钥 <span class="hint">（留空则自动生成）</span>
        <div class="copyrow">
          <input type="text" name="secret" placeholder="留空自动生成" />
          <button type="button" class="btn" @click=${fillGeneratedSecret}>生成</button>
        </div>
      </label>
      <label
        >筛选条件 <span class="hint">（可选，每行一条，格式为 <code>路径: 值1, 值2</code>)</span>
        <textarea name="filters" rows="2" placeholder="action: opened, reopened"></textarea>
      </label>
      <p class="hint">事件在你的个人上下文中执行。创建后，可以让智能体将重要结果发送给指定成员或频道。</p>
      <div class="form-error"></div>
      <div class="actions"><button class="btn primary" type="submit">创建 Webhook</button></div>
    </form>
  `;
}

function showNewWebhook(): void {
  if (!appState.mainEl) return;
  const host = document.createElement("div");
  host.className = "resource-pane";
  render(webhookForm(), host);
  appState.mainEl.replaceChildren(host);
}

function selectWebhookScheme(e: Event, scheme: WebhookScheme): void {
  e.stopPropagation();
  const control = (e.currentTarget as HTMLElement).closest(".scheme-control") as HTMLElement | null;
  const form = control?.closest("form");
  setFormMenuValue(control, scheme, WEBHOOK_SCHEMES.find((s) => s.value === scheme)?.label ?? scheme);
  applyWebhookScheme(form, scheme);
  closeFormMenus();
}

function applyWebhookScheme(form: Element | null | undefined, scheme: string): void {
  const guidance = form?.querySelector(".webhook-scheme-guidance");
  if (guidance) guidance.textContent = WEBHOOK_SCHEMES.find((candidate) => candidate.value === scheme)?.guidance ?? "";
}

function fillGeneratedSecret(e: Event): void {
  const form = (e.currentTarget as HTMLElement).closest("form");
  const secret = form?.querySelector('input[name="secret"]') as HTMLInputElement | null;
  if (secret && !secret.disabled) secret.value = randomHex(32);
}

function parseWebhookFilters(text: string): Array<{ path: string; in: string[] }> {
  const out: Array<{ path: string; in: string[] }> = [];
  for (const line of text.split("\n")) {
    const idx = line.indexOf(":");
    if (!line.trim()) continue;
    if (idx < 1) throw new Error(`筛选条件“${line}”无效，请使用“路径: 值1, 值2”格式。`);
    const path = line.slice(0, idx).trim();
    const values = line
      .slice(idx + 1)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!path || values.length === 0) throw new Error(`筛选条件“${line}”无效，路径和值均为必填项。`);
    out.push({ path, in: values });
  }
  return out;
}

async function onCreateWebhook(e: Event): Promise<void> {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  const errSlot = form.querySelector(".form-error") as HTMLElement | null;
  const field = (n: string) =>
    (form.querySelector(`[name="${n}"]`) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null)?.value ??
    "";
  const action = field("action").trim();
  const scheme = field("scheme") || "hmac-sha256";
  const secret = field("secret").trim();
  let filters: Array<{ path: string; in: string[] }>;
  if (errSlot) errSlot.textContent = "";
  if (!action) {
    if (errSlot) errSlot.textContent = "请填写执行操作。";
    return;
  }
  try {
    filters = parseWebhookFilters(field("filters"));
  } catch (err) {
    if (errSlot) errSlot.textContent = errMessage(err, "筛选条件无效。");
    return;
  }
  const payload: Record<string, unknown> = {
    action,
    verification: { scheme, ...(secret ? { secret } : {}) },
  };
  if (filters.length) payload.filters = filters;
  try {
    const r = await api<{ webhook: WebhookView; url: string }>("/api/webhooks", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    await refreshWebhooks();
    showWebhookCreated(r.webhook, r.url);
  } catch (err) {
    if (errSlot) errSlot.textContent = errMessage(err, "创建失败");
  }
}

function showWebhookCreated(w: WebhookView, url: string): void {
  if (!appState.mainEl) return;
  const host = document.createElement("div");
  host.className = "resource-pane";
  const secret = w.verification.secret;
  render(
    html`
      <div class="resource-detail">
        ${listBackLink("Webhook", drawWebhooksPage)}
        <h2>Webhook 已创建 ✓</h2>
        <div class="warn">请立即复制密钥，此后将不再显示。</div>
        <div class="field">
          <label>接收地址</label>
          ${copyRow(url)}
          <div class="hint">将事件发送方指向此地址。</div>
        </div>
        ${
          secret && secret !== "***"
            ? html`<div class="field">
                <label>签名密钥</label>
                ${copyRow(secret)}
                <div class="hint">请将发送方配置为使用此密钥签名请求（方案：${w.verification.scheme}）。</div>
              </div>`
            : html`<div class="field">
                <div class="hint">此方案不使用签名密钥： <code>${w.verification.scheme}</code>.</div>
              </div>`
        }
        <div class="actions">
          <button class="btn" @click=${() => openWebhook(webhookList.find((x) => x.id === w.id) ?? w)}>完成</button>
        </div>
      </div>
    `,
    host,
  );
  appState.mainEl.replaceChildren(host);
}
