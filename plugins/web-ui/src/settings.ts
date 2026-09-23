import "./slack-account";
import { openModelConnectManager, type StatusResponse } from "./model-connect";
import { api } from "./core-bridge";
import { html, nothing, render, type TemplateResult } from "lit";
import { BookOpen, ExternalLink, LogOut, Monitor, Moon, ShieldUser, Sun, type IconNode } from "lucide";
import { icon } from "./ui";
import { ADMIN_HOME_URL, appState, can, signOut } from "./shell";
import { sessionsState, setWebOnly } from "./sessions";
import { errMessage } from "../../chassis/src/errors";
import { importTheme, isPalette, themeCss, themeTokens, type Palette } from "./theme-import";

export type ThemeChoice = "light" | "dark" | "system" | "custom";

const THEME_KEY = "theme";
const CUSTOM_THEME_KEY = "theme:custom";
const CUSTOM_THEME_STYLE_ID = "custom-theme";
const THEME_FILE_ACCEPT = ".itermcolors,.plist,.json,.jsonc,application/json,text/xml,application/xml";

const QM_ABOUT_URL = "https://github.com/yc-software/qm";

const THEME_OPTIONS: Array<{ value: ThemeChoice; label: string; glyph: IconNode }> = [
  { value: "light", label: "浅色", glyph: Sun },
  { value: "dark", label: "深色", glyph: Moon },
  { value: "system", label: "跟随系统", glyph: Monitor },
];

let settingsHost: HTMLElement | null = null;
let themeImportError: string | null = null;

export function storedTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") return stored;
    if (stored === "custom" && storedCustomTheme()) return stored;
  } catch {
    void 0;
  }
  return "system";
}

export function storedCustomTheme(): Palette | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CUSTOM_THEME_KEY) ?? "null");
    return isPalette(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function storeCustomTheme(palette: Palette | null): void {
  try {
    if (palette) localStorage.setItem(CUSTOM_THEME_KEY, JSON.stringify(palette));
    else localStorage.removeItem(CUSTOM_THEME_KEY);
  } catch {
    void 0;
  }
}

let themeParentOrigin: string | null = null;

function publishTheme(): void {
  if (!themeParentOrigin) return;
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const colors = Object.fromEntries(
    ["--background", "--foreground", "--secondary", "--muted-foreground", "--border", "--brand-accent"].map((key) => [
      key,
      style.getPropertyValue(key).trim(),
    ]),
  );
  window.parent.postMessage({ type: "qm:theme", dark: root.classList.contains("dark"), colors }, themeParentOrigin);
}

export function applyTheme(): void {
  const choice = storedTheme();
  const custom = choice === "custom" ? storedCustomTheme() : null;
  const root = document.documentElement;
  let styleEl = document.getElementById(CUSTOM_THEME_STYLE_ID);
  if (custom) {
    const tokens = themeTokens(custom);
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = CUSTOM_THEME_STYLE_ID;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = themeCss(tokens);
    root.classList.toggle("dark", tokens.dark);
    publishTheme();
    return;
  }
  styleEl?.remove();
  const dark = choice === "system" ? window.matchMedia("(prefers-color-scheme: dark)").matches : choice === "dark";
  root.classList.toggle("dark", dark);
  publishTheme();
}

export function setTheme(choice: ThemeChoice): void {
  themeImportError = null;
  try {
    if (choice === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    void 0;
  }
  applyTheme();
  drawSettings();
}

export function installCustomTheme(palette: Palette): void {
  storeCustomTheme(palette);
  setTheme("custom");
}

export function removeCustomTheme(): void {
  const wasActive = storedTheme() === "custom";
  storeCustomTheme(null);
  setTheme(wasActive ? "system" : storedTheme());
}

async function onThemeFileChosen(e: Event): Promise<void> {
  const input = e.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    installCustomTheme(importTheme(file.name, await file.text()));
  } catch (err) {
    themeImportError = errMessage(err, "无法读取主题文件。");
    drawSettings();
  }
}

export function watchSystemTheme(): void {
  window.addEventListener("message", (event) => {
    if (window.parent === window || event.source !== window.parent || event.origin === "null") return;
    if (event.data?.type !== "qm:theme-request") return;
    themeParentOrigin = event.origin;
    publishTheme();
  });
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === THEME_KEY || event.key === CUSTOM_THEME_KEY) applyTheme();
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (storedTheme() === "system") applyTheme();
  });
}

function themeSwatches(palette: Palette): TemplateResult {
  const { vars } = themeTokens(palette);
  const swatches = [vars["--background"], vars["--syntax-tag"], vars["--syntax-string"], vars["--primary"]];
  return html`
    <span class="theme-swatches" aria-hidden="true">
      ${swatches.map((color) => html`<span class="theme-swatch" style="background:${color}"></span>`)}
    </span>
  `;
}

