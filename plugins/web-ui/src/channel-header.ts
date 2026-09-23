import { html, nothing, type TemplateResult } from "lit";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { fieldSelect } from "./ui";

interface HeaderPinWire {
  scopeId: string;
  on: boolean;
  configured?: boolean | null;
  default?: boolean;
}

export const channelHeaderState = {
  scope: null as string | null,
  loading: false,
  saving: false,
  on: false,
  configured: null as boolean | null,
  orgDefault: false,
  loaded: false,
  notice: "",
  noticeKind: "" as "" | "saved" | "error",
};

let loadSeq = 0;
let redraw: () => void = () => {};

export function channelHeaderApplies(scopeId: string): boolean {
  return scopeId.startsWith("channel:");
}

export function resetChannelHeader(): void {
  loadSeq += 1;
  channelHeaderState.scope = null;
  channelHeaderState.loading = false;
  channelHeaderState.saving = false;
  channelHeaderState.on = false;
  channelHeaderState.configured = null;
  channelHeaderState.orgDefault = false;
  channelHeaderState.loaded = false;
  channelHeaderState.notice = "";
  channelHeaderState.noticeKind = "";
}

export async function loadChannelHeader(scopeId: string, onChange: () => void): Promise<void> {
  redraw = onChange;
  if (!channelHeaderApplies(scopeId) || channelHeaderState.scope === scopeId) return;
  resetChannelHeader();
  const seq = ++loadSeq;
  channelHeaderState.scope = scopeId;
  channelHeaderState.loading = true;
  try {
    const r = await api<HeaderPinWire>(`/api/channel-header-pin?scopeId=${encodeURIComponent(scopeId)}`);
    if (seq !== loadSeq) return;
    channelHeaderState.on = r.on;
    channelHeaderState.configured = r.configured ?? null;
    channelHeaderState.orgDefault = r.default ?? false;
    channelHeaderState.loaded = true;
  } catch (e) {
    if (seq !== loadSeq) return;
    channelHeaderState.notice = errMessage(e, "无法加载频道置顶栏设置。");
    channelHeaderState.noticeKind = "error";
  } finally {
    if (seq === loadSeq) {
      channelHeaderState.loading = false;
      redraw();
    }
  }
}

async function save(scope: string, on: boolean | null): Promise<void> {
  if (channelHeaderState.saving) return;
  const seq = loadSeq;
  channelHeaderState.saving = true;
  channelHeaderState.notice = "";
  channelHeaderState.noticeKind = "";
  redraw();
  try {
    const r = await api<HeaderPinWire>("/api/channel-header-pin", {
      method: "PUT",
      body: JSON.stringify({ scopeId: scope, on }),
    });
    if (seq !== loadSeq) return;
    channelHeaderState.on = r.on;
    channelHeaderState.configured = r.configured ?? null;
    channelHeaderState.notice = r.on ? "已在频道中置顶。" : "已移除置顶栏。";
    channelHeaderState.noticeKind = "saved";
  } catch (e) {
    if (seq !== loadSeq) return;
    channelHeaderState.notice = errMessage(e, "无法更新频道置顶栏设置。");
    channelHeaderState.noticeKind = "error";
  } finally {
    if (seq === loadSeq) {
      channelHeaderState.saving = false;
      redraw();
    }
  }
}

function configuredSelectValue(configured: boolean | null): "default" | "on" | "off" {
  if (configured === null) return "default";
  return configured ? "on" : "off";
}

export function channelHeaderSection(scopeId: string): TemplateResult | typeof nothing {
  if (!channelHeaderApplies(scopeId) || channelHeaderState.scope !== scopeId) return nothing;
  if (channelHeaderState.loading)
    return html`<section class="context-panel channel-header" aria-labelledby="channel-header-title">
      <h2 class="context-panel-title" id="channel-header-title">置顶栏</h2>
      <div class="context-panel-loading">加载中…</div>
    </section>`;
  return html`
    <section class="context-panel channel-header" aria-labelledby="channel-header-title">
      <div class="context-panel-heading">
        <div>
          <h2 class="context-panel-title" id="channel-header-title">置顶栏</h2>
          <p class="context-panel-copy">在 Slack 频道中置顶一条简短消息，显示当前使用的模型。</p>
        </div>
      </div>
      ${
        channelHeaderState.loaded
          ? fieldSelect({
              id: "channel-header-select",
              className: "channel-header-select",
              focusKey: "channel-header",
              describedBy: "channel-header-hint",
              ariaLabel: "此频道的 Slack 置顶栏",
              disabled: channelHeaderState.saving,
              value: configuredSelectValue(channelHeaderState.configured),
              onChange: (v) => void save(scopeId, v === "default" ? null : v === "on"),
              options: [
                html`<option value="default" ?selected=${channelHeaderState.configured === null}>
                  默认（${channelHeaderState.orgDefault ? "开启" : "关闭"}）
                </option>`,
                html`<option value="on" ?selected=${channelHeaderState.configured === true}>开启</option>`,
                html`<option value="off" ?selected=${channelHeaderState.configured === false}>关闭</option>`,
              ],
            })
          : nothing
      }
      <p class="channel-header-hint" id="channel-header-hint">
        开启后会发布并置顶该消息；关闭后会取消置顶并移除。默认跟随组织设置，模型变更会直接更新置顶消息。
      </p>
      ${
        channelHeaderState.notice
          ? html`<span class="context-model-status ${channelHeaderState.noticeKind}" aria-live="polite"
              >${channelHeaderState.notice}</span
            >`
          : nothing
      }
    </section>
  `;
}
