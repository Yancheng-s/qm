import { displayStatus } from "./display-labels";
import { LOOP_ICONS, loopIcon, readLoopIcon } from "./loop-icon";
import { html, nothing, render, type TemplateResult } from "lit";
import { CheckCircle2, CornerUpLeft, Pause, Play, Zap } from "lucide";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { fieldSelect, icon } from "./ui";
import { listBackLink, listPageTpl } from "./list-page";
import { appState, can } from "./shell";

interface LoopView {
  id: string;
  name: string;
  icon?: string;
  purpose?: string;
  playbook: string;
  playbookVersion: number;
  successCondition: string;
  shipActions: Array<{ action: string; gate: "auto" | "hold" }>;
  state: "enabled" | "paused" | "quarantined" | "archived";
  health: "healthy" | "degraded" | "failing" | "quarantined";
  healthReason?: string;
  owner: string;
  cronId?: string;
  sources?: string[];
  lastFiredAt?: number;
  consecutiveFailedFires?: number;
}

interface LoopItemView {
  id: string;
  sourceKey: string;
  sourceSummary?: string;
  status: string;
  attempts: number;
  parkedReason?: string;
  guidance?: string;
  updatedAt: number;
}

interface LoopOutputView {
  id: string;
  itemId: string;
  shipAction: string;
  label?: string;
  externalRef?: string;
  title: string;
  summary?: string;
  state: "ready" | "unconfirmed" | "shipped" | "returned" | "expired";
  decidedBy?: string;
  decisionNote?: string;
  createdAt: number;
}

interface LoopDetail {
  loop: LoopView;
  items: LoopItemView[];
  outputs: LoopOutputView[];
  vitals: { queue: { queued: number; inProgress: number }; openOutputs: number };
}

interface IngestionSource {
  id: string;
  kind: "webhook" | "slack" | "gmail";
  enabled: boolean;
  url: string;
  channels?: string[];
  gmail?: { email: string; expiresAt: number };
  lastReceivedAt?: number;
  lastError?: string;
}
let ingestion: { sources: IngestionSource[]; gmailAvailable: boolean } | null = null;
let ingestionKind: IngestionSource["kind"] | "" = "";
let ingestionSecret = "";
let ingestionTeam = "";
let ingestionChannels = "";
let createdSecret = "";

let loopList: LoopView[] = [];
let loopsHost: HTMLElement | null = null;
let loopsLoading = false;
let loopsNotice = "";
let activeLoopId: string | null = null;
let activeDetail: LoopDetail | null = null;
let loopBusy = false;
let iconPickerOpen = false;
let playbookDraft: string | null = null;
let returnDrafts = new Map<string, string>();

export function resetActiveLoop(): void {
  activeLoopId = null;
  iconPickerOpen = false;
  ingestion = null;
  ingestionKind = "";
  createdSecret = "";
  ingestionSecret = "";
  activeDetail = null;
  playbookDraft = null;
  returnDrafts = new Map();
}

function healthBadge(loop: LoopView): TemplateResult {
  const label = loop.state === "enabled" ? loop.health : loop.state;
  return html`<span class="loop-health loop-health-${label}" title=${loop.healthReason ?? ""}>${label}</span>`;
}

