import { html, render, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { Search, X } from "lucide";
import { api } from "./core-bridge";
import { closeFormMenus, icon, initials, menuSelect } from "./ui";
import { scopeChip } from "./contexts";
import { friendlyPrincipal } from "./deploy-view";
import { errMessage } from "../../chassis/src/errors";
import { peopleResults, type DirectoryMatch } from "./people-results";

interface Grant {
  scope: string;
  permission: "read" | "write";
}

export async function openDeploymentPermissions(id: string, title: string, owner: string): Promise<void> {
  const opener = document.activeElement as HTMLElement | null;
  const dialog = document.createElement("dialog");
  dialog.className = "project-dialog deployment-permissions-dialog";
  dialog.setAttribute("aria-labelledby", "deployment-permissions-heading");
  document.body.append(dialog);
  let grantees: Grant[] = [];
  let matches: DirectoryMatch[] = [];
  let query = "";
  let access = "view";
  let selected: DirectoryMatch | null = null;
  let searchSequence = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let searching = false;
  const names = new Map<string, string>();
  let busy = true;
  let loaded = false;
  let error = "";
  let searched = false;
  const endpoint = `/api/deployments/${encodeURIComponent(id)}/share`;
  const close = () => {
    clearTimeout(timer);
    searchSequence++;
    closeFormMenus();
    dialog.close();
    dialog.remove();
    if (opener?.isConnected) opener.focus();
  };
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (closeFormMenus()) return;
    close();
  });
  const change = async (scope: string, value: string) => {
    if (busy) return;
    closeFormMenus();
    busy = true;
    error = "";
    draw();
    try {
      const response = await api<{ grantees: Grant[] }>(endpoint, {
        method: "POST",
        body: JSON.stringify({ scope, access: value }),
      });
      grantees = response.grantees;
      selected = null;
      query = "";
      searched = false;
      searchSequence++;
      matches = [];
    } catch (e) {
      error = errMessage(e, "无法更新权限。");
    } finally {
      busy = false;
      if (dialog.isConnected) draw();
    }
  };
  const search = async () => {
    const sequence = ++searchSequence;
    const term = query.trim();
    if (!term) {
      matches = [];
      searched = false;
      searching = false;
      draw();
      return;
    }
    searching = true;
    error = "";
    draw();
    try {
      const response = await api<{ matches?: DirectoryMatch[] }>(
        `/api/directory/resolve?q=${encodeURIComponent(term)}`,
      );
      if (sequence !== searchSequence || !dialog.isConnected) return;
      matches = (response.matches ?? [])
        .filter(
          (person) =>
            `personal:${person.principalId}` !== owner &&
            !grantees.some((grant) => grant.scope === `personal:${person.principalId}`),
        )
        .slice(0, 8);
      searched = true;
    } catch (e) {
      if (sequence === searchSequence) error = errMessage(e, "无法查找人员。");
    } finally {
      if (sequence === searchSequence && dialog.isConnected) {
        searching = false;
        draw();
      }
    }
  };
  const permissionMenu = (value: string, label: string, update: (value: string) => void, removable = false) =>
    html`<fieldset class="permission-control" ?disabled=${busy}>
      ${menuSelect({
        value,
        ariaLabel: label,
        options: [
          { value: "view", label: "可查看" },
          { value: "manage", label: "可管理" },
          ...(removable ? [{ value: "none", label: "移除访问权限" }] : []),
        ],
        onSelect: (next) => {
          if (next) update(next);
        },
      })}
    </fieldset>`;
  const draw = () =>
    render(
      html`
        <div class="project-dialog-head">
          <div>
            <h2 id="deployment-permissions-heading">应用权限</h2>
            <p>${title}</p>
          </div>
          <button class="chip-x" type="button" aria-label="关闭" @click=${close}>${icon(X, 16)}</button>
        </div>
        ${
          loaded
            ? html` <div class="permission-search">
                ${
                  selected
                    ? html`<div class="permission-invite">
                        <div class="permission-person">
                          <span class="project-member-avatar">${initials(selected.displayName)}</span
                          ><span class="permission-person-label"
                            >${selected.displayName}<small>${selected.principalId}</small></span
                          >
                        </div>
                        <button
                          class="chip-x"
                          aria-label="取消选择"
                          ?disabled=${busy}
                          @click=${() => {
                            selected = null;
                            draw();
                          }}
                        >
                          ${icon(X, 14)}
                        </button>
                        <div class="permission-invite-actions">
                          ${permissionMenu(access, "新成员权限", (value) => {
                            access = value;
                            draw();
                          })}<button
                            class="btn primary"
                            ?disabled=${busy}
                            @click=${() => {
                              if (selected) {
                                names.set(`personal:${selected.principalId}`, selected.displayName);
                                void change(`personal:${selected.principalId}`, access);
                              }
                            }}
                          >
                            添加
                          </button>
                        </div>
                      </div>`
                    : html`<form
                        @submit=${(event: SubmitEvent) => {
                          event.preventDefault();
                          clearTimeout(timer);
                          void search();
                        }}
                      >
                        <div class="project-member-search-row">
                          ${icon(Search, 16)}<input
                            id="app-people-query"
                            aria-label="添加成员"
                            placeholder="按姓名或账户名添加成员"
                            type="search"
                            autocomplete="off"
                            maxlength="80"
                            .value=${live(query)}
                            ?disabled=${busy}
                            @input=${(event: Event) => {
                              query = (event.currentTarget as HTMLInputElement).value;
                              searchSequence++;
                              matches = [];
                              searched = false;
                              clearTimeout(timer);
                              timer = setTimeout(() => void search(), 200);
                            }}
                          />
                        </div>
                        ${peopleResults(matches, busy, (person) => {
                          selected = person;
                          closeFormMenus();
                          draw();
                        })}
                        ${searching ? html`<p class="permission-note" role="status">正在搜索…</p>` : nothing}
                        ${!searching && searched && !matches.length ? html`<p class="permission-note">没有找到其他成员。</p>` : nothing}
                      </form>`
                }
              </div>`
            : nothing
        }
        <div class="permission-section-label">有权访问的成员</div>
        <div class="project-member-list">
          <div class="permission-row">
            <span class="project-member-avatar" aria-hidden="true">${initials(owner.replace("personal:", ""))}</span
            ><span class="permission-person-label"
              >${owner.startsWith("personal:") ? friendlyPrincipal(owner.slice(9)) : scopeChip(owner)}</span
            ><span class="permission-owner">所有者</span>
          </div>
          ${grantees.map((grant) => html`<div class="permission-row"><span class="project-member-avatar" aria-hidden="true">${initials(grant.scope.replace("personal:", ""))}</span><span class="permission-person-label">${names.get(grant.scope) ?? (grant.scope.startsWith("personal:") ? grant.scope.slice(9) : scopeChip(grant.scope))}${names.has(grant.scope) ? html`<small>${grant.scope.replace("personal:", "")}</small>` : nothing}</span>${permissionMenu(grant.permission === "write" ? "manage" : "view", `${grant.scope} 的访问权限`, (value) => void change(grant.scope, value), true)}</div>`)}
        </div>
        ${busy ? html`<p role="status">加载中…</p>` : nothing}
        ${error ? html`<p class="composer-error" role="alert">${error}</p>` : nothing}
        <div class="project-dialog-actions actions"><button class="btn" @click=${close}>完成</button></div>
      `,
      dialog,
    );
  draw();
  dialog.showModal();
  try {
    grantees = (await api<{ grantees: Grant[] }>(endpoint)).grantees;
    loaded = true;
  } catch (e) {
    error = errMessage(e, "无法加载权限。");
  } finally {
    busy = false;
    if (dialog.isConnected) draw();
  }
}
