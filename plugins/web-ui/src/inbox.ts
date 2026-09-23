import { loopIcon } from "./loop-icon";
import {
  ensureSentMail,
  openSentEmail,
  openSentEmailById,
  isSentMailLoading,
  loadSentMail,
  resetSentMail,
  resetSelectedSentEmail,
  selectedSentEmail,
  sentEmailPageTpl,
  sentChatTpl,
  selectedSentChat,
  updateSentChat,
  sentMailTpl,
} from "./sent-mail";
import { html, nothing, render, type TemplateResult } from "lit";
import {
  Archive,
  ArrowUp,
  ArrowUpRight,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Inbox as InboxGlyph,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Send,
  Undo2,
  X,
} from "lucide";
import { api, ApiError } from "./core-bridge";
import { onInboxItemEvent, onInboxResync } from "./conversations";
import { createInboxEventCoalescer, type InboxItemRef } from "./inbox-coalesce";
import { charForName, ensureEmojiIndex } from "./emoji-picker";
import type { DensityTier } from "./density";
import { deepLinkPath, UI_BASE } from "./deep-link";
import { appState, can } from "./shell-state";
import { renderSidebarTop, switchView } from "./shell";
import { openSession, sessionsState } from "./sessions";
import { splitMentions } from "./linkify";
import { splitSlackWire } from "./slack-text";
import { openLoop } from "./loops";
import { listBackLink } from "./list-page";
import { registerPaneKind } from "./pane-kinds";
import { exitSplitIfActive, notifyPanesChanged } from "./split";
import { tip } from "./tooltip";
import { brandName, icon, initials, relTime, workingWave } from "./ui";

export type InboxSource = "gmail" | "slack" | "generic";

export interface InboxDraft {
  to?: string[];
  cc?: string[];
  subject?: string;
  body: string;
}

export interface InboxContextMessage {
  author: string;
  at?: number;
  text: string;
  images?: string[];
}

export interface LedgerThreadMessage {
  id: string;
  role: "human" | "agent" | "system";
  text: string;
  at: number;
}

export interface LedgerItem {
  id: string;
  loopId: string;
  dedupeKey: string;
  state: "pending" | "processed" | "held" | "actioned" | "dismissed" | "failed";
  summary?: string;
  parkedReason?: string;
  source?: string;
  sourcePayload: Record<string, unknown>;
  sourceAt?: number;
  proposal?: { data: Record<string, unknown>; by: "agent" | "human"; at: number; sessionId?: string };
  thread: LedgerThreadMessage[];
  actedAt?: number;
  actionKind?: string;
  actionResult?: string;
  updatedAt: number;
}

export interface InboxItem {
  sentChat?: boolean;
  id: string;
  loopId: string;
  source: InboxSource;
  sourceKey: string;
  reviewState?: string;
  attention?: boolean;
  proposalData?: Record<string, unknown>;
  outputs?: ReviewOutput[];
  detailLoaded?: boolean;
  status: "open" | "sent" | "dismissed" | "replied";
  title: string;
  from: string;
  fromDetail?: string;
  snippet: string;
  context?: InboxContextMessage[];
  receivedAt: number;
  externalUrl?: string;
  draft?: InboxDraft;
  draftEdited?: boolean;
  draftAt?: number;
  draftSessionId?: string;
  thread: LedgerThreadMessage[];
  gmail?: { threadId: string; subject?: string; to?: string[]; cc?: string[] };
  slack?: { channelId: string; channelLabel?: string; ts: string; threadTs?: string };
  sentAt?: number;
  dismissedAt?: number;
  repliedAt?: number;
  externalReplyText?: string;
  reactions?: string[];
  probablyResolved?: boolean;
  images?: string[];
  updatedAt: number;
}

export interface InboxView {
  id: string;
  name: string;
  sources: InboxSource[];
}

export interface InboxSyncCron {
  id: string;
  enabled: boolean;
  lastFiredAt?: number;
  taskVersion: number | null;
  currentTaskVersion: number;
}

const DEFAULT_VIEWS: InboxView[] = [
  { id: "all", name: "全部", sources: ["gmail", "slack"] },
  { id: "gmail", name: "邮件", sources: ["gmail"] },
  { id: "slack", name: "Slack", sources: ["slack"] },
  { id: "sent", name: "已发送", sources: [] },
];

function isInboxViewId(value: string | null): value is string {
  return value !== null && [...DEFAULT_VIEWS, ...inboxViews()].some((view) => view.id === value);
}

function inboxViewIdForSegment(segment: string | null): string | null {
  if (segment?.startsWith("loop-")) return segment.slice(5);
  if (segment === "email") return "gmail";
  return isInboxViewId(segment) ? segment : null;
}

function inboxViewSegment(viewId: string): string {
  if (viewId === "gmail") return "email";
  return DEFAULT_VIEWS.some((view) => view.id === viewId) ? viewId : `loop-${viewId}`;
}

export const inboxState = {
  items: [] as InboxItem[],
  selected: [] as Array<{
    id: string;
    name: string;
    icon?: string;
    sources?: string[];
    count: number;
    source?: string;
    cronId?: string;
    syncCron?: InboxSyncCron | null;
    ingestionActive?: boolean;
  }>,
  available: [] as Array<{
    id: string;
    name: string;
    icon?: string;
    sources?: string[];
    source?: string;
    selected: boolean;
  }>,
  total: 0,
  nextCursor: null as string | null,
  picker: false,
  menuId: null as string | null,
  selectionBusy: false,
  migrationPending: false,
  loopId: null as string | null,
  syncCron: null as InboxSyncCron | null,
  loaded: false,
  loading: false,
  error: null as string | null,
  fetchedAt: 0,
  notice: null as string | null,
  syncBusy: false,
};

const DRAFT_SUGGESTIONS = ["精简内容", "语气更友好", "移除称呼和落款"];
const ASIDE_MIN_HEIGHT = 320;
const ASIDE_MAX_HEIGHT = 1100;
const CHAT_INPUT_MAX_HEIGHT = 200;
const draftEdits = new Map<string, InboxDraft & { basedOnAt?: number }>();
const sending = new Set<string>();
const acting = new Set<string>();
const chatting = new Set<string>();
const chatDrafts = new Map<string, string>();

let archiveToastHost: HTMLDivElement | null = null;
let archiveToastTimer: ReturnType<typeof setTimeout> | undefined;

function closeArchiveToast(): void {
  clearTimeout(archiveToastTimer);
  archiveToastHost?.remove();
  archiveToastHost = null;
}

function showArchiveToast(item: InboxItem): void {
  closeArchiveToast();
  const host = document.createElement("div");
  archiveToastHost = host;
  document.body.append(host);
  let busy = false;
  const schedule = (): void => {
    clearTimeout(archiveToastTimer);
    if (!busy && !host.matches(":hover") && !host.contains(document.activeElement)) {
      archiveToastTimer = setTimeout(() => {
        if (archiveToastHost === host) closeArchiveToast();
      }, 8000);
    }
  };
  const draw = (): void => {
    render(
      html`<div
        class="action-toast"
        role="status"
        @mouseenter=${() => clearTimeout(archiveToastTimer)}
        @mouseleave=${schedule}
        @focusin=${() => clearTimeout(archiveToastTimer)}
        @focusout=${() => queueMicrotask(schedule)}
      >
        ${icon(Archive, 16)}
        <span>已从收件箱忽略</span>
        <button
          type="button"
          ?disabled=${busy}
          @click=${async () => {
            busy = true;
            clearTimeout(archiveToastTimer);
            draw();
            const restored = await setItemStatus(item, "open");
            if (archiveToastHost !== host) return;
            if (restored) closeArchiveToast();
            else {
              busy = false;
              draw();
              schedule();
            }
          }}
        >
          ${busy ? "正在撤销…" : "撤销"}
        </button>
        <button class="icon-btn" type="button" aria-label="关闭通知" @click=${closeArchiveToast}>${icon(X, 14)}</button>
      </div>`,
      host,
    );
  };
  draw();
  schedule();
}

let emojiIndexRequested = false;

function ensureEmojiChips(): void {
  if (emojiIndexRequested) return;
  emojiIndexRequested = true;
  void ensureEmojiIndex().then(() => drawAll());
}

interface InboxSurface {
  host: HTMLElement;
  viewId: string;
  pane: boolean;
  density: () => DensityTier;
  selectedId: string | null;
  showHandled: boolean;
}

const surfaces = new Set<InboxSurface>();

export function resetInboxState(): void {
  resetSentMail();
  closeArchiveToast();
  inboxState.items = [];
  inboxState.selected = [];
  inboxState.available = [];
  inboxState.total = 0;
  inboxState.nextCursor = null;
  feedWindows.clear();
  inboxState.picker = false;
  inboxState.loopId = null;
  inboxState.syncCron = null;
  inboxState.loaded = false;
  inboxState.loading = false;
  inboxState.error = null;
  inboxState.fetchedAt = 0;
  inboxState.notice = null;
  inboxState.syncBusy = false;
  draftEdits.clear();
  sending.clear();
  acting.clear();
  chatting.clear();
  chatDrafts.clear();
}

export function inboxViews(): InboxView[] {
  return [
    { id: "all", name: "全部", sources: ["gmail", "slack", "generic"] },
    ...inboxState.selected.map((loop) => ({ id: loop.id, name: loop.name, sources: [] as InboxSource[] })),
  ];
}

