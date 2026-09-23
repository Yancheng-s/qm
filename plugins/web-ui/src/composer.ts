import { loadPiWebUi } from "./component-language";
import { appEditSlug } from "./app-edit";
import { getRuntimeConfig, loadRuntimeConfig, saveRuntimeConfig, subscribeRuntimeConfig } from "./runtime-config-store";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import { createFileDragState } from "./file-drag";
import type { Attachment } from "@earendil-works/pi-web-ui";
import { FolderDropError, folderToZipFile, isFolderReadError, splitDropItems, type DropEntryLike } from "./folder-drop";
import { html, nothing, render, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { repeat } from "lit/directives/repeat.js";
import { ArrowUp, Box, Camera, CornerDownRight, FileText, ImagePlus, Mic, Paperclip, Plus, Square, X } from "lucide";
import { createAudioRecorder, createVoiceInput } from "./voice-input";
import {
  api,
  ApiError,
  editQueuedRun,
  approvalBlocksComposer,
  MAX_ATTACHMENT_BYTES,
  MAX_FILES_PER_MESSAGE,
  mintSendKey,
  oversizeAttachmentNote,
  PENDING_APPROVAL_REASON,
  queueTurn,
  tooManyFilesNote,
  uploadAttachments,
  userSendMessage,
  withdrawRun,
  type ApprovalDecision,
  type CoreAttachment,
  type PendingApproval,
  type QueuedRun,
} from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { browserRenderableImage, fieldSelect, icon } from "./ui";
import {
  defaultEffortForModel,
  defaultModelValue,
  getModelOptions,
  harnessSupportsFastMode,
  harnessSupportsSteer,
  type EffortLevel,
  type ModelOption,
  type ModelOptionValue,
} from "./model-options";
import { modelSupportsFastMode } from "./pi-models";
import type { ComposerSurface, ConvCtx } from "./conv-types";
import { bumpSessionActivity, dropPendingSession, renderList } from "./sessions";
import { appState } from "./shell";
import { base64ToText, bytesToBase64, insertIntoDraft, pasteChipLabel } from "./paste-text";
import { clearDraft, newChatDraftKey, saveDraft } from "./drafts";
import { tip } from "./tooltip";
import { isPhone, onPhoneChange } from "./viewport";
import {
  LOADOUT_CAP,
  loadLoadout,
  saveLoadout,
  reconcileLoadout,
  upsertLoadout,
  effortLevelsForHarness,
  compatibleHarnessOptions,
  modelLoadoutOptions,
  type LoadoutEntry,
} from "./composer-loadout";

import { createModelPicker } from "./model-picker";

export type ComposerMenu = "effort" | "model" | "settings" | "loadout";

const LEGACY_MODEL_STORAGE_KEY = "web-ui:model";
const THREAD_PICKS_STORAGE_KEY = "web-ui:model-picks";
const THREAD_PICKS_CAP = 50;
function loadThreadPicks(): Map<string, ModelOptionValue> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(THREAD_PICKS_STORAGE_KEY) ?? "[]");
    if (Array.isArray(raw)) {
      const pairs = raw.filter(
        (p): p is [string, string] => Array.isArray(p) && typeof p[0] === "string" && typeof p[1] === "string",
      );
      return new Map(pairs.slice(-THREAD_PICKS_CAP));
    }
  } catch {
    void 0;
  }
  return new Map();
}

let threadModelPicks = loadThreadPicks();
function runtimeScopeKey(scopeId: string | null): string | null {
  if (scopeId) return scopeId;
  const user = appState.me?.user;
  return user ? `personal:${user}` : null;
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === THREAD_PICKS_STORAGE_KEY) threadModelPicks = loadThreadPicks();
  });
}

function rememberThreadPick(threadRef: string, value: ModelOptionValue): void {
  const merged = loadThreadPicks();
  for (const [ref, pick] of threadModelPicks) if (!merged.has(ref)) merged.set(ref, pick);
  merged.delete(threadRef);
  merged.set(threadRef, value);
  while (merged.size > THREAD_PICKS_CAP) merged.delete(merged.keys().next().value as string);
  threadModelPicks = merged;
  persistPreference(THREAD_PICKS_STORAGE_KEY, JSON.stringify([...merged]));
}

function forgetThreadPick(threadRef: string): void {
  threadModelPicks = loadThreadPicks();
  threadModelPicks.delete(threadRef);
  persistPreference(THREAD_PICKS_STORAGE_KEY, JSON.stringify([...threadModelPicks]));
}

export function carryModelPick(fromThreadRef: string | null, toThreadRef: string): void {
  const pick = fromThreadRef ? threadModelPicks.get(fromThreadRef) : undefined;
  if (pick) rememberThreadPick(toThreadRef, pick);
}

function modelOptionFor(value: ModelOptionValue, scopeKey?: string | null): ModelOption | undefined {
  return getModelOptions(scopeKey).find((option) => option.value === value);
}

function persistPreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    void 0;
  }
}

export interface SkillItem {
  id?: string;
  name: string;
  description: string;
  body?: string;
  scope: string;
  shadowed?: boolean;
  editable?: boolean;
  scopeId?: string;
  status?: string;
  version?: number;
  source?: "native" | "pack";
  pack?: { packId: string; commit: string; upstreamName: string };
  assetCount?: number;
  requiredCapabilities?: string[];
  createdBy?: string;
  files?: Array<{ path: string; executable?: boolean }>;
}
interface SkillMatch {
  skill: SkillItem;
  start: number;
  end: number;
}

let skillsCache: SkillItem[] | null = null;

export function clearSkillsCache(): void {
  skillsCache = null;
}

const SLASH_TOKEN = /(^|\s)\/([a-zA-Z0-9_-]*)$/;

export function slashQuery(draft: string): string | null {
  const m = SLASH_TOKEN.exec(draft);
  return m ? (m[2] ?? "") : null;
}

export function resyncModelSelection(): void {
  try {
    localStorage.removeItem(LEGACY_MODEL_STORAGE_KEY);
  } catch {
    void 0;
  }
}

