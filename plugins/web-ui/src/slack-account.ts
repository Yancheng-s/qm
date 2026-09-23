import { LitElement, html, nothing } from "lit";
import { ArrowUpRight, Check, Link2, UserRound } from "lucide";
import { icon, slackMark } from "./ui";
import "./slack-account.css";
import { withBase } from "./core-bridge";

interface SlackAttempt {
  user: string;
  state: string;
  ticket: string;
  expiresAt: number;
}

let returnUrl: URL | null = null;

export function captureSlackReturn(url: string): void {
  const parsed = new URL(url);
  returnUrl = parsed.searchParams.has("slackReturn") ? parsed : null;
}

export class SlackAccount extends LitElement {
  static properties = {
    user: {},
    busy: { state: true },
    error: { state: true },
    connected: { state: true },
    label: { state: true },
  };
  user = "";
  private busy = false;
  private error = "";
  private connected = false;
  private label = "";
  private attempt: SlackAttempt | null = null;

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  protected firstUpdated(): void {
    const url = returnUrl ?? new URL(location.href);
    returnUrl = null;
    const state = url.searchParams.get("slackReturn");
    try {
      const saved = JSON.parse(sessionStorage.getItem("qm-slack-account") ?? "null") as SlackAttempt | null;
      if (saved?.user === this.user && saved.expiresAt > Date.now()) this.attempt = saved;
    } catch {
      this.attempt = null;
    }
    if (state) {
      const cancelled = url.searchParams.has("error");
      for (const key of ["slackReturn", "status", "error", "connectedAccountId"]) url.searchParams.delete(key);
      history.replaceState(history.state, "", url);
      if (!this.attempt || this.attempt.state !== state) {
        this.error = "此连接已过期，或由另一个 QM 账户发起。请登录要连接的账户后重试。";
        return;
      }
      if (cancelled) {
        this.clearAttempt();
        this.error = "Slack 授权已取消，尚未关联你的 QM 账户。";
        return;
      }
      void this.complete();
    } else void this.status();
  }

  private clearAttempt(): void {
    this.attempt = null;
    sessionStorage.removeItem("qm-slack-account");
  }

  private async status(): Promise<void> {
    try {
      const response = await fetch(withBase("/api/composio/slack"), {
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return;
      const result = await response.json();
      this.connected = result.connected === true;
      this.label = [result.user, result.workspace].filter(Boolean).join(" · ");
    } catch {
      return;
    }
  }

  private async connect(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    try {
      const state = crypto.randomUUID();
      const response = await fetch(withBase("/api/composio/slack/authorize"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state, returnTo: `${location.pathname}${location.search}` }),
        signal: AbortSignal.timeout(30_000),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.message ?? "无法发起 Slack 授权，请重试。");
      const url = new URL(result.url);
      if (
        url.protocol !== "https:" ||
        !["connect.composio.dev", "app.composio.dev"].includes(url.hostname) ||
        url.username ||
        url.password ||
        typeof result.ticket !== "string"
      )
        throw Error("无法验证 Slack 授权链接。");
      this.attempt = { user: this.user, state, ticket: result.ticket, expiresAt: Date.now() + 20 * 60_000 };
      sessionStorage.setItem("qm-slack-account", JSON.stringify(this.attempt));
      location.assign(url.href);
    } catch (error) {
      this.error = error instanceof Error ? error.message : "无法连接 Slack。";
    } finally {
      this.busy = false;
    }
  }

  private async complete(): Promise<void> {
    if (this.busy || !this.attempt) return;
    this.busy = true;
    this.error = "";
    try {
      const response = await fetch(withBase("/api/composio/slack/complete"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket: this.attempt.ticket }),
        signal: AbortSignal.timeout(45_000),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.message ?? "无法验证你的 Slack 账户，请重试。");
      this.connected = true;
      this.label = [result.user, result.workspace].filter(Boolean).join(" · ");
      this.clearAttempt();
    } catch (error) {
      this.error = error instanceof Error ? error.message : "无法验证你的 Slack 账户。";
    } finally {
      this.busy = false;
    }
  }

  protected render() {
    return html`<section class="slack-account" aria-label="你的 Slack 账户">
      ${
        this.connected
          ? html`<div class="slack-connected" role="status">
              ${icon(Check, 14)}<span>你的 Slack 账户已关联${this.label ? ` · ${this.label}` : ""}</span>
            </div>`
          : html`<button class="welcome-slack" type="button" ?disabled=${this.busy} @click=${() => void this.connect()}>
              <div class="slack-link-icon" aria-hidden="true">
                <span class="slack-link-person">${icon(UserRound, 17)}</span>
                <span class="slack-link-service">${slackMark(18)}</span>
                <span class="slack-link-chain">${icon(Link2, 13)}</span>
              </div>
              <span
                ><strong>${this.busy ? "正在关联 Slack…" : "关联你的 Slack 账户"}</strong
                ><small>让 QM 代你搜索 Slack 并执行操作。</small></span
              >
              ${icon(ArrowUpRight, 16)}
            </button>`
      }
      ${this.error ? html`<p class="slack-account-error" role="alert">${this.error}</p>` : nothing}
      ${this.attempt && !this.connected ? html`<button class="btn" type="button" ?disabled=${this.busy} @click=${() => void this.complete()}>检查连接</button>` : nothing}
    </section>`;
  }
}

if (!customElements.get("qm-slack-account")) customElements.define("qm-slack-account", SlackAccount);