export function inboxViewName(viewId: string): string {
  return inboxViews().find((v) => v.id === viewId)?.name ?? DEFAULT_VIEWS.find((v) => v.id === viewId)?.name ?? "全部";
}

export function itemsFor(viewId: string, status: "open" | "handled"): InboxItem[] {
  return inboxState.items.filter((item) => {
    if (item.sentChat) return false;
    if (viewId !== "all" && viewId !== "sent" && item.loopId !== viewId && item.source !== viewId) return false;
    if (viewId === "sent") return item.status === "sent" && item.source !== "generic";
    return status === "open" ? item.status === "open" && item.attention !== false : item.status !== "open";
  });
}

export function inboxOpenCount(viewId = "all"): number {
  if (!inboxState.loaded) return 0;
  return viewId === "all" ? inboxState.total : (inboxState.selected.find((loop) => loop.id === viewId)?.count ?? 0);
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function draftOf(item: LedgerItem): InboxDraft | undefined {
  const data = item.proposal?.data;
  if (!data || typeof data.body !== "string") return undefined;
  return {
    body: data.body,
    ...(Array.isArray(data.to) ? { to: data.to as string[] } : {}),
    ...(Array.isArray(data.cc) ? { cc: data.cc as string[] } : {}),
    ...(str(data.subject) ? { subject: data.subject as string } : {}),
  };
}

function resolvedStatus(entry: LedgerItem): InboxItem["status"] {
  if (entry.state === "actioned") return entry.source === "gmail" || entry.source === "slack" ? "sent" : "dismissed";
  if (entry.state !== "dismissed") return "open";
  return entry.actionKind === "replied" ? "replied" : "dismissed";
}

export function toInboxItem(entry: LedgerItem): InboxItem {
  const payload = entry.sourcePayload;
  const sourceId = entry.source ?? payload.source;
  const source: InboxSource = sourceId === "gmail" || sourceId === "slack" ? sourceId : "generic";
  const draft = draftOf(entry);
  const resolved = resolvedStatus(entry);
  const reactions = Array.isArray(payload.reactions) ? (payload.reactions as string[]) : undefined;
  return {
    id: entry.id,
    loopId: entry.loopId,
    source,
    sourceKey: entry.dedupeKey,
    status: resolved,
    sentChat: payload.sentChat === true,
    ...(payload.sentChat === true ? { detailLoaded: true } : {}),
    title: str(payload.title) ?? entry.summary ?? "审核事项",
    reviewState: entry.parkedReason
      ? "需要补充信息"
      : (({ held: "待审核" } as Record<string, string>)[entry.state] ?? "处理中"),
    attention: entry.state === "held" || (entry.state === "failed" && Boolean(entry.parkedReason)),
    proposalData: entry.proposal?.data,
    from: str(payload.from) ?? "",
    snippet: str(payload.snippet) ?? entry.parkedReason ?? entry.summary ?? "",
    receivedAt: entry.sourceAt ?? (typeof payload.receivedAt === "number" ? payload.receivedAt : entry.updatedAt),
    thread: entry.thread,
    updatedAt: entry.updatedAt,
    ...(str(payload.fromDetail) ? { fromDetail: payload.fromDetail as string } : {}),
    ...(Array.isArray(payload.context) ? { context: payload.context as InboxContextMessage[] } : {}),
    ...(str(payload.externalUrl) ? { externalUrl: payload.externalUrl as string } : {}),
    ...(draft ? { draft } : {}),
    ...(entry.proposal?.by === "human" ? { draftEdited: true } : {}),
    ...(entry.proposal ? { draftAt: entry.proposal.at } : {}),
    ...(entry.proposal?.sessionId ? { draftSessionId: entry.proposal.sessionId } : {}),
    ...(payload.gmail ? { gmail: payload.gmail as InboxItem["gmail"] } : {}),
    ...(payload.slack ? { slack: payload.slack as InboxItem["slack"] } : {}),
    ...(reactions?.length ? { reactions } : {}),
    ...(payload.probablyResolved === true ? { probablyResolved: true } : {}),
    ...(Array.isArray(payload.images)
      ? { images: (payload.images as unknown[]).filter((u): u is string => typeof u === "string") }
      : {}),
    ...(resolved === "sent" && entry.actedAt !== undefined ? { sentAt: entry.actedAt } : {}),
    ...(resolved === "dismissed" && entry.actedAt !== undefined ? { dismissedAt: entry.actedAt } : {}),
    ...(resolved === "replied" && entry.actedAt !== undefined ? { repliedAt: entry.actedAt } : {}),
    ...(resolved === "replied" && entry.actionResult ? { externalReplyText: entry.actionResult } : {}),
  };
}

let pollTimer: number | null = null;

function anySurfaceVisible(): boolean {
  if (!can("inbox")) return false;
  if (appState.currentView === "inbox") return true;
  return [...surfaces].some((s) => s.pane && s.host.isConnected);
}

function ensurePolling(): void {
  if (!can("inbox")) return;
  if (pollTimer !== null) return;
  pollTimer = window.setInterval(() => {
    if (document.visibilityState !== "visible" || !anySurfaceVisible()) return;
    void refreshInbox({ silent: true });
  }, 120_000);
}

const feedWindows = new Map<string, { limit: number; nextCursor: string | null }>();
let refreshFollowUp = false;
let resyncMissedWhileHidden = false;

export async function refreshInbox(
  opts: { silent?: boolean; ifStaleMs?: number; more?: boolean; viewId?: string } = {},
): Promise<void> {
  if (!can("inbox")) return;
  if (inboxState.loading) {
    if (opts.ifStaleMs === undefined || resyncMissedWhileHidden) refreshFollowUp = true;
    return;
  }
  if (opts.ifStaleMs !== undefined && !resyncMissedWhileHidden && Date.now() - inboxState.fetchedAt < opts.ifStaleMs)
    return;
  resyncMissedWhileHidden = false;
  inboxState.loading = true;
  if (!opts.silent) drawAll();
  try {
    type Feed = {
      migrationPending: boolean;
      selected: typeof inboxState.selected;
      available: typeof inboxState.available;
      items: LedgerItem[];
      total: number;
      nextCursor: string | null;
    };
    const viewIds = new Set(["all", fullViewId, ...[...surfaces].map((surface) => surface.viewId)]);
    const moreView = opts.viewId ?? fullViewId;
    const combined = new Map<string, InboxItem>();
    for (const viewId of [...viewIds, ...[...viewIds].filter((id) => id !== "sent").map((id) => `handled:${id}`)]) {
      const handled = viewId.startsWith("handled:");
      const filterView = handled ? viewId.slice(8) : viewId;
      const previous = feedWindows.get(viewId);
      const limit = (previous?.limit ?? 40) + (opts.more && moreView === viewId ? 40 : 0);
      const qs = new URLSearchParams();
      if (handled) qs.set("view", "handled");
      else if (filterView === "sent") qs.set("view", "sent");
      if (filterView !== "all" && filterView !== "sent")
        qs.set("loopId", inboxState.selected.find((loop) => loop.source === filterView)?.id ?? filterView);
      let found = await api<Feed>(`/api/inbox?${qs}`);
      while (found.nextCursor && found.items.length < limit) {
        qs.set("cursor", found.nextCursor);
        const page = await api<Feed>(`/api/inbox?${qs}`);
        found = { ...page, items: [...found.items, ...page.items] };
      }
      feedWindows.set(viewId, { limit, nextCursor: found.nextCursor });
      inboxState.selected = found.selected;
      inboxState.available = found.available;
      inboxState.total = found.total;
      inboxState.migrationPending = found.migrationPending;
      for (const entry of found.items) combined.set(entry.id, toInboxItem(entry));
    }
    const next = [...combined.values()];
    const openId = fullSurface?.selectedId;
    const detail = openId ? inboxState.items.find((item) => item.id === openId && item.detailLoaded) : undefined;
    inboxState.items = next;
    if (detail && inboxState.selected.some((loop) => loop.id === detail.loopId)) {
      upsertItem(detail);
      void loadDetail(detail.id, detail.loopId);
    }
    if (openId && !detail) {
      const entry = inboxState.items.find((item) => item.id === openId);
      if (entry) void loadDetail(entry.id, entry.loopId);
    }
    const localItems = await fetchLocalInboxItems();
    if (localItems.length) inboxState.items = localItems;
    inboxState.loaded = true;
    inboxState.error = null;
    inboxState.fetchedAt = Date.now();
  } catch (e) {
    inboxState.error = e instanceof Error ? e.message : String(e);
  } finally {
    inboxState.loading = false;
    drawAll();
  }
  if (refreshFollowUp) {
    refreshFollowUp = false;
    void refreshInbox({ silent: true });
  }
}

interface ReviewOutput {
  id: string;
  title: string;
  summary?: string;
  shipAction: string;
  externalRef?: string;
  decisionNote?: string;
  state: string;
}

async function loadDetail(itemId: string, loopId: string): Promise<void> {
  try {
    const result = await api<{ item: LedgerItem; outputs: ReviewOutput[] }>(
      `/api/loops/${encodeURIComponent(loopId)}/items/${encodeURIComponent(itemId)}`,
    );
    if (!inboxState.selected.some((loop) => loop.id === loopId)) return;
    upsertItem({ ...toInboxItem(result.item), outputs: result.outputs, detailLoaded: true });
    drawAll();
  } catch (error) {
    inboxState.items = inboxState.items.filter((item) => item.id !== itemId);
    notify(error instanceof Error ? error.message : "无法加载事项");
  }
}

async function toggleSelection(id: string): Promise<void> {
  if (inboxState.selectionBusy) return;
  inboxState.selectionBusy = true;
  drawAll();
  const ids = inboxState.selected.map((loop) => loop.id);
  try {
    await api("/api/inbox/selection", {
      method: "POST",
      body: JSON.stringify({ loopIds: ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id] }),
    });
    if (fullViewId === id) fullViewId = "all";
    await refreshInbox();
  } catch (error) {
    notify(error instanceof Error ? error.message : "无法更新收件箱");
  } finally {
    inboxState.selectionBusy = false;
    drawAll();
  }
}