function ago(ts?: number): string {
  if (!ts) return "从未";
  const mins = Math.round((Date.now() - ts) / 60_000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

async function refreshLoops(): Promise<void> {
  loopsLoading = true;
  paint();
  try {
    const r = await api<{ loops: LoopView[] }>("/api/loops");
    loopList = r.loops ?? [];
    loopsNotice = "";
  } catch (e) {
    loopsNotice = errMessage(e);
  } finally {
    loopsLoading = false;
    paint();
  }
}

async function refreshDetail(id: string): Promise<void> {
  try {
    const [detail, sources] = await Promise.all([
      api<LoopDetail>(`/api/loops/${encodeURIComponent(id)}`),
      api<NonNullable<typeof ingestion>>(`/api/loops/${encodeURIComponent(id)}/ingestion`),
    ]);
    activeDetail = detail;
    ingestion = sources;
    loopsNotice = "";
  } catch (e) {
    loopsNotice = errMessage(e);
  }
  paint();
}

async function mutate(fn: () => Promise<unknown>): Promise<void> {
  if (loopBusy) return;
  loopBusy = true;
  paint();
  let failure = "";
  try {
    await fn();
    loopsNotice = "";
  } catch (e) {
    failure = errMessage(e);
  } finally {
    loopBusy = false;
    if (activeLoopId) await refreshDetail(activeLoopId);
    else await refreshLoops();
    if (failure) {
      loopsNotice = failure;
      paint();
    }
  }
}

async function setLoopIcon(loop: LoopView, value: string | null | File): Promise<void> {
  await mutate(async () => {
    const icon = value instanceof File ? await readLoopIcon(value) : value;
    await api(`/api/loops/${encodeURIComponent(loop.id)}`, { method: "PATCH", body: JSON.stringify({ icon }) });
    iconPickerOpen = false;
    const { refreshInbox } = await import("./inbox");
    await refreshInbox({ silent: true });
  });
  loopsHost?.querySelector<HTMLElement>(".loop-icon-picker summary")?.focus();
}

export function openLoop(id: string): void {
  resetActiveLoop();
  activeLoopId = id;
  activeDetail = null;
  playbookDraft = null;
  void refreshDetail(id);
  paint();
}

function setState(loop: LoopView, state: LoopView["state"]): void {
  void mutate(() =>
    api(`/api/loops/${encodeURIComponent(loop.id)}`, { method: "PATCH", body: JSON.stringify({ state }) }),
  );
}

function fireNow(loop: LoopView): void {
  void mutate(() => api(`/api/loops/${encodeURIComponent(loop.id)}/fire`, { method: "POST" }));
}

function setAutopilot(loop: LoopView, enabled: boolean): void {
  void mutate(() =>
    api(`/api/loops/${encodeURIComponent(loop.id)}/autopilot`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),
  );
}

function decide(loop: LoopView, output: LoopOutputView, decision: "ship" | "return"): void {
  const note = returnDrafts.get(output.id)?.trim();
  if (decision === "return" && !note) {
    loopsNotice = "退回时需要填写下次处理的说明";
    paint();
    return;
  }
  void mutate(() =>
    api(`/api/loops/${encodeURIComponent(loop.id)}/outputs/${encodeURIComponent(output.id)}/decide`, {
      method: "POST",
      body: JSON.stringify({ decision, ...(note ? { note } : {}) }),
    }),
  );
  returnDrafts.delete(output.id);
}

function savePlaybook(loop: LoopView): void {
  const draft = playbookDraft?.trim();
  if (!draft || draft === loop.playbook) {
    playbookDraft = null;
    paint();
    return;
  }
  void mutate(() =>
    api(`/api/loops/${encodeURIComponent(loop.id)}`, { method: "PATCH", body: JSON.stringify({ playbook: draft }) }),
  );
  playbookDraft = null;
}

function reviewRow(loop: LoopView, output: LoopOutputView, shipLabel = "交付"): TemplateResult {
  const externalUrl = output.externalRef && /^https?:\/\//i.test(output.externalRef) ? output.externalRef : undefined;
  return html`
    <div class="loop-output">
      <div class="loop-output-main">
        <span class="loop-output-action">${output.shipAction}${output.label ? html` · ${output.label}` : nothing}</span>
        <span class="loop-output-title">
          ${
            externalUrl
              ? html`<a href=${externalUrl} target="_blank" rel="noopener noreferrer">${output.title}</a>`
              : output.title
          }
        </span>
        ${output.summary ? html`<span class="loop-output-summary">${output.summary}</span>` : nothing}
      </div>
      <div class="loop-output-decide">
        <input
          type="text"
          placeholder="填写退回说明…"
          .value=${returnDrafts.get(output.id) ?? ""}
          @input=${(e: Event) => returnDrafts.set(output.id, (e.target as HTMLInputElement).value)}
        />
        <button class="btn" type="button" ?disabled=${loopBusy} @click=${() => decide(loop, output, "return")}>
          ${icon(CornerUpLeft, 14)}<span>退回</span>
        </button>
        <button class="btn primary" type="button" ?disabled=${loopBusy} @click=${() => decide(loop, output, "ship")}>
          ${icon(CheckCircle2, 14)}<span>${shipLabel}</span>
        </button>
      </div>
    </div>
  `;
}

function itemRow(item: LoopItemView): TemplateResult {
  return html`
    <div class="loop-item">
      <span class="loop-item-status loop-item-${item.status}">${displayStatus(item.status)}</span>
      <span class="loop-item-key">${item.sourceKey}</span>
      <span class="loop-item-summary">${item.sourceSummary ?? ""}</span>
      <span class="loop-item-meta">
        ${item.attempts > 0 ? `${item.attempts} 次尝试` : ""}
        ${item.parkedReason ? html` · <span title=${item.parkedReason}>已搁置</span>` : nothing}
      </span>
    </div>
  `;
}

async function addIngestion(loop: LoopView): Promise<void> {
  await mutate(async () => {
    const result = await api<{ secret?: string }>(`/api/loops/${encodeURIComponent(loop.id)}/ingestion`, {
      method: "POST",
      body: JSON.stringify({
        kind: ingestionKind,
        ...(ingestionKind === "slack"
          ? {
              secret: ingestionSecret,
              teamId: ingestionTeam.trim(),
              channels: ingestionChannels.split(/[\s,]+/).filter(Boolean),
            }
          : {}),
      }),
    });
    createdSecret = result.secret ?? "";
    ingestionSecret = "";
    ingestionKind = "";
    await refreshDetail(loop.id);
  });
}

function ingestionTpl(loop: LoopView): TemplateResult {
  const names = { webhook: "签名 Webhook", slack: "Slack 事件", gmail: "Gmail Pub/Sub" };
  return html`<section class="loop-ingestion">
    <div class="loop-ingestion-heading">
      <h2>输入来源</h2>
      <span>${loop.cronId ? "定时同步已启用" : "未设置定时同步"}</span>
    </div>
    <p>选择新任务进入此工作流的方式。事件来源可与定时运行同时启用。</p>
    ${ingestion?.sources.map(
      (source) =>
        html`<div class="loop-ingestion-source">
          <div class="loop-ingestion-source-head">
            <strong>${names[source.kind]}</strong><span>${source.enabled ? "监听中" : "已停用"}</span
            ><button
              class="btn compact"
              ?disabled=${loopBusy}
              @click=${() =>
                mutate(async () => {
                  await api(`/api/loops/${encodeURIComponent(loop.id)}/ingestion/${encodeURIComponent(source.id)}`, {
                    method: "PATCH",
                    body: JSON.stringify({ enabled: !source.enabled }),
                  });
                  await refreshDetail(loop.id);
                })}
            >
              ${source.enabled ? "停用" : "启用"}
            </button>
          </div>
          <label>接口地址<input readonly .value=${source.url} aria-label=${`${names[source.kind]} 接口地址`} /></label>
          ${source.gmail ? html`<p>${source.gmail.email} · 监听会自动续期</p>` : nothing}
          ${source.channels?.length ? html`<p>频道：${source.channels.join(", ")}</p>` : nothing}
          <p>最近事件：${ago(source.lastReceivedAt)}${loop.state !== "enabled" ? " · 处理已暂停" : ""}</p>
          ${source.lastError ? html`<p class="error-banner">${source.lastError}</p>` : nothing}
        </div>`,
    )}
    ${
      createdSecret
        ? html`<div class="loop-ingestion-secret">
            <label
              >签名密钥 — 请立即保存，仅显示一次<input readonly .value=${createdSecret} aria-label="Webhook 签名密钥"
            /></label>
            <p>使用 HMAC-SHA256 对原始 JSON 正文签名，并将十六进制摘要放入 X-Signature 请求头。</p>
            <button
              class="btn compact"
              @click=${() => {
                createdSecret = "";
                paint();
              }}
            >
              完成
            </button>
          </div>`
        : nothing
    }
    <div class="loop-ingestion-add">
      ${fieldSelect({
        ariaLabel: "输入来源",
        value: ingestionKind,
        onChange: (value) => {
          ingestionKind = value as typeof ingestionKind;
          ingestionSecret = "";
          paint();
        },
        options: html`<option value="">添加事件来源…</option>
          ${Object.entries(names)
            .filter(
              ([kind]) =>
                !ingestion?.sources.some((source) => source.kind === kind) &&
                (!loop.sources?.length ? true : kind !== "webhook" && loop.sources.includes(kind)),
            )
            .map(([kind, name]) => html`<option value=${kind}>${name}</option>`)}`,
      })}
    </div>
    ${
      ingestionKind === "slack"
        ? html`<div class="loop-ingestion-fields">
            <label
              >工作区 ID<input
                placeholder="T0123456789"
                .value=${ingestionTeam}
                @input=${(event: Event) => {
                  ingestionTeam = (event.target as HTMLInputElement).value;
                }} /></label
            ><label
              >频道 ID<input
                placeholder="C0123456789, C9876543210"
                .value=${ingestionChannels}
                @input=${(event: Event) => {
                  ingestionChannels = (event.target as HTMLInputElement).value;
                }} /></label
            ><label
              >Slack 签名密钥<input
                type="password"
                autocomplete="off"
                .value=${ingestionSecret}
                @input=${(event: Event) => {
                  ingestionSecret = (event.target as HTMLInputElement).value;
                }}
            /></label>
            <p>将此接口地址配置为 Slack 应用的 Events API 请求地址。只接收这些频道中由用户发送的消息。</p>
          </div>`
        : nothing
    }
    ${ingestionKind === "gmail" ? html`<p>${ingestion?.gmailAvailable ? "使用你已连接的个人 Gmail 账户，收件箱的新邮件将转为工作流待办。" : "管理员需要先配置 Google Cloud Pub/Sub 主题、受众和推送服务账户，才能启用 Gmail。"}</p>` : nothing}
    ${ingestionKind ? html`<button class="btn compact" ?disabled=${loopBusy || (ingestionKind === "gmail" && !ingestion?.gmailAvailable)} @click=${() => void addIngestion(loop)}>${loopBusy ? "正在连接…" : `启用 ${names[ingestionKind]}`}</button>` : nothing}
  </section>`;
}

function detailTpl(detail: LoopDetail): TemplateResult {
  const { loop, items, outputs } = detail;
  const autopilot = loop.shipActions.length > 0 && loop.shipActions.every((policy) => policy.gate === "auto");
  const ready = outputs.filter((o) => o.state === "ready");
  const unconfirmed = outputs.filter((o) => o.state === "unconfirmed");
  const decided = outputs.filter((o) => o.state !== "ready" && o.state !== "unconfirmed");
  return html`
    ${listBackLink("持续工作流", () => {
      resetActiveLoop();
      paint();
      void refreshLoops();
    })}
    <div class="list-page-head">
      <div class="loop-title">
        <details
          class="loop-icon-picker"
          .open=${iconPickerOpen}
          @toggle=${(event: Event) => {
            iconPickerOpen = (event.currentTarget as HTMLDetailsElement).open;
          }}
          @keydown=${(event: KeyboardEvent) => {
            if (event.key === "Escape") {
              iconPickerOpen = false;
              (event.currentTarget as HTMLDetailsElement).open = false;
              (event.currentTarget as HTMLElement).querySelector("summary")?.focus();
            }
          }}
        >
          <summary aria-label=${`更换 ${loop.name} 的图标`} title="更换图标">${loopIcon(loop, 24)}</summary>
          <div class="loop-icon-popover" role="group" aria-label="工作流图标">
            <span class="loop-icon-heading">选择图标</span>
            <div class="loop-icon-grid">
              ${LOOP_ICONS.map((choice) => html`<button type="button" aria-label=${choice.label} title=${choice.label} aria-pressed=${loop.icon === choice.id ? "true" : "false"} ?disabled=${loopBusy} @click=${() => void setLoopIcon(loop, choice.id)}>${loopIcon({ icon: choice.id }, 20)}</button>`)}
            </div>
            <label class="loop-icon-upload">
              <span>${loopBusy ? "正在保存…" : "上传图片"}</span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                aria-label="上传工作流图标"
                ?disabled=${loopBusy}
                @change=${(event: Event) => {
                  const input = event.currentTarget as HTMLInputElement;
                  const file = input.files?.[0];
                  input.value = "";
                  if (file) void setLoopIcon(loop, file);
                }}
              />
            </label>
            <span class="loop-icon-hint">支持不超过 2 MB 的图片，包括 SVG</span>
            <button
              class="loop-icon-default"
              type="button"
              ?disabled=${loopBusy || !loop.icon}
              @click=${() => void setLoopIcon(loop, null)}
            >
              ${loopIcon({ sources: loop.sources })}<span>使用默认图标</span>
            </button>
          </div>
        </details>
        <h1 class="pane-title">${loop.name}</h1>
      </div>
      <div class="list-page-actions">
        ${healthBadge(loop)}
        <button class="btn" type="button" ?disabled=${loopBusy} @click=${() => fireNow(loop)}>
          ${icon(Zap, 14)}<span>立即运行</span>
        </button>
        ${
          loop.state === "enabled"
            ? html`<button class="btn" type="button" ?disabled=${loopBusy} @click=${() => setState(loop, "paused")}>
                ${icon(Pause, 14)}<span>暂停</span>
              </button>`
            : html`<button
                class="btn primary"
                type="button"
                ?disabled=${loopBusy}
                @click=${() => setState(loop, "enabled")}
              >
                ${icon(Play, 14)}<span>${loop.state === "quarantined" ? "解除隔离" : "继续"}</span>
              </button>`
        }
      </div>
    </div>
    ${loop.healthReason ? html`<p class="loop-health-reason">${loop.healthReason}</p>` : nothing}
    ${loopsNotice ? html`<p class="error-banner">${loopsNotice}</p>` : nothing}
    ${
      loop.shipActions.length
        ? html`<button
            class="loop-autopilot ${autopilot ? "on" : ""}"
            type="button"
            role="switch"
            aria-checked=${autopilot ? "true" : "false"}
            ?disabled=${loopBusy}
            @click=${() => setAutopilot(loop, !autopilot)}
          >
            <span class="loop-autopilot-copy">
              <span class="loop-autopilot-label">自动执行</span>
              <span class="loop-autopilot-sublabel">${autopilot ? "无需审核直接交付" : "无需审核即可交付结果"}</span>
            </span>
            <span class="loop-autopilot-switch"><span></span></span>
          </button>`
        : nothing
    }

    <h2 class="loop-section-title">
      待交付 ${ready.length ? html`<span class="loop-count">${ready.length}</span>` : nothing}
    </h2>
    ${ready.length ? ready.map((o) => reviewRow(loop, o)) : html`<p class="list-empty">暂无需要你处理的事项。</p>`}

    <h2 class="loop-section-title">
      待确认 ${unconfirmed.length ? html`<span class="loop-count">${unconfirmed.length}</span>` : nothing}
    </h2>
    ${
      unconfirmed.length
        ? unconfirmed.map((o) => reviewRow(loop, o, "确认已交付"))
        : html`<p class="list-empty">暂无需要确认的事项。</p>`
    }
    ${ingestionTpl(loop)}
    <h2 class="loop-section-title">执行手册 <span class="loop-count">v${loop.playbookVersion}</span></h2>
    <textarea
      class="loop-playbook"
      rows="10"
      .value=${playbookDraft ?? loop.playbook}
      @input=${(e: Event) => {
        playbookDraft = (e.target as HTMLTextAreaElement).value;
      }}
    ></textarea>
    <div class="loop-playbook-actions">
      <span class="loop-success-condition" title="完成条件">完成条件：${loop.successCondition}</span>
      ${
        playbookDraft !== null && playbookDraft !== loop.playbook
          ? html`<button class="btn primary" type="button" ?disabled=${loopBusy} @click=${() => savePlaybook(loop)}>
              保存执行手册
            </button>`
          : nothing
      }
    </div>

    <h2 class="loop-section-title">工作记录</h2>
    ${items.length ? items.map(itemRow) : html`<p class="list-empty">暂无事项，请运行工作流。</p>`}
    ${
      decided.length
        ? html`<h2 class="loop-section-title">已决定</h2>
            ${decided.map(
              (o) => html`
                <div class="loop-output loop-output-decided">
                  <span class="loop-output-state loop-output-${o.state}">${displayStatus(o.state)}</span>
                  <span class="loop-output-title">${o.title}</span>
                  <span class="loop-output-meta"
                    >${o.decidedBy ?? ""} ${o.decisionNote ? `· ${o.decisionNote}` : ""}</span
                  >
                </div>
              `,
            )}`
        : nothing
    }
  `;
}

function loopRow(loop: LoopView): TemplateResult {
  return html`
    <button class="list-row loop-row" type="button" @click=${() => openLoop(loop.id)}>
      ${loopIcon(loop, 18)}<span class="loop-row-name">${loop.name}</span>
      ${healthBadge(loop)}
      <span class="loop-row-meta">上次触发 ${ago(loop.lastFiredAt)}</span>
    </button>
  `;
}

function paint(): void {
  if (!loopsHost || appState.currentView !== "loops") return;
  if (activeLoopId) {
    render(activeDetail ? detailTpl(activeDetail) : html`<p class="list-empty">加载中…</p>`, loopsHost);
    return;
  }
  render(
    listPageTpl({
      title: "持续工作流",
      rows: loopList.map(loopRow),
      empty: loopsLoading
        ? "加载中…"
        : (loopsNotice ?? "暂无工作流。可以让智能体帮你设置，define-loop 技能会先进行模拟运行。"),
    }),
    loopsHost,
  );
}

export async function renderLoopsPage(): Promise<void> {
  if (!can("loops")) return;
  if (!appState.mainEl) return;
  if (!loopsHost || loopsHost.parentElement !== appState.mainEl) {
    loopsHost = document.createElement("div");
    loopsHost.className = "pane loops-page";
    appState.mainEl.replaceChildren(loopsHost);
  }
  paint();
  await refreshLoops();
  if (activeLoopId) await refreshDetail(activeLoopId);
}
