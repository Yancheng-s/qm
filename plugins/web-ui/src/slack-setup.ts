import { html, LitElement, nothing } from "lit";

// This is a bot installation, not a personal Slack account connection.
class SlackSetup extends LitElement {
  private timer?: ReturnType<typeof setTimeout>;
  private request?: AbortController;
  private appReady = false;
  private connected = false;
  private unavailable = false;
  private forbidden = false;
  private startedAt = 0;
  private links?: { tokenUrl: string; submitUrl: string; installUrl: string };

  protected createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.startedAt = Date.now();
    document.addEventListener("visibilitychange", this.refreshVisible);
    window.addEventListener("focus", this.refreshVisible);
    void this.refresh();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    clearTimeout(this.timer);
    this.request?.abort();
    document.removeEventListener("visibilitychange", this.refreshVisible);
    window.removeEventListener("focus", this.refreshVisible);
  }

  private refreshVisible = (): void => {
    if (!document.hidden && !this.request) void this.refresh();
  };

  private async refresh(): Promise<void> {
    if (this.request || !this.isConnected) return;
    clearTimeout(this.timer);
    const controller = new AbortController();
    this.request = controller;
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch("/admin/api/slack-installation", {
        signal: controller.signal,
        credentials: "same-origin",
        redirect: "error",
      });
      this.forbidden = response.status === 401 || response.status === 403;
      if (!response.ok) throw new Error("状态不可用");
      const data = await response.json();
      if (!data.setup || data.setupUnavailable) throw new Error("状态不可用");
      const { tokenUrl, submitUrl, installUrl } = data.setup;
      if (
        tokenUrl !== "https://api.slack.com/apps" ||
        submitUrl !== `${location.origin}/admin?slack=setup` ||
        installUrl !== `${location.origin}/admin?slack=install`
      )
        throw new Error("设置链接无效");
      this.links = { tokenUrl, submitUrl, installUrl };
      this.appReady = data.setup.appReady === true;
      this.connected = data.configured === true && data.setup.connected === true;
      this.unavailable = false;
    } catch {
      this.unavailable = true;
      // A stale success is not evidence of a current connection.
      this.connected = false;
    } finally {
      clearTimeout(timeout);
      this.request = undefined;
      if (this.isConnected) {
        this.requestUpdate();
        if (!this.connected && !this.forbidden && Date.now() - this.startedAt < 10 * 60_000) {
          this.timer = setTimeout(() => {
            if (!document.hidden) void this.refresh();
          }, 5_000);
        }
      }
    }
  }

  protected render() {
    if (this.forbidden) return html`<p>只有 QM 管理员可以设置 Slack 机器人。</p>`;
    if (this.connected)
      return html`<div class="connector-widget connected" role="status">
        <span class="connector-widget-text"
          ><strong>已连接 Slack</strong><small>机器人已安装，你可以返回入门引导。</small></span
        >
      </div>`;
    if (!this.links)
      return html`<p role="status">
        ${this.unavailable ? "暂时无法获取 Slack 设置状态。" : "正在检查 Slack 设置…"}
        <button type="button" @click=${() => void this.refresh()}>重试</button>
      </p>`;
    let progress = this.appReady ? "等待 Slack 授权。" : "等待提交令牌。";
    if (this.unavailable) progress = "无法检查进度，设置仍已保留。";
    return html`<section class="slack-setup-checklist" aria-label="将 QM 添加到 Slack">
      <strong>将 QM 添加到 Slack</strong>
      <ol>
        <li>
          <a href=${this.links.tokenUrl} target="_blank" rel="noreferrer">创建令牌</a><br /><small
            >在 App Configuration Tokens 中选择 Generate Token，选定工作区，然后复制访问令牌（不是刷新令牌）。</small
          >
          <details>
            <summary>查看操作方法</summary>
            <img
              src=${new URL("../../../docs/images/slack-app-config-token-setup.gif", import.meta.url).href}
              alt="生成 Slack 应用配置令牌，并复制其中的访问令牌"
              loading="lazy"
            />
          </details>
        </li>
        <li>
          <a href=${this.links.submitUrl} target="_blank" rel="noopener">安全提交令牌</a><br /><small
            >${this.appReady ? "应用已创建，无需再复制令牌。" : "请仅在安全表单中粘贴，不要发送到对话中。QM 用它创建应用后便会丢弃。"}</small
          >
        </li>
        <li>
          <a class="connector-widget" href=${this.links.installUrl} target="_blank" rel="noopener"
            ><span class="connector-widget-text"
              ><strong>添加到 Slack</strong
              ><small
                >${this.appReady ? "核对工作区，然后选择“允许”。" : "先提交令牌，再在 Slack 中选择“允许”。"}</small
              ></span
            ></a
          >
        </li>
      </ol>
      <small>此令牌可管理你在所选工作区拥有的其他应用。QM 创建的应用归你的公司所有。</small>
      <p role="status">${progress}</p>
      <button
        type="button"
        @click=${() => {
          this.startedAt = Date.now();
          void this.refresh();
        }}
      >
        检查进度
      </button>
      ${this.unavailable ? html`<small> 可以使用现有链接重试。</small>` : nothing}
    </section>`;
  }
}

if (!customElements.get("qm-slack-setup")) customElements.define("qm-slack-setup", SlackSetup);