async function decideReview(
  item: InboxItem,
  output: ReviewOutput,
  decision: "ship" | "return",
  note: string,
): Promise<void> {
  if (acting.has(item.id)) return;
  if (decision === "return" && !note.trim()) {
    notify("请添加说明，描述需要修改的内容。");
    return;
  }
  acting.add(item.id);
  drawAll();
  try {
    const result = await api<{ output: ReviewOutput }>(
      `/api/loops/${encodeURIComponent(item.loopId)}/outputs/${encodeURIComponent(output.id)}/decide`,
      { method: "POST", body: JSON.stringify({ decision, note }) },
    );
    const messages: Record<string, string> = { shipped: "操作已完成", returned: "已要求修改" };
    notify(messages[result.output.state] ?? "等待确认中，请检查工作流状态后再重试。");
    await loadDetail(item.id, item.loopId);
    await refreshInbox({ silent: true });
  } catch (error) {
    notify(error instanceof Error ? error.message : "无法确认操作");
  } finally {
    acting.delete(item.id);
    drawAll();
  }
}

function reviewActionLabel(action: string): string {
  const labels: Record<string, string> = { open_draft_pr: "打开草稿 PR", open_pr: "打开 PR", send: "发送回复" };
  return labels[action] ?? `批准 ${action.replaceAll("_", " ")}`;
}

function reviewStateLabel(state: string): string {
  const labels: Record<string, string> = {
    unconfirmed: "等待确认",
    shipping: "操作进行中",
    returned: "已要求修改",
    superseded: "已被替代",
  };
  return labels[state] ?? state;
}

function usesOutputReview(item: InboxItem): boolean {
  return (
    item.source === "generic" ||
    Boolean(item.outputs?.some((output) => ["ready", "shipping", "unconfirmed"].includes(output.state)))
  );
}

function reviewTpl(item: InboxItem): TemplateResult {
  if (!item.detailLoaded) return html`<div class="empty compact">正在加载审核内容…</div>`;
  const outputs = item.outputs ?? [];
  return html`<div class="inbox-generic-review">
    <div class="inbox-draft-head"><span>${inboxViewName(item.loopId)}</span><span>${item.reviewState}</span></div>
    <p>${item.snippet}</p>
    ${!outputs.length && item.proposalData ? html`<pre class="inbox-proposal-data">${JSON.stringify(item.proposalData, null, 2)}</pre>` : nothing}
    ${outputs.map(
      (output) =>
        html`<section class="loop-output">
          <h2>${output.title}</h2>
          <p>${output.summary ?? ""}</p>
          ${output.decisionNote ? html`<p class="inbox-review-note">修改要求：${output.decisionNote}</p>` : nothing}
          <span class="loop-output-action">执行效果：${output.shipAction.replaceAll("_", " ")}</span>
          ${output.externalRef && /^https?:\/\//i.test(output.externalRef) ? html`<a href=${output.externalRef} target="_blank" rel="noopener noreferrer">打开产物</a>` : nothing}
          ${
            output.state === "ready"
              ? html`<div class="loop-output-decide">
                  <input
                    aria-label="修改要求"
                    placeholder="需要修改什么？"
                    .value=${chatDrafts.get(output.id) ?? ""}
                    @input=${(event: Event) => chatDrafts.set(output.id, (event.target as HTMLInputElement).value)}
                  />
                  <button
                    class="btn"
                    ?disabled=${acting.has(item.id)}
                    @click=${() => void decideReview(item, output, "return", chatDrafts.get(output.id) ?? "")}
                  >
                    要求修改
                  </button>
                  <button
                    class="btn primary"
                    ?disabled=${acting.has(item.id)}
                    @click=${() => void decideReview(item, output, "ship", "")}
                  >
                    ${reviewActionLabel(output.shipAction)}
                  </button>
                </div>`
              : html`<p role="status">${reviewStateLabel(output.state)}</p>`
          }
        </section>`,
    )}
    ${chatTpl(item)}
  </div>`;
}

async function fetchLocalInboxItems(): Promise<InboxItem[]> {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) return [];
  try {
    const response = await fetch("/inbox-seed.local.json", { cache: "no-store" });
    if (!response.ok) return [];
    const payload = (await response.json()) as { items?: unknown };
    if (!Array.isArray(payload.items)) return [];
    return payload.items.filter(
      (item): item is InboxItem =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as InboxItem).id === "string" &&
        typeof (item as InboxItem).sourceKey === "string" &&
        ((item as InboxItem).source === "gmail" || (item as InboxItem).source === "slack"),
    );
  } catch {
    return [];
  }
}

let realtimeWired = false;

const enqueueRealtimeEvent = createInboxEventCoalescer(
  250,
  (batch) => void applyRealtimeBatch(batch),
  (fn, ms) => void window.setTimeout(fn, ms),
);

async function applyRealtimeBatch(_batch: InboxItemRef[]): Promise<void> {
  await refreshInbox({ silent: true });
}

function upsertItem(next: InboxItem): void {
  if (inboxState.items.some((i) => i.id === next.id)) replaceItem(next);
  else inboxState.items = [next, ...inboxState.items];
}

function ensureRealtime(): void {
  if (realtimeWired) return;
  realtimeWired = true;
  onInboxItemEvent((event) => {
    if (!can("inbox")) return;
    if (!inboxState.selected.some((loop) => loop.id === event.loopId)) return;
    enqueueRealtimeEvent({ loopId: event.loopId, itemId: event.itemId });
  });
  onInboxResync(() => {
    if (!can("inbox")) return;
    if (document.visibilityState !== "visible" || !anySurfaceVisible()) {
      resyncMissedWhileHidden = true;
      return;
    }
    void refreshInbox({ silent: true });
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !anySurfaceVisible()) return;
    void refreshInbox({ ifStaleMs: 30_000, silent: true });
  });
}

function inboxItemById(id: string): InboxItem | undefined {
  const sent = selectedSentChat(id);
  return sent?.id === id ? toInboxItem(sent) : inboxState.items.find((item) => item.id === id);
}

async function continueSentReply(item: InboxItem): Promise<void> {
  try {
    replaceItem(await postAction(item, "reply"));
    drawAll();
  } catch (error) {
    notify(`无法开始回复：${error instanceof Error ? error.message : error}`);
  }
}

function replaceItem(next: InboxItem): void {
  inboxState.items = inboxState.items.map((i) => (i.id === next.id ? next : i));
}

function notify(msg: string | null): void {
  inboxState.notice = msg;
  drawAll();
  if (msg) {
    window.setTimeout(() => {
      if (inboxState.notice === msg) {
        inboxState.notice = null;
        drawAll();
      }
    }, 4000);
  }
}

function draftSubject(item: InboxItem, draft: InboxDraft): string {
  if (draft.subject !== undefined) return draft.subject;
  return item.gmail?.subject ? `Re: ${item.gmail.subject.replace(/^re:\s*/i, "")}` : "";
}

function headerPeek(item: InboxItem, draft: InboxDraft): string {
  const to = (draft.to ?? []).join(", ");
  const subject = draftSubject(item, draft);
  return [to, subject].filter(Boolean).join(" · ") || "收件人和主题";
}

function effectiveDraft(item: InboxItem): InboxDraft {
  const edited = draftEdits.get(item.id);
  if (edited) {
    const { basedOnAt: _basedOnAt, ...draft } = edited;
    return draft;
  }
  return {
    body: "",
    ...(item.source === "gmail"
      ? { to: item.gmail?.to ?? [], cc: item.gmail?.cc ?? [], subject: item.gmail?.subject }
      : {}),
    ...item.draft,
  };
}

function editDraft(item: InboxItem, patch: Partial<InboxDraft>): void {
  const basedOnAt = draftEdits.get(item.id)?.basedOnAt ?? item.draftAt;
  draftEdits.set(item.id, { ...effectiveDraft(item), ...patch, ...(basedOnAt !== undefined ? { basedOnAt } : {}) });
}

function isDraftConflict(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409 && /draft changed/i.test(e.message);
}

async function explainDraftConflict(item: InboxItem, edited: boolean): Promise<void> {
  await refetchItem(item);
  const fresh = inboxItemById(item.id);
  const overlay = draftEdits.get(item.id);
  if (overlay && fresh?.draftAt !== undefined) draftEdits.set(item.id, { ...overlay, basedOnAt: fresh.draftAt });
  const preview = (fresh?.draft?.body ?? "").trim().slice(0, 140);
  notify(
    edited
      ? `你编辑期间智能体已重新生成回复。输入框保留了你的内容。新草稿：“${preview}”。再次发送将使用你的版本。`
      : "你查看期间草稿已发生变化，请审核新草稿后再发送。",
  );
}