function themeOption(
  value: ThemeChoice,
  current: ThemeChoice,
  label: string,
  glyph: TemplateResult | SVGElement,
): TemplateResult {
  return html`
    <button
      class="settings-choice-option ${current === value ? "selected" : ""}"
      type="button"
      role="radio"
      aria-checked=${current === value ? "true" : "false"}
      @click=${() => setTheme(value)}
    >
      ${glyph}<span>${label}</span>
    </button>
  `;
}

function themeRow(): TemplateResult {
  const current = storedTheme();
  const custom = storedCustomTheme();
  const note = themeImportError
    ? html`<span class="settings-row-error">${themeImportError}</span>`
    : "“跟随系统”会使用设备的浅色或深色设置。也可导入 iTerm2 .itermcolors 或 VS Code 颜色主题 .json 文件。";
  return html`
    <div class="settings-row">
      <div class="settings-row-copy">
        <div class="settings-row-title">主题</div>
        <div class="settings-row-note">${note}</div>
      </div>
      <div class="settings-theme-controls">
        <div class="settings-choice" role="radiogroup" aria-label="主题">
          ${THEME_OPTIONS.map((option) => themeOption(option.value, current, option.label, icon(option.glyph, 15)))}
          ${custom ? themeOption("custom", current, custom.name, themeSwatches(custom)) : nothing}
        </div>
        <div class="settings-theme-import">
          <input
            class="theme-file-input"
            type="file"
            hidden
            accept=${THEME_FILE_ACCEPT}
            @change=${(e: Event) => void onThemeFileChosen(e)}
          />
          <button
            class="settings-theme-link"
            type="button"
            @click=${(e: Event) =>
              (e.currentTarget as HTMLElement).parentElement
                ?.querySelector<HTMLInputElement>(".theme-file-input")
                ?.click()}
          >
            ${custom ? "替换主题文件" : "导入主题文件"}
          </button>
          ${
            custom
              ? html`
                  <button
                    class="settings-theme-link"
                    type="button"
                    aria-label="移除导入的主题"
                    @click=${() => removeCustomTheme()}
                  >
                    移除
                  </button>
                `
              : nothing
          }
        </div>
      </div>
    </div>
  `;
}

const SURFACE_OPTIONS: Array<{ webOnly: boolean; label: string }> = [
  { webOnly: false, label: "所有对话" },
  { webOnly: true, label: "仅网页" },
];

function sidebarSurfaceRow(): TemplateResult {
  return html`
    <div class="settings-row">
      <div class="settings-row-copy">
        <div class="settings-row-title">侧边栏对话</div>
        <div class="settings-row-note">“仅网页”会隐藏智能体参与的 Slack 频道和私聊。</div>
      </div>
      <div class="settings-choice" role="radiogroup" aria-label="侧边栏对话">
        ${SURFACE_OPTIONS.map(
          (option) => html`
            <button
              class="settings-choice-option ${sessionsState.webOnly === option.webOnly ? "selected" : ""}"
              type="button"
              role="radio"
              aria-checked=${sessionsState.webOnly === option.webOnly ? "true" : "false"}
              @click=${() => {
                setWebOnly(option.webOnly);
                drawSettings();
              }}
            >
              <span>${option.label}</span>
            </button>
          `,
        )}
      </div>
    </div>
  `;
}

let aiStatus: StatusResponse | null = null;
let aiError = "";
let aiBusy = false;
let aiSaving = false;
let aiRevision = 0;

function acceptAiStatus(status: StatusResponse): void {
  aiRevision++;
  aiStatus = status;
  if (appState.me) {
    appState.me.individualModelAuth = status.individualModelAuth;
    appState.me.modelAuthConnected = status.connections.some(
      (c) => status.account === "personal" || status.account === c.provider,
    );
  }
  drawSettings();
}

window.addEventListener("model-account-changed", (event) => {
  const status = (event as CustomEvent<StatusResponse>).detail;
  if (status) {
    aiBusy = false;
    acceptAiStatus(status);
  }
});

async function loadAiStatus(): Promise<void> {
  if (aiSaving) return;
  const revision = ++aiRevision;
  aiBusy = true;
  aiError = "";
  drawSettings();
  try {
    const status = await api<StatusResponse>("/api/user-model-auth/status");
    if (revision !== aiRevision) return;
    acceptAiStatus(status);
  } catch (error) {
    aiError = errMessage(error);
  }
  aiBusy = false;
  drawSettings();
}

