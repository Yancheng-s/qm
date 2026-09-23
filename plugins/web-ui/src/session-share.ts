import { html, render } from "lit";
import { X, Link, Copy, Check, Users, Globe, ChevronDown } from "lucide";
import { icon, toggleFormMenu, closeFormMenus } from "./ui";
import { api, withBase } from "./core-bridge";

interface ShareState {
  share: { token: string; audience: "internal" | "external"; createdAt: number } | null;
}

export async function openSessionShare(id: string): Promise<void> {
  const opener = document.activeElement as HTMLElement | null;
  const dialog = document.createElement("dialog");
  dialog.className = "project-dialog session-share-dialog";
  document.body.append(dialog);
  const chat = document.getElementById("main");
  const position = () => {
    const bounds = chat?.getBoundingClientRect();
    const left = Math.max(0, bounds?.left ?? 0);
    const right = Math.min(window.innerWidth, bounds?.right ?? window.innerWidth);
    dialog.style.left = `${left}px`;
    dialog.style.right = `${window.innerWidth - right}px`;
    dialog.style.setProperty("--share-dialog-space", `${right - left}px`);
  };
  const resize = new ResizeObserver(position);
  if (chat) resize.observe(chat);
  window.addEventListener("resize", position);
  position();
  let state: ShareState = { share: null };
  let busy = false;
  let audience = "internal";
  let error = "";
  let copied = false;
  const endpoint = `/api/sessions/${encodeURIComponent(id)}/share`;
  const close = () => {
    resize.disconnect();
    window.removeEventListener("resize", position);
    closeFormMenus();
    dialog.close();
    dialog.remove();
    if (opener?.isConnected) opener.focus();
  };
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !dialog.querySelector(".form-menu-control.open")) return;
    event.preventDefault();
    event.stopPropagation();
    closeFormMenus();
    dialog.querySelector<HTMLButtonElement>(".share-audience-button")?.focus();
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  const change = async () => {
    busy = true;
    error = "";
    copied = false;
    draw();
    try {
      state = await api<ShareState>(endpoint, { method: "POST", body: JSON.stringify({ audience }) });
    } catch (e) {
      error = e instanceof Error ? e.message : "无法创建分享。";
    } finally {
      busy = false;
      draw();
    }
  };
  const draw = () => {
    const saveLabel = state.share ? "创建新链接" : "创建链接";
    const url = state.share
      ? new URL(withBase(`/share/${state.share.audience}/${state.share.token}`), location.origin).href
      : "";
    render(
      html`
        <div class="project-dialog-head">
          <div><h2 id="session-share-heading">分享对话</h2></div>
          <button class="chip-x" type="button" aria-label="关闭" @click=${close}>${icon(X, 16)}</button>
        </div>
        <div class="share-access-row">
          <span class="share-access-icon">${icon(audience === "external" ? Globe : Users, 18)}</span>
          <div class="form-menu-control menu-control share-audience" data-drop="down">
            <button
              class="btn menu-button share-audience-button"
              type="button"
              aria-label="谁可以查看"
              aria-haspopup="menu"
              aria-expanded="false"
              ?disabled=${busy}
              @click=${toggleFormMenu}
              @keydown=${(event: KeyboardEvent) => {
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                event.preventDefault();
                const control = (event.currentTarget as HTMLElement).parentElement!;
                if (!control.classList.contains("open")) toggleFormMenu(event);
                const options = control.querySelectorAll<HTMLButtonElement>(".menu-option");
                options[event.key === "ArrowUp" ? options.length - 1 : 0]?.focus();
              }}
            >
              <span>${audience === "external" ? "知道链接的任何人" : "组织内的任何人"}</span>${icon(ChevronDown, 14)}
            </button>
            <div
              class="menu-popover share-audience-menu"
              role="menu"
              aria-label="谁可以查看"
              hidden
              @keydown=${(event: KeyboardEvent) => {
                const options = [
                  ...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>(".menu-option"),
                ];
                const index = options.indexOf(document.activeElement as HTMLButtonElement);
                if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                  event.preventDefault();
                  let next = (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
                  if (event.key === "Home") next = 0;
                  if (event.key === "End") next = options.length - 1;
                  options[next]?.focus();
                }
              }}
            >
              ${(["internal", "external"] as const).map(
                (value) =>
                  html`<button
                    type="button"
                    role="menuitemradio"
                    aria-checked=${audience === value}
                    class=${`menu-option ${audience === value ? "active" : ""}`}
                    @click=${() => {
                      audience = value;
                      state = { share: null };
                      copied = false;
                      error = "";
                      closeFormMenus();
                      draw();
                      dialog.querySelector<HTMLButtonElement>(".share-audience-button")?.focus();
                    }}
                  >
                    ${icon(value === "external" ? Globe : Users, 16)}<span class="menu-option-label"
                      >${value === "external" ? "知道链接的任何人" : "组织内的任何人"}</span
                    >${audience === value ? icon(Check, 15) : ""}
                  </button>`,
              )}
            </div>
          </div>
          <span class="share-access-label">可查看</span>
        </div>
        ${audience === "external" ? html`<p class="share-external-warning" role="status">⚠️ 允许外部访问，请核对分享内容。</p>` : ""}
        ${
          state.share
            ? html`
                <div class="share-link-row project-name-field">
                  <input
                    aria-label="分享链接"
                    readonly
                    .value=${url}
                    @click=${(e: Event) => (e.target as HTMLInputElement).select()}
                  />
                  <button
                    class="btn primary"
                    type="button"
                    ?disabled=${busy}
                    @click=${async () => {
                      try {
                        await writeClipboardText(url);
                        copied = true;
                      } catch {
                        error = "复制失败，请选中并复制上方链接。";
                      }
                      draw();
                    }}
                  >
                    ${icon(copied ? Check : Copy, 14)}${copied ? "已复制" : "复制链接"}
                  </button>
                </div>
              `
            : ""
        }
        <p class="share-privacy-note">
          除非重新分享，否则后续消息不会显示。${url ? html`<a class="as-link" href=${url} target="_blank" rel="noreferrer">预览</a>` : ""}
        </p>
        ${error ? html`<div class="composer-error" role="alert">${error}</div>` : ""}
        <div class="project-dialog-actions actions">
          <button
            class=${state.share ? "btn" : "btn primary"}
            type="button"
            ?disabled=${busy}
            @click=${() => void change()}
          >
            ${!state.share ? icon(Link, 14) : ""}${busy ? "加载中…" : saveLabel}
          </button>
        </div>
      `,
      dialog,
    );
  };
  dialog.setAttribute("aria-labelledby", "session-share-heading");
  draw();
  dialog.showModal();
}
import { writeClipboardText } from "./clipboard.ts";