function addressHeaderList(raw: string): string[] {
  return raw.trim() ? [raw.trim()] : [];
}

function actionPath(item: InboxItem, leaf: "action" | "followup"): string {
  return `/api/loops/${encodeURIComponent(item.loopId)}/items/${encodeURIComponent(item.id)}/${leaf}`;
}

async function refetchItem(item: InboxItem): Promise<void> {
  try {
    const { item: fresh } = await api<{ item: LedgerItem }>(
      `/api/loops/${encodeURIComponent(item.loopId)}/items/${encodeURIComponent(item.id)}`,
    );
    updateSentChat(fresh);
    replaceItem({ ...toInboxItem(fresh), detailLoaded: true });
    drawAll();
  } catch {
    void refreshInbox({ silent: true });
  }
}

async function postAction(item: InboxItem, kind: string, args?: Record<string, unknown>): Promise<InboxItem> {
  const { item: next } = await api<{ item: LedgerItem }>(actionPath(item, "action"), {
    method: "POST",
    body: JSON.stringify({ kind, ...(args ? { args } : {}) }),
  });
  updateSentChat(next);
  return { ...toInboxItem(next), detailLoaded: true };
}

const persistQueue = new Map<string, Promise<void>>();
const persistWaiting = new Set<string>();

function enqueueForItem(itemId: string, task: () => Promise<void>): Promise<void> {
  const queued = (persistQueue.get(itemId) ?? Promise.resolve()).then(task);
  persistQueue.set(itemId, queued);
  void queued.finally(() => {
    if (persistQueue.get(itemId) === queued) persistQueue.delete(itemId);
  });
  return queued;
}

export function persistDraft(item: InboxItem): Promise<void> {
  if (persistWaiting.has(item.id)) return persistQueue.get(item.id) ?? Promise.resolve();
  persistWaiting.add(item.id);
  return enqueueForItem(item.id, () => {
    persistWaiting.delete(item.id);
    return persistDraftNow(item.id);
  });
}

async function persistDraftNow(itemId: string): Promise<void> {
  const item = inboxItemById(itemId);
  if (!item) return;
  const edited = draftEdits.get(item.id);
  if (!edited) return;
  const saved = item.draft;
  if (
    saved &&
    saved.body === edited.body &&
    (saved.subject ?? "") === (edited.subject ?? "") &&
    (saved.to ?? []).join(",") === (edited.to ?? []).join(",") &&
    (saved.cc ?? []).join(",") === (edited.cc ?? []).join(",")
  ) {
    draftEdits.delete(item.id);
    return;
  }
  const { basedOnAt, ...proposal } = edited;
  try {
    const next = await postAction(item, "edit", {
      proposal,
      ...(basedOnAt !== undefined ? { expectedProposalAt: basedOnAt } : {}),
    });
    const newer = draftEdits.get(item.id);
    if (newer === edited) draftEdits.delete(item.id);
    else if (newer && next.draftAt !== undefined) draftEdits.set(item.id, { ...newer, basedOnAt: next.draftAt });
    replaceItem(next);
  } catch (e) {
    if (isDraftConflict(e)) return explainDraftConflict(item, true);
    notify(`无法保存草稿：${e instanceof Error ? e.message : e}`);
  }
}

async function sendItem(item: InboxItem): Promise<void> {
  if (item.source === "generic" || !item.detailLoaded || sending.has(item.id)) return;
  if (!effectiveDraft(item).body.trim()) {
    notify("草稿为空，没有可发送的内容。");
    return;
  }
  sending.add(item.id);
  drawAll();
  try {
    await enqueueForItem(item.id, () => sendItemNow(item.id));
  } finally {
    sending.delete(item.id);
    drawAll();
  }
}

async function sendItemNow(itemId: string): Promise<void> {
  const item = inboxItemById(itemId);
  if (!item) return;
  const edited = draftEdits.get(item.id);
  const draft = effectiveDraft(item);
  if (!draft.body.trim()) {
    notify("草稿为空，没有可发送的内容。");
    return;
  }
  try {
    const basedOnAt = edited?.basedOnAt ?? item.draftAt;
    const next = await postAction(item, "send", {
      proposal: draft,
      ...(basedOnAt !== undefined ? { expectedProposalAt: basedOnAt } : {}),
    });
    if (draftEdits.get(item.id) === edited) draftEdits.delete(item.id);
    replaceItem(next);
    notify(item.source === "gmail" ? "回复已通过邮件发送。" : "回复已发送到 Slack。");
  } catch (e) {
    if (isDraftConflict(e)) return explainDraftConflict(item, Boolean(edited));
    const hint =
      e instanceof ApiError && e.status === 409 && /connect/i.test(e.message) ? "。请在密钥库中重新连接" : "";
    notify(`发送失败：${e instanceof Error ? e.message : e}${hint}`);
  }
}

export async function setItemStatus(item: InboxItem, status: "open" | "dismissed"): Promise<boolean> {
  if (acting.has(item.id)) return false;
  acting.add(item.id);
  drawAll();
  try {
    upsertItem(await postAction(item, status === "dismissed" ? "dismiss" : "reopen"));
    if (status === "dismissed") showArchiveToast(item);
    return true;
  } catch (e) {
    notify(`无法更新事项：${e instanceof Error ? e.message : e}`);
    return false;
  } finally {
    acting.delete(item.id);
    drawAll();
  }
}

export async function askAgent(item: InboxItem, message: string): Promise<void> {
  const text = message.trim();
  if (!text || chatting.has(item.id)) return;
  chatting.add(item.id);
  chatDrafts.delete(item.id);
  drawAll();
  try {
    const { item: next } = await api<{ item: LedgerItem }>(actionPath(item, "followup"), {
      method: "POST",
      body: JSON.stringify({ message: text }),
    });
    updateSentChat(next);
    const mapped = { ...toInboxItem(next), outputs: item.outputs, detailLoaded: true };
    draftEdits.delete(item.id);
    replaceItem(mapped);
  } catch (e) {
    notify(`智能体无法回答：${e instanceof Error ? e.message : e}`);
    if (!chatDrafts.has(item.id)) chatDrafts.set(item.id, text);
  } finally {
    chatting.delete(item.id);
    drawAll();
  }
}

async function setUpSync(loopId?: string): Promise<void> {
  if (inboxState.syncBusy) return;
  inboxState.syncBusy = true;
  drawAll();
  try {
    const out = await api<{ loop: { id: string } | null; syncCron: InboxSyncCron | null }>("/api/inbox/sync-cron", {
      method: "POST",
      body: JSON.stringify({ enabled: true, loopId }),
    });
    inboxState.syncCron = out.syncCron;
    inboxState.loopId = out.loop?.id ?? inboxState.loopId;
    notify("同步已开启，首次同步将在 15 分钟内执行。");
    await refreshInbox({ silent: true });
  } catch (e) {
    notify(`无法设置同步：${e instanceof Error ? e.message : e}`);
  } finally {
    inboxState.syncBusy = false;
    drawAll();
  }
}

async function syncNow(viewId: string): Promise<void> {
  const crons = syncLoops(viewId).flatMap((loop) => (loop.syncCron ? [loop.syncCron] : []));
  if (!crons.length || inboxState.syncBusy) return;
  inboxState.syncBusy = true;
  drawAll();
  try {
    for (const cron of crons)
      await api(`/api/crons/${encodeURIComponent(cron.id)}/run`, { method: "POST", body: "{}" });
    notify("同步已开始，智能体完成草稿后会显示新事项。");
  } catch (e) {
    notify(`无法开始同步：${e instanceof Error ? e.message : e}`);
  } finally {
    inboxState.syncBusy = false;
    drawAll();
  }
}

function openDraftSession(e: MouseEvent, sessionId: string): void {
  e.preventDefault();
  const session = sessionsState.list.find((s) => s.id === sessionId);
  if (session) void openSession(session);
  else window.location.assign(deepLinkPath(UI_BASE, "chats", sessionId));
}

function sourceGlyph(item: InboxItem): TemplateResult {
  return loopIcon(inboxState.selected.find((loop) => loop.id === item.loopId) ?? { source: item.source }, 14);
}

function fmtClock(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}

interface Participant {
  key: string;
  name: string;
}

function participantName(raw: string): string {
  return (raw.match(/^\s*"?([^"<]+?)"?\s*</)?.[1] ?? raw).trim();
}

function participantKey(raw: string): string {
  return (raw.match(/<([^>]+)>/)?.[1] ?? raw).trim().toLowerCase();
}

function participantsOf(item: InboxItem): Participant[] {
  const found = new Map<string, Participant>();
  for (const raw of [item.from, ...(item.context ?? []).map((m) => m.author)]) {
    const name = participantName(raw ?? "");
    if (!name) continue;
    const key = participantKey(raw);
    if (!found.has(key)) found.set(key, { key, name });
  }
  return [...found.values()];
}

function avatarHue(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) % 360;
  return hash;
}

const AVATARS_SHOWN = 4;