async function chooseAiAccount(account: "company" | "anthropic" | "openai"): Promise<void> {
  if (aiBusy || aiSaving) return;
  if (
    account === aiStatus?.account &&
    (account === "company" || aiStatus.connections.some((c) => c.provider === account))
  )
    return;
  if (account !== "company" && !aiStatus?.connections.some((c) => c.provider === account)) {
    openModelConnectManager(account);
    return;
  }
  aiSaving = true;
  aiError = "";
  drawSettings();
  try {
    const status = await api<StatusResponse>("/api/user-model-auth/account", {
      method: "POST",
      body: JSON.stringify({
        account: account === "company" ? "company" : "personal",
        provider: account === "company" ? undefined : account,
      }),
    });
    acceptAiStatus(status);
    window.dispatchEvent(new CustomEvent("model-account-changed", { detail: status }));
  } catch (error) {
    aiError = errMessage(error);
  }
  aiSaving = false;
  drawSettings();
}

function aiAccountsRow(): TemplateResult {
  return html`
    <div class="settings-row">
      <div class="settings-row-copy">
        <div class="settings-row-title">AI 服务</div>
        <div class="settings-row-note">使用组织提供的服务或个人订阅。</div>
        ${aiError ? html`<div class="settings-row-error" role="alert">${aiError} <button class="settings-theme-link" ?disabled=${aiSaving} @click=${loadAiStatus}>重试</button></div>` : nothing}
      </div>
      <div class="settings-ai-controls">
        <div class="settings-choice" role="group" aria-label="AI 服务">
          ${(
            [
              ["company", "组织"],
              ["anthropic", "Claude"],
              ["openai", "ChatGPT / Codex"],
            ] as const
          ).map(
            ([value, label]) => html`
              <button
                type="button"
                class="settings-choice-option ${aiStatus?.account === value ? "selected" : ""}"
                aria-pressed=${aiStatus?.account === value}
                ?disabled=${aiBusy || aiSaving || !aiStatus || (value === "company" && aiStatus.required)}
                @click=${() => void chooseAiAccount(value)}
              >
                ${label}
              </button>
            `,
          )}
        </div>
        ${aiStatus?.account === "anthropic" || aiStatus?.account === "openai" ? html`<button class="settings-theme-link" ?disabled=${aiBusy || aiSaving} @click=${() => openModelConnectManager(aiStatus!.account as "anthropic" | "openai")}>连接设置</button>` : nothing}
      </div>
    </div>
  `;
}

function adminRow(): TemplateResult {
  return html`
    <div class="settings-row">
      <div class="settings-row-copy">
        <div class="settings-row-title">管理后台</div>
        <div class="settings-row-note">组织设置、成员和策略。</div>
      </div>
      <a class="btn settings-row-action" href=${ADMIN_HOME_URL}>
        ${icon(ShieldUser, 15)}<span>打开管理后台</span>${icon(ExternalLink, 14)}
      </a>
    </div>
  `;
}

function aboutRow(): TemplateResult {
  return html`
    <div class="settings-row">
      <div class="settings-row-copy">
        <div class="settings-row-title">了解 QM</div>
        <div class="settings-row-note">了解 Y Combinator 为什么创建此开源智能体框架，以及如何自行部署。</div>
      </div>
      <a class="btn settings-row-action" href=${QM_ABOUT_URL} target="_blank" rel="noreferrer noopener">
        ${icon(BookOpen, 15)}<span>阅读发布说明</span>${icon(ExternalLink, 14)}
      </a>
    </div>
  `;
}

function accountRow(): TemplateResult {
  const me = appState.me;
  return html`
    <div class="settings-row">
      <div class="settings-row-copy">
        <div class="settings-row-title">账户</div>
        <div class="settings-row-note">
          ${me?.displayName?.trim() || me?.user || "未登录"}${me?.org ? ` · ${me.org}` : ""}
        </div>
      </div>
      <button class="btn settings-row-action" type="button" @click=${() => void signOut()}>
        ${icon(LogOut, 15)}<span>退出登录</span>
      </button>
    </div>
  `;
}

function settingsPane(): TemplateResult {
  return html`
    <div class="list-page-head">
      <h1 class="pane-title">设置</h1>
    </div>
    <div class="settings-group">
      ${aiAccountsRow()} ${themeRow()} ${sidebarSurfaceRow()} ${can("admin") ? adminRow() : nothing} ${aboutRow()}
      ${accountRow()}
      <div class="settings-row settings-slack-account">
        <qm-slack-account .user=${`${appState.me?.org}:${appState.me?.user}`}></qm-slack-account>
      </div>
    </div>
  `;
}

function drawSettings(): void {
  if (appState.currentView !== "settings" || !appState.mainEl) return;
  if (!settingsHost || settingsHost.parentElement !== appState.mainEl) {
    settingsHost = document.createElement("div");
    settingsHost.className = "pane settings-page";
    appState.mainEl.replaceChildren(settingsHost);
  }
  render(settingsPane(), settingsHost);
}

export function renderSettings(): void {
  drawSettings();
  void loadAiStatus();
}