export function createComposerSurface(ctx: ConvCtx): ComposerSurface {
  const refreshAccount = () => ctx.chat.drawActiveChat();
  window.addEventListener("model-account-changed", refreshAccount);
  let runtimeRequest = 0;
  let runtimeIdentity = "";
  let unsubscribeRuntime: (() => void) | undefined;
  let effortOverride: EffortLevel | undefined;
  let fastModeOverride: boolean | undefined;
  let restoredLoadout: LoadoutEntry | undefined;
  let loadoutRestored = false;
  let modelSelectionRevision = 0;
  let effortSelectionRevision = 0;
  let fastSelectionRevision = 0;

  function isUnsentNewChat(): boolean {
    return (
      ctx.chat.state.sessionId === null &&
      !(ctx.chat.state.agent?.state.messages ?? []).some((m) => !(m as { opener?: boolean }).opener)
    );
  }

  function persistDraft(): void {
    if (!ctx.chat.state.threadRef) return;
    saveDraft(ctx.chat.state.threadRef, composerState.draft);
    if (isUnsentNewChat()) saveDraft(newChatDraftKey(appState.me?.user), composerState.draft);
  }

  function clearActiveDraft(): void {
    if (ctx.chat.state.threadRef) clearDraft(ctx.chat.state.threadRef);
    if (ctx.chat.state.sessionId === null) clearDraft(newChatDraftKey(appState.me?.user));
  }

  const composerState = {
    draft: "",
    attachments: [] as Attachment[],
    error: "",
    processingFiles: false,
    dragging: false,
    openMenu: null as ComposerMenu | null,
    menuQuery: "",
    slashDismissed: false,
    get effortLevel(): EffortLevel {
      const selected = currentModelOption();
      const effort =
        effortOverride ??
        (restoredLoadout?.value === selected?.value ? restoredLoadout?.effort : undefined) ??
        (getRuntimeConfig(scopeKey())?.effective.effortLevel as EffortLevel | undefined) ??
        defaultEffortForModel(selected?.model);
      const levels = effortLevelsForHarness(selected?.harnessId ?? "");
      return levels.some((level) => level.value === effort) ? effort : "auto";
    },
    set effortLevel(value: EffortLevel) {
      ++effortSelectionRevision;
      effortOverride = value;
    },
    get fastMode(): boolean | undefined {
      const selected = currentModelOption();
      const fast =
        fastModeOverride ??
        (restoredLoadout?.value === selected?.value ? restoredLoadout?.fast : undefined) ??
        getRuntimeConfig(scopeKey())?.effective.fastMode === true;
      return (
        fast &&
        harnessSupportsFastMode(selected?.harnessId ?? "") &&
        modelSupportsFastMode(scopeKey(), selected?.model.id)
      );
    },
    set fastMode(value: boolean | undefined) {
      ++fastSelectionRevision;
      fastModeOverride = value;
    },
    pasteView: null as { id: string; text: string; initial: string; dirty: boolean } | null,
  };

  let attachmentsOpen = false;
  let voiceThread: string | null = null;
  const voice = createVoiceInput({
    supported: () =>
      Boolean(
        window.isSecureContext &&
        typeof navigator.mediaDevices?.getUserMedia === "function" &&
        typeof MediaRecorder !== "undefined",
      ),
    openMicrophone: () =>
      navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      }),
    createRecorder: createAudioRecorder,
    transcribe: async (audio, durationMs, signal) => {
      const result = await api<{ text: string }>("/api/asr", {
        method: "POST",
        signal,
        body: JSON.stringify({
          audio: bytesToBase64(new Uint8Array(await audio.arrayBuffer())),
          mimeType: audio.type,
          durationMs,
        }),
      });
      return result.text;
    },
    onChange: () => ctx.chat.drawActiveChat(),
    onText: (text) => {
      if (ctx.chat.state.threadRef !== voiceThread) return;
      composerState.draft = composerState.draft.trim() ? `${composerState.draft.trimEnd()} ${text}` : text;
      composerState.error = "";
      persistDraft();
      ctx.chat.drawActiveChat();
      focusComposerEnd();
    },
  });
  const cancelHiddenVoice = (): void => {
    if (document.hidden && voice.state.phase !== "idle") voice.cancel();
  };
  const cancelPageVoice = (): void => voice.cancel(false);
  document.addEventListener("visibilitychange", cancelHiddenVoice);
  window.addEventListener("pagehide", cancelPageVoice);
  const unsubscribePhone = onPhoneChange(() => {
    voice.cancel(false);
    attachmentsOpen = false;
    ctx.chat.drawActiveChat();
  });

  const pastedTextIds = new Set<string>();

  const queuedRuns = new Map<string, QueuedRun[]>();
  let queuedEdit: { runId: string; threadRef: string; original: string; text: string; saving: boolean } | null = null;

  function queuedRunsFor(threadRef: string | null): QueuedRun[] {
    return (threadRef ? queuedRuns.get(threadRef) : undefined) ?? [];
  }

  function setQueuedRuns(threadRef: string, runs: QueuedRun[]): void {
    if (runs.length) queuedRuns.set(threadRef, runs);
    else queuedRuns.delete(threadRef);
  }

  function forgetQueuedRun(threadRef: string, runId: string): void {
    setQueuedRuns(
      threadRef,
      queuedRunsFor(threadRef).filter((r) => r.runId !== runId),
    );
  }

  const fileDrag = createFileDragState((dragging) => {
    composerState.dragging = dragging;
    ctx.chat.drawActiveChat();
  });
  let skillsLoading = false;
  let slashActiveIndex = 0;
  function effectiveFastMode(): boolean {
    return composerState.fastMode === true;
  }

  function resetComposer(): void {
    voice.cancel(false);
    attachmentsOpen = false;
    composerState.draft = "";
    composerState.attachments = [];
    composerState.pasteView = null;
    pastedTextIds.clear();
    composerState.error = "";
    composerState.processingFiles = false;
    composerState.openMenu = null;
    slashActiveIndex = 0;
    composerState.slashDismissed = false;
  }

  function scopeKey(): string | null {
    return runtimeScopeKey(ctx.chat.state.scopeId);
  }

  function currentModelOption(): ModelOption | undefined {
    const picked = ctx.chat.state.threadRef ? threadModelPicks.get(ctx.chat.state.threadRef) : undefined;
    return modelOptionFor(picked ?? defaultModelValue(scopeKey()), scopeKey());
  }

  async function refreshRuntimeSelection(scopeId: string | null, agent?: Agent, refresh = false): Promise<void> {
    const request = ++runtimeRequest;
    const key = runtimeScopeKey(scopeId);
    const identity = `${key}:${ctx.chat.state.threadRef}`;
    const changedIdentity = identity !== runtimeIdentity;
    if (changedIdentity) {
      effortOverride = undefined;
      fastModeOverride = undefined;
      restoredLoadout = undefined;
      loadoutRestored = false;
      runtimeIdentity = identity;
    }
    unsubscribeRuntime?.();
    let defaults = getRuntimeConfig(key)?.effective;
    unsubscribeRuntime =
      key === null
        ? undefined
        : subscribeRuntimeConfig(key, () => {
            if (key !== scopeKey()) return;
            const next = getRuntimeConfig(key)?.effective;
            if (
              (["harnessId", "modelId", "effortLevel", "fastMode"] as const).some(
                (field) => defaults?.[field] !== next?.[field],
              )
            ) {
              restoredLoadout = undefined;
            }
            defaults = next;
            syncRuntimeSelection(ctx.chat.state.agent ?? undefined);
          });
    composerState.error = "";
    syncRuntimeSelection(agent);
    const config = key === null ? null : await loadRuntimeConfig(key, refresh);
    if (request !== runtimeRequest) return;
    if (!config) composerState.error = "无法加载运行设置。";
    if (config && !loadoutRestored) {
      restoreLoadoutSelection();
      loadoutRestored = true;
    }
    syncRuntimeSelection(agent);
  }

  function restoreLoadoutSelection(): void {
    loadout = loadLoadout();
    let selected = currentModelOption();
    const threadRef = ctx.chat.state.threadRef;
    if (selected && threadRef && !threadModelPicks.has(threadRef)) {
      const preferred = modelLoadoutOptions(getModelOptions(scopeKey()), loadout, selected.harnessId).find(
        (option) => option.model.id === selected!.model.id,
      );
      if (preferred && preferred.value !== selected.value) {
        rememberThreadPick(threadRef, preferred.value);
        selected = preferred;
      }
    }
    if (!selected) return;
    const saved = loadout.find((entry) => entry.value === selected.value);
    if (!saved) return;
    const normalized = normalizeLoadoutEntry(saved, selected);
    if (threadRef && threadModelPicks.has(threadRef)) {
      effortOverride ??= normalized.effort;
      fastModeOverride ??= normalized.fast;
    } else {
      restoredLoadout = normalized;
    }
  }

  function syncRuntimeSelection(agent?: Agent): void {
    const selected = currentModelOption();
    if (agent && selected) agent.state.model = selected.model;
    ctx.chat.drawActiveChat(agent);
    if (pendingComposerFocus) focusComposerEnd();
  }

  async function changeScopeRuntime(
    change: {
      harnessId?: string;
      modelId?: string;
      effortLevel?: string;
      fastMode?: boolean;
      inherit?: boolean;
      keep?: boolean;
    },
    agent: Agent,
    preserveSelection = false,
  ): Promise<void> {
    const request = ++runtimeRequest;
    const scopeId = scopeKey();
    if (!scopeId) return;
    composerState.error = "";
    const current = preserveSelection ? currentModelOption() : undefined;
    const settings = current ? activeLoadoutEntry(current) : undefined;
    const modelRevision = modelSelectionRevision;
    const effortRevision = effortSelectionRevision;
    const fastRevision = fastSelectionRevision;
    try {
      await saveRuntimeConfig(scopeId, change);
      if (request !== runtimeRequest || scopeId !== scopeKey()) return;
      if (modelSelectionRevision === modelRevision) {
        if (current && settings) {
          if (effortSelectionRevision === effortRevision) effortOverride = settings.effort;
          if (fastSelectionRevision === fastRevision) fastModeOverride = settings.fast;
          if (ctx.chat.state.threadRef) rememberThreadPick(ctx.chat.state.threadRef, current.value);
          rememberActiveTweaks(current);
        } else if (
          !change.keep &&
          effortSelectionRevision === effortRevision &&
          fastSelectionRevision === fastRevision
        ) {
          if (ctx.chat.state.threadRef) forgetThreadPick(ctx.chat.state.threadRef);
          effortOverride = undefined;
          fastModeOverride = undefined;
          restoredLoadout = undefined;
        }
      }
      syncRuntimeSelection(agent);
      placeLoadout();
    } catch (e) {
      if (request !== runtimeRequest || scopeId !== scopeKey()) return;
      composerState.error = errMessage(e, "无法更新项目默认设置。");
      ctx.chat.drawActiveChat(agent);
    }
  }

  function composerForm(agent: Agent, header: TemplateResult | typeof nothing = nothing): TemplateResult {
    const activeRuntimeConfig = getRuntimeConfig(scopeKey());
    const selectedModel = currentModelOption();
    if (!selectedModel) {
      const selected =
        (ctx.chat.state.threadRef ? threadModelPicks.get(ctx.chat.state.threadRef) : undefined) ??
        defaultModelValue(scopeKey());
      return html`<div class="composer-wrap">
        ${header} ${composerApprovalPanel(ctx.chat.activePendingApprovals())}
        <p role="status">
          ${composerState.error || activeRuntimeConfig?.unavailableReason || "所选模型不可用，请选择其他模型以继续。"}
          ${selected}
        </p>
        <label
          >替代模型
          ${fieldSelect({
            ariaLabel: "替代模型",
            value: "",
            options: html`<option value="" selected>选择模型…</option>
              ${getModelOptions(scopeKey()).map((option) => html`<option value=${option.value}>${option.harnessLabel} · ${option.label}</option>`)}`,
            onChange: async (value) => {
              const option = modelOptionFor(value, scopeKey());
              if (!option) return;
              await changeScopeRuntime({ harnessId: option.harnessId, modelId: option.model.id }, agent);
              if (
                getRuntimeConfig(scopeKey())?.effective.harnessId === option.harnessId &&
                getRuntimeConfig(scopeKey())?.effective.modelId === option.model.id
              )
                selectModel(value, agent);
            },
          })}
        </label>
        <button type="button" @click=${() => void refreshRuntimeSelection(ctx.chat.state.scopeId, agent, true)}>
          刷新模型
        </button>
      </div>`;
    }
    const approvalPauses = ctx.chat.activePendingApprovals();
    const blockingPauses = approvalPauses.filter(approvalBlocksComposer);
    const runtimePending = activeRuntimeConfig === null;
    const inputBlocked = runtimePending || ctx.chat.state.resolvingApprovals.size > 0 || blockingPauses.length > 0;
    const attachingDisabled = inputBlocked;
    const voiceActive = voice.state.phase !== "idle";
    let voiceLabel = `正在录音 ${Math.floor(voice.state.seconds / 60)}:${String(voice.state.seconds % 60).padStart(2, "0")}`;
    if (voice.state.phase === "starting") voiceLabel = "正在启动麦克风…";
    if (voice.state.phase === "transcribing") voiceLabel = "正在识别…";
    let placeholder = appEditSlug(ctx.chat.state.threadRef, appState.me?.user) ? "描述你想修改的内容…" : "输入你的问题";
    if (inputBlocked) placeholder = runtimePending ? "正在加载运行配置…" : "请批准或拒绝以继续";
    else if (agent.state.isStreaming) placeholder = "可先输入，等待回复结束或停止后发送…";
    let composerNotice: TemplateResult | typeof nothing = nothing;
    if (composerState.processingFiles) {
      composerNotice = html`<div class="composer-note">正在准备文件…</div>`;
    } else if (!approvalPauses.length && runtimePending) {
      composerNotice = composerState.error
        ? html`<div class="composer-error">
            ${composerState.error}
            <button type="button" @click=${() => void refreshRuntimeSelection(ctx.chat.state.scopeId, agent, true)}>
              重试
            </button>
          </div>`
        : html`<div class="composer-note">正在加载运行设置…</div>`;
    } else if (composerState.error) {
      composerNotice = html`<div class="composer-error">${composerState.error}</div>`;
    }

    const compact = Boolean(ctx.pane) || isPhone();
    const showRuntimeControls = !appState.me?.individualModelAuth;
    const runtimeControls = modelPicker.render(agent, selectedModel, inputBlocked);
    return html`
      <form
        class="composer-wrap ${compact ? "compact" : ""}"
        @submit=${(e: Event) => submitComposer(e, agent)}
        @keydown=${(e: KeyboardEvent) => composerShortcut(e, agent, inputBlocked)}
      >
        ${header} ${slashMenu(agent)}
        ${isPhone() && attachmentsOpen ? addToConversationSheet(agent, attachingDisabled || voiceActive) : nothing}
        ${
          voiceActive
            ? html`<div class="composer-voice-status">
                <div role="status">
                  <span class="voice-recording-dot"></span>${voiceLabel}<span class="voice-limit">最长 60 秒</span>
                </div>
                <button type="button" @click=${() => voice.cancel()}>取消</button>
              </div>`
            : nothing
        }
        ${voice.state.error ? html`<div class="composer-error" role="alert">${voice.state.error}</div>` : nothing}
        ${
          activeRuntimeConfig?.upgradeAvailable
            ? html`<div class="runtime-upgrade">
                <span
                  >组织当前推荐
                  ${modelOptionFor(`${activeRuntimeConfig.orgDefault.harnessId}:${activeRuntimeConfig.orgDefault.modelId}`, scopeKey())?.harnessLabel ?? activeRuntimeConfig.orgDefault.harnessId}
                  ·
                  ${modelOptionFor(`${activeRuntimeConfig.orgDefault.harnessId}:${activeRuntimeConfig.orgDefault.modelId}`, scopeKey())?.buttonLabel ?? activeRuntimeConfig.orgDefault.modelId}。</span
                >
                <button
                  type="button"
                  @click=${() => changeScopeRuntime({ harnessId: activeRuntimeConfig!.orgDefault.harnessId, modelId: activeRuntimeConfig!.orgDefault.modelId }, agent)}
                >
                  升级
                </button>
                <button type="button" @click=${() => changeScopeRuntime({ keep: true }, agent)}>保留我的设置</button>
                <button type="button" @click=${() => changeScopeRuntime({ inherit: true }, agent)}>
                  跟随后续默认设置
                </button>
              </div>`
            : nothing
        }
        ${
          composerState.attachments.length
            ? html`
                <div class="attachment-strip">
                  ${repeat(
                    composerState.attachments,
                    (a) => a.id,
                    (a) => html`
                      <span class=${browserRenderableImage(a.mimeType) ? "file-chip composer-image" : "file-chip"}>
                        ${
                          browserRenderableImage(a.mimeType)
                            ? html`<button
                                type="button"
                                class="composer-image-open"
                                aria-label=${`预览 ${a.fileName}`}
                                @click=${() => openImagePreview(a)}
                              >
                                <img
                                  src=${a.content.startsWith("data:") ? a.content : `data:${a.mimeType};base64,${a.content}`}
                                  alt=${a.fileName}
                                  @error=${(event: Event) => {
                                    (event.currentTarget as HTMLImageElement).parentElement!.hidden = true;
                                  }}
                                />
                              </button>`
                            : nothing
                        }
                        ${
                          pastedTextIds.has(a.id)
                            ? html`
                                <button
                                  type="button"
                                  class="chip-open"
                                  aria-label="查看粘贴的文本"
                                  ${tip("查看粘贴的文本")}
                                  @click=${() => openPasteView(a.id, agent)}
                                >
                                  ${icon(FileText, 14)}
                                  <span>${pasteChipLabel(a.extractedText?.length ?? 0)}</span>
                                </button>
                              `
                            : html`${browserRenderableImage(a.mimeType) ? nothing : icon(Paperclip, 14)}<span
                                  dir="auto"
                                  title=${a.fileName}
                                  >${a.fileName}</span
                                >`
                        }
                        <button
                          type="button"
                          class="chip-x"
                          aria-label="移除附件"
                          ${tip("移除")}
                          @click=${() => removeAttachment(a.id, agent)}
                        >
                          ${icon(X, 13)}
                        </button>
                      </span>
                    `,
                  )}
                </div>
              `
            : nothing
        }
        ${approvalPauses.length ? composerApprovalPanel(approvalPauses) : nothing}
        ${
          blockingPauses.length
            ? nothing
            : html`
                <textarea
                  class="composer-input"
                  dir="auto"
                  rows="1"
                  placeholder=${placeholder}
                  ?disabled=${inputBlocked || voiceActive}
                  .value=${live(composerState.draft)}
                  @input=${(e: InputEvent) => onDraftInput(e, agent)}
                  @keydown=${(e: KeyboardEvent) => onComposerKeydown(e, agent)}
                  @paste=${(e: ClipboardEvent) => void onComposerPaste(e, agent)}
                ></textarea>
              `
        }
        <div class="composer-toolbar">
          <div class="composer-left">
            <input
              class="file-input"
              type="file"
              multiple
              hidden
              ?disabled=${attachingDisabled}
              @change=${(e: Event) => void onFilesSelected(e, agent)}
            />
            <button
              class="icon-btn composer-attach"
              type="button"
              aria-label=${isPhone() ? "添加到对话" : "添加附件"}
              aria-haspopup=${isPhone() ? "dialog" : nothing}
              aria-expanded=${isPhone() ? String(attachmentsOpen) : nothing}
              ${tip(isPhone() ? "添加到对话" : "添加附件")}
              ?disabled=${isPhone() ? voiceActive : attachingDisabled || voiceActive}
              @click=${() => {
                if (isPhone()) {
                  if (!attachmentsOpen && document.activeElement instanceof HTMLElement) document.activeElement.blur();
                  attachmentsOpen = !attachmentsOpen;
                  ctx.chat.drawActiveChat(agent);
                  if (attachmentsOpen)
                    requestAnimationFrame(() =>
                      ctx.chat.state.host?.querySelector<HTMLElement>(".composer-add-close")?.focus(),
                    );
                } else pickFiles();
              }}
            >
              ${icon(isPhone() ? Plus : Paperclip, isPhone() ? 20 : 18)}
            </button>
            ${showRuntimeControls ? runtimeControls : nothing}
          </div>
          <div class="composer-right">${sendControls(agent)}</div>
        </div>
        ${composerNotice}
      </form>
      ${pasteViewDialog(agent)}
    `;
  }

  function addToConversationSheet(agent: Agent, attachingDisabled: boolean): TemplateResult {
    const close = () => {
      attachmentsOpen = false;
      ctx.chat.drawActiveChat(agent);
      requestAnimationFrame(() => ctx.chat.state.host?.querySelector<HTMLElement>(".composer-attach")?.focus());
    };
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
      if (event.key !== "Tab") return;
      const buttons = Array.from(
        (event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
      );
      const first = buttons[0];
      const last = buttons.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const picker = (label: string, glyph: Parameters<typeof icon>[0], accept: string, capture = false) => html`
      <button
        class="composer-add-tile"
        type="button"
        ?disabled=${attachingDisabled}
        @click=${() => pickFiles(accept, capture)}
      >
        ${icon(glyph, 26)}<span>${label}</span>
      </button>
    `;
    return html`
      <div class="composer-add-overlay">
        <div class="composer-add-backdrop" @click=${() => close()}></div>
        <section
          class="composer-add-sheet"
          role="dialog"
          aria-modal="true"
          aria-labelledby="composer-add-title"
          @keydown=${onKeydown}
        >
          <div class="composer-add-handle" aria-hidden="true"></div>
          <div class="composer-add-head">
            <h2 id="composer-add-title">添加到对话</h2>
            <button class="composer-add-close" type="button" aria-label="关闭" @click=${() => close()}>
              ${icon(X, 24)}
            </button>
          </div>
          <div class="composer-add-tiles">
            ${picker("拍照", Camera, "image/*", true)} ${picker("相册", ImagePlus, "image/*")}
            ${picker("文件", FileText, "")}
          </div>
        </section>
      </div>
    `;
  }

  function pasteViewDialog(agent: Agent): TemplateResult | typeof nothing {
    const view = composerState.pasteView;
    if (!view) return nothing;
    return html`
      <div
        class="project-dialog-backdrop"
        @click=${(e: MouseEvent) => e.target === e.currentTarget && closePasteView(agent)}
        @keydown=${(e: KeyboardEvent) => e.key === "Escape" && closePasteView(agent)}
      >
        <div class="project-dialog paste-dialog" role="dialog" aria-modal="true" aria-labelledby="paste-dialog-title">
          <div class="project-dialog-head">
            <div><h2 id="paste-dialog-title">粘贴的文本</h2></div>
            <button class="chip-x" type="button" aria-label="关闭" ${tip("关闭")} @click=${() => closePasteView(agent)}>
              ${icon(X, 16)}
            </button>
          </div>
          <textarea
            class="paste-dialog-text"
            dir="auto"
            @input=${(e: InputEvent) => {
              view.text = (e.currentTarget as HTMLTextAreaElement).value;
              view.dirty = true;
            }}
          >
  ${view.initial}</textarea>
          <div class="project-dialog-actions">
            <button class="btn" type="button" @click=${() => removeAttachment(view.id, agent)}>移除</button>
            <button class="btn" type="button" @click=${() => insertPasteIntoDraft(agent)}>插入消息</button>
            <button class="btn primary" type="button" @click=${() => closePasteView(agent)}>完成</button>
          </div>
        </div>
      </div>
    `;
  }

  function openPasteView(id: string, agent: Agent): void {
    const attachment = composerState.attachments.find((a) => a.id === id);
    if (!attachment) return;
    const text = attachment.extractedText ?? base64ToText(attachment.content);
    composerState.pasteView = { id, text, initial: text, dirty: false };
    ctx.chat.drawActiveChat(agent);
    requestAnimationFrame(() => ctx.chat.state.host?.querySelector<HTMLTextAreaElement>(".paste-dialog-text")?.focus());
  }

  function closePasteView(agent: Agent): void {
    const view = composerState.pasteView;
    if (!view) return;
    const attachment = composerState.attachments.find((a) => a.id === view.id);
    if (attachment && view.dirty) {
      const bytes = new TextEncoder().encode(view.text);
      attachment.content = bytesToBase64(bytes);
      attachment.size = bytes.length;
      attachment.extractedText = view.text;
    }
    composerState.pasteView = null;
    ctx.chat.drawActiveChat(agent);
  }

  function insertPasteIntoDraft(agent: Agent): void {
    const view = composerState.pasteView;
    if (!view) return;
    const ta = ctx.chat.state.host?.querySelector<HTMLTextAreaElement>(".composer-input");
    const { draft, cursor } = insertIntoDraft(composerState.draft, view.text, ta ? ta.selectionStart : null);
    composerState.draft = draft;
    persistDraft();
    composerState.pasteView = null;
    removeAttachment(view.id, agent);
    resizeComposer();
    requestAnimationFrame(() => {
      const input = ctx.chat.state.host?.querySelector<HTMLTextAreaElement>(".composer-input");
      if (!input) return;
      input.focus();
      input.setSelectionRange(cursor, cursor);
    });
  }

  function sendControls(agent: Agent): TemplateResult {
    const phase = voice.state.phase;
    let busyLabel: string | null = null;
    if (phase === "starting") busyLabel = "正在启动麦克风";
    else if (phase === "transcribing") busyLabel = "正在识别语音";
    else if (ctx.chat.isStopping()) busyLabel = "正在停止任务";
    if (busyLabel) {
      return html`<button class="send-btn action-busy" type="button" aria-label=${busyLabel} aria-busy="true" disabled>
        <span class="composer-action-spinner" aria-hidden="true"></span>
      </button>`;
    }
    if (phase === "recording") {
      return html`<button class="send-btn voice-stop" type="button" aria-label="结束录音" @click=${() => voice.stop()}>
        ${icon(Square, 16)}
      </button>`;
    }
    if (agent.state.isStreaming) {
      return html`<button
        class="send-btn task-stop"
        type="button"
        aria-label="停止生成"
        ${tip("停止生成")}
        @click=${() => stopStreaming(agent)}
      >
        ${icon(Square, 16)}
      </button>`;
    }
    if (isPhone() && !composerState.draft.trim() && !composerState.attachments.length) {
      return html`<button
        class="send-btn voice-start"
        type="button"
        aria-label="语音输入"
        ?disabled=${composerState.processingFiles || getRuntimeConfig(scopeKey()) === null || ctx.chat.state.resolvingApprovals.size > 0 || ctx.chat.hasUnresolvedApproval()}
        @click=${() => {
          attachmentsOpen = false;
          voiceThread = ctx.chat.state.threadRef;
          void voice.start();
        }}
      >
        ${icon(Mic, 20)}
      </button>`;
    }
    return html`<button class="send-btn" type="submit" aria-label="发送" ${tip("发送")} ?disabled=${!composerCanSend()}>
      ${icon(ArrowUp, 16)}
    </button>`;
  }

  function queuedStrip(agent: Agent): TemplateResult | typeof nothing {
    const queued = [...queuedRunsFor(ctx.chat.state.threadRef)];
    if (queuedEdit?.threadRef === ctx.chat.state.threadRef && !queued.some((q) => q.runId === queuedEdit?.runId))
      queued.push({ runId: queuedEdit.runId, text: queuedEdit.original });
    if (!queued.length) return nothing;
    const steerable =
      agent.state.isStreaming &&
      !ctx.chat.isStopping() &&
      ctx.chat.hasLiveRun() &&
      harnessSupportsSteer(currentModelOption()?.harnessId ?? "");
    const steerTip = (): string => {
      if (steerable) return "立即用此消息调整正在运行的任务";
      return "当前没有运行中的任务，将作为新一轮消息发送";
    };
    return html`
      <div class="queued-strip" role="list" aria-label="队列中的消息">
        ${queued.map((q) =>
          queuedEdit?.runId === q.runId && queuedEdit.threadRef === ctx.chat.state.threadRef
            ? html` <div class="queued-chip queued-editing" role="listitem">
                <textarea
                  class="queued-edit-input"
                  aria-label="编辑队列中的消息"
                  rows="3"
                  .value=${live(queuedEdit.text)}
                  ?disabled=${queuedEdit.saving}
                  @input=${(event: Event) => {
                    if (queuedEdit) queuedEdit.text = (event.target as HTMLTextAreaElement).value;
                  }}
                  @keydown=${(event: KeyboardEvent) => {
                    if (event.isComposing || queuedEdit?.saving) return;
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      cancelQueuedEdit(agent);
                    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      event.stopPropagation();
                      void saveQueuedEdit(agent);
                    }
                  }}
                ></textarea>
                <button
                  type="button"
                  class="queued-steer"
                  aria-keyshortcuts="Control+Enter Meta+Enter"
                  ?disabled=${queuedEdit.saving}
                  @click=${() => void saveQueuedEdit(agent)}
                >
                  保存
                </button>
                <button
                  type="button"
                  class="queued-steer"
                  ?disabled=${queuedEdit.saving}
                  @click=${() => cancelQueuedEdit(agent)}
                >
                  取消
                </button>
              </div>`
            : html`
                <div class="queued-chip" role="listitem">
                  <span class="queued-tag">已排队</span>
                  <span class="queued-text" dir="auto" ${tip(q.text || "仅文件，无文字")}
                    >${q.text || (q.hasAttachments ? "(files)" : "")}</span
                  >
                  <button
                    type="button"
                    class="queued-steer"
                    ?disabled=${!steerable}
                    ${tip(steerTip())}
                    @click=${() => void steerQueued(agent, q)}
                  >
                    ${icon(CornerDownRight, 13)}<span>调整任务</span>
                  </button>
                  <button
                    type="button"
                    class="queued-steer"
                    aria-label="编辑队列中的消息"
                    @click=${() => {
                      const edit = (queuedEdit = {
                        runId: q.runId,
                        threadRef: ctx.chat.state.threadRef!,
                        original: q.text,
                        text: q.text,
                        saving: false,
                      });
                      ctx.chat.drawActiveChat(agent);
                      requestAnimationFrame(() => {
                        if (
                          queuedEdit !== edit ||
                          ctx.chat.state.threadRef !== edit.threadRef ||
                          ctx.chat.state.agent !== agent
                        )
                          return;
                        const input = ctx.chat.state.host?.querySelector<HTMLTextAreaElement>(".queued-edit-input");
                        input?.focus();
                        input?.setSelectionRange(input.value.length, input.value.length);
                      });
                    }}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    class="chip-x"
                    aria-label="移除队列中的消息"
                    ${tip("移除")}
                    @click=${() => void removeQueued(agent, q)}
                  >
                    ${icon(X, 13)}
                  </button>
                </div>
              `,
        )}
      </div>
    `;
  }

  function composerApprovalPanel(approvals: PendingApproval[]): TemplateResult {
    const decide = (decision: ApprovalDecision): void => {
      if (!ctx.chat.state.resolvingApprovals.has(decision.requestId)) ctx.chat.resolveCommandApproval(decision);
    };
    return html`<div class="composer-approval-panel" role="group" aria-label="命令审批">
      ${approvals.map(
        (a) =>
          html`<div class="composer-approval">
            <div class="composer-approval-copy">${ctx.chat.approvalSummaryView(a, true)}</div>
            <div class="approval-actions">
              <button
                class="approval-btn deny"
                type="button"
                ?disabled=${ctx.chat.state.resolvingApprovals.has(a.requestId)}
                @click=${() => decide({ requestId: a.requestId, approved: false })}
              >
                拒绝
              </button>
              <button
                class="approval-btn"
                type="button"
                ?disabled=${ctx.chat.state.resolvingApprovals.has(a.requestId)}
                @click=${() => decide({ requestId: a.requestId, approved: true, scope: "once" })}
              >
                仅允许一次
              </button>
              ${
                a.grantModes?.session === false
                  ? nothing
                  : html`<button
                      class="approval-btn primary"
                      type="button"
                      ?disabled=${ctx.chat.state.resolvingApprovals.has(a.requestId)}
                      @click=${() => decide({ requestId: a.requestId, approved: true, scope: "session" })}
                    >
                      本次会话允许
                    </button>`
              }
              ${
                a.grantModes?.always === false
                  ? nothing
                  : html`<button
                      class="approval-btn"
                      type="button"
                      ?disabled=${ctx.chat.state.resolvingApprovals.has(a.requestId)}
                      @click=${() => decide({ requestId: a.requestId, approved: true, scope: "always" })}
                    >
                      始终允许
                    </button>`
              }
            </div>
          </div>`,
      )}
    </div>`;
  }

  let loadout = loadLoadout();
  const modelPicker = createModelPicker<Agent>({
    host: () => ctx.chat.state.host,
    redraw: () => ctx.chat.drawActiveChat(),
    scopeKey,
    state: composerState,
    entries: seededLoadout,
    activeEntry: activeLoadoutEntry,
    saveEntries: (entries) => {
      loadout = entries;
      saveLoadout(entries);
    },
    apply: applyLoadout,
    add: addLoadoutEntry,
    selectEffort,
    selectHarness,
    toggleFastMode,
    effectiveFastMode,
    changeDefault: changeScopeRuntime,
  });
  const placeLoadout = modelPicker.place;

  function activeLoadoutEntry(selected: ModelOption): LoadoutEntry {
    return {
      value: selected.value,
      effort: composerState.effortLevel,
      fast:
        harnessSupportsFastMode(selected.harnessId) &&
        modelSupportsFastMode(scopeKey(), selected.model.id) &&
        effectiveFastMode(),
    };
  }

  function normalizeLoadoutEntry(entry: LoadoutEntry, option: ModelOption): LoadoutEntry {
    const levels = effortLevelsForHarness(option.harnessId);
    const defaultEffort = defaultEffortForModel(option.model);
    const fallbackEffort = levels.some((level) => level.value === defaultEffort) ? defaultEffort : "auto";
    return {
      value: option.value,
      effort: levels.some((level) => level.value === entry.effort) ? entry.effort : fallbackEffort,
      fast:
        entry.fast && harnessSupportsFastMode(option.harnessId) && modelSupportsFastMode(scopeKey(), option.model.id),
    };
  }

  function seededLoadout(selected: ModelOption): LoadoutEntry[] {
    const latest = loadLoadout();
    if (latest.length) loadout = latest;
    const active = activeLoadoutEntry(selected);
    if (!loadout.length) {
      loadout = [active];
      const other = getModelOptions(scopeKey()).find(
        (option) => option.model.id !== selected.model.id && option.model.provider !== selected.model.provider,
      );
      if (other) loadout.push({ value: other.value, effort: defaultEffortForModel(other.model), fast: false });
    }
    return reconcileLoadout(loadout, getModelOptions(scopeKey()), active).map((entry) =>
      normalizeLoadoutEntry(entry, modelOptionFor(entry.value, scopeKey())!),
    );
  }

  function rememberActiveTweaks(selected: ModelOption): void {
    loadout = upsertLoadout(seededLoadout(selected), activeLoadoutEntry(selected));
    saveLoadout(loadout);
  }

  function applyLoadout(entry: LoadoutEntry, agent: Agent): void {
    const option = modelOptionFor(entry.value, scopeKey());
    if (!option) return;
    const previous = currentModelOption();
    if (previous) rememberActiveTweaks(previous);
    const wasOpen = composerState.openMenu === "loadout";
    selectModel(entry.value, agent);
    const normalized = normalizeLoadoutEntry(entry, option);
    composerState.effortLevel = normalized.effort;
    composerState.fastMode = normalized.fast;
    loadout = upsertLoadout(loadout, activeLoadoutEntry(option));
    saveLoadout(loadout);
    modelPicker.resetSection();
    composerState.openMenu = wasOpen ? "loadout" : null;
    ctx.chat.drawActiveChat(agent);
    placeLoadout();
  }

  function composerShortcut(e: KeyboardEvent, agent: Agent, disabled: boolean): void {
    if (disabled || e.defaultPrevented || !e.metaKey) return;
    if (e.shiftKey && e.code === "KeyE") {
      e.preventDefault();
      toggleFastMode(agent);
    }
  }

  function addLoadoutEntry(option: ModelOption, agent: Agent): void {
    const current = currentModelOption();
    if (!current || seededLoadout(current).length >= LOADOUT_CAP) return;
    applyLoadout({ value: option.value, effort: defaultEffortForModel(option.model), fast: false }, agent);
    composerState.menuQuery = "";
  }

  function matchSkills(query: string, skills: SkillItem[]): SkillMatch[] {
    const q = query.toLowerCase();
    if (!q) return skills.map((skill) => ({ skill, start: -1, end: -1 }));
    const out: SkillMatch[] = [];
    for (const skill of skills) {
      const at = skill.name.toLowerCase().indexOf(q);
      if (at >= 0) out.push({ skill, start: at, end: at + q.length });
    }
    return out.sort((a, b) => a.start - b.start || a.skill.name.localeCompare(b.skill.name));
  }

  function currentSlashMenu(): { open: boolean; loading: boolean; matches: SkillMatch[] } {
    const query = slashQuery(composerState.draft);
    if (query === null || composerState.slashDismissed) return { open: false, loading: false, matches: [] };
    const loading = skillsLoading;
    const matches = skillsCache ? matchSkills(query, skillsCache) : [];
    return { open: loading || matches.length > 0, loading, matches };
  }

  function clampedActive(matchCount: number): number {
    return Math.max(0, Math.min(slashActiveIndex, matchCount - 1));
  }

  async function loadSkills(agent: Agent): Promise<void> {
    if (skillsLoading || skillsCache !== null) return;
    skillsLoading = true;
    ctx.chat.drawActiveChat(agent);
    try {
      const r = await api<{ skills: SkillItem[] }>("/api/skills");
      skillsCache = r.skills ?? [];
    } catch {
      skillsCache = null;
    } finally {
      skillsLoading = false;
      if (agent === ctx.chat.state.agent) ctx.chat.drawActiveChat(agent);
    }
  }

  function acceptSkill(skill: SkillItem, agent: Agent): void {
    composerState.draft = composerState.draft.replace(SLASH_TOKEN, (_m, pre: string) => `${pre}/${skill.name} `);
    persistDraft();
    slashActiveIndex = 0;
    composerState.slashDismissed = false;
    ctx.chat.drawActiveChat(agent);
    focusComposerEnd();
  }

  function fillSuggestedPrompt(prompt: string, agent: Agent): void {
    if (
      agent !== ctx.chat.state.agent ||
      agent.state.isStreaming ||
      composerState.draft ||
      composerState.attachments.length ||
      composerState.processingFiles
    )
      return;
    composerState.draft = prompt;
    composerState.error = "";
    persistDraft();
    ctx.chat.drawActiveChat(agent);
    focusComposerEnd();
  }

  let pendingComposerFocus = false;

  function focusComposerEnd(): void {
    requestAnimationFrame(() => {
      const ta = ctx.chat.state.host?.querySelector<HTMLTextAreaElement>(".composer-input");
      if (!ta) return;
      if (ta.disabled) {
        pendingComposerFocus = true;
        return;
      }
      pendingComposerFocus = false;
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  }

  function closeSlashMenu(agent: Agent): void {
    composerState.slashDismissed = true;
    ctx.chat.drawActiveChat(agent);
  }

  function slashMenu(agent: Agent): TemplateResult | typeof nothing {
    const slash = currentSlashMenu();
    if (!slash.open) return nothing;
    if (slash.loading && slash.matches.length === 0) {
      return html`<div class="slash-popover">
        <div class="menu-title">技能</div>
        <div class="slash-empty">正在加载技能…</div>
      </div>`;
    }
    const active = clampedActive(slash.matches.length);
    return html`
      <div class="slash-popover" role="listbox" aria-label="技能">
        <div class="menu-title">技能</div>
        ${slash.matches.map((m, i) => slashRow(m, i === active, agent))}
      </div>
    `;
  }

  function slashRow(m: SkillMatch, active: boolean, agent: Agent): TemplateResult {
    return html`
      <button
        type="button"
        role="option"
        aria-selected=${active ? "true" : "false"}
        class="slash-option ${active ? "active" : ""}"
        ${tip(m.skill.description)}
        @mousedown=${(e: Event) => e.preventDefault()}
        @click=${() => acceptSkill(m.skill, agent)}
      >
        <span class="slash-icon">${icon(Box, 16)}</span>
        <span class="slash-name">${highlightName(m)}</span>
        <span class="slash-desc">${m.skill.description}</span>
        <span class="slash-scope">${scopeBadge(m.skill.scope)}</span>
      </button>
    `;
  }

  function highlightName(m: SkillMatch): TemplateResult {
    const { name } = m.skill;
    if (m.start < 0 || m.end <= m.start) return html`${name}`;
    return html`${name.slice(0, m.start)}<b>${name.slice(m.start, m.end)}</b>${name.slice(m.end)}`;
  }

  function scopeBadge(scope: string): string {
    return scope ? scope.charAt(0).toUpperCase() + scope.slice(1) : "";
  }

  function submitComposer(e: Event, agent: Agent): void {
    e.preventDefault();
    void sendPrompt(agent);
  }

  function onDraftInput(e: InputEvent, agent: Agent): void {
    const wasEmpty = !composerState.draft;
    const wasBlank = !composerState.draft.trim();
    composerState.draft = (e.currentTarget as HTMLTextAreaElement).value;
    persistDraft();
    const hadError = Boolean(composerState.error);
    composerState.error = "";
    composerState.slashDismissed = false;
    slashActiveIndex = 0;
    const armed = slashQuery(composerState.draft) !== null;
    if (armed && skillsCache === null && !skillsLoading) void loadSkills(agent);
    const popoverShown = Boolean(ctx.chat.state.host?.querySelector(".slash-popover"));
    if (
      armed ||
      popoverShown ||
      hadError ||
      (isPhone() && wasBlank !== !composerState.draft.trim()) ||
      (Boolean(appState.me?.suggestedActivities?.length) && wasEmpty !== !composerState.draft)
    ) {
      ctx.chat.drawActiveChat(agent);
      return;
    }
    syncComposerControls(agent);
    resizeComposer();
  }

  function composerCanSend(): boolean {
    if (
      !currentModelOption() ||
      voice.state.phase !== "idle" ||
      ctx.chat.state.agent?.state.isStreaming ||
      ctx.chat.isStopping()
    )
      return false;
    return (
      Boolean(composerState.draft.trim() || composerState.attachments.length) &&
      !composerState.processingFiles &&
      getRuntimeConfig(scopeKey()) !== null &&
      ctx.chat.state.resolvingApprovals.size === 0 &&
      !ctx.chat.hasUnresolvedApproval()
    );
  }

  function syncComposerControls(agent: Agent): void {
    if (!ctx.chat.state.host || agent !== ctx.chat.state.agent) return;
    const send = ctx.chat.state.host.querySelector<HTMLButtonElement>('.send-btn[type="submit"]');
    if (send) send.disabled = !composerCanSend();
  }

  function clearComposerDom(agent: Agent): void {
    if (!ctx.chat.state.host || agent !== ctx.chat.state.agent) return;
    const input = ctx.chat.state.host.querySelector<HTMLTextAreaElement>(".composer-input");
    if (input) {
      input.value = "";
      input.style.height = "auto";
      input.style.overflowY = "hidden";
      input.scrollTop = 0;
    }
    const send = ctx.chat.state.host.querySelector<HTMLButtonElement>('.send-btn[type="submit"]');
    if (send) send.disabled = true;
  }

  function onComposerKeydown(e: KeyboardEvent, agent: Agent): void {
    // During IME composition (Japanese/Chinese/Korean), Enter confirms the
    // conversion — it must never send. Safari reports composition Enter with
    // keyCode 229 and may fire after compositionend, so check both.
    if (e.isComposing || e.keyCode === 229) return;
    const slash = currentSlashMenu();
    if (slash.open) {
      if (e.key === "Escape") {
        e.preventDefault();
        return closeSlashMenu(agent);
      }
      if (slash.matches.length) {
        const count = slash.matches.length;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          slashActiveIndex = (clampedActive(count) + 1) % count;
          return ctx.chat.drawActiveChat(agent);
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          slashActiveIndex = (clampedActive(count) - 1 + count) % count;
          return ctx.chat.drawActiveChat(agent);
        }
        if (!e.shiftKey && (e.key === "Enter" || e.key === "Tab")) {
          e.preventDefault();
          return acceptSkill(slash.matches[clampedActive(count)]!.skill, agent);
        }
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        return;
      }
    }
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    void sendPrompt(agent);
  }

  function stopStreaming(agent: Agent): void {
    composerState.error = "";
    void ctx.chat.stopLiveRun().catch(() => {
      if (agent !== ctx.chat.state.agent) return;
      composerState.error = "无法请求停止，请重试。";
      ctx.chat.drawActiveChat(agent);
    });
    focusComposerEnd();
  }

  let failedQueueSend: { threadRef: string; text: string; filesKey: string; idempotencyKey: string } | null = null;

  function queuedFilesKey(staged: readonly Attachment[]): string {
    return staged.map((a) => a.id).join(",");
  }

  function queueSendKey(threadRef: string, text: string, filesKey: string): string {
    return failedQueueSend?.threadRef === threadRef &&
      failedQueueSend.text === text &&
      failedQueueSend.filesKey === filesKey
      ? failedQueueSend.idempotencyKey
      : mintSendKey();
  }

  async function queueDraft(agent: Agent): Promise<void> {
    const threadRef = ctx.chat.state.threadRef;
    const text = composerState.draft.trim();
    const staged = composerState.attachments;
    if ((!text && !staged.length) || !threadRef) return;
    clearActiveDraft();
    composerState.draft = "";
    composerState.attachments = [];
    composerState.error = "";
    ctx.chat.drawActiveChat(agent);
    clearComposerDom(agent);
    const { uploaded, skipped } = await uploadAttachments(staged);
    const stillHere = (): boolean => ctx.chat.state.threadRef === threadRef;
    if (skipped.length && stillHere()) composerState.error = skipped.map((s) => s.note).join(" ");
    const droppedIds = new Set(skipped.filter((s) => s.permanent).flatMap((s) => (s.id ? [s.id] : [])));
    const transientIds = new Set(skipped.filter((s) => !s.permanent).flatMap((s) => (s.id ? [s.id] : [])));
    const sendable = staged.filter((a) => !droppedIds.has(a.id));
    if (!text && !uploaded.length) {
      if (stillHere()) restoreStagedOnFailure(text, sendable, composerState.error || "无法将文件加入队列。");
      return ctx.chat.drawActiveChat(agent);
    }
    if (!(await enqueueTurn(agent, threadRef, text, uploaded, queuedFilesKey(sendable)))) {
      if (stillHere()) restoreStagedOnFailure(text, sendable, composerState.error);
    } else if (transientIds.size && stillHere()) {
      restageAttachments(
        staged.filter((a) => transientIds.has(a.id)),
        composerState.error,
      );
    }
    ctx.chat.drawActiveChat(agent);
  }

  function restoreStagedOnFailure(text: string, staged: Attachment[], note: string): void {
    const typedSince = composerState.draft.trim();
    composerState.draft = !typedSince || typedSince === text ? text : `${text}\n${composerState.draft}`;
    const { kept, note: capNote } = mergeStagedAttachments(staged, composerState.attachments);
    composerState.attachments = kept;
    composerState.error = combineNote(note, capNote);
  }

  async function enqueueTurn(
    agent: Agent,
    threadRef: string,
    text: string,
    attachments: CoreAttachment[] = [],
    filesKey = "",
  ): Promise<boolean> {
    const idempotencyKey = queueSendKey(threadRef, text, filesKey);
    try {
      const queued = await queueTurn(threadRef, text, agent, ctx.chat.currentTurnOptions, idempotencyKey, attachments);
      failedQueueSend = null;
      setQueuedRuns(threadRef, [...queuedRunsFor(threadRef).filter((r) => r.runId !== queued.runId), queued]);
      bumpSessionActivity(threadRef);
      return true;
    } catch (err) {
      failedQueueSend = { threadRef, text, filesKey, idempotencyKey };
      composerState.error = errMessage(err, "无法将消息加入队列。");
      return false;
    }
  }

  function cancelQueuedEdit(agent: Agent): void {
    if (queuedEdit?.saving) return;
    queuedEdit = null;
    composerState.error = "";
    ctx.chat.drawActiveChat(agent);
    focusComposerEnd();
  }

  async function saveQueuedEdit(agent: Agent): Promise<void> {
    const edit = queuedEdit;
    if (!edit || edit.saving) return;
    edit.saving = true;
    composerState.error = "";
    ctx.chat.drawActiveChat(agent);
    try {
      await editQueuedRun(edit.runId, edit.text, edit.original);
      setQueuedRuns(
        edit.threadRef,
        queuedRunsFor(edit.threadRef).map((q) => (q.runId === edit.runId ? { ...q, text: edit.text } : q)),
      );
      if (queuedEdit === edit) {
        queuedEdit = null;
        if (ctx.chat.state.threadRef === edit.threadRef && ctx.chat.state.agent === agent) focusComposerEnd();
      }
    } catch (error) {
      if (ctx.chat.state.threadRef === edit.threadRef)
        composerState.error =
          error instanceof ApiError && error.status === 409
            ? "该消息已更改或开始处理，你的编辑未保存。"
            : errMessage(error, "无法编辑队列中的消息。");
    } finally {
      edit.saving = false;
      if (ctx.chat.state.threadRef === edit.threadRef) ctx.chat.drawActiveChat(agent);
    }
  }

  async function removeQueued(agent: Agent, queued: QueuedRun): Promise<void> {
    const threadRef = ctx.chat.state.threadRef;
    if (!threadRef) return;
    composerState.error = "";
    try {
      await withdrawRun(queued.runId);
    } catch (err) {
      if (!(err instanceof ApiError && (err.status === 409 || err.status === 404))) {
        composerState.error = errMessage(err, "无法移除队列中的消息。");
        return ctx.chat.drawActiveChat(agent);
      }
    }
    forgetQueuedRun(threadRef, queued.runId);
    ctx.chat.drawActiveChat(agent);
  }

  const pendingSteers = new Set<string>();

  async function steerQueued(agent: Agent, queued: QueuedRun): Promise<void> {
    const threadRef = ctx.chat.state.threadRef;
    if (!threadRef || !ctx.chat.hasLiveRun() || pendingSteers.has(queued.runId)) return;
    pendingSteers.add(queued.runId);
    composerState.error = "";
    try {
      const outcome = await ctx.chat.signalLiveRun("steer", queued.text, queued.runId);
      if (outcome.ok || outcome.replayed) {
        forgetQueuedRun(threadRef, queued.runId);
        bumpSessionActivity(threadRef);
        if (agent === ctx.chat.state.agent && threadRef === ctx.chat.state.threadRef) {
          agent.state.messages.push({
            role: "user",
            content: queued.text,
            timestamp: Date.now(),
            ...(outcome.ok ? { steered: true } : {}),
          } as unknown as AgentMessage);
        }
      } else if (outcome.reason === "queued_changed") {
        if (agent === ctx.chat.state.agent && threadRef === ctx.chat.state.threadRef)
          composerState.error = "队列中的消息已更改，请重新发送调整指令。";
      } else if (outcome.reason === "queued_started" || outcome.reason === "not_found") {
        forgetQueuedRun(threadRef, queued.runId);
      }
    } catch (err) {
      if (agent === ctx.chat.state.agent && threadRef === ctx.chat.state.threadRef)
        composerState.error = errMessage(err, "无法确认任务调整，请重试。");
    } finally {
      pendingSteers.delete(queued.runId);
    }
    if (agent !== ctx.chat.state.agent || threadRef !== ctx.chat.state.threadRef) return;
    ctx.chat.drawActiveChat(agent);
    ctx.chat.resumeIfIdle();
  }

  async function sendPrompt(agent: Agent): Promise<void> {
    if (!composerCanSend()) return;
    if (composerState.pasteView) closePasteView(agent);
    if (agent.state.isStreaming) return queueDraft(agent);
    const text = composerState.draft.trim();
    if (ctx.chat.state.threadRef) {
      bumpSessionActivity(ctx.chat.state.threadRef);
      ctx.chat.state.pendingSend = ctx.chat.state.threadRef;
      renderList();
    }
    const attachments = composerState.attachments;
    const sentFromThread = ctx.chat.state.threadRef;
    ctx.chat.notePendingSessionOnSend();
    clearActiveDraft();
    resetComposer();
    ctx.chat.drawActiveChat(agent);
    clearComposerDom(agent);
    try {
      if (ctx.chat.state.normalStreamFn) agent.streamFn = ctx.chat.state.normalStreamFn;
      ctx.chat.scrollToBottom();
      await agent.prompt(userSendMessage(text, attachments.length ? attachments : undefined));
      restoreBlockedSend(agent, sentFromThread, text, attachments);
      restoreFailedAttachments(agent, text, attachments);
    } catch (err) {
      ctx.chat.state.pendingSend = null;
      if (ctx.chat.state.threadRef && ctx.chat.state.sessionId === null) dropPendingSession(ctx.chat.state.threadRef);
      renderList();
      composerState.error = errMessage(err, "无法发送消息。");
      ctx.chat.drawActiveChat(agent);
    }
  }

  function restoreFailedAttachments(agent: Agent, text: string, attachments: Attachment[]): void {
    const messages = agent.state.messages;
    const last = messages[messages.length - 1] as
      { role?: string; sendFailed?: string; droppedAttachmentIds?: string[] } | undefined;
    if (last?.role !== "assistant" || last.sendFailed !== "attachments" || agent !== ctx.chat.state.agent) return;
    const dropped = new Set(last.droppedAttachmentIds ?? []);
    const retryable = attachments.filter((a) => !dropped.has(a.id));
    messages.pop();
    const prompt = messages[messages.length - 1] as { role?: string } | undefined;
    if (prompt?.role === "user" || prompt?.role === "user-with-attachments") messages.pop();
    (agent.state as { errorMessage?: string }).errorMessage = undefined;
    ctx.chat.state.pendingSend = null;
    if (ctx.chat.state.threadRef && ctx.chat.state.sessionId === null) dropPendingSession(ctx.chat.state.threadRef);
    renderList();
    restoreStagedOnFailure(
      text,
      retryable,
      retryable.length ? "无法添加附件，消息未发送，请重试。" : "没有成功添加附件，消息未发送。",
    );
    persistDraft();
    ctx.chat.drawActiveChat(agent);
  }

  function restoreBlockedSend(
    agent: Agent,
    sentFromThread: string | null,
    text: string,
    attachments: Attachment[],
  ): void {
    const messages = agent.state.messages;
    const last = messages[messages.length - 1] as
      { role?: string; sendBlocked?: string; errorMessage?: string } | undefined;
    if (last?.role !== "assistant" || last.sendBlocked !== "pending_approval") return;
    if (agent !== ctx.chat.state.agent) {
      if (sentFromThread) saveDraft(sentFromThread, text);
      return;
    }
    messages.pop();
    const prompt = messages[messages.length - 1] as { role?: string } | undefined;
    if (prompt?.role === "user" || prompt?.role === "user-with-attachments") messages.pop();
    (agent.state as { errorMessage?: string }).errorMessage = undefined;
    ctx.chat.state.pendingSend = null;
    if (ctx.chat.state.threadRef && ctx.chat.state.sessionId === null) dropPendingSession(ctx.chat.state.threadRef);
    renderList();
    const typedSince = composerState.draft.trim();
    composerState.draft = !typedSince || typedSince === text ? text : `${text}\n${composerState.draft}`;
    const { kept, note } = mergeStagedAttachments(attachments, composerState.attachments);
    composerState.attachments = kept;
    composerState.error = combineNote(last.errorMessage || PENDING_APPROVAL_REASON, note);
    persistDraft();
    ctx.chat.drawActiveChat(agent);
  }

  const LARGE_PASTE_CHARS = 2000;

  async function onComposerPaste(e: ClipboardEvent, agent: Agent): Promise<void> {
    const data = e.clipboardData;
    if (!data) return;
    const files = Array.from(data.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length) {
      e.preventDefault();
      await addFiles(files, agent);
      return;
    }
    const text = data.getData("text/plain");
    if (text.length <= LARGE_PASTE_CHARS) return;
    if (ctx.chat.hasUnresolvedApproval() || ctx.chat.state.resolvingApprovals.size > 0 || composerState.processingFiles)
      return;
    if (composerState.attachments.length >= MAX_FILES_PER_MESSAGE) return;
    e.preventDefault();
    const names = new Set(composerState.attachments.map((a) => a.fileName));
    let n = 1;
    while (names.has(n === 1 ? "pasted-text.txt" : `pasted-text-${n}.txt`)) n++;
    const bytes = new TextEncoder().encode(text);
    const attachment: Attachment = {
      id: `paste_${Date.now()}_${Math.random()}`,
      type: "document",
      fileName: n === 1 ? "pasted-text.txt" : `pasted-text-${n}.txt`,
      mimeType: "text/plain",
      size: bytes.length,
      content: bytesToBase64(bytes),
      extractedText: text,
    };
    pastedTextIds.add(attachment.id);
    composerState.attachments = [...composerState.attachments, attachment];
    ctx.chat.drawActiveChat(agent);
  }

  async function onFilesSelected(e: Event, agent: Agent): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = "";
    await addFiles(files, agent);
  }

  async function fileToBase64(file: File): Promise<string> {
    return bytesToBase64(new Uint8Array(await file.arrayBuffer()));
  }

  async function loadAnyAttachment(file: File): Promise<Attachment> {
    try {
      const { loadAttachment } = await loadPiWebUi();
      return await loadAttachment(file);
    } catch {
      return {
        id: `${file.name}_${Date.now()}_${Math.random()}`,
        type: "document",
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        content: await fileToBase64(file),
      };
    }
  }

  function restageAttachments(attachments: Attachment[], note: string): void {
    if (!attachments.length) {
      composerState.error = note;
      return;
    }
    const { kept, note: capNote } = mergeStagedAttachments(attachments, composerState.attachments);
    composerState.attachments = kept;
    composerState.error = combineNote(note, capNote);
  }

  function combineNote(existing: string, note: string | null): string {
    if (!note) return existing;
    return existing ? `${existing} ${note}` : note;
  }

  function capOverflowNote(dropped: readonly { fileName: string }[]): string | null {
    return dropped.length ? tooManyFilesNote(dropped.map((a) => a.fileName)) : null;
  }

  function mergeStagedAttachments(
    restored: Attachment[],
    current: Attachment[],
  ): { kept: Attachment[]; note: string | null } {
    const seen = new Set<string>();
    const merged: Attachment[] = [];
    for (const a of [...restored, ...current]) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      merged.push(a);
    }
    return { kept: merged.slice(0, MAX_FILES_PER_MESSAGE), note: capOverflowNote(merged.slice(MAX_FILES_PER_MESSAGE)) };
  }

  function planAdmission(files: File[], folderCount: number): { files: File[]; folders: number; note: string | null } {
    const notes: string[] = [];
    const sized: File[] = [];
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) notes.push(oversizeAttachmentNote(file.name));
      else sized.push(file);
    }
    const room = Math.max(0, MAX_FILES_PER_MESSAGE - composerState.attachments.length);
    const admittedFiles = sized.slice(0, room);
    const admittedFolders = Math.min(folderCount, Math.max(0, room - admittedFiles.length));
    const overflow = [
      ...sized.slice(room).map((f) => f.name),
      ...Array.from({ length: folderCount - admittedFolders }, () => "文件夹"),
    ];
    if (overflow.length) notes.push(tooManyFilesNote(overflow));
    return { files: admittedFiles, folders: admittedFolders, note: notes.length ? notes.join(" ") : null };
  }

  async function addFiles(files: File[], agent: Agent, folders: DropEntryLike[] = []): Promise<void> {
    if (
      (!files.length && !folders.length) ||
      ctx.chat.hasUnresolvedApproval() ||
      ctx.chat.state.resolvingApprovals.size > 0
    )
      return;
    if (composerState.processingFiles) {
      composerState.error = "正在处理上一次拖入的内容，请稍后重试。";
      ctx.chat.drawActiveChat(agent);
      return;
    }
    composerState.processingFiles = true;
    composerState.error = "";
    ctx.chat.drawActiveChat(agent);
    const plan = planAdmission(files, folders.length);
    try {
      const zipped: File[] = [];
      for (const folder of folders.slice(0, plan.folders)) zipped.push(await folderToZipFile(folder));
      const loaded = await Promise.all([...plan.files, ...zipped].map((file) => loadAnyAttachment(file)));
      composerState.attachments = [...composerState.attachments, ...loaded];
      if (plan.note) composerState.error = plan.note;
    } catch (err) {
      let message: string;
      if (err instanceof FolderDropError) message = err.message;
      else if (isFolderReadError(err)) message = "当前浏览器无法读取拖入的文件夹，请压缩后再上传。";
      else message = errMessage(err, "无法添加此文件。");
      composerState.error = combineNote(plan.note ?? "", message);
    } finally {
      composerState.processingFiles = false;
      ctx.chat.drawActiveChat(agent);
    }
  }

  function dragHasFiles(e: DragEvent): boolean {
    const types = e.dataTransfer?.types;
    return types ? Array.from(types).includes("Files") : false;
  }

  function onDragEnter(e: DragEvent): void {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    fileDrag.enter(e);
  }

  function onDragOver(e: DragEvent): void {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave(e: DragEvent): void {
    fileDrag.leave(e);
  }

  async function onDrop(e: DragEvent, agent: Agent): Promise<void> {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    fileDrag.reset();
    const { files, folders } = splitDropItems(Array.from(e.dataTransfer?.items ?? []));
    if (!files.length && !folders.length) files.push(...Array.from(e.dataTransfer?.files ?? []));
    ctx.chat.drawActiveChat(agent);
    await addFiles(files, agent, folders);
  }

  function pickFiles(accept = "", capture = false): void {
    if (ctx.chat.hasUnresolvedApproval() || ctx.chat.state.resolvingApprovals.size > 0 || voice.state.phase !== "idle")
      return;
    const input = ctx.chat.state.host?.querySelector<HTMLInputElement>(".file-input");
    if (!input || input.disabled) return;
    input.accept = accept;
    input.multiple = !capture;
    if (capture) input.setAttribute("capture", "environment");
    else input.removeAttribute("capture");
    if (typeof input.showPicker === "function") {
      try {
        input.showPicker();
      } catch {
        input.click();
      }
    } else input.click();
    attachmentsOpen = false;
    ctx.chat.drawActiveChat();
  }

  function openImagePreview(attachment: Attachment): void {
    const dialog = document.createElement("dialog");
    dialog.className = "project-dialog attachment-preview";
    dialog.setAttribute("aria-label", attachment.fileName);
    dialog.addEventListener(
      "close",
      () => {
        render(nothing, dialog);
        dialog.remove();
      },
      { once: true },
    );
    document.body.append(dialog);
    const src = attachment.content.startsWith("data:")
      ? attachment.content
      : `data:${attachment.mimeType};base64,${attachment.content}`;
    render(
      html`
        <div class="attachment-preview-head">
          <span dir="auto">${attachment.fileName}</span>
          <button type="button" class="btn compact" @click=${() => dialog.close()}>关闭</button>
        </div>
        <div class="attachment-preview-body">
          <button
            type="button"
            aria-label="切换图片原始尺寸"
            @click=${(event: Event) => (event.currentTarget as HTMLElement).classList.toggle("actual-size")}
          >
            <img src=${src} alt=${attachment.fileName} />
          </button>
        </div>
      `,
      dialog,
    );
    dialog.showModal();
  }

  function removeAttachment(id: string, agent: Agent): void {
    composerState.attachments = composerState.attachments.filter((a) => a.id !== id);
    pastedTextIds.delete(id);
    if (composerState.pasteView?.id === id) composerState.pasteView = null;
    ctx.chat.drawActiveChat(agent);
  }

  function selectModel(value: string, agent: Agent): void {
    const option = getModelOptions(scopeKey()).find((candidate) => candidate.value === value);
    if (!option) return;
    ++modelSelectionRevision;
    const previousDefaultEffort = defaultEffortForModel(currentModelOption()?.model);
    if (ctx.chat.state.threadRef) rememberThreadPick(ctx.chat.state.threadRef, option.value);
    agent.state.model = option.model;
    if (composerState.effortLevel === previousDefaultEffort) {
      composerState.effortLevel = defaultEffortForModel(option.model);
    }
    composerState.openMenu = null;
    ctx.chat.drawActiveChat(agent);
  }

  function selectHarness(harnessId: string, agent: Agent): void {
    const selected = currentModelOption();
    if (!selected || selected.harnessId === harnessId) return;
    const target = compatibleHarnessOptions(getModelOptions(scopeKey()), selected.model.id).find(
      (option) => option.harnessId === harnessId,
    );
    if (!target) return;
    const active = activeLoadoutEntry(selected);
    applyLoadout({ ...active, value: target.value }, agent);
  }

  function selectEffort(level: EffortLevel, agent: Agent): void {
    const selected = currentModelOption();
    if (!selected || !effortLevelsForHarness(selected.harnessId).some((option) => option.value === level)) return;
    composerState.effortLevel = level;
    rememberActiveTweaks(selected);
    ctx.chat.drawActiveChat(agent);
    placeLoadout();
  }

  function toggleFastMode(agent: Agent): void {
    const selected = currentModelOption();
    if (ctx.chat.hasUnresolvedApproval() || ctx.chat.state.resolvingApprovals.size > 0) return;
    if (
      !selected ||
      !harnessSupportsFastMode(selected.harnessId) ||
      !modelSupportsFastMode(scopeKey(), selected.model.id)
    )
      return;
    composerState.fastMode = !effectiveFastMode();
    rememberActiveTweaks(selected);
    ctx.chat.drawActiveChat(agent);
    placeLoadout();
  }

  let autosizedTa: HTMLTextAreaElement | null = null;
  let autosizedValue: string | null = null;
  let autosizeObserver: ResizeObserver | null = null;

  function resizeComposer(): void {
    requestAnimationFrame(() => {
      const ta = ctx.chat.state.host?.querySelector<HTMLTextAreaElement>(".composer-input");
      if (!ta) return;
      if (autosizedTa !== ta && typeof ResizeObserver !== "undefined") {
        autosizeObserver ??= new ResizeObserver(() => {
          autosizedValue = null;
          resizeComposer();
        });
        if (autosizedTa) autosizeObserver.unobserve(autosizedTa);
        autosizeObserver.observe(ta);
        autosizedTa = ta;
        autosizedValue = null;
      }
      if (ta.value === autosizedValue) return;
      autosizedValue = ta.value;
      const wrap = ta.closest<HTMLElement>(".composer-wrap");
      const wrapHeight = wrap?.style.height ?? "";
      if (wrap) wrap.style.height = `${wrap.getBoundingClientRect().height}px`;
      ta.style.height = "auto";
      const cap = parseFloat(getComputedStyle(ta).maxHeight) || 180;
      const content = ta.scrollHeight;
      ta.style.height = `${Math.min(cap, Math.max(ctx.pane ? 0 : 48, content))}px`;
      if (wrap) wrap.style.height = wrapHeight;
      if (content > cap) {
        ta.style.overflowY = "auto";
      } else {
        ta.style.overflowY = "hidden";
        ta.scrollTop = 0;
      }
    });
  }

  function closeMenus(): boolean {
    let changed = attachmentsOpen;
    attachmentsOpen = false;
    if (composerState.openMenu) {
      modelPicker.resetSection();
      composerState.openMenu = null;
      changed = true;
    }
    if (!composerState.slashDismissed && slashQuery(composerState.draft) !== null) {
      composerState.slashDismissed = true;
      changed = true;
    }
    return changed;
  }

  function dispose(): void {
    voice.cancel(false);
    unsubscribePhone();
    document.removeEventListener("visibilitychange", cancelHiddenVoice);
    window.removeEventListener("pagehide", cancelPageVoice);
    window.removeEventListener("model-account-changed", refreshAccount);
    modelPicker.dispose();
    unsubscribeRuntime?.();
    ++runtimeRequest;
    fileDrag.dispose();
    autosizeObserver?.disconnect();
    autosizeObserver = null;
    autosizedTa = null;
  }

  return {
    state: composerState,
    restageAttachments,
    composerForm,
    composerApprovalPanel,
    queuedStrip,
    queuedRunsFor,
    setQueuedRuns,
    resetComposer,
    focusComposerEnd,
    fillSuggestedPrompt,
    sendSuggestedPrompt: async (prompt: string, agent: Agent): Promise<void> => {
      if (
        agent !== ctx.chat.state.agent ||
        agent.state.isStreaming ||
        composerState.draft ||
        composerState.attachments.length ||
        composerState.processingFiles
      )
        return;
      fillSuggestedPrompt(prompt, agent);
      await sendPrompt(agent);
    },
    resizeComposer,
    currentModelOption,
    carryModelPick,
    refreshRuntimeSelection,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
    closeMenus,
    dispose,
  };
}