export function participantsTpl(item: InboxItem): TemplateResult | typeof nothing {
  const people = participantsOf(item);
  if (!people.length) return nothing;
  const shown = people.length > AVATARS_SHOWN ? people.slice(0, AVATARS_SHOWN - 1) : people;
  const rest = people.slice(shown.length);
  return html`<span class="inbox-avatars" aria-label=${`在此对话中：${people.map((p) => p.name).join(", ")}`}>
    ${shown.map(
      (p) =>
        html`<span class="inbox-avatar" style=${`--avatar-hue:${avatarHue(p.key)}`} ${tip(p.name)} aria-hidden="true"
          >${initials(p.name)}</span
        >`,
    )}
    ${
      rest.length
        ? html`<span class="inbox-avatar more" ${tip(rest.map((p) => p.name).join(", "))} aria-hidden="true"
            >+${rest.length}</span
          >`
        : nothing
    }
  </span>`;
}

function selfHandle(): string {
  const me = appState.me?.user ?? "";
  return (me.split("@")[0] || me).trim().toLowerCase();
}

export function slackTextTpl(item: InboxItem, text: string, opts: { links?: boolean } = {}): TemplateResult {
  if (item.source !== "slack") return html`${text}`;
  const self = selfHandle();
  const mentionChip = (handle: string): TemplateResult =>
    html`<span class="slack-mention ${handle.toLowerCase() === self ? "self" : ""}">@${handle}</span>`;
  const withMentions = (str: string): Array<TemplateResult | string> =>
    splitMentions(str).map((m) => (m.kind === "text" ? m.text : mentionChip(m.handle)));
  return html`${splitSlackWire(text).map((seg) => {
    if (seg.kind === "mention") return mentionChip(seg.handle);
    if (seg.kind === "link") {
      if (opts.links === false) return html`<span ${tip(seg.href)}>${withMentions(seg.label)}</span>`;
      return html`<a class="inbox-text-link" href=${seg.href} target="_blank" rel="noreferrer noopener"
        >${withMentions(seg.label)}</a
      >`;
    }
    return withMentions(seg.text);
  })}`;
}

function itemImagesTpl(item: InboxItem, urls: string[] | undefined, ctxIndex: number): TemplateResult | typeof nothing {
  if (!urls?.length) return nothing;
  const base = `${UI_BASE}/api/loops/${encodeURIComponent(item.loopId)}/items/${encodeURIComponent(item.id)}/image`;
  return html`<div class="inbox-images">
    ${urls.map((_u, j) => {
      const src = `${base}?ctx=${ctxIndex}&i=${j}`;
      return html`<a href=${src} target="_blank" rel="noreferrer noopener"
        ><img class="inbox-image" src=${src} loading="lazy" alt="附件图片"
      /></a>`;
    })}
  </div>`;
}

export function contextTpl(item: InboxItem): TemplateResult | typeof nothing {
  const rows = [
    ...(item.context ?? []).map((message, index) => ({ ...message, imageIndex: index })),
    { author: item.from, at: item.receivedAt, text: item.snippet, images: item.images, imageIndex: -1 },
  ];
  return html`<div class="inbox-context">
    ${rows.map((m) => {
      const name = participantName(m.author) || m.author;
      return html`
        <div class="inbox-context-msg">
          <span class="inbox-avatar" style=${`--avatar-hue:${avatarHue(participantKey(m.author))}`} aria-hidden="true"
            >${initials(name)}</span
          >
          <div class="inbox-context-body">
            <div class="inbox-context-head">
              <span class="inbox-context-author">${name}</span>
              ${m.at ? html`<span class="inbox-context-at">${relTime(m.at)}</span>` : nothing}
            </div>
            <div class="inbox-context-text">${slackTextTpl(item, m.text)}</div>
            ${itemImagesTpl(item, m.images, m.imageIndex)}
          </div>
        </div>
      `;
    })}
  </div>`;
}

export function chatTpl(item: InboxItem): TemplateResult {
  const busy = chatting.has(item.id);
  let suggestions = DRAFT_SUGGESTIONS;
  if (item.sentChat) suggestions = ["总结这封邮件", "我需要跟进哪些事项？"];
  else if (item.source === "generic") suggestions = ["解释这个方案", "哪些事情需要我处理？"];
  const pending = chatDrafts.get(item.id) ?? "";
  const submit = (el: HTMLTextAreaElement): void => {
    if (busy) return;
    const text = el.value;
    el.value = "";
    autosizeChatInput(el);
    void askAgent(item, text);
  };
  const empty = item.thread.length === 0;
  return html`
    <div class="inbox-chat">
      ${
        empty
          ? html`<div class="inbox-chat-empty">
              <h2 class="inbox-chat-cta">${item.sentChat ? "询问这封邮件的内容" : "我该修改什么？"}</h2>
              <div class="inbox-chat-suggestions">
                ${suggestions.map(
                  (prompt) =>
                    html`<button
                      class="inbox-chat-suggestion"
                      type="button"
                      ?disabled=${busy}
                      @click=${() => void askAgent(item, prompt)}
                    >
                      ${prompt}
                    </button>`,
                )}
              </div>
            </div>`
          : html`<div class="inbox-chat-log">
              ${item.thread.map(
                (m) =>
                  html`<div class="inbox-chat-msg ${m.role}">
                    <span class="inbox-chat-text">${m.text}</span>
                  </div>`,
              )}
            </div>`
      }
      ${busy ? html`<div class="inbox-chat-working">${workingWave()}<span>正在思考…</span></div>` : nothing}
      <div class="inbox-chat-composer ${pending.trim() ? "has-text" : ""}">
        <textarea
          class="inbox-chat-input"
          rows="1"
          placeholder=${`向 ${brandName()} 提问`}
          .value=${pending}
          @input=${(e: Event) => {
            const box = e.currentTarget as HTMLTextAreaElement;
            const had = Boolean((chatDrafts.get(item.id) ?? "").trim());
            chatDrafts.set(item.id, box.value);
            autosizeChatInput(box);
            if (had !== Boolean(box.value.trim())) drawAll();
          }}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit(e.currentTarget as HTMLTextAreaElement);
            }
          }}
        ></textarea>
        <div class="inbox-chat-actions">
          <div class="inbox-chat-suggest">
            ${
              item.status === "open" && !item.sentChat && !usesOutputReview(item)
                ? html`
                    <button
                      class="inbox-suggest-chip primary"
                      type="button"
                      ?disabled=${sending.has(item.id)}
                      ${tip(item.source === "gmail" ? "通过 Gmail 发送回复草稿" : "将回复草稿发送到 Slack")}
                      @click=${() => void sendItem(item)}
                    >
                      ${icon(Send, 12)}<span>${sending.has(item.id) ? "正在发送…" : "发送"}</span>
                    </button>
                    <button
                      class="inbox-suggest-chip"
                      type="button"
                      @click=${() => void setItemStatus(item, "dismissed")}
                    >
                      ${icon(X, 12)}<span>关闭</span>
                    </button>
                  `
                : nothing
            }
          </div>
          <button
            class="btn inbox-chat-send"
            type="button"
            aria-label="提问"
            ${tip("输入问题。按 Enter 发送，Shift+Enter 换行")}
            ?disabled=${busy || !pending.trim()}
            @click=${(e: MouseEvent) => {
              const box = (e.currentTarget as HTMLElement)
                .closest(".inbox-chat-composer")
                ?.querySelector<HTMLTextAreaElement>(".inbox-chat-input");
              if (box) submit(box);
            }}
          >
            ${icon(ArrowUp, 14)}
          </button>
        </div>
      </div>
    </div>
  `;
}

export function draftEditorTpl(item: InboxItem, opts: { chat?: boolean } = {}): TemplateResult {
  const draft = effectiveDraft(item);
  const gmail = item.source === "gmail";
  const showCc = gmail && ((draft.cc?.length ?? 0) > 0 || (item.gmail?.cc?.length ?? 0) > 0);
  return html`
    <div class="inbox-draft ${gmail ? "email" : "slack"}">
      <div class="inbox-draft-head">
        <span class="inbox-draft-label">回复草稿</span>
        ${
          item.draftSessionId
            ? html`<a
                class="inbox-session-link"
                href=${deepLinkPath(UI_BASE, "chats", item.draftSessionId)}
                title="查看智能体如何生成此草稿"
                @click=${(e: MouseEvent) => openDraftSession(e, item.draftSessionId!)}
              >
                ${icon(ArrowUpRight, 12)}<span>打开智能体会话</span>
              </a>`
            : nothing
        }
        ${
          item.externalUrl
            ? html`<a class="inbox-external-link" href=${item.externalUrl} target="_blank" rel="noreferrer noopener">
                ${icon(ArrowUpRight, 12)}<span>在 ${gmail ? "Gmail" : "Slack"} 中打开</span>
              </a>`
            : nothing
        }
      </div>
      ${
        gmail
          ? html`
              <details class="inbox-draft-headers">
                <summary><span class="inbox-draft-headers-peek">${headerPeek(item, draft)}</span></summary>
                <div class="inbox-draft-headers-fields">
                  <label class="inbox-field">
                    <span>收件人</span>
                    <input
                      type="text"
                      .value=${(draft.to ?? []).join(", ")}
                      placeholder="who@example.com"
                      @input=${(e: Event) => editDraft(item, { to: addressHeaderList((e.currentTarget as HTMLInputElement).value) })}
                      @blur=${() => void persistDraft(item)}
                    />
                  </label>
                  ${
                    showCc
                      ? html`<label class="inbox-field">
                          <span>抄送</span>
                          <input
                            type="text"
                            .value=${(draft.cc ?? []).join(", ")}
                            @input=${(e: Event) => editDraft(item, { cc: addressHeaderList((e.currentTarget as HTMLInputElement).value) })}
                            @blur=${() => void persistDraft(item)}
                          />
                        </label>`
                      : nothing
                  }
                  <label class="inbox-field">
                    <span>主题</span>
                    <input
                      type="text"
                      .value=${draftSubject(item, draft)}
                      @input=${(e: Event) => editDraft(item, { subject: (e.currentTarget as HTMLInputElement).value })}
                      @blur=${() => void persistDraft(item)}
                    />
                  </label>
                </div>
              </details>
            `
          : nothing
      }
      <div class="inbox-draft-body-wrap">
        <textarea
          class="inbox-draft-body"
          rows=${gmail ? 7 : 3}
          placeholder=${item.draft ? "撰写回复…" : "暂无草稿。下次同步将生成草稿，你也可以自行撰写。"}
          .value=${draft.body}
          @input=${(e: Event) => editDraft(item, { body: (e.currentTarget as HTMLTextAreaElement).value })}
          @blur=${() => void persistDraft(item)}
        ></textarea>
      </div>
      ${
        !gmail && item.reactions?.length
          ? html`<div class="inbox-reactions">${item.reactions.map((name) => reactionChipTpl(name))}</div>`
          : nothing
      }
      ${opts.chat === false ? nothing : chatTpl(item)}
    </div>
  `;
}

function reactionChipTpl(name: string): TemplateResult {
  ensureEmojiChips();
  const char = charForName(name);
  return html`<span class="inbox-reaction-chip" title=${`:${name}:`}>${char ?? `:${name}:`}</span>`;
}

function handledStateLabel(item: InboxItem): string {
  if (item.status === "sent") return "已发送";
  if (item.status === "replied") return "已回复";
  return "已忽略";
}

function itemSideMark(item: InboxItem, handled: boolean): TemplateResult | typeof nothing {
  if (handled) return html`<span class="inbox-item-state">${handledStateLabel(item)}</span>`;
  if (item.draft) return html`<span class="inbox-item-drafted" title="回复草稿已就绪">${icon(CheckCheck, 12)}</span>`;
  return nothing;
}

function reopenButtonTpl(item: InboxItem): TemplateResult {
  return html`<button class="btn inbox-reopen" type="button" @click=${() => void setItemStatus(item, "open")}>
    ${icon(Undo2, 13)}<span>重新打开</span>
  </button>`;
}

export function handledNoteTpl(item: InboxItem): TemplateResult {
  if (item.status === "sent") {
    return html`<div class="inbox-handled-note">
      ${icon(CheckCheck, 13)}<span>回复已发送 ${item.sentAt ? relTime(item.sentAt) : ""}</span>
    </div>`;
  }
  if (item.status === "replied") {
    const where = item.source === "slack" ? "Slack" : "Gmail";
    return html`<div class="inbox-handled-note inbox-replied-note">
      <div class="inbox-handled-line">
        ${icon(CheckCheck, 13)}<span>你已在 ${where} 回复 ${item.repliedAt ? relTime(item.repliedAt) : ""}</span>
        ${reopenButtonTpl(item)}
      </div>
      ${item.externalReplyText ? html`<div class="inbox-replied-text">${slackTextTpl(item, item.externalReplyText)}</div>` : nothing}
    </div>`;
  }
  return html`<div class="inbox-handled-note">
    ${icon(X, 13)}<span>已忽略 ${item.dismissedAt ? relTime(item.dismissedAt) : ""}</span>
    ${reopenButtonTpl(item)}
  </div>`;
}

function itemRowTpl(surface: InboxSurface, item: InboxItem): TemplateResult {
  const inlineDetail = surface.pane;
  const open = surface.selectedId === item.id;
  const expanded = inlineDetail && open;
  const expandedAttr = inlineDetail ? String(open) : nothing;
  const handled = item.status !== "open";
  const gmail = item.source === "gmail";
  const heading = gmail ? item.from || item.title : (item.slack?.channelLabel ?? item.title);
  const sub = gmail ? item.title : item.from || inboxViewName(item.loopId);
  return html`
    <div class="inbox-item ${expanded ? "expanded" : ""} ${handled ? "handled" : ""} src-${item.source}">
      <div class="inbox-item-summary">
        <button
          class="inbox-item-row"
          type="button"
          aria-expanded=${expandedAttr}
          @click=${() => {
            const previous = surface.selectedId;
            if (previous && previous !== item.id) {
              const prevItem = inboxState.items.find((i) => i.id === previous);
              if (prevItem) void persistDraft(prevItem);
            }
            surface.selectedId = inlineDetail && open ? null : item.id;
            if (surface.selectedId) void loadDetail(item.id, item.loopId);
            if (!inlineDetail) syncInboxUrl(surface.selectedId, true);
            drawAll();
          }}
        >
          <span class="inbox-item-glyph">${sourceGlyph(item)}</span>
          <span class="inbox-item-main">
            <span class="inbox-item-top">
              <span class="inbox-item-heading">${heading}</span>
              <span class="inbox-item-sub">${sub}</span>
            </span>
            <span class="inbox-item-snippet">${slackTextTpl(item, item.snippet, { links: false })}</span>
          </span>
          <span class="inbox-item-side">
            ${participantsTpl(item)} ${itemSideMark(item, handled)}
            <span class="inbox-item-time" title=${fmtClock(item.receivedAt)}>${relTime(item.receivedAt)}</span>
            ${icon(expanded ? ChevronDown : ChevronRight, 13)}
          </span>
        </button>
        ${
          !handled
            ? html`<button
                class="session-menu-btn inbox-item-dismiss"
                type="button"
                aria-label=${`归档 ${item.title || heading}`}
                ${tip("归档")}
                ?disabled=${acting.has(item.id)}
                @click=${() => void setItemStatus(item, "dismissed")}
              >
                ${icon(Archive, 13.5)}
              </button>`
            : nothing
        }
      </div>
      ${
        expanded
          ? html`<div class="inbox-item-detail">
              ${usesOutputReview(item) ? reviewTpl(item) : html`${contextTpl(item)} ${handled ? handledNoteTpl(item) : draftEditorTpl(item)}`}
            </div>`
          : nothing
      }
    </div>
  `;
}

function syncStatusLabel(cron: InboxSyncCron): string {
  if (!cron.enabled) return "同步已暂停";
  return cron.lastFiredAt ? `已同步 ${relTime(cron.lastFiredAt)}` : "等待首次同步";
}

function syncActionTpl(opts: {
  label: string;
  busyLabel: string;
  busy: boolean;
  tooltip: string;
  action: () => void;
}): TemplateResult {
  return html`<button
    class="btn inbox-sync-action"
    type="button"
    ${tip(opts.tooltip)}
    ?disabled=${opts.busy}
    @click=${opts.action}
  >
    ${icon(RefreshCw, 13)}<span>${opts.busy ? opts.busyLabel : opts.label}</span>
  </button>`;
}

function syncLoops(viewId: string) {
  return inboxState.selected.filter(
    (loop) => loop.source && (viewId === "all" || loop.id === viewId || loop.source === viewId),
  );
}

function syncLineTpl(surface: InboxSurface): TemplateResult | typeof nothing {
  if (surface.viewId === "sent") {
    const busy = isSentMailLoading();
    return syncActionTpl({
      label: "刷新",
      busyLabel: "正在刷新…",
      busy,
      tooltip: "刷新已发送邮件",
      action: () => void loadSentMail(drawAll),
    });
  }
  const loops = syncLoops(surface.viewId);
  const crons = loops.flatMap((loop) => (loop.syncCron ? [loop.syncCron] : []));
  if (!crons.length) return nothing;
  return html`<span class="inbox-sync-line">
    ${syncActionTpl({
      label: "同步",
      busyLabel: "正在同步…",
      busy: inboxState.syncBusy,
      tooltip: "立即同步",
      action: () => void syncNow(surface.viewId),
    })}
    <span class="inbox-sync-status"
      >${crons.length === 1 ? syncStatusLabel(crons[0]!) : `${crons.filter((cron) => cron.enabled).length} 同步已开启`}</span
    >
  </span>`;
}

function surfaceTpl(surface: InboxSurface): TemplateResult {
  const density = surface.density();
  const compact = density !== "full";
  const allOpen = itemsFor(surface.viewId, "open");
  const openItems = allOpen.filter((i) => !i.probablyResolved);
  const resolvedItems = allOpen.filter((i) => i.probablyResolved);
  const handledItems = itemsFor(surface.viewId, "handled");
  const setupLoops = inboxState.selected.filter(
    (loop) =>
      loop.source && !loop.cronId && !loop.ingestionActive && (surface.viewId === loop.id || surface.viewId === "all"),
  );
  const chips = html`
    <div class="inbox-chips" role="tablist" aria-label="收件箱视图">
      ${inboxViews().map((v) => {
        const count = inboxOpenCount(v.id);
        return html`<button
          class="inbox-chip ${surface.viewId === v.id ? "active" : ""}"
          type="button"
          role="tab"
          aria-selected=${surface.viewId === v.id ? "true" : "false"}
          @click=${() => {
            if (surface === fullSurface) selectInboxView(v.id, true);
            else surface.viewId = v.id;
            void refreshInbox();
            drawAll();
          }}
        >
          ${v.id === "all" ? nothing : loopIcon(inboxState.selected.find((loop) => loop.id === v.id) ?? {})}<span>${v.name}</span>${count > 0 ? html`<span class="inbox-chip-count">${count}</span>` : nothing}
        </button>`;
      })}
      ${
        surface.viewId !== "all" && surface.viewId !== "sent"
          ? html`<button
              class="icon-btn subtle compact"
              aria-label=${`${inboxViewName(surface.viewId)} 的选项`}
              @click=${() => {
                inboxState.menuId = inboxState.menuId === surface.viewId ? null : surface.viewId;
                drawAll();
              }}
            >
              ${icon(MoreHorizontal, 16)}
            </button>`
          : nothing
      }
      <button
        class="inbox-chip inbox-add-loop"
        type="button"
        aria-label="添加工作流"
        aria-expanded=${inboxState.picker}
        @click=${() => {
          inboxState.picker = !inboxState.picker;
          drawAll();
        }}
      >
        ${icon(Plus, 16)}
      </button>
      <span class="inbox-chip-divider" aria-hidden="true"></span>
      <button
        class="inbox-chip ${surface.viewId === "sent" ? "active" : ""}"
        type="button"
        role="tab"
        aria-selected=${surface.viewId === "sent"}
        @click=${() => {
          if (surface === fullSurface) selectInboxView("sent", true);
          else surface.viewId = "sent";
          ensureSentMail(drawAll);
          drawAll();
        }}
      >
        已发送
      </button>
    </div>
  `;
  const list = html`
    ${!inboxState.loaded && inboxState.loading ? html`<div class="empty compact">正在读取收件箱…</div>` : nothing}
    ${
      inboxState.error && !inboxState.loaded
        ? html`<div class="empty compact">无法加载收件箱：${inboxState.error}</div>`
        : nothing
    }
    ${
      inboxState.loaded && openItems.length === 0
        ? html`<div class="empty compact inbox-zero">
            ${
              surface.viewId === "sent"
                ? "暂无已发送消息。已发送的邮件和 Slack 回复将显示在这里。"
                : "所选工作流中暂无需要你处理的事项。"
            }
          </div>`
        : nothing
    }
    <div class="inbox-list">${openItems.map((i) => itemRowTpl(surface, i))}</div>
    ${
      resolvedItems.length
        ? html`<div class="inbox-resolved-sect">
            <div class="inbox-resolved-head">可能已解决 · 通常无需回复</div>
            <div class="inbox-list inbox-resolved-list">${resolvedItems.map((i) => itemRowTpl(surface, i))}</div>
          </div>`
        : nothing
    }
    ${
      handledItems.length
        ? html`
            <button
              class="inbox-handled-toggle"
              type="button"
              aria-expanded=${surface.showHandled ? "true" : "false"}
              @click=${() => {
                surface.showHandled = !surface.showHandled;
                drawAll();
              }}
            >
              ${icon(surface.showHandled ? ChevronDown : ChevronRight, 13)}
              <span>已处理（${handledItems.length}）</span>
            </button>
            ${surface.showHandled ? html`<div class="inbox-list handled">${handledItems.map((i) => itemRowTpl(surface, i))}</div>` : nothing}${surface.showHandled && feedWindows.get(`handled:${surface.viewId}`)?.nextCursor ? html`<button class="btn" ?disabled=${inboxState.loading} @click=${() => void refreshInbox({ more: true, viewId: `handled:${surface.viewId}` })}>加载更多已处理事项</button>` : nothing}
          `
        : nothing
    }
  `;
  return html`
    <div class="inbox-surface ${compact ? "compact" : ""}" data-density=${density}>
      ${inboxState.migrationPending ? html`<div class="inbox-notice" role="status">正在迁移现有收件箱。待当前任务完成并核对记录后，即可设置同步。</div>` : nothing}
      <div class="inbox-toolbar">
        ${chips} ${surface.pane ? html`<span class="inbox-toolbar-spacer"></span>${syncLineTpl(surface)}` : nothing}
      </div>
      ${
        setupLoops.length
          ? html`<section class="inbox-setup" aria-label="设置账户同步">
              ${setupLoops.map(
                (loop) =>
                  html`<div class="inbox-setup-row">
                    <span class="inbox-setup-icon" aria-hidden="true">${loopIcon(loop, 17)}</span>
                    <div class="inbox-setup-copy">
                      <span class="inbox-setup-title">${loop.name}</span
                      ><span class="inbox-setup-description">尚未设置同步</span>
                    </div>
                    <button
                      class="inbox-setup-action"
                      aria-label=${`设置 ${loop.name}`}
                      ?disabled=${inboxState.syncBusy || inboxState.migrationPending}
                      @click=${() => void setUpSync(loop.id)}
                    >
                      <span>${inboxState.syncBusy ? "正在设置…" : "设置"}</span>${icon(ChevronRight, 14)}
                    </button>
                  </div>`,
              )}
            </section>`
          : nothing
      }
      ${
        inboxState.menuId
          ? html`<div class="inbox-loop-menu" role="menu">
              <button
                class="btn"
                role="menuitem"
                ?disabled=${!can("loops")}
                @click=${() => {
                  const id = inboxState.menuId!;
                  inboxState.menuId = null;
                  switchView("loops");
                  openLoop(id);
                }}
              >
                打开工作流
              </button>
              <button
                class="btn"
                role="menuitem"
                @click=${() => {
                  const id = inboxState.menuId!;
                  inboxState.menuId = null;
                  void toggleSelection(id);
                }}
              >
                从收件箱移除
              </button>
            </div>`
          : nothing
      }
      ${
        inboxState.picker
          ? html`<section class="inbox-loop-picker" aria-label="添加工作流">
              <div class="inbox-draft-head">
                <strong>收件箱中的工作流</strong
                ><button
                  class="icon-btn"
                  aria-label="关闭选择器"
                  @click=${() => {
                    inboxState.picker = false;
                    drawAll();
                  }}
                >
                  ${icon(X, 16)}
                </button>
              </div>
              <p>选择要在这里审核的工作流。</p>
              ${inboxState.available.map((loop) => html`<label><input type="checkbox" .checked=${loop.selected} ?disabled=${inboxState.selectionBusy} @change=${() => void toggleSelection(loop.id)} />${loopIcon(loop)}<span>${loop.name}</span><span>${loop.selected ? "已包含" : "添加"}</span></label>`)}
            </section>`
          : nothing
      }
      ${feedWindows.get(surface.viewId)?.nextCursor ? html`<button class="btn" ?disabled=${inboxState.loading} @click=${() => void refreshInbox({ more: true, viewId: surface.viewId })}>加载更多</button>` : nothing}
      ${inboxState.notice ? html`<div class="inbox-notice" role="status">${inboxState.notice}</div>` : nothing}
      <div class="inbox-scroll">
        ${
          surface.viewId === "sent"
            ? sentMailTpl(drawAll, (message) => {
                resetActiveInboxItem();
                if (surface.pane) {
                  exitSplitIfActive();
                  switchView("inbox");
                }
                fullViewId = "sent";
                if (fullSurface) fullSurface.selectedId = null;
                syncInboxUrl(message.id, true);
                void openSentEmail(message, drawAll);
              })
            : list
        }
      </div>
    </div>
  `;
}

function itemDetailTpl(item: InboxItem, handled: boolean): TemplateResult {
  if (usesOutputReview(item)) return reviewTpl(item);
  if (!item.detailLoaded) return html`<div class="empty compact">正在加载消息…</div>`;
  return html`${contextTpl(item)} ${handled ? handledNoteTpl(item) : draftEditorTpl(item, { chat: false })}`;
}

function itemPageTpl(item: InboxItem): TemplateResult {
  const handled = item.status !== "open";
  const gmail = item.source === "gmail";
  const heading = gmail ? item.from || item.title : (item.slack?.channelLabel ?? item.title);
  const sub = gmail ? item.title : "";
  return html`
    <div class="pane-head inbox-item-head src-${item.source}">
      <div class="inbox-item-head-copy">
        ${listBackLink("收件箱", closeInboxItem)}
        <h1 class="pane-title">
          <span class="inbox-item-glyph">${sourceGlyph(item)}</span><span>${heading}</span>
          <span class="inbox-item-head-meta">
            ${participantsTpl(item)} ${itemSideMark(item, handled)}
            <span class="inbox-item-time" title=${fmtClock(item.receivedAt)}>${relTime(item.receivedAt)}</span>
          </span>
        </h1>
        ${sub ? html`<div class="pane-subtitle">${sub}</div>` : nothing}
      </div>
    </div>
    <div class="inbox-surface inbox-item-surface">
      <div class="inbox-scroll inbox-item-thread">
        ${inboxState.notice ? html`<div class="inbox-notice" role="status">${inboxState.notice}</div>` : nothing}
        ${itemDetailTpl(item, handled)}
      </div>
    </div>
    ${!usesOutputReview(item) ? html`<aside class="inbox-item-aside">${chatTpl(item)}</aside>` : nothing}
  `;
}

function sentDraftTpl(): TemplateResult | undefined {
  const saved = selectedSentChat();
  if (!saved) return;
  const item = toInboxItem(saved);
  if (item.status !== "open")
    return html`<div class="inbox-draft">
      <p>回复已发送。</p>
      <button class="btn" @click=${() => void continueSentReply(item)}>再写一条回复</button>
    </div>`;
  return html`${inboxState.notice ? html`<div class="inbox-notice" role="status">${inboxState.notice}</div>` : nothing}${draftEditorTpl(item, { chat: false })}<button
      class="btn primary"
      ?disabled=${sending.has(item.id)}
      @click=${() => void sendItem(item)}
    >
      ${sending.has(item.id) ? "正在发送…" : "发送回复"}
    </button>`;
}

function keepingChatLogsPinned(host: HTMLElement, draw: () => void): void {
  const logs = () => [...host.querySelectorAll<HTMLElement>(".inbox-chat-log")];
  const wasAtBottom = logs().map((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  draw();
  logs().forEach((el, i) => {
    if (wasAtBottom[i] ?? true) el.scrollTop = el.scrollHeight;
  });
}

function drawSurface(surface: InboxSurface): void {
  if (!surface.host.isConnected && surface.pane) return;
  keepingChatLogsPinned(surface.host, () => render(surfaceTpl(surface), surface.host));
  sizeChatInputs(surface.host);
}

let fullSurface: InboxSurface | null = null;
let asideObserver: ResizeObserver | null = null;
let fullViewId = "all";
let pendingItemId: string | null = null;
let loadingDeepLink = false;
async function loadDeepLink(id: string): Promise<void> {
  try {
    const result = await api<{ item: LedgerItem; outputs: ReviewOutput[] }>(
      `/api/inbox?itemId=${encodeURIComponent(id)}`,
    );
    upsertItem({ ...toInboxItem(result.item), outputs: result.outputs, detailLoaded: true });
  } catch {
    if (fullSurface?.selectedId === id) fullSurface.selectedId = null;
    fullViewId = "sent";
    await openSentEmailById(id, drawAll);
  } finally {
    loadingDeepLink = false;
    drawAll();
  }
}

function drawFull(): void {
  if (appState.currentView !== "inbox" || !appState.mainEl) return;
  if (!fullSurface || !fullSurface.host.isConnected || fullSurface.host.parentElement !== appState.mainEl) {
    const host = document.createElement("div");
    host.className = "pane inbox-page content-wide-page";
    fullSurface = {
      host,
      viewId: fullViewId,
      pane: false,
      density: () => "full" as DensityTier,
      selectedId: fullSurface?.selectedId ?? null,
      showHandled: fullSurface?.showHandled ?? false,
    };
    appState.mainEl.replaceChildren(host);
    observeAsideSize(host);
  }
  fullSurface.viewId = fullViewId;
  if (pendingItemId) {
    fullSurface.selectedId = pendingItemId;
    pendingItemId = null;
  }
  const openItem = fullSurface.selectedId ? inboxState.items.find((i) => i.id === fullSurface?.selectedId) : undefined;
  const openSentEmail = selectedSentEmail();
  if (fullSurface.selectedId && !openItem?.detailLoaded && inboxState.loaded && !loadingDeepLink) {
    loadingDeepLink = true;
    void loadDeepLink(fullSurface.selectedId);
  }
  syncInboxUrl(openSentEmail?.id ?? fullSurface.selectedId);
  const host = fullSurface.host;
  const surface = fullSurface;
  let page: TemplateResult | typeof nothing;
  if (openItem) page = itemPageTpl(openItem);
  else if (openSentEmail) {
    page = sentEmailPageTpl(
      drawAll,
      sentChatTpl(drawAll, (item) => chatTpl(toInboxItem(item))),
      sentDraftTpl(),
      closeInboxItem,
    );
  } else
    page = html`
      <div class="pane-head">
        <h1 class="pane-title">收件箱</h1>
        <div class="pane-head-actions">${syncLineTpl(surface)}</div>
      </div>
      ${surfaceTpl(surface)}
    `;
  keepingChatLogsPinned(host, () => render(page, host));
  sizeAside(host);
  sizeChatInputs(host);
}

/**
 * The assistant sticks to the top of a page that now scrolls, so its height is
 * the viewport below wherever it starts rather than a share of a fixed frame.
 */
function sizeAside(host: HTMLElement): void {
  if (!host.querySelector(".inbox-item-aside")) return;
  const pad = getComputedStyle(host);
  const padTop = Number.parseFloat(pad.paddingTop) || 0;
  const padBottom = Number.parseFloat(pad.paddingBottom) || 0;
  const available = host.clientHeight - padTop - padBottom;
  const height = Math.min(ASIDE_MAX_HEIGHT, Math.max(ASIDE_MIN_HEIGHT, available));
  const next = `${height}px`;
  if (host.style.getPropertyValue("--inbox-aside-height") === next) return;
  host.style.setProperty("--inbox-aside-height", next);
}

function observeAsideSize(host: HTMLElement): void {
  if (typeof ResizeObserver === "undefined") return;
  asideObserver?.disconnect();
  asideObserver = new ResizeObserver(() => {
    sizeAside(host);
    sizeChatInputs(host);
  });
  asideObserver.observe(host);
}

function autosizeChatInput(box: HTMLTextAreaElement): void {
  box.style.height = "auto";
  const cap = Number.parseFloat(getComputedStyle(box).maxHeight) || CHAT_INPUT_MAX_HEIGHT;
  const content = box.scrollHeight;
  box.style.height = `${Math.min(cap, content)}px`;
  box.style.overflowY = content > cap ? "auto" : "hidden";
}

function sizeChatInputs(host: HTMLElement): void {
  for (const box of host.querySelectorAll<HTMLTextAreaElement>(".inbox-chat-input")) autosizeChatInput(box);
}

function syncInboxUrl(itemId: string | null, push = false): void {
  if (appState.currentView !== "inbox") return;
  const next = deepLinkPath(UI_BASE, "inbox", null, null, itemId ?? inboxViewSegment(fullViewId));
  if (`${location.pathname}${location.search}` === next) return;
  if (push) history.pushState(null, "", next);
  else history.replaceState(null, "", next);
}

export function resetActiveInboxItem(): void {
  const sent = selectedSentChat();
  if (sent) void persistDraft(toInboxItem(sent));
  resetSelectedSentEmail();
  const open = fullSurface?.selectedId;
  if (!open || !fullSurface) return;
  const item = inboxState.items.find((i) => i.id === open);
  if (item) void persistDraft(item);
  fullSurface.selectedId = null;
}

function closeInboxItem(): void {
  resetActiveInboxItem();
  syncInboxUrl(null);
  if (fullViewId === "sent") ensureSentMail(drawAll);
  drawAll();
}

export function routeInboxHistory(segment: string | null): void {
  resetActiveInboxItem();
  const viewId = inboxViewIdForSegment(segment);
  if (viewId) {
    fullViewId = viewId;
    pendingItemId = null;
    if (fullSurface) {
      fullSurface.viewId = viewId;
      fullSurface.selectedId = null;
    }
    if (viewId === "sent") ensureSentMail(drawAll);
  } else {
    fullViewId = "all";
    pendingItemId = segment;
    if (fullSurface) {
      fullSurface.viewId = "all";
      fullSurface.selectedId = segment;
    }
  }
  if (appState.currentView === "inbox") drawAll();
}

export function drawAll(): void {
  for (const s of surfaces) drawSurface(s);
  drawFull();
  renderSidebarTop();
  notifyPanesChanged();
}

export function selectInboxView(viewId: string, push = false): void {
  resetActiveInboxItem();
  if (!isInboxViewId(viewId)) viewId = "all";
  fullViewId = viewId;
  if (fullSurface) {
    fullSurface.viewId = viewId;
    fullSurface.selectedId = null;
  }
  syncInboxUrl(null, push);
}

export async function renderInbox(): Promise<void> {
  ensurePolling();
  ensureRealtime();
  drawFull();
  await refreshInbox({ ifStaleMs: 30_000, silent: true });
}

export function mountInboxPane(opts: {
  host: HTMLElement;
  viewId: string;
  density: () => DensityTier;
  onDensityChange: (handler: () => void) => void;
}): { dispose: () => void } {
  const surface: InboxSurface = {
    host: opts.host,
    viewId: opts.viewId,
    pane: true,
    density: opts.density,
    selectedId: null,
    showHandled: false,
  };
  surfaces.add(surface);
  opts.host.classList.add("inbox-pane-host");
  opts.onDensityChange(() => drawSurface(surface));
  ensurePolling();
  ensureRealtime();
  drawSurface(surface);
  void refreshInbox({ ifStaleMs: 30_000, silent: true });
  return {
    dispose() {
      surfaces.delete(surface);
      opts.host.classList.remove("inbox-pane-host");
    },
  };
}

registerPaneKind({
  paramsKey: "inboxView",
  glyph: InboxGlyph,
  title: (id) => inboxViewName(id),
  badge: (id) => (can("inbox") ? inboxOpenCount(id) : 0),
  mount: ({ host, id, density, onDensityChange }) => mountInboxPane({ host, viewId: id, density, onDensityChange }),
  maximize: (id) => {
    exitSplitIfActive();
    selectInboxView(id);
    switchView("inbox");
  },
});
