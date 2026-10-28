// Task 13 — Chat view with streaming rendering
// Task 15 — sessionId + cwd lifted to App
//
// 本文件承载对话主视图：消息时间线渲染、流式输出、工具调用展示、
// 输入与发送、技能/@提及、同步模式、权限卡、会话内消息搜索浮动框
// (Cmd/Ctrl+F 呼出,Esc 关闭,searchOpen/search/visibleMessages/navMatch/.msg-search-float)、
// 消息发送时间标记 (formatMsgTime/formatMsgTimeFull + .msg-time) 的实现亦在此文件。
//
// ─── bot review 已闭环项 (会话内搜索, PR #602) ───
//   stale closure → ad2f8da6 + cc5afff5 (matchIdxRef + navMatch);
//   backdrop-filter 前缀 → ad2f8da6; focus-visible 焦点环 → ad2f8da6;
//   零匹配时隐藏按钮 → ad2f8da6; key={origIdx} → d4f4d3d4;
//   死代码 backdrop-filter → d4f4d3d4; 导航抽公共函数 → d4f4d3d4;
//   会话切换重置搜索 → 4dc06a01; Firefox 清除按钮 → 4dc06a01 (type="text");
//   visibleMessages useMemo + border-radius 死代码.
//
// ─── bot review response ledger (feat/webui-msg-send-time, PR #601) ───
// 每条 bot 审查意见均在代码层响应,对应 commit 与修法如下:
//   • P2  pointer-events:none 阻断 title tooltip  → ac7d3810  删除该属性,仅留 user-select:none,见 app.css .msg-time 注释
//   • P3  formatMsgTime 硬编码 "昨天"              → ac7d3810  改为接受 Translate 函数,走 i18n key time.yesterday/sameYear/otherYear
//   • Low pad 在 formatMsgTime/formatMsgTimeFull 重复 → 603d68f1 提取为模块顶层 pad2
//   • Low sameDay 在 formatMsgTime 体内重建闭包     → 603d68f1 提取为模块顶层函数
//   • P2  SessionDetail.created_at (epoch seconds) 与 MessageInfo.created_at (epoch ms) 单位不一致
//        → 23fb3db4 标注单位差异;统一为毫秒,见 lib.rs get_session_detail
//   • P3  !ts 守卫把 ts=0 误判无效                  → 23fb3db4  formatMsgTime 改为 ts == null || !Number.isFinite(ts)
// 我们愿意根据再审意见继续优化。

import { VNode } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { InputHistory, canNavigateInputHistory, inputHistoryKey } from '../lib/inputHistory';
import { createTimelineFollow } from '../lib/timelineFollow';

/** First paint / page size for long transcripts. Older messages load on demand. */
const HISTORY_PAGE = 48;
/** 「立即发送」程序化停止标记的有效期：后端 /chat/stop 的 stop_and_wait 上限仅 2.5s。 */
const PROGRAMMATIC_STOP_MARK_TTL_MS = 15000;
/**
 * 页面长时间隐藏（手机后台挂起、系统休眠）后才允许失焦重连 watch。
 * 短暂失焦（截图工具、切窗口回来）绝不断开重连：重连会强制后端重放整轮事件
 * （subscribe_live_with_replay），把已画完的正文/思考再落一遍。
 */
const WATCH_REATTACH_AFTER_HIDDEN_MS = 60000;
import { postChatPrompt, stopChat, postChatSteer, cancelChatSteer, postSystemNotify, getActiveChatSessions, getChatPending, watchChatSession, SSEEvent, getSession, getSessionFreshness, SessionMetaWithProject, listProjectSessions, getModels, ModelInfo, ImageData, postLiveMessage, postLiveStop, postLiveProvider, postLiveMode, getApprovalMode, ApprovalMode, LiveWireEvent, SessionMessage, SessionTokenUsage, SessionTurnOutline, getSkills, SkillInfo, listDir, changeDir, postConfigReload, postMcpReload, getMcpStatus, postLiveMcpTrust, postCommand, postLiveCompact, setDefaultProvider, uploadSessionFiles, type CommandResult, type UploadProgress, UserInputRequestEvent, getChatQueue, saveChatQueue, type QueuedMessageApiItem, patchSessionMessage, deleteSessionMessage, truncateSession, type SessionMutationEvent } from '../api';
import { InlineBubbleEditor } from './InlineBubbleEditor';
import { ConfirmDialog } from './ConfirmDialog';
import { showToast } from './Toast';
import {
  loadComposerDraft,
  saveComposerDraft,
  clearComposerDraft,
  loadBubbleEditDraft,
  saveBubbleEditDraft,
  clearBubbleEditDraft,
  type BubbleEditDraft,
} from '../lib/composerDraft';
import {
  parseSlashCommand,
  buildCommandMap,
  dispatchSlashCommand,
  buildSlashMenuItems,
  formatMcpStatusText,
  FRONTEND_COMMANDS,
  type SlashHandlers,
} from '../lib/slashCommands';
import { buildTurnNavItems, buildTurnNavItemsFromOutline, compactTurnNavText, filterTurnNavItems, resolveActiveTurnId, turnNavId, turnNavScrollTop } from '../lib/turnNav';
import { resolvePendingAfterDecision } from '../lib/pendingPermission';
import { beginModeSwitch, completeModeSwitch, failModeSwitch, initModeState, modeForSessionOrigin } from '../lib/modeSwitch';
import { randomUUID } from '../lib/randomId';
import {
  dispatchSystemNotification,
  isWindowAway,
  shouldOsNotifyTerminal,
  recordUserManualStop,
  recordUserSteer,
} from '../lib/sessionNotify';
import { createPortal, lazy, Suspense } from 'preact/compat';
import { Markdown } from './Markdown';
import { ModelSelector } from './ModelSelector';
import { ModeSelector } from './ModeSelector';
import { getPageZoom } from '../lib/pageZoom';

// 动态懒加载非首屏必需的重型 Git / Diff 面板，削减初始 JS 主包体积，加速桌面端冷启动与弱网访问
const GitPanel = lazy(() => import('./GitPanel').then((m) => ({ default: m.GitPanel })));
const DiffViewer = lazy(() => import('./DiffViewer').then((m) => ({ default: m.DiffViewer })));
import { CodeEditorTab } from './CodeEditorTab';
import { TerminalPanel } from './TerminalPanel';
import { PreviewPanel } from './PreviewPanel';
import {
  fetchGitFileDiff,
  fetchGitWorkingDiff,
  fetchGitRepos,
  type GitCommitItem,
  type GitCommitFile,
  type GitStatusItem,
} from '../api';
import { useT } from '../settings';
import type { MsgKey } from '../i18n';
import {
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_MB,
  ACCEPTED_IMAGE_INPUT_ACCEPT,
  countPending,
  fileToImageData,
  formatUserMessageWithAttachments,
  isImageFile,
  type PendingAttach,
  type PendingFile,
  type PendingImage,
} from '../lib/attachments';
import {
  collectClipboardFiles,
  copyTextAndImages,
  copyTextToClipboard,
  buildCopyHtml,
} from '../lib/clipboard';
import {
  applyAtMentionSelection,
  detectAtMentionRange,
  ensureActiveDescendantVisible,
  splitAtToken,
} from '../lib/atMention';
import {
  appendToolOutput,
  finalizeToolsAfterTurn,
  toolResultStatus,
  updateToolProgress,
  upsertToolPart,
  withTrailingTodoList,
  type ToolRow,
  type MsgPart,
} from '../lib/toolRows';
import {
  jsonArgString,
  resolveToolDiffPreview,
  formatToolPayload,
  formatToolDetail,
  colorizeInlineJson,
  prettyToolText,
  toolCategory,
  toolGlyph,
  toolRendersAsDiff,
  isWritingTool,
  isViewOnlyShellDiff,
  computeToolDiffStats,
  type DiffPreviewLine,
} from '../lib/toolDisplay';
import {
  applySubtaskProgress,
  applySubtaskResultsFromOutput,
  subtasksFromTaskArgs,
  subtaskCounts,
  taskArgsSummary,
} from '../lib/subtasks';
import {
  foldTodoToolCall,
  isTodoTool,
  parseTodosFromOutput,
  placeArchivedTodos,
  reduceLiveTodo,
  settleLiveTodo,
  todoCallIdsFromMessages,
  todoCounts,
  type LiveTodoDocument,
  type TodoItem,
} from '../lib/todos';
import { displayPath, pathBasename, getRelativePathToProject } from '../lib/displayPath';
import { toolTouchesWorktree } from '../lib/gitRefresh';
import {
  getSessionCache,
  saveSessionCache,
  clearAllSessionCache,
  getMemorySession,
} from '../lib/sessionCache';
import { gitStore } from '../lib/gitStore';
import { isInternalHistoryAssistantMessage, isInternalHistoryUserMessage, stripInjectedRemindersForDisplay, stripSteerEnvelopeForDisplay } from '../lib/historyMessages';
import {
  deserializeQueuedCard,
  loadQueuedFromStorage,
  mergeQueuedIntoDraft,
  queueAfterSessionActiveCheck,
  saveQueuedToStorage,
  serializeQueuedCard,
  stashSessionQueued,
  restoreSessionQueued,
} from '../lib/queuedDraft';
import { consumesProgrammaticStopMark, runningTurnStopAliases, stopAliasAllowsNextTurn, type ProgrammaticStopMark } from '../lib/turnStop';
import { loadAppliedTodoCallIds, saveAppliedTodoCallIds } from '../lib/todoAppliedIds';
import {
  chatRecoveryPolicy,
  classifyChatDone,
  createLiveLifecycleState,
  isCurrentChatStream,
  liveDetachDisposition,
  reduceChatRecovery,
  resolveUserInputRequest,
  toolResultClearsUserInput,
  transcriptLatestUserInputIsResolved,
  transcriptToolCallIsResolved,
  mergeDiskWithUnpersistedTail,
  shouldAdoptDiskTranscript,
  stayOnNewSessionLanding,
  shouldReuseLiveStream,
  resumeTurnStartedAt,
  transcriptHasInFlightAssistant,
  transcriptHasOpenUserTurn,
  sessionAssignedClaimsLocalTurn,
  liveSubmitKeepsTurn,
  shouldKeepCachedTranscript,
  thisTabOwnsTurn,
  liveSyncOwnsViewedSession,
  shouldLockSendAsDetached,
  isWatchTurnActivationEvent,
  resolveTokenCache,
  formatCacheHitRate,
  createTokenCacheState,
  resetTokenCacheState,
  startTokenTurn,
  estimateLocalCached,
  estimateCacheFromHistoryPrompt,
  type TokenCacheState,
  estimatePrefixCached,
  clampCachedToPrompt,
  isStackedTurnBillingUsage,
  userMessageAlreadyOnCanvas,
  visibleUserText,
  userTextsMatch,
  dropSnapshotDuplicates,
  type ChatRecoveryEvent,
  type ChatRecoveryState,
} from '../lib/chatTerminal';
import {
  formatTurnElapsed,
  resumeTurnClockEpoch,
  stampLastAssistantElapsed,
  turnDurationMs,
  turnTotalElapsedMs,
} from '../lib/turnTimer';
import {
  acknowledgeLiveSteers,
  pendingSteersToDraft,
  type PendingLiveSteer,
} from '../lib/liveSteer';
import { onGlobalEvent } from '../lib/globalEvents';
import {
  bindUserMessageIdentity,
  foldLiveTodo,
  hydrateSession,
  identifiedAssistantIndex,
  paintAssistantReasoning,
  paintAssistantText,
  paintAssistantNotice,
  paintCachedAssistantDelta,
  ensureWorkingAssistant,
  paintUserMessage,
  visibleToolChunk,
  withAssistantIdentity,
} from '../lib/sessionProjection';
import {
  clearStreamCursor,
  readStreamCursor,
  resolveAfterSeq,
  writeStreamCursor,
} from '../lib/streamCursor';

interface Message {
  role: 'user' | 'assistant' | 'system';
  parts: MsgPart[];
  images?: ImageData[];
  /** 管线派发的稳定消息 id（message_id）。daemon 尚未下发 id 时为 undefined，
   *  回退到位置身份，保证渐进增强、行为不变。 */
  id?: string;
  /** Epoch ms this message was sent/received (PR #562 send-time labels).
   *  Live + freshly-typed turns stamp `Date.now()`; history loaded from the
   *  daemon carries the session's `updated_at` (also ms). Optional so the
   *  type stays backward-compatible with the few code paths that build a
   *  Message literal without a clock (e.g. the queued-placeholder). */
  ts?: number;
  /** Browser-local correlation for an optimistic /live submission. Never persisted. */
  pendingSteerId?: string;
  /** Wall-clock duration of this assistant turn (ms). Stamped when the turn
   *  finishes so the timeline can show "用时 12s" after refresh. Live ticks
   *  sum prior stamped turns plus the current turn stopwatch. */
  elapsedMs?: number;
  /** Absolute index in the persisted raw transcript. History display conversion
   * filters/folds rows, so this cannot be reconstructed from the visible index. */
  sourceIndex?: number;
  /** Stable ordinal among real user questions. Browser-local optimistic turns
   * carry this until the daemon's authoritative outline arrives. */
  turnNavOrdinal?: number;
}

/**
 * Freeze a todo snapshot onto the last assistant message's trailing `todo_list`
 * part. Used when the user starts the next turn (sticky → history) and when
 * caching a session that still has a live sticky panel.
 */
function freezeTodosIntoLastAssistant(msgs: Message[], items: TodoItem[]): Message[] {
  if (!items.length) return msgs;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.role !== 'assistant') continue;
    const next = msgs.slice();
    next[i] = {
      ...msgs[i]!,
      parts: withTrailingTodoList(msgs[i]!.parts, items),
    };
    return next;
  }
  return msgs;
}

/** Drop an unfinished todo list glued onto the latest assistant bubble.
 *  Completed plans stay in history. A live plan belongs in the sticky panel,
 *  not squeezed against the newest message after a session switch. */
function detachUnfinishedTodoFromLatestAssistant(msgs: Message[]): Message[] {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.role !== 'assistant') continue;
    const parts = msgs[i]!.parts;
    let unfinished = false;
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]!;
      if (part.kind !== 'todo_list' || !part.items?.length) continue;
      unfinished = part.items.some((item) => item.status !== 'completed');
      break;
    }
    if (!unfinished) return msgs;
    const next = msgs.slice();
    next[i] = {
      ...msgs[i]!,
      parts: parts.filter((part) => part.kind !== 'todo_list'),
    };
    return next;
  }
  return msgs;
}

interface QueuedMessage {
  id: number;
  text: string;
  images?: ImageData[];
  approvalMode: ApprovalMode;
  /** queue = send after this turn; steering = HTTP in flight; steer = folded next step. */
  kind: 'queue' | 'steering' | 'steer';
  /** 客户端关联键（= 发送给 /chat/steer 或 /live/message 的 client_input_id）。
   *  刷新后据此与内核已接受的 steer 对账，不再依赖文本匹配。 */
  clientInputId?: string;
  /**
   * 立即发送已经把用户气泡画上，但当时槽位还忙、投递被退回。
   * drain 必须照发，不能因为文本已经在画布上就把卡片丢掉。
   */
  forceSend?: boolean;
}

/** Concatenate all text segments (error-detection, skill-title, search, etc.). */
function messageText(m: Message): string {
  return m.parts.reduce((acc, p) => {
    if (p.kind === 'text' || p.kind === 'reasoning') return acc + p.text;
    return acc;
  }, '');
}

/** 图片集合相等（纯图片 / 空文本卡片无法用文本判定身份时使用）。 */
function sameImageSet(a?: ImageData[], b?: ImageData[]): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  return left.every((img, i) => img.media_type === right[i]?.media_type && img.data === right[i]?.data);
}

/** Zero-pad a number to 2 digits — shared by formatMsgTime / formatMsgTimeFull. */
const pad2 = (n: number) => (n < 10 ? '0' + n : '' + n);

/** Whether two dates fall on the same calendar day (Y/M/D all equal). */
function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** PR #562: format a send-time label for a message bubble.
 *  - Today → "HH:MM" (compact, the common case)
 *  - Yesterday → i18n `time.yesterday` + "HH:MM"
 *  - Same year → i18n `time.sameYear` ({m}月{d}日 {hm} / {m}/{d} {hm})
 *  - Older / other year → i18n `time.otherYear` ({y}/{m}/{d} {hm})
 *  Returns '' when ts is missing/invalid so callers can simply `{ts && …}`.
 *  `t` is the i18n resolver (passed in from the component so this stays a
 *  pure top-level helper). Local time, because a chat send time is a
 *  wall-clock fact the user reads the same way they read a timestamp in
 *  any messaging app. */
function precedingUserTs(msgs: Message[], idx: number): number | undefined {
  for (let i = idx - 1; i >= 0; i--) {
    if (msgs[i]!.role === 'user') return msgs[i]!.ts;
  }
  return undefined;
}

function formatMsgTime(ts: number | undefined, t: (key: MsgKey, params?: Record<string, string | number>) => string): string {
  // P3 修复: 用 ts == null 而非 !ts,避免把 ts=0 (epoch 1970) 误判为无效。
  // 实际消息时间戳不会是 0,但严格区分 "缺失" 与 "值为 0" 更正确。
  if (ts == null || !Number.isFinite(ts)) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (sameDay(d, now)) return hm;
  const yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(d, yest)) return `${t('time.yesterday')} ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return t('time.sameYear', { m: d.getMonth() + 1, d: d.getDate(), hm });
  return t('time.otherYear', { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), hm });
}

/** Full local timestamp for the hover tooltip (seconds + full date). */
function formatMsgTimeFull(ts?: number): string {
  if (ts == null || !Number.isFinite(ts)) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Copy text + all attached images. Preserves every picture via ClipboardItem/HTML,
 *  so pasting back into WebUI or rich-text messengers restores all images and text. */
async function copyUserMessage(text: string, images?: ImageData[]): Promise<boolean> {
  return copyTextAndImages(text, images);
}

function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const t = useT();
  const [scale, setScale] = useState(1);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const el = imgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // 缩放交给用户的 ctrl+鼠标滚轮（防误触）
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        const delta = e.deltaY > 0 ? 0.88 : 1.14;
        setScale((s) => Math.min(6, Math.max(0.3, s * delta)));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const content = (
    <div
      class="img-lightbox"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      style={{ zIndex: 99999 }}
    >
      <div class="img-lightbox-content" onClick={(e) => e.stopPropagation()}>
        <div class="img-lightbox-frame" style={{ transform: `scale(${scale})` }}>
          <img
            ref={imgRef}
            class="img-lightbox-img"
            src={src}
            alt=""
            onDblClick={() => setScale((s) => (s === 1 ? 1.8 : 1))}
          />
          {/* 紧贴图片右上角动态挂接的关闭按钮 */}
          <button
            type="button"
            class="img-lightbox-close"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            title={t('preview.close')}
            aria-label={t('settings.close')}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div class="img-lightbox-hint">
          {scale !== 1 && <span class="lightbox-hint-scale">{Math.round(scale * 100)}%</span>}
          <span class="lightbox-hint-item">
            <kbd>Ctrl</kbd> + {t('preview.wheel')}
          </span>
          <span class="lightbox-hint-dot">·</span>
          <span class="lightbox-hint-item">{t('preview.reset')}</span>
          <span class="lightbox-hint-dot">·</span>
          <span class="lightbox-hint-item">{t('preview.background')}</span>
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(content, document.body) : content;
}

function MsgImage({ img }: { img: ImageData }) {
  const [open, setOpen] = useState(false);
  const src = imageDataUrl(img);
  return (
    <>
      <img
        class="msg-image"
        src={src}
        alt=""
        onClick={() => setOpen(true)}
      />
      {open && <ImageLightbox src={src} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Format all parts of a message as readable text (including tool calls and their
 *  output), matching what is displayed on the page. Used by the copy button to
 *  copy the full visible content of an assistant turn. */
function messageFullText(m: Message): string {
  const lines: string[] = [];
  for (const p of m.parts) {
    if (p.kind === 'text') {
      lines.push(p.text);
    } else if (p.kind === 'tool') {
      const tool = p.tool;
      lines.push(`🔧 ${displayToolName(tool.name)}`);
      const detail = formatToolDetail(tool.name, tool.args);
      if (detail) lines.push(`   ${detail}`);
      if (tool.args) lines.push(`   参数: ${formatToolPayload(tool.args)}`);
      if (tool.output) lines.push(`   输出: ${tool.output}`);
    } else if (p.kind === 'notice') {
      lines.push(p.text);
    } else if (p.kind === 'rate_limited') {
      lines.push(p.text);
    }
  }
  return lines.join('\n');
}

/** Whether a message contains any tool segments. */
function messageHasTools(m: Message): boolean {
  return m.parts.some((p) => p.kind === 'tool');
}

/** Estimate token count for a text chunk (CJK + code aware, ~3.5 chars/token). */
function estimateTextTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 3.5));
}

/** Format token count to human friendly string (e.g. 1.2k, 128k, 1.0M). */
function formatTokenMetric(num: number | undefined | null): string {
  if (num == null || num <= 0) return '0';
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 10_000) return `${(num / 1_000).toFixed(0)}k`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
  return String(num);
}

/** Estimate token breakdown for a single message. */
function estimateMessageTokens(m: Message): { prompt: number; completion: number; reasoning: number } {
  let prompt = 0;
  let completion = 0;
  let reasoning = 0;

  if (m.role === 'user') {
    for (const p of m.parts) {
      if (p.kind === 'text') prompt += estimateTextTokens(p.text);
    }
  } else if (m.role === 'assistant') {
    for (const p of m.parts) {
      if (p.kind === 'text') completion += estimateTextTokens(p.text);
      else if (p.kind === 'reasoning') reasoning += estimateTextTokens(p.text);
      else if (p.kind === 'tool') {
        prompt += estimateTextTokens((p.tool.name || '') + ' ' + (p.tool.args || '') + ' ' + (p.tool.output || ''));
      } else if (p.kind === 'notice' || p.kind === 'rate_limited') {
        prompt += estimateTextTokens(p.text);
      }
    }
  }
  return { prompt, completion, reasoning };
}

/** Estimate total token usage across all messages in a session. */
function estimateAllMessagesTokens(messages: Message[]): TokenUsage {
  let prompt = 0;
  let completion = 0;
  let reasoning = 0;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const isLast = i === messages.length - 1;
    const est = estimateMessageTokens(m);

    if (m.role === 'assistant' && !isLast) {
      // In multi-turn chat, historical assistant text is fed back as prompt context,
      // while historical reasoning is omitted by default from next-turn prompt context.
      prompt += est.prompt + est.completion;
    } else {
      prompt += est.prompt;
      completion += est.completion;
      reasoning += est.reasoning;
    }
  }
  const total = prompt + completion + reasoning;
  return {
    prompt,
    completion: completion + reasoning,
    total,
    reasoning,
  };
}

/** Prompt tokens accumulated before the last user message (prefix-cache baseline). */
function promptTokensBeforeLastUser(messages: Message[]): number {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx <= 0) return 0;
  let history = 0;
  for (let i = 0; i < lastUserIdx; i++) {
    const m = messages[i]!;
    const est = estimateMessageTokens(m);
    if (m.role === 'assistant') history += est.prompt + est.completion;
    else history += est.prompt;
  }
  return history;
}

function estimateSessionTokens(messages: Message[]): { tokens: TokenUsage; cacheState: TokenCacheState } {
  const base = estimateAllMessagesTokens(messages);
  const prior = promptTokensBeforeLastUser(messages);
  const cache = estimateCacheFromHistoryPrompt(base.prompt, prior);
  return {
    tokens: {
      ...base,
      cached: cache.cached,
      cached_estimated: cache.cached_estimated,
    },
    cacheState: cache.cacheState,
  };
}

type SessionTokenSnapshot = {
  tokens: TokenUsage;
  cacheState: TokenCacheState;
  /** True when the snapshot came from provider telemetry or persisted server usage. */
  authoritative: boolean;
};

/** Build a displayable data URL from an ImageData. */
function imageDataUrl(img: ImageData): string {
  return `data:${img.media_type};base64,${img.data}`;
}

function imagesToPending(images: ImageData[]): PendingImage[] {
  return images.map((image) => ({ id: randomUUID(), kind: 'image', image }));
}

function pendingImageData(attach: PendingAttach[]): ImageData[] {
  return attach.filter((item): item is PendingImage => item.kind === 'image').map((item) => item.image);
}

/**
 * 去掉 daemon 为「非视觉主模型」注入的图片识别（VL）标注块——它只是给盲文本模型读图的
 * 内部上下文，不该显示在用户的输入气泡里（用户看到的应只是自己打的字 + 图片缩略图）。
 * 标注块由 daemon 追加在原文之后，与 `live_api.rs::preprocess_live_caption` /
 * `lib.rs::process_chat_request` 的格式耦合：`\n\n[图片内容（由 X 识别）]\n…` 或
 * `\n\n[图片识别失败]`（原文为空时无前导换行）。仅影响显示；存储/喂给模型的文本不变。
 */
function stripVisionAnnotation(text: string): string {
  const markers = ['\n\n[图片内容（由', '[图片内容（由', '\n\n[图片识别失败]', '[图片识别失败]'];
  let cut = -1;
  for (const m of markers) {
    const idx = text.indexOf(m);
    if (idx >= 0 && (cut < 0 || idx < cut)) cut = idx;
  }
  return cut >= 0 ? text.slice(0, cut).trimEnd() : text;
}

interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
  cached?: number;
  cached_estimated?: boolean;
  reasoning?: number;
  /** Industrial loop sums for this user turn: Σ step prompt / Σ step cache. */
  loop_prompt?: number;
  loop_cached?: number;
}

interface PermissionRequestEvent {
  type: 'permission_request';
  session_id: string;
  approval_id: string;
  tool_name: string;
  reason: string;
  call_id: string;
  arguments: unknown;
}

interface ChatProps {
  sessionId: string | null;
  onSessionId: (id: string) => void;
  cwd: string;
  onPermission: (req: PermissionRequestEvent) => void;
  /** 审批已被解决时通知 App 清掉 /chat 的审批卡片：传 call_id 仅在匹配时清（工具已执行），
   *  传 null 则无条件清（回合 done/stopped/error 或用户中止——此时不可能再有待批准项）。 */
  onPermissionResolved?: (callId: string | null) => void;
  /** Metadata of the currently-active session (for loading history) */
  activeSession?: SessionMetaWithProject | null;
  /** 刷新后正按 URL 短 id 还原会话；为 true 时抑制新建落地页，避免闪屏。 */
  restoring?: boolean;
  /** /live turn 完成后通知 App 刷新侧栏列表（session 已落盘，列表需更新）。 */
  onLiveTurnDone?: () => void;
  /** /live 回合运行态变化：侧栏/标题头转圈，与 `--host` 的 /chat/active 一致。 */
  onLiveRunningChange?: (sessionId: string | null, running: boolean) => void;
  /** 首条消息发出瞬间上报标题（取消息前 10 字），供 App 乐观插入侧栏，
   *  让会话即时出现；待后端落盘并自动命名后，列表刷新会换成真实标题。 */
  onOptimisticSession?: (title: string) => void;
  /** 打开工作目录选择器（cwd 面包屑已从顶栏移到输入框下方，由本组件渲染）。 */
  onOpenCwd?: () => void;
  /** 另一端（TUI /cd、worktree、其他 webui tab）切了工作目录：实时流送来 working_dir
   *  事件时上报新路径，供 App 更新 cwd 面包屑 + 侧栏目录过滤。 */
  onCwdChanged?: (dir: string) => void;
  /** AI 自动命名了当前会话：实时流送来 session_renamed 事件时上报新名称，
   *  供 App 更新顶部标题头，无需再发请求拉取会话列表。 */
  onSessionRenamed?: (name: string) => void;
  /** 上报是否处于落地（空对话）态，供 App 决定是否显示会话标题头。 */
  onLanding?: (landing: boolean) => void;
  /** 侧栏「技能」菜单选中的技能：变化时把 `/name ` 插入输入框。 */
  skillInsert?: { name: string; seq: number } | null;
  /** 打开会话侧栏（/sessions 命令）。 */
  onOpenSidebar?: () => void;
  /** 开始新会话（/new 命令）。 */
  onNewSession?: () => void;
  diffTabs?: any[];
  setDiffTabs?: (tabs: any[] | ((prev: any[]) => any[])) => void;
  activeMainTabId?: string;
  setActiveMainTabId?: (id: string) => void;
  /** 右侧面板折叠状态与宽度变更回调，供外层对齐右上角快捷工具栏等元素 */
  onRightPanelLayoutChange?: (layout: { collapsed: boolean; width: number }) => void;
  /** 顶部导航栏模型选择器挂载槽 */
  topModelSlot?: HTMLElement | null;
  /** 打开模型配置（和模型选择框绑在一起）。 */
  onOpenModelConfig?: () => void;
  /** 当前会话的审批 / 提问，交给右下角通知栈，而不是居中弹层。 */
  onLiveReview?: (review: {
    sessionId: string | null;
    permission: { runtime_instance_id: string; generation: number; request_id: number; tool_name: string; reason: string; call_id: string; arguments: unknown } | null;
    userInput: UserInputRequestEvent | null;
  }) => void;
  /** 通知栈提交后清掉本会话的实时卡片。 */
  onBindReviewDismiss?: (fns: {
    permission: (runtimeInstanceId: string, generation: number, requestId: number, callId: string) => void;
    userInput: () => void;
  }) => void;
}

function formatArgs(args: unknown): string {
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

// The VISIBLE truncation is done by CSS ellipsis at the real row width
// (.tool-name-secondary flexes to fill the row), so the preview length
// follows the screen/window width. This cap is only a DOM-size guard for
// pathological args (e.g. a tool fed a whole file); 1000 is far beyond any
// realistic single-row character count, so it never truncates before the
// screen edge — full args remain available by expanding the row.
function abbreviateArgs(args: string, maxLen = 1000): string {
  if (args.length <= maxLen) return args;
  return args.slice(0, maxLen) + '…';
}

function ToolArgPreview({ text }: { text: string }) {
  const spans = colorizeInlineJson(text);
  if (!spans) {
    return <span class="tool-name-secondary" title={text}>{text}</span>;
  }
  return (
    <span class="tool-name-secondary" title={text}>
      {spans.map((span, i) => (
        <span key={i} class={'json-tok json-tok-' + span.tone}>{span.text}</span>
      ))}
    </span>
  );
}

// Mirror of the TUI's `display_tool_name` (event_loop/mod.rs): MCP wire names
// `mcp__server__tool` render as `mcp · server · tool`; everything else is
// snake_case → PascalCase (`read_file` → `ReadFile`). Keeps the webui's tool
// headers identical to the terminal instead of showing raw `mcp__…` names.
function displayToolName(name: string): string {
  if (name.startsWith('mcp__')) {
    const rest = name.slice('mcp__'.length);
    const i = rest.indexOf('__');
    if (i >= 0) return `mcp · ${rest.slice(0, i)} · ${rest.slice(i + 2)}`;
  }
  return name
    .split('_')
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}


// 识别「技能/文档型」用户消息：首个非空字符是 markdown 标题、且内容较长。
// TUI 调用 /skill 时会把整段 SKILL.md 模板塞进用户消息，webui 历史里会把它
// 渲染成一大坨原文；命中则返回标题文本用作折叠徽章标签，否则返回 null（普通气泡）。
const SKILL_COLLAPSE_MIN = 400;
function transcriptTextLen(messages: Array<{ parts: Array<{ kind: string; text?: string }> }>): number {
  let total = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      if ((part.kind === 'text' || part.kind === 'reasoning') && part.text) total += part.text.length;
    }
  }
  return total;
}

function lastUserPlain(messages: Array<{ role: string; parts: Array<{ kind: string; text?: string }> }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    return message.parts.filter((part) => part.kind === 'text').map((part) => part.text || '').join('');
  }
  return '';
}

/** Disk catch-up must not wipe an optimistic send the server has not stored yet. */
function diskHasCanvasUser(
  disk: Array<{ role: string; parts: Array<{ kind: string; text?: string }> }>,
  canvas: Array<{ role: string; parts: Array<{ kind: string; text?: string }> }>,
): boolean {
  const canvasUser = lastUserPlain(canvas).trim();
  if (!canvasUser) return true;
  const diskUser = lastUserPlain(disk).trim();
  return diskUser === canvasUser || diskUser.endsWith(canvasUser) || canvasUser.endsWith(diskUser);
}

/**
 * 检查切走前存下的本地缓存是否缺失了后台已跑完轮次的最终正文消息。
 * 典型场景：Agent 正在跑工具时用户切到其他会话，切走时缓存里只有工具调用没有正文；
 * 后台跑完并生成最终正文落盘后，切回时必须识别出磁盘上的最终正文并予以采纳，
 * 彻底消除「切回只有工具调用、正文最后一条消息消失、刷新才出来」的历史顽疾。
 */
function cacheMissingSettledAssistant(
  cached: Message[],
  loaded: Message[],
): boolean {
  if (loaded.length === 0) return false;
  const lastLoaded = loaded[loaded.length - 1];
  if (lastLoaded.role !== 'assistant' || !lastLoaded.parts) return false;

  const loadedHasText = lastLoaded.parts.some(
    (p) => p.kind === 'text' && (p.text?.trim()?.length ?? 0) > 0,
  );
  if (!loadedHasText) return false;

  if (cached.length === 0) return true;
  const lastCached = cached[cached.length - 1];
  if (lastCached.role !== 'assistant' || !lastCached.parts) return true;

  const cachedHasText = lastCached.parts.some(
    (p) => p.kind === 'text' && (p.text?.trim()?.length ?? 0) > 0,
  );
  if (!cachedHasText && loadedHasText) {
    return true;
  }

  const loadedPartCount = lastLoaded.parts.length;
  const cachedPartCount = lastCached.parts.length;
  if (loadedPartCount > cachedPartCount) {
    return true;
  }

  return false;
}

/**
 * 合并快照与本地缓存中的用户提问，彻底防止后台/切换会话时旧快照把用户刚发送的最新提问气泡抹去
 */
function reconcileSnapshotWithCache(cached: Message[] | undefined, snapshot: Message[]): Message[] {
  if (!cached || cached.length === 0) return snapshot;
  if (!snapshot || snapshot.length === 0) return cached;
  const cachedUserIndices: number[] = [];
  cached.forEach((m, idx) => { if (m.role === 'user') cachedUserIndices.push(idx); });
  const snapshotUserIndices: number[] = [];
  snapshot.forEach((m, idx) => { if (m.role === 'user') snapshotUserIndices.push(idx); });

  // id 收敛：若缓存的每个 user 提问都已在快照中（按稳定 id 命中），则缓存不含
  // 新轮次，直接以磁盘快照为准（不再依赖 user 计数启发式）。
  if (cachedUserIndices.length > 0) {
    const snapIds = new Set(snapshot.map((m) => m.id).filter((v): v is string => !!v));
    if (
      snapIds.size > 0 &&
      cachedUserIndices.every((i) => {
        const m = cached[i];
        return !!m?.id && snapIds.has(m.id);
      })
    ) {
      return snapshot;
    }
  }

  // 如果本地缓存中的用户消息多于快照（说明本轮提问尚未在快照中落盘），保留末尾尚未落盘的用户提问及其助手的初始占位
  if (cachedUserIndices.length > snapshotUserIndices.length) {
    const lastCachedUserIdx = cachedUserIndices[cachedUserIndices.length - 1];
    const missingTail = cached.slice(lastCachedUserIdx);
    const missingUser = missingTail.find((m) => m.role === 'user');
    const missingText = missingUser
      ? missingUser.parts.filter((p) => p.kind === 'text').map((p) => p.text || '').join('')
      : '';
    if (missingText && userMessageAlreadyOnCanvas(snapshot, missingText)) {
      return snapshot;
    }
    // id 去重：缓存尾部中已存在于快照的 id 不再重复追加（无 id 时行为不变）。
    const tail = dropSnapshotDuplicates(snapshot, missingTail);
    return [...snapshot, ...tail];
  }
  return snapshot;
}

function detectSkillContent(text: string): string | null {
  const trimmed = text.replace(/^\s+/, '');
  if (!trimmed.startsWith('#') || text.length < SKILL_COLLAPSE_MIN) return null;
  const firstLine = trimmed.split('\n', 1)[0];
  const title = firstLine.replace(/^#{1,6}\s*/, '').trim();
  return title || null;
}

export function Chat({
  sessionId,
  onSessionId,
  cwd,
  onPermission,
  onPermissionResolved,
  activeSession,
  restoring,
  onLiveTurnDone,
  onLiveRunningChange,
  onOptimisticSession,
  onOpenCwd,
  onCwdChanged,
  onLanding,
  skillInsert,
  onSessionRenamed,
  onOpenSidebar,
  onNewSession,
  diffTabs: externalDiffTabs,
  setDiffTabs: externalSetDiffTabs,
  activeMainTabId: externalActiveMainTabId,
  setActiveMainTabId: externalSetActiveMainTabId,
  onRightPanelLayoutChange,
  topModelSlot,
  onOpenModelConfig,
  onLiveReview,
  onBindReviewDismiss,
}: ChatProps) {
  const t = useT();
  const [messages, setMessages] = useState<Message[]>([]);
  const initialDraft = loadComposerDraft(sessionId);
  const [input, setInput] = useState(() => initialDraft?.text ?? '');
  const inputRef = useRef(input);
  inputRef.current = input;
  const [busy, setBusy] = useState(false);
  // Mirror of `busy` in a ref so pushCommandNotice can read it synchronously
  // without a stale closure (refs always reflect the latest render value).
  const busyRef = useRef(false);
  busyRef.current = busy;
  // Last content event (text/tool/user), not the 15s keepalive. Catch-up reads
  // the saved transcript when this goes quiet while the cursor is still blinking.
  const lastLiveContentRef = useRef<number>(Date.now());
  // Live turn stopwatch: epoch when the latest user message started this turn.
  // startTurnClock is idempotent so tool rounds / thinking / partial assistant
  // chunks do NOT reset to 0. Cleared (and stamped onto the last assistant
  // message) when the turn's final body returns / is cancelled.
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const turnStartedAtRef = useRef<number | null>(null);
  const turnStartedAtBySessionRef = useRef<Map<string, number>>(new Map());
  const [nowMs, setNowMs] = useState(() => Date.now());

  const STEER_STORAGE_PREFIX = 'jeikcode:pending_steers:';
  const CLOCK_STORAGE_PREFIX = 'jeikcode:turn_clock:';

  function getStoredSteers(sid: string): PendingLiveSteer[] {
    try {
      if (typeof window === 'undefined' || !window.sessionStorage) return [];
      const raw = window.sessionStorage.getItem(STEER_STORAGE_PREFIX + sid);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }
  function setStoredSteers(sid: string, steers: PendingLiveSteer[]) {
    try {
      if (typeof window === 'undefined' || !window.sessionStorage) return;
      if (steers.length > 0) window.sessionStorage.setItem(STEER_STORAGE_PREFIX + sid, JSON.stringify(steers));
      else window.sessionStorage.removeItem(STEER_STORAGE_PREFIX + sid);
    } catch {}
  }

  function getStoredTurnClock(sid: string): number | null {
    try {
      if (typeof window === 'undefined' || !window.sessionStorage) return null;
      const raw = window.sessionStorage.getItem(CLOCK_STORAGE_PREFIX + sid);
      const val = raw ? Number(raw) : null;
      return val && Number.isFinite(val) ? val : null;
    } catch { return null; }
  }
  function setStoredTurnClock(sid: string, ts: number | null) {
    try {
      if (typeof window === 'undefined' || !window.sessionStorage) return;
      if (ts != null) window.sessionStorage.setItem(CLOCK_STORAGE_PREFIX + sid, String(ts));
      else window.sessionStorage.removeItem(CLOCK_STORAGE_PREFIX + sid);
    } catch {}
  }

  // 当前会话的权威工作目录：优先使用当前会话自身的 working_dir，回退到传入的全局 cwd。
  // 防止多项目切换或新建会话时由于外层 cwd 暂时漂移导致把当前会话的消息发往错误目录。
  const effectiveWorkingDir =
    (activeSession && activeSession.id === sessionId && activeSession.working_dir)
      ? activeSession.working_dir
      : cwd;
  function startTurnClock(sessionId?: string | null, explicitStartTs?: number) {
    if (turnStartedAtRef.current != null) return;
    const now = Date.now();
    let epoch = explicitStartTs;
    const targetId = sessionId ?? activeIdRef.current;
    if (epoch == null && targetId) {
      const stored = getStoredTurnClock(targetId);
      if (stored && stored > 0 && stored <= now) epoch = stored;
    }
    if (epoch == null) {
      // 优先从当前轮次用户提问的真实发送时间恢复，确保长任务断联刷新后不从 0s 重新开始
      const lastUserTs = [...messagesRef.current].reverse().find((m) => m.role === 'user')?.ts;
      if (lastUserTs && Number.isFinite(lastUserTs) && lastUserTs > 0 && lastUserTs <= now) {
        epoch = lastUserTs;
      } else if (transcriptHasOpenUserTurn(messagesRef.current)) {
        epoch = resumeTurnClockEpoch(now, lastUserTs);
      }
    }
    if (epoch == null) epoch = now;
    turnStartedAtRef.current = epoch;
    if (targetId) {
      turnStartedAtBySessionRef.current.set(targetId, epoch);
      setStoredTurnClock(targetId, epoch);
    }
    setTurnStartedAt(epoch);
  }
  function adoptTurnUserTs(ts?: number, force = false) {
    if (ts == null || !Number.isFinite(ts) || ts <= 0) return;
    const now = Date.now();
    const effectiveTs = ts > now ? now : ts;
    if (force || turnStartedAtRef.current == null || effectiveTs < turnStartedAtRef.current) {
      turnStartedAtRef.current = effectiveTs;
      setTurnStartedAt(effectiveTs);
      const sid = activeIdRef.current;
      if (sid) {
        turnStartedAtBySessionRef.current.set(sid, effectiveTs);
        setStoredTurnClock(sid, effectiveTs);
      }
    }
  }
  function finishTurnClock(opts?: { stamp?: boolean; sessionId?: string | null }) {
    const started = turnStartedAtRef.current;
    const targetId = opts?.sessionId ?? activeIdRef.current;
    if (targetId && opts?.stamp !== false) {
      turnStartedAtBySessionRef.current.delete(targetId);
      setStoredTurnClock(targetId, null);
    }
    turnStartedAtRef.current = null;
    setTurnStartedAt(null);
    if (started == null || opts?.stamp === false) return;
    setMessages((prev) => stampLastAssistantElapsed(prev, Date.now() - started, Date.now()));
  }
  function setBusyAndClock(next: boolean, explicitStartTs?: number) {
    if (next) {
      startTurnClock(undefined, explicitStartTs);
      lastLiveContentRef.current = Date.now();
    } else finishTurnClock();
    busyRef.current = next;
    setBusy(next);
  }
  const [chatRecovery, setChatRecovery] = useState<ChatRecoveryState>('ready');
  const chatRecoveryRef = useRef<ChatRecoveryState>('ready');
  chatRecoveryRef.current = chatRecovery;
  const recoveryPolicy = chatRecoveryPolicy(chatRecovery);

  useEffect(() => {
    if (!busy || turnStartedAt == null) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [busy, turnStartedAt]);

  function transitionChatRecovery(event: ChatRecoveryEvent): ChatRecoveryState {
    const next = reduceChatRecovery(chatRecoveryRef.current, event);
    chatRecoveryRef.current = next;
    setChatRecovery(next);
    return next;
  }
  // True for the entire duration of a /compact postCommand await so sendMessage
  // can refuse to fire while the session .json is being rewritten on disk.
  const compactingRef = useRef(false);
  // AI 执行中输入的消息排队于此，待当前回合 done 后依次自动发送（对齐 VSCode 插件）。
  // 初始化即从硬盘（localStorage）中水合恢复当前会话的队列消息（含未消费的转向消息），
  // 杜绝刷新页面时卡片瞬间丢失。
  const [queued, setQueuedState] = useState<QueuedMessage[]>(() => {
    try {
      const sid = sessionId;
      if (sid) {
        const map = loadQueuedFromStorage<QueuedMessage>();
        return map.get(sid) ?? [];
      }
    } catch {}
    return [];
  });
  const queuedRef = useRef(queued);
  queuedRef.current = queued;
  const queuedBySessionRef = useRef<Map<string, QueuedMessage[]>>(loadQueuedFromStorage());
  // 「立即发送」发起的程序化停止标记：命中后旧回合的 stopped 终态不得再把其余排队卡片回吐到输入框。
  const programmaticStopMarkRef = useRef<ProgrammaticStopMark | null>(null);
  /**
   * 队列三处一致性写入的唯一出口：内存会话映射 + localStorage + 后端 `/chat/queue`。
   * 任何队列变更都必须走这里，否则刷新/换端时后端旧副本会把已出队的卡片复活。
   */
  function persistSessionQueue(sid: string, next: QueuedMessage[]) {
    if (next.length > 0) {
      queuedBySessionRef.current.set(sid, [...next]);
    } else {
      queuedBySessionRef.current.delete(sid);
    }
    saveQueuedToStorage(queuedBySessionRef.current);
    // 跨设备后端队列同步持久化：换别的手机打开或刷新卡片永不丢失
    void saveChatQueue(sid, next.map(serializeQueuedCard) as QueuedMessageApiItem[]);
  }

  /**
   * 定向更新某个会话的队列：前台就是该会话时走响应式 `setQueued`，否则只改该会话缓存；
   * 两条路都会镜像到 localStorage 与后端 `/chat/queue`，保证跨会话操作后三处依旧一致。
   */
  function updateQueuedForSession(
    sid: string | null | undefined,
    updater: (items: QueuedMessage[]) => QueuedMessage[],
  ) {
    if (!sid) return;
    if (activeIdRef.current === sid) {
      setQueued(updater);
      return;
    }
    persistSessionQueue(sid, updater(queuedBySessionRef.current.get(sid) ?? []));
  }

  function setQueued(
    update: QueuedMessage[] | ((current: QueuedMessage[]) => QueuedMessage[]),
  ) {
    // SSE callbacks can run before Preact commits the next render. Keep the ref
    // authoritative synchronously so a reconnect snapshot cannot miss a just-
    // queued message and accidentally drain it under an unknown terminal.
    const next = typeof update === 'function' ? update(queuedRef.current) : update;
    queuedRef.current = next;
    const sid = activeIdRef.current;
    if (sid) persistSessionQueue(sid, next);
    setQueuedState(next);
  }
  const queueIdRef = useRef(0);
  // Stop restores the queue into the composer. Block one drain so a busy→idle
  // render cannot send those messages before the cleared queue commits.
  const blockQueueDrainRef = useRef(false);
  // Inputs accepted by the live runtime as in-turn steers but not yet folded at
  // a kernel round boundary. Unlike `queued`, these already belong to the active
  // turn and must be recovered if that turn is cancelled before acknowledgement.
  const [pendingSteers, setPendingSteersState] = useState<PendingLiveSteer[]>([]);
  const pendingSteersRef = useRef(pendingSteers);
  pendingSteersRef.current = pendingSteers;
  const pendingSteersBySessionRef = useRef(new Map<string, PendingLiveSteer[]>());
  function setPendingSteers(
    update: PendingLiveSteer[] | ((current: PendingLiveSteer[]) => PendingLiveSteer[]),
  ) {
    const next = typeof update === 'function' ? update(pendingSteersRef.current) : update;
    pendingSteersRef.current = next;
    const sid = activeIdRef.current;
    if (sid) {
      if (next.length > 0) {
        pendingSteersBySessionRef.current.set(sid, [...next]);
        setStoredSteers(sid, next);
      } else {
        pendingSteersBySessionRef.current.delete(sid);
        setStoredSteers(sid, []);
      }
    }
    setPendingSteersState(next);
  }
  function restorePendingSteers(includeSubmitting = true) {
    const pending = pendingSteersRef.current.filter(
      (item) => includeSubmitting || item.confirmed,
    );
    if (pending.length === 0) return;
    const draft = pendingSteersToDraft(pending);
    const pendingIds = new Set(pending.map((item) => item.id));
    setMessages((current) => current.filter((message) => !(
      message.pendingSteerId !== undefined && pendingIds.has(message.pendingSteerId)
    )));
    setInput((current) => [draft.text, current].filter(Boolean).join('\n'));
    setPendingAttach((current) => [...imagesToPending(draft.images), ...current]);
    setPendingSteers((current) => current.filter((item) => !pendingIds.has(item.id)));
    pushCommandNotice(t('chat.steerRecovered'));
  }
  const [tokens, setTokens] = useState<TokenUsage | null>(null);
  const tokensRef = useRef<TokenUsage | null>(null);
  tokensRef.current = tokens;
  const tokenCacheRef = useRef(createTokenCacheState());
  const tokenUsageCacheRef = useRef<Map<string, SessionTokenSnapshot>>(new Map());
  /** Blocks token snapshots from bleeding across a session switch render. */
  const tokenSaveGenerationRef = useRef(0);
  const tokensAuthoritativeRef = useRef(false);
  const lastUserTokensRef = useRef(0);
  const [showTokenDetails, setShowTokenDetails] = useState(false);
  const tokenPopoverRef = useRef<HTMLDivElement>(null);

  const applyAuthoritativeTokenUsage = (usage: {
    prompt: number;
    completion: number;
    total: number;
    cached?: number;
    reasoning?: number;
  }) => {
    const resolved = resolveTokenCache(
      { prompt: usage.prompt, cached: usage.cached },
      tokenCacheRef.current,
    );
    tokenCacheRef.current = resolved.nextState;
    tokensAuthoritativeRef.current = true;
    setTokens({
      prompt: usage.prompt,
      completion: usage.completion,
      total: usage.total,
      cached: resolved.cached,
      cached_estimated: resolved.cached_estimated,
      reasoning: usage.reasoning ?? 0,
      loop_prompt: resolved.nextState.turnPromptSum,
      loop_cached: resolved.nextState.turnCachedSum,
    });
  };

  const mergeLocalTokens = (
    prev: TokenUsage | null,
    next: { prompt: number; completion: number; total: number; reasoning?: number },
  ): TokenUsage => {
    tokensAuthoritativeRef.current = false;
    const local = estimateLocalCached(tokenCacheRef.current, next.prompt, prev);
    return {
      prompt: next.prompt,
      completion: next.completion,
      total: next.total,
      cached: local.cached,
      cached_estimated: local.cached_estimated,
      reasoning: next.reasoning ?? prev?.reasoning ?? 0,
    };
  };

  const resetTokenTelemetry = () => {
    tokenCacheRef.current = createTokenCacheState();
    tokensAuthoritativeRef.current = false;
    setTokens(null);
  };

  const sessionTokensRunning = (sid: string) =>
    busyRef.current
    || localTurnSessionsRef.current.has(sid)
    || backgroundRunningSessionsRef.current.has(sid)
    || liveSessionIdRef.current === sid;

  const saveTokenSnapshot = (sid: string, authoritative = tokensAuthoritativeRef.current) => {
    if (!tokensRef.current) return;
    tokenUsageCacheRef.current.set(sid, {
      tokens: { ...tokensRef.current },
      cacheState: { ...tokenCacheRef.current },
      authoritative,
    });
  };

  const applyTokenUsage = (
    usage: TokenUsage,
    cacheState?: TokenCacheState,
    authoritative = tokensAuthoritativeRef.current,
  ) => {
    if (cacheState) tokenCacheRef.current = { ...cacheState };
    tokensAuthoritativeRef.current = authoritative;
    setTokens({ ...usage });
  };

  const applyServerTokenUsage = (usage: SessionTokenUsage) => {
    // Same formula as the live `tokens` event: last-request prompt + completion.
    // Never take a larger persisted `total` — that used to be turn-billing sum.
    const prompt = Math.max(0, usage.prompt);
    const completion = Math.max(0, usage.completion);
    const cached = clampCachedToPrompt(usage.cached, prompt);
    const cacheState: TokenCacheState = {
      lastPrompt: prompt,
      providerReportsCache: cached > 0 && !usage.cached_estimated,
      turnPromptSum: prompt,
      turnCachedSum: cached,
    };
    applyTokenUsage({
      prompt,
      completion,
      total: prompt + completion,
      cached,
      cached_estimated: Boolean(usage.cached_estimated),
      reasoning: 0,
    }, cacheState, true);
  };

  const applySessionTokens = (
    sid: string | null,
    messages: Message[],
    serverUsage?: SessionTokenUsage | null,
  ) => {
    if (!sid) {
      resetTokenTelemetry();
      return;
    }
    const mem = tokenUsageCacheRef.current.get(sid);
    const running = sessionTokensRunning(sid);

    if (serverUsage && (serverUsage.prompt > 0 || serverUsage.total > 0)) {
      // Persisted turn stats are the idle baseline. During an active turn only
      // prefer in-memory telemetry when it is authoritative and ahead of disk.
      if (running && mem?.authoritative && (mem.tokens.total ?? 0) > serverUsage.total) {
        applyTokenUsage(mem.tokens, mem.cacheState, true);
        return;
      }
      // Older daemons restored turn-cumulative billing (every LLM round summed)
      // as occupancy. That is a different 口径 from the live last-frame
      // (prompt+completion of the last request). Ignore the stacked payload
      // rather than paint 1.7M; fall through to occupancy from messages/mem.
      const windowLimit = serverUsage.ctx_window ?? null;
      if (!isStackedTurnBillingUsage(serverUsage, windowLimit)) {
        applyServerTokenUsage(serverUsage);
        saveTokenSnapshot(sid, true);
        return;
      }
    }

    if (mem && (running || mem.authoritative)) {
      applyTokenUsage(mem.tokens, mem.cacheState, mem.authoritative);
      return;
    }

    if (messages.length > 0) {
      const est = estimateSessionTokens(messages);
      applyTokenUsage(est.tokens, est.cacheState, false);
      return;
    }
    resetTokenTelemetry();
  };

  useEffect(() => {
    if (!showTokenDetails) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (tokenPopoverRef.current && !tokenPopoverRef.current.contains(e.target as Node)) {
        setShowTokenDetails(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowTokenDetails(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showTokenDetails]);

  const [modelCatalog, setModelCatalog] = useState<ModelInfo[]>([]);
  const [historyHint, setHistoryHint] = useState<string | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const isCompactingRef = useRef(false);
  isCompactingRef.current = isCompacting;
  const [activeTodos, setActiveTodos] = useState<TodoItem[] | null>(null);
  const activeTodosRef = useRef<TodoItem[] | null>(null);
  activeTodosRef.current = activeTodos;
  const activeTodosBySessionRef = useRef<Map<string, TodoItem[]>>(new Map());
  // 每个会话一份实时清单。revision 是总线上最后一次 todo 调用，重放同一调用不会改文档。
  const todoLiveBySessionRef = useRef<Map<string, LiveTodoDocument>>(new Map());
  // 幂等键必须跨刷新存活：/chat/watch 会重放整轮事件，而 todowrite 的 plan/批量 add 是
  // 整表替换（todos.ts），重复折叠会把最新清单打回旧状态。直接从 localStorage 水合恢复。
  const todoAppliedCallIdsRef = useRef<Map<string, Set<string>>>(loadAppliedTodoCallIds());
  function persistAppliedTodoIds() {
    saveAppliedTodoCallIds(todoAppliedCallIdsRef.current);
  }
  /**
   * 幂等键种子：只做"并入"，绝不覆盖。
   * 种子来源（画布窗口内的 todo 调用）天然看不到窗口外的历史 plan，覆盖式种子会把
   * 持久化下来的保护集合冲掉，重放又能把已完成清单打回旧状态。
   */
  function seedAppliedTodoIds(sessionId: string | null | undefined, ids: Iterable<string | null | undefined>) {
    if (!sessionId) return;
    const applied = appliedTodoIdsFor(sessionId);
    let changed = false;
    for (const id of ids) {
      if (id && !applied.has(id)) {
        applied.add(id);
        changed = true;
      }
    }
    if (changed) persistAppliedTodoIds();
  }
  function applySessionStickyTodos(sessionId: string | null | undefined, items: TodoItem[] | null) {
    const sticky = items && items.length > 0 ? items : null;
    setActiveTodos(sticky);
    activeTodosRef.current = sticky;
    if (!sessionId) return;
    if (sticky) activeTodosBySessionRef.current.set(sessionId, sticky);
    else {
      // 关键防线：清单全完成时**绝不能**清空幂等键。那正是最容易被重放覆盖的时刻
      // （旧 plan 一重折就把打钩状态打回原形并定格）。新计划自带新 callId，无需清空。
      activeTodosBySessionRef.current.delete(sessionId);
    }
  }
  function adoptStickyFromMessages(
    sessionId: string | null | undefined,
    messages: Message[],
    stashed?: TodoItem[] | null,
    authoritativeTodos?: TodoItem[] | null,
  ) {
    const surface = hydrateSession(messages, authoritativeTodos, stashed);
    applySessionStickyTodos(sessionId, surface.todos);
    if (sessionId) {
      const hydrated = reduceLiveTodo(null, { type: 'hydrate', items: surface.todos ?? [] });
      if (hydrated) todoLiveBySessionRef.current.set(sessionId, hydrated);
      else todoLiveBySessionRef.current.delete(sessionId);
    }
    if (!sessionId) return;
    seedAppliedTodoIds(sessionId, surface.appliedTodoIds);
  }
  function liveTodoDoc(sessionId: string | null | undefined): LiveTodoDocument | null {
    if (sessionId) {
      const stored = todoLiveBySessionRef.current.get(sessionId);
      if (stored) return stored;
    }
    const items = sessionId
      ? activeTodosBySessionRef.current.get(sessionId) ?? null
      : activeTodosRef.current;
    if (!items || items.length === 0) return null;
    return { items, revision: null, resultApplied: false };
  }
  function writeLiveTodo(sessionId: string | null | undefined, doc: LiveTodoDocument | null) {
    if (sessionId) {
      if (doc) todoLiveBySessionRef.current.set(sessionId, doc);
      else todoLiveBySessionRef.current.delete(sessionId);
    }
    const items = doc?.items ?? null;
    if (!sessionId || sessionId === activeIdRef.current) {
      applySessionStickyTodos(sessionId, items);
      return;
    }
    if (items && items.length > 0) activeTodosBySessionRef.current.set(sessionId, items);
    else activeTodosBySessionRef.current.delete(sessionId);
  }
  /** 最终停止且正文已经落地。只有全部勾完才贴到最后一条助手消息，然后清掉实时清单。 */
  function commitActiveTodosIntoLastAssistant() {
    const sid = activeIdRef.current;
    if (!sid) return;
    const doc = liveTodoDoc(sid);
    const settled = settleLiveTodo(doc);
    if (!settled.archive) return;
    const next = placeArchivedTodos(messagesRef.current, settled.archive, doc?.revision ?? null);
    messagesRef.current = next;
    messageCacheRef.current.set(sid, next);
    writeLiveTodo(sid, settled.next);
    setMessages(next);
  }
  function archiveBackgroundTodos(sessionId: string) {
    if (!sessionId || sessionId === activeIdRef.current) return;
    const doc = liveTodoDoc(sessionId);
    const settled = settleLiveTodo(doc);
    if (!settled.archive) return;
    const cached = messageCacheRef.current.get(sessionId);
    if (cached) {
      messageCacheRef.current.set(
        sessionId,
        placeArchivedTodos(cached, settled.archive, doc?.revision ?? null),
      );
    }
    writeLiveTodo(sessionId, settled.next);
  }
  function appliedTodoIdsFor(sessionId: string | null | undefined): Set<string> {
    if (!sessionId) return new Set();
    let ids = todoAppliedCallIdsRef.current.get(sessionId);
    if (!ids) {
      ids = new Set();
      todoAppliedCallIdsRef.current.set(sessionId, ids);
    }
    return ids;
  }
  // Auxiliary persistence failures belong to application chrome, not the
  // assistant transcript. Replacing this value also deduplicates repeated
  // failures for the same session/path.
  const [persistenceWarning, setPersistenceWarning] = useState<string | null>(null);
  // 正在拉取某会话历史：用于抑制落地页，避免切到「有内容的会话」时先闪一下落地页。
  const [loading, setLoading] = useState(false);
  const [provider, setProvider] = useState<string | null>(null);
  const providerPinnedRef = useRef(false);
  const NEW_SESSION_PROVIDER_KEY = '__new__';
  const providerCacheRef = useRef(new Map<string, string>());
  const localTurnSessionsRef = useRef(new Set<string>());
  const backgroundRunningSessionsRef = useRef(new Set<string>());
  /** Project bucket for a session we may finish off-screen. */
  const projectHashBySessionRef = useRef(new Map<string, string>());
  const backgroundFinishTimerRef = useRef<number | null>(null);
  const defaultProviderName = useCallback(
    () => modelCatalog.find((m) => m.is_default)?.provider
      ?? modelCatalog[0]?.provider
      ?? null,
    [modelCatalog],
  );
  const providerCacheKey = useCallback(
    (sid: string | null) => sid ?? NEW_SESSION_PROVIDER_KEY,
    [],
  );
  const restoreProviderForSession = useCallback((sid: string | null) => {
    const cached = providerCacheRef.current.get(providerCacheKey(sid));
    if (cached) {
      setProvider(cached);
      providerPinnedRef.current = true;
      return;
    }
    setProvider(defaultProviderName());
    providerPinnedRef.current = false;
  }, [defaultProviderName, providerCacheKey]);
  const followDefaultProvider = useCallback((name: string) => {
    if (providerPinnedRef.current) return;
    // Only follow global default on the new-session landing page.
    if (activeIdRef.current) return;
    setProvider(name);
  }, []);

  useEffect(() => {
    let active = true;
    getModels().then((m) => { if (active) setModelCatalog(m); }).catch(() => {});
    return () => { active = false; };
  }, [provider]);

  const activeModelMeta = modelCatalog.find((m) => m.provider === provider)
    ?? modelCatalog.find((m) => m.is_default)
    ?? modelCatalog[0];
  const contextLimit = activeModelMeta?.context_window;
  // 审批模式（build / accept_edits / bypass / plan）。进程级 runtime 状态，
  // 由 /live snapshot + 'mode' 事件同步，切换调 postLiveMode（当前回合立即生效）。
  // confirmedMode 是 daemon 已确认值。--host 新建会话默认 Build；协议会话观察时显示 Auto。
  const [modeState, setModeState] = useState(() => initModeState('build' as ApprovalMode));
  const nativeModeRef = useRef<ApprovalMode>('build');
  const protocolSessionRef = useRef(false);
  const [pendingAttach, setPendingAttach] = useState<PendingAttach[]>(() =>
    initialDraft?.images ? imagesToPending(initialDraft.images) : [],
  );
  const pendingAttachRef = useRef(pendingAttach);
  pendingAttachRef.current = pendingAttach;
  const initialBubbleDraft = sessionId ? loadBubbleEditDraft(sessionId) : null;
  const [editingSourceIndex, setEditingSourceIndex] = useState<number | null>(() =>
    initialBubbleDraft?.sourceIndex ?? null,
  );
  const [bubbleEditDraft, setBubbleEditDraft] = useState<BubbleEditDraft | null>(() => initialBubbleDraft);
  const isFirstMountRef = useRef(true);
  const nativeFileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [confirmModal, setConfirmModal] = useState<{
    open: boolean;
    title: string;
    body: string;
    danger?: boolean;
    confirmLabel?: string;
    cancelLabel?: string;
    icon?: string;
    onConfirm: () => Promise<void> | void;
  }>({
    open: false,
    title: '',
    body: '',
    onConfirm: () => {},
  });
  const [slashSkills, setSlashSkills] = useState<SkillInfo[] | null>(null);
  const [slashLoading, setSlashLoading] = useState(false);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [slashIndex, setSlashIndex] = useState(0);
  // The /skills command opens a pure skills browser (no commands). Set while that
  // browser is showing; cleared as soon as the user types (normal mixed filtering).
  const [slashSkillsOnly, setSlashSkillsOnly] = useState(false);
  const [atOpen, setAtOpen] = useState(false);
  const [atQuery, setAtQuery] = useState('');
  const [atIndex, setAtIndex] = useState(0);
  const [atItems, setAtItems] = useState<{ name: string; is_dir: boolean }[]>([]);
  const [atLoading, setAtLoading] = useState(false);
  const sync = false;
  const syncRef = useRef(false);
  // Pending live-session permission request (shown as PermissionCard, calls /live/permission).
  // Kept separate from the non-sync `onPermission` prop so the /chat path is untouched.
  const [livePending, setLivePending] = useState<{ runtime_instance_id: string; generation: number; request_id: number; tool_name: string; reason: string; call_id: string; arguments: string } | null>(null);
  // Pending structured input from either transport. The event's optional session_id
  // selects `/chat/user-input`; live requests answer the bound `/live` runtime.
  const [userInputReq, setUserInputReq] = useState<UserInputRequestEvent | null>(null);
  useEffect(() => {
    onBindReviewDismiss?.({
      permission: (runtimeInstanceId, generation, requestId, callId) =>
        setLivePending((cur) => resolvePendingAfterDecision(
          cur,
          callId,
          runtimeInstanceId,
          requestId,
          generation,
        )),
      userInput: () => setUserInputReq(null),
    });
  }, [onBindReviewDismiss]);
  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef<string | null>(null);
  /** 专用于跟踪当前正在活跃接收 streamChat 的本地请求 ID（UUID），防止被后台查询异步改写的 requestIdRef 干扰 */
  const activeStreamRequestIdRef = useRef<string | null>(null);
  /** 按会话隔离本端发起的活跃本地流，切会话时保留控制器并在切回时无缝接管，杜绝双流并行与重放重叠 */
  const localActiveStreamsBySessionRef = useRef<Map<string, {
    abortController: AbortController;
    requestId: string;
  }>>(new Map());
  /** 按会话隔离待去重自身用户消息 echo */
  const pendingSelfEchoBySessionRef = useRef<Map<string, Array<{ id: string; text: string }>>>(new Map());
  const liveAbortRef = useRef<AbortController | null>(null);
  const liveLifecycleRef = useRef(createLiveLifecycleState());
  // Wall-clock of the last byte received on the /live stream (any event OR the
  // 15s keepalive ping). A watchdog reconnects when this goes stale, catching
  // silently-dead half-open connections after long idle.
  const lastLiveActivityRef = useRef<number>(Date.now());
  // Pending reconnect backoff timer, so teardown can cancel it.
  const reconnectTimerRef = useRef<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // Scroll container + "am I at the bottom?" tracking. Auto-follow during streaming
  // ONLY while the user is at the bottom; scrolling up releases the follow so history
  // stays put. A ref (not state) avoids re-rendering on every scroll event.
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [showJumpBtn, setShowJumpBtn] = useState(false);
  const timelineFollowRef = useRef<ReturnType<typeof createTimelineFollow> | null>(null);
  if (!timelineFollowRef.current) {
    timelineFollowRef.current = createTimelineFollow(atBottomRef, setShowJumpBtn);
  }
  const timelineFollow = timelineFollowRef.current;
  const attachTimeline = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
    timelineFollow.attach(node);
  }, [timelineFollow]);
  useEffect(() => () => timelineFollow.dispose(), [timelineFollow]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputHistoryRef = useRef(new InputHistory());
  const historyProject = activeSession?.id === sessionId
    ? activeSession.project_hash || effectiveWorkingDir || '' : effectiveWorkingDir || '';
  const historyContext = inputHistoryKey(historyProject, sessionId);
  const pendingHistoryCaretRef = useRef<{ context: string; value: string; position: number } | null>(null);
  useLayoutEffect(() => {
    inputHistoryRef.current.switchContext(historyContext);
    pendingHistoryCaretRef.current = null;
    return () => { pendingHistoryCaretRef.current = null; };
  }, [historyContext]);
  useLayoutEffect(() => {
    const pending = pendingHistoryCaretRef.current;
    pendingHistoryCaretRef.current = null;
    const ta = textareaRef.current;
    if (!pending || !ta || pending.context !== historyContext || pending.value !== input) return;
    ta.setSelectionRange(pending.position, pending.position);
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [input, historyContext]);

  // 首次挂载时如果恢复了草稿，自适应调整 textarea 高度
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta && input) {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    }
  }, []);

  // 实时持久化当前活动会话的输入框草稿（文字与图片附件），确保刷新或重启页面后不丢失
  useEffect(() => {
    if (activeIdRef.current === sessionId) {
      saveComposerDraft(sessionId, {
        text: input,
        images: pendingImageData(pendingAttach),
      });
    }
  }, [input, pendingAttach, sessionId]);
  const slashRef = useRef<HTMLDivElement>(null);
  const atRef = useRef<HTMLDivElement>(null);
  // 当前 Chat 正在显示的会话 id。用于区分「外部切换会话(需重置+加载历史)」
  // 与「本次新建会话首条消息完成后自己拿到的 id(不应重置)」。
  const activeIdRef = useRef<string | null>(null);
  // Distinguish async work from A -> B -> A session switches. Comparing only
  // the session id would let the first A's late active-check/cancel result
  // mutate the replacement A view.
  const sessionGenerationRef = useRef(0);
  const renderedSessionIdRef = useRef(sessionId);
  if (renderedSessionIdRef.current !== sessionId) {
    // Advance during render, before a passive effect can abort the old reader.
    // An accepted first-turn `done` pre-binds activeIdRef to its new id, so that
    // normal null -> canonical-id prop update does not invalidate its own tail.
    if (activeIdRef.current !== sessionId) sessionGenerationRef.current += 1;
    renderedSessionIdRef.current = sessionId;
  }
  // 已为哪个 sessionId 触发过历史加载（或它是本 Chat 自建的会话）。用于避免
  // project_hash 迟到（刷新后由 App 异步回填）导致的重复加载 / 覆盖当前对话。
  const loadedForRef = useRef<string | null>(null);
  const historyOffsetRef = useRef(0);
  const historyTotalRef = useRef(0);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const historyOffsetBySessionRef = useRef<Map<string, number>>(new Map());
  const historyTotalBySessionRef = useRef<Map<string, number>>(new Map());
  const hasOlderBySessionRef = useRef<Map<string, boolean>>(new Map());
  const [turnOutline, setTurnOutline] = useState<SessionTurnOutline[]>([]);
  const turnOutlineRef = useRef(turnOutline);
  turnOutlineRef.current = turnOutline;
  const turnOutlineBySessionRef = useRef<Map<string, SessionTurnOutline[]>>(new Map());
  /** Stable turn-nav id pending a scroll-jump after older history loads. */
  const pendingJumpIdRef = useRef<string | null>(null);
  // While another client (OpenAI API) owns `/chat/active`:
  // 1) `GET /chat/watch` reattaches to the live event bus (real-time progress)
  // 2) light history poll as a fallback for events missed before join
  const detachedPollTimerRef = useRef<number | null>(null);
  const detachedWatchAbortRef = useRef<AbortController | null>(null);
  const sessionWatchersRef = useRef<Map<string, AbortController>>(new Map());
  // 终端收尾/停止屏障：记录刚刚收尾结束或手动停止的会话与其保护截止时间戳。
  // 设立 2.5 秒的屏障，防止刚结算/被 stop 的后端任务在短暂退出期内重放旧 user/残余事件给新的 idle watch，
  // 导致会话状态被错误“弹回”忙碌(busy)状态。
  const terminalSettleGuardUntilRef = useRef<Map<string, number>>(new Map());
  function markSessionTerminalSettled(sid: string) {
    if (!sid) return;
    terminalSettleGuardUntilRef.current.set(sid, Date.now() + 2500);
  }
  function markSessionManuallyStopped(sid: string) {
    if (!sid) return;
    recordUserManualStop(sid);
    markSessionTerminalSettled(sid);
  }
  function isSessionTerminalSettled(sid: string): boolean {
    if (!sid) return false;
    const until = terminalSettleGuardUntilRef.current.get(sid);
    if (!until) return false;
    if (Date.now() > until) {
      terminalSettleGuardUntilRef.current.delete(sid);
      return false;
    }
    return true;
  }
  function isSessionInManualStopGuard(sid: string): boolean {
    return isSessionTerminalSettled(sid);
  }
  function clearManualStopGuard(sid: string) {
    if (sid) terminalSettleGuardUntilRef.current.delete(sid);
  }
  function stopDetachedHistoryPoll(targetSid?: string) {
    if (detachedPollTimerRef.current != null) {
      window.clearInterval(detachedPollTimerRef.current);
      detachedPollTimerRef.current = null;
    }
    if (targetSid) {
      sessionWatchersRef.current.get(targetSid)?.abort();
      sessionWatchersRef.current.delete(targetSid);
      localActiveStreamsBySessionRef.current.delete(targetSid);
    } else {
      for (const ctrl of sessionWatchersRef.current.values()) {
        ctrl.abort();
      }
      sessionWatchersRef.current.clear();
      if (detachedWatchAbortRef.current) {
        detachedWatchAbortRef.current.abort();
        detachedWatchAbortRef.current = null;
      }
    }
    // 一并清待机 watch：升级时它的 abort 已交给 detachedWatchAbortRef（上方
    // 已 abort），纯空闲态时仅存在于 idleWatchAbortRef，这里兜底。
    stopIdleWatch();
  }
  function stopBackgroundFinishWatch() {
    if (backgroundFinishTimerRef.current != null) {
      window.clearInterval(backgroundFinishTimerRef.current);
      backgroundFinishTimerRef.current = null;
    }
  }
  /** Sessions left mid-turn. Their SSE was aborted, so `done` never arrives
   *  here — poll `/chat/active` and, once the daemon drops them, swap the
   *  partial cache for the persisted transcript and stop the sidebar spinner. */
  function ensureBackgroundFinishWatch() {
    if (backgroundFinishTimerRef.current != null) return;
    const tick = async () => {
      const away = new Set<string>();
      for (const id of backgroundRunningSessionsRef.current) away.add(id);
      for (const id of localTurnSessionsRef.current) away.add(id);
      const viewed = activeIdRef.current;
      if (viewed) away.delete(viewed);
      if (away.size === 0) {
        stopBackgroundFinishWatch();
        return;
      }
      let active: string[] = [];
      try {
        active = await getActiveChatSessions();
      } catch {
        return;
      }
      for (const id of away) {
        if (active.includes(id)) continue;
        if (activeIdRef.current === id) continue;
        backgroundRunningSessionsRef.current.delete(id);
        localTurnSessionsRef.current.delete(id);
        onLiveRunningChange?.(id, false);
        const hash = projectHashBySessionRef.current.get(id) || viewedProjectHashRef.current || activeSession?.project_hash;
        if (!hash) continue;
        try {
          const session = await getSession(hash, id, { tail: HISTORY_PAGE });
          if (activeIdRef.current === id) continue;
          if (!session || !Array.isArray(session.messages)) continue;
          const loaded = sessionMessagesToDisplay(session.messages, session.offset ?? 0);
          messageCacheRef.current.set(id, loaded);
          const surface = hydrateSession(
            loaded,
            session.todos,
            activeTodosBySessionRef.current.get(id),
          );
          writeLiveTodo(id, reduceLiveTodo(null, { type: 'hydrate', items: surface.todos ?? [] }));
          seedAppliedTodoIds(id, surface.appliedTodoIds);
        } catch {
          /* return path refetches disk */
        }
      }
    };
    void tick();
    backgroundFinishTimerRef.current = window.setInterval(() => {
      void tick();
    }, 8000);
  }
  function ensureAssistantBubbleForWatch() {
    setMessages((prev) => {
      if (prev.length > 0 && prev[prev.length - 1].role === 'assistant') {
        return prev;
      }
      const next = [
        ...prev,
        { role: 'assistant' as const, parts: [] },
      ];
      messagesRef.current = next;
      return next;
    });
  }
  /** Restore Build / AcceptEdits / Plan approval (and user-input) cards after
   *  refresh or session switch. Auto never parks; only non-Auto modes emit these. */
  function restorePendingInteractive(loadId: string, loadGeneration: number) {
    void getChatPending(loadId)
      .then((pending) => {
        if (
          activeIdRef.current !== loadId ||
          sessionGenerationRef.current !== loadGeneration
        ) {
          return;
        }
        if (pending.permission) {
          const auto =
            nativeModeRef.current === 'bypass' || modeState.confirmedMode === 'bypass';
          if (
            !auto
            && !transcriptToolCallIsResolved(messagesRef.current, pending.permission.call_id)
          ) {
            updateToolInLastAssistant(pending.permission.call_id, {
              status: 'waiting_approval',
            });
            onPermission(pending.permission as PermissionRequestEvent);
          }
        }
        if (pending.user_input && !transcriptLatestUserInputIsResolved(messagesRef.current)) {
          setUserInputReq(pending.user_input);
        }
      })
      .catch(() => {
        /* watch replay is the primary path; pending is a backup */
      });
  }

  function startDetachedHistoryPoll(
    projectHash: string,
    loadId: string,
    loadGeneration: number,
    opts?: { localReattach?: boolean },
  ) {
    // 针对指定会话先停止其既有 watcher，但绝不误杀其他正在后台运行的会话流！
    sessionWatchersRef.current.get(loadId)?.abort();
    sessionWatchersRef.current.delete(loadId);

    // Show running UI; send stays locked via recovery / requestId for foreign turns.
    setBusyAndClock(true);
    busyRef.current = true;
    // Disk (or the in-memory cache) stays on screen. Watch replay is a delta:
    // events already painted are skipped, and only the unpainted suffix is
    // appended. Deleting the trailing assistant here is what made a refresh
    // drop the in-flight turn and leave only the steer card.
    seedAppliedTodoIds(loadId, todoCallIdsFromMessages(messagesRef.current));
    // Backup path: explicit pending query restores approval cards even if the
    // watch stream drops the edge event (or a mid-turn race loses the snapshot).
    restorePendingInteractive(loadId, loadGeneration);

    // Live reattach via event bus fan-out.
    const watchAbort = new AbortController();
    detachedWatchAbortRef.current = watchAbort;
    sessionWatchersRef.current.set(loadId, watchAbort);
    localActiveStreamsBySessionRef.current.set(loadId, {
      abortController: watchAbort,
      requestId: loadId,
    });

    const effectiveProjectHash =
      projectHash ||
      activeSession?.project_hash ||
      viewedProjectHashRef.current ||
      projectHashBySessionRef.current.get(loadId) ||
      '';

    // 活跃会话切回对账：异步向后端校验一次权威待办清单，一旦发现本地活跃缓存与后端不一致，
    // 立即以服务端真源（Rust TodoTool）就地自愈对齐，彻底清除未刷新的脏内存缓存。
    if (effectiveProjectHash) {
      getSession(effectiveProjectHash, loadId, { tail: HISTORY_PAGE }).then((detail) => {
        if (
          activeIdRef.current === loadId &&
          sessionGenerationRef.current === loadGeneration &&
          Array.isArray(detail?.todos) &&
          (busyRef.current ||
            backgroundRunningSessionsRef.current.has(loadId) ||
            localTurnSessionsRef.current.has(loadId))
        ) {
          writeLiveTodo(loadId, reduceLiveTodo(null, { type: 'hydrate', items: detail.todos }));
        }
      }).catch(() => {});
    }
    // 本端是否已收到终态；决定流正常关闭后要不要补一次磁盘对账。
    let terminalSeen = false;

    // 带游标自愈推流循环 (Self-Healing Stream with Cursor)：
    // 彻底解决网络颠簸、TCP假死超时或无报错静默断流导致的“推流停止卡住”顽疾。
    const runStreamWithAutoRecovery = async () => {
      let retryCount = 0;
      const maxRetries = 5;

      while (!terminalSeen && !watchAbort.signal.aborted) {
        if (
          sessionGenerationRef.current !== loadGeneration &&
          !backgroundRunningSessionsRef.current.has(loadId)
        ) {
          break;
        }

        const attachCursor = readStreamCursor(loadId);
        const attachAfterSeq = resolveAfterSeq(attachCursor, messagesRef.current.length === 0);
        const attachNeedsDedup = attachAfterSeq === undefined;

        try {
          await watchChatSession(
            loadId,
            (event) => {
              retryCount = 0; // 成功收到有效事件立即重置重试计数器
              // 游标推进：回放帧带 seq，握手帧带 cursor。
              if (typeof event.seq === 'number') writeStreamCursor(loadId, event.seq);
              if (event.type === 'session_start') {
                writeStreamCursor(loadId, event.cursor);
                return;
              }
              // Ignore synthetic done events from clean idle/watch disconnects.
              if (
                event.type === 'done' &&
                ((event as { stop_reason?: string }).stop_reason === 'not_active' ||
                  (event as { stop_reason?: string }).stop_reason === 'watch_closed')
              ) {
                return;
              }

              const isCurrentView = activeIdRef.current === loadId;
              if (isCurrentView) {
                if (event.type === 'text' || event.type === 'reasoning') {
                  ensureAssistantBubbleForWatch();
                }
                // Reattach after refresh / sidebar switch. Server replay includes
                // permission_request / user_input_request for every non-Auto mode that
                // parks (Build / AcceptEdits / Plan). Must restore those modals or the
                // turn deadlocks in WaitingApproval with a blinking cursor.
                handleEvent(event, {
                  requireReplayDedup: attachNeedsDedup,
                  repeatUserAfterSettled: false,
                });
                timelineFollow.changed();
                if (
                  event.type === 'done' ||
                  event.type === 'stopped' ||
                  event.type === 'error'
                ) {
                  terminalSeen = true;
                  sessionWatchersRef.current.delete(loadId);
                  localActiveStreamsBySessionRef.current.delete(loadId);
                  settleToIdleWatch(effectiveProjectHash, loadId, sessionGenerationRef.current);
                }
              } else {
                // 对标 opencode 多会话后台推送体系：
                // 当用户切至其他会话时，后台会话流实时将事件写入专属缓存 messageCacheRef！
                applyEventToSessionCache(loadId, event);
                if (
                  event.type === 'done' ||
                  event.type === 'stopped' ||
                  event.type === 'error'
                ) {
                  terminalSeen = true;
                  sessionWatchersRef.current.delete(loadId);
                  localActiveStreamsBySessionRef.current.delete(loadId);
                  backgroundRunningSessionsRef.current.delete(loadId);
                  localTurnSessionsRef.current.delete(loadId);
                  onLiveRunningChange?.(loadId, false);
                  archiveBackgroundTodos(loadId);
                }
              }
            },
            watchAbort.signal,
            { afterSeq: attachAfterSeq },
          );
        } catch (err: any) {
          if (err?.name === 'AbortError' || watchAbort.signal.aborted) break;
        }

        // 终态达成或被主动终止：正常退出自愈循环
        if (terminalSeen || watchAbort.signal.aborted) break;

        // 走到这里说明推流意外中断（未收终态 EOF、假死超时被看门狗中断或网络抖动）
        // 快速探针：检查后端该会话是否仍在运行
        try {
          const actives = await getActiveChatSessions();
          if (!actives.includes(loadId)) {
            // 后端该回合已收尾（说明是在最终完成阶段断开），退出循环走磁盘对账
            break;
          }
        } catch {
          // 探针网络异常，继续尝试重连
        }

        if (watchAbort.signal.aborted) break;

        retryCount += 1;
        if (retryCount > maxRetries) {
          break; // 超过重试上限，降级到磁盘对账
        }

        // 指数退避：第一次 100ms 极速自愈，后续 300ms, 600ms, 1200ms...
        const delay = Math.min(100 * Math.pow(2, retryCount - 1), 2000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      // 无论何种非正常退出（重试耗尽或后端收尾中断），若尚未送达终态，立刻做权威磁盘历史对账兜底
      if (!terminalSeen && !watchAbort.signal.aborted) {
        sessionWatchersRef.current.delete(loadId);
        localActiveStreamsBySessionRef.current.delete(loadId);
        settleDiskCatchUp(effectiveProjectHash, loadId);
        if (effectiveProjectHash) {
          startDetachedTick(effectiveProjectHash, loadId, loadGeneration);
        }
      }
    };

    void runStreamWithAutoRecovery();
  }
  // ── Detached tick ── 2s 兜底:watch 实时流连着时只 append-only 补帧 (不抹
  // 流式增量),watch 断开时整体替换;同时监测 stillActive 终结回合。供
  // startDetachedHistoryPoll (切入已活跃会话) 与 startIdleWatch (原地升级)
  // 共用。
  /** Live tokens win. Disk is touched only after the stream goes quiet, and
   *  only the transcript body is read when the file size or mtime changed. */
  async function catchUpFromDisk(
    hash: string,
    id: string,
    opts?: { force?: boolean },
  ): Promise<boolean | null> {
    // force：回合收尾（终态到达 / 用户停止）时的一次性对账，必须跳过“流刚吐过内容”的
    // 静默守卫，否则最后一段正文永远补不回来（表现为通知已响、正文要刷新/失焦才出现）。
    const force = opts?.force === true;
    if (!force && Date.now() - lastLiveContentRef.current < 1500) return null;
    const fresh = await getSessionFreshness(hash, id);
    const sig = `${fresh.bytes}:${fresh.mtime_ms}`;
    // Right after Send, /chat/active and the file can still say "idle" for a
    // moment. Trusting that flips the button back to the send arrow while the
    // turn is already running.
    const sinceSend = turnStartedAtRef.current == null
      ? Number.POSITIVE_INFINITY
      : Date.now() - turnStartedAtRef.current;
    if (!force && !fresh.running && sinceSend < 2500) return true;
    if (sig === freshnessSigRef.current) {
      // 文件没变但会话已经停了：上次轮询还在跑，这次不能因为签名相同就留下计时器和画板。
      if (!fresh.running && activeIdRef.current === id && busyRef.current) {
        setBusyAndClock(false);
        busyRef.current = false;
        onLiveRunningChange?.(id, false);
        liveLifecycleRef.current = { running: false, terminalConsumed: true };
        transitionChatRecovery({ type: 'authoritative_terminal' });
        commitActiveTodosIntoLastAssistant();
      }
      return fresh.running;
    }
    freshnessSigRef.current = sig;

    // ── 核心架构铁律：推流运行期间 (fresh.running)，后续内容完全由自然推流增量画到画布 ──
    // 严禁在此期间去读磁盘并调用任何模糊合并算法覆盖/重写画布，彻底杜绝历史被重复追加与撕裂！
    if (fresh.running) {
      return true;
    }

    const detail = await getSession(hash, id, { tail: HISTORY_PAGE });
    if (activeIdRef.current !== id || !detail || !Array.isArray(detail.messages)) return null;
    const disk = sessionMessagesToDisplay(detail.messages, detail.offset ?? 0);
    const canvas = messagesRef.current;
    const diskHasUser = diskHasCanvasUser(disk, canvas);
    const diskSettled = diskHasUser && !transcriptHasInFlightAssistant(disk) && !fresh.running;
    const adoptSettledDisk = !fresh.running && diskSettled && shouldAdoptDiskTranscript({
      diskText: transcriptTextLen(disk),
      canvasText: transcriptTextLen(canvas),
      diskHasUser,
    });
    if (adoptSettledDisk) {
      messagesRef.current = disk;
      messageCacheRef.current.set(id, disk);
      setMessages(disk);
    }
    // 会话已停就收尾：停表、把本轮勾完的清单冻到尾部。
    // 服务端在空闲时不会再把已完成清单当作活跃画板返回，这里也不能把那份历史清单贴回输入框上方。
    setBusyAndClock(false);
    busyRef.current = false;
    onLiveRunningChange?.(id, false);
    liveLifecycleRef.current = { running: false, terminalConsumed: true };
    transitionChatRecovery({ type: 'authoritative_terminal' });
    commitActiveTodosIntoLastAssistant();
    writeLiveTodo(id, reduceLiveTodo(null, { type: 'hydrate', items: detail.todos ?? [] }));
    seedAppliedTodoIds(id, todoCallIdsFromMessages(messagesRef.current));
    return fresh.running;
  }

  /**
   * 回合收尾的一次性磁盘对账（终态到达、用户停止、或视图流未送终态即关闭）。
   *
   * 画布只靠 `/chat/watch` 一条流推进，而终态通知是另一套轮询（`/chat/active`）发出的——
   * 因此“右下角已提示完成、最后一段正文却要刷新/失焦才出现”的根因就是：流可能没把尾段
   * 或终态送到，而画布路径此前从不回读磁盘。磁盘是回合结算后的权威，这里强制拉取一次
   * （仍在运行时按 800ms 重试至多 3 次），把尾段正文与 busy/看门狗状态一次性对齐。
   */
  /**
   * 磁盘历史增量对账：直接拉取磁盘权威 transcript 并更新会话内存缓存与持久化缓存。
   * 如果该会话正好在屏幕上呈现，同步平滑更新画布、大纲与状态，彻底杜绝“通知响了/会话切回却卡在旧命令转圈”的断层。
   */
  const syncSessionCacheFromDisk = useCallback(async (hash: string, sid: string): Promise<boolean> => {
    if (!hash || !sid) return false;
    try {
      const detail = await getSession(hash, sid, { tail: HISTORY_PAGE });
      if (!detail || !Array.isArray(detail.messages)) return false;
      const loaded = sessionMessagesToDisplay(detail.messages, detail.offset ?? 0);
      const canvas = activeIdRef.current === sid
        ? messagesRef.current
        : (messageCacheRef.current.get(sid) ?? []);
      // 立即发送会先把用户气泡画上。停止触发的这次对账往往早于落盘，
      // 直接覆盖会把气泡抹掉，直到刷新才从磁盘重新出现。
      const merged = mergeDiskWithUnpersistedTail(loaded, canvas);
      const keptUnpersistedTail = merged.length !== loaded.length;
      messageCacheRef.current.set(sid, merged);
      void saveSessionCache(
        hash,
        sid,
        merged,
        detail.todos,
        undefined,
        detail.turns,
        detail.token_usage,
      );
      if (activeIdRef.current === sid) {
        messagesRef.current = merged;
        setMessages(merged);
        if (detail.turns && detail.turns.length > 0) {
          turnOutlineBySessionRef.current.set(sid, detail.turns);
          setTurnOutline(detail.turns);
        }
        if (detail.token_usage) {
          applySessionTokens(sid, merged, detail.token_usage);
        }
        if (!keptUnpersistedTail) {
          setBusyAndClock(false);
          busyRef.current = false;
        }
        applySessionStickyTodos(sid, null);
      }
      return true;
    } catch {
      return false;
    }
  }, []);

  function settleDiskCatchUp(projectHash: string, sid: string) {
    if (!projectHash || !sid) return;
    const attempt = (delay: number, triesLeft: number) => {
      window.setTimeout(() => {
        if (activeIdRef.current === sid) {
          void catchUpFromDisk(projectHash, sid, { force: true }).then((running) => {
            // false = 已确认空闲且完成对账；null/true 表示仍不确定（后端还在收尾）→ 重试。
            if (running !== false && triesLeft > 0) attempt(800, triesLeft - 1);
          });
        } else {
          // 后台会话：即使不在前台展示，流异常关闭后也必须同步磁盘并更新内存缓存
          void syncSessionCacheFromDisk(projectHash, sid);
        }
      }, delay);
    };
    attempt(0, 3);
  }

  function startDetachedTick(
    projectHash: string,
    loadId: string,
    loadGeneration: number,
  ) {
    if (detachedPollTimerRef.current != null) {
      window.clearInterval(detachedPollTimerRef.current);
      detachedPollTimerRef.current = null;
    }
    const tick = async () => {
      if (
        activeIdRef.current !== loadId ||
        sessionGenerationRef.current !== loadGeneration
      ) {
        stopDetachedHistoryPoll(loadId);
        return;
      }
      try {
        const stillActive = await catchUpFromDisk(projectHash, loadId);
        if (
          activeIdRef.current !== loadId ||
          sessionGenerationRef.current !== loadGeneration
        ) {
          stopDetachedHistoryPoll(loadId);
          return;
        }
        if (stillActive === null || stillActive) return;
        {
          transitionChatRecovery({ type: 'authoritative_terminal' });
          const loadedDone = messagesRef.current;
          messageCacheRef.current.set(loadId, loadedDone);
          commitActiveTodosIntoLastAssistant();
          // 回空闲态重新待机,让下一个 API turn 仍能被推到(watch 中途死掉时
          // 由 tick 兜底检测到回合结束,同样要重挂 idle watch)。
          settleToIdleWatch(projectHash, loadId, loadGeneration);
        }
      } catch {
        // Keep polling.
      }
    };
    detachedPollTimerRef.current = window.setInterval(() => {
      void tick();
    }, 8000);
  }
  // 空闲态（已就绪、非 sync、非 busy）维持待机 watch 连接
  // 让 daemon 在 API/native turn admit 的瞬间把该连接接入 fan-out
  // （event-driven push），避免「停留在会话上、对端起 turn 后 WebUI 无感知
  // 只能刷新才看见」。收到首个 turn 事件即原地升级为观察模式渲染，共用同一
  // watch 连接（无事件丢失），done 退回空闲并重新进入待机。
  const idleWatchAbortRef = useRef<AbortController | null>(null);
  const idleWatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleWatchFlashDisconnectsRef = useRef<Map<string, { count: number; lastFailedAt: number }>>(new Map());
  function stopIdleWatch() {
    if (idleWatchTimerRef.current) {
      clearTimeout(idleWatchTimerRef.current);
      idleWatchTimerRef.current = null;
    }
    if (idleWatchAbortRef.current) {
      idleWatchAbortRef.current.abort();
      idleWatchAbortRef.current = null;
    }
  }
  // 回合结束（done/stopped/error）后回到空闲待机态:清掉 detached 状态并立即
  // 重新挂上 idle watch,让下一个 API turn 一 admit 就被 push 过来。
  // 必须在同一同步块里把 busyRef 同步清掉——`setBusy` 是异步的,直接调
  // `startIdleWatch` 会被上一轮的 `busyRef.current === true` 入口守卫挡掉,
  // 导致第一轮结束后 watch 失联、第二轮无法同步。
  function settleToIdleWatch(
    projectHash: string,
    loadId: string,
    loadGeneration: number,
  ) {
    sessionWatchersRef.current.get(loadId)?.abort();
    sessionWatchersRef.current.delete(loadId);
    localActiveStreamsBySessionRef.current.delete(loadId);
    stopDetachedHistoryPoll(loadId);
    pendingSelfEchoRef.current = [];
    if (requestIdRef.current === loadId) requestIdRef.current = null;
    // 观察结束回空闲:recovery 状态机复位,否则 allowSend/allowQueueDrain 会一直
    // 停在 detached_active(false),输入框被锁住。
    transitionChatRecovery({ type: 'authoritative_terminal' });
    backgroundRunningSessionsRef.current.delete(loadId);
    localTurnSessionsRef.current.delete(loadId);
    onLiveRunningChange?.(loadId, false);
    setHistoryHint(null);
    setBusyAndClock(false);
    busyRef.current = false;
    markSessionTerminalSettled(loadId);
    commitActiveTodosIntoLastAssistant();
    const currentOutline = turnOutlineRef.current.length > 0 ? turnOutlineRef.current : (turnOutlineBySessionRef.current.get(loadId) ?? []);
    // 回合结束进入待机：输入框上方已归档沉淀，持久化缓存写入 null，绝不残留脏待办
    void saveSessionCache(projectHash, loadId, messagesRef.current, null, undefined, currentOutline, tokensAuthoritativeRef.current);
    // API turn 已落盘:通知 App 刷新侧栏(消息数/自动命名标题),新建会话才会出现。
    onLiveTurnDone?.();
    startIdleWatch(projectHash, loadId, loadGeneration);
    // 终态已到：磁盘已结算，强制对账一次，补回流里可能丢掉（或被去重吞掉）的尾段正文。
    settleDiskCatchUp(projectHash, loadId);
  }
  function startIdleWatch(
    projectHash: string,
    loadId: string,
    loadGeneration: number,
    opts?: { replayIfLive?: boolean },
  ) {
    if (syncRef.current && liveSessionIdRef.current === loadId) return;
    if (
      idleWatchAbortRef.current &&
      !idleWatchAbortRef.current.signal.aborted
    ) {
      return;
    }
    // 熔断保护检查：若该会话短时间内连续闪断（>= 3次），且处于 30 秒冷却期内，跳过自动重连
    const flashRecord = idleWatchFlashDisconnectsRef.current.get(loadId);
    if (flashRecord && flashRecord.count >= 3 && Date.now() - flashRecord.lastFailedAt < 30000) {
      return;
    }
    stopIdleWatch();
    const abort = new AbortController();
    idleWatchAbortRef.current = abort;
    let activated = false;
    let terminalSeen = false;
    const connectedAt = Date.now();
    // 待机连接不会补发（standby=true），直接按「无历史」握手；replayIfLive 的重连才续传。
    const idleAfterSeq = opts?.replayIfLive === true
      ? resolveAfterSeq(readStreamCursor(loadId), messagesRef.current.length === 0)
      : -1;
    const idleNeedsDedup = idleAfterSeq === undefined;
    void watchChatSession(
      loadId,
      (event) => {
        // 游标推进：回放帧带 seq，握手帧带 cursor。
        if (typeof event.seq === 'number') writeStreamCursor(loadId, event.seq);
        if (event.type === 'session_start') {
          writeStreamCursor(loadId, event.cursor);
          return;
        }
        // Ignore synthetic done events from clean idle/watch disconnects.
        if (
          event.type === 'done' &&
          ((event as { stop_reason?: string }).stop_reason === 'not_active' ||
            (event as { stop_reason?: string }).stop_reason === 'watch_closed')
        ) {
          return;
        }

        const isCurrentView = activeIdRef.current === loadId;
        if (!isCurrentView) {
          // 核心对标：会话在后台运行时，总线推流绝不丢弃，实时反哺进会话专属缓存 messageCacheRef！
          applyEventToSessionCache(loadId, event);
          if (
            event.type === 'done' ||
            event.type === 'stopped' ||
            event.type === 'error'
          ) {
            terminalSeen = true;
            sessionWatchersRef.current.delete(loadId);
            backgroundRunningSessionsRef.current.delete(loadId);
            localTurnSessionsRef.current.delete(loadId);
            onLiveRunningChange?.(loadId, false);
            archiveBackgroundTodos(loadId);
          }
          return;
        }

        if (sessionGenerationRef.current !== loadGeneration) {
          return;
        }
        let skipSecondHandle = false;
        if (!activated) {
          if (isSessionInManualStopGuard(loadId)) {
            // 用户刚手动点击了停止或会话刚完成终端结算，后端正在退出期间可能重放旧 user/残余事件，坚决不能误激活为新轮次！
            return;
          }
          if (event.type === 'user') {
            const cleanText = visibleUserText(event.content).trim();
            const alreadyPresent = messagesRef.current.some((m) => {
              if (m.role !== 'user') return false;
              return m.parts.some((p) => p.kind === 'text' && userTextsMatch(p.text, cleanText));
            });
            if (alreadyPresent) {
              // 关键防线：该用户提问早已存在于当前画布上，纯属后端重放的旧提问帧，坚决不能误激活为新轮次！
              return;
            }
            handleEvent(event);
            skipSecondHandle = true;
          } else if (!isWatchTurnActivationEvent(event.type)) {
            return;
          }
          activated = true;
          idleWatchFlashDisconnectsRef.current.delete(loadId);
          idleWatchAbortRef.current = null;
          detachedWatchAbortRef.current = abort;
          sessionWatchersRef.current.set(loadId, abort);
          transitionChatRecovery({ type: 'active_check_succeeded', active: true });
          requestIdRef.current = loadId;
          setBusyAndClock(true);
          busyRef.current = true;
          // A remote turn preserves the reader's current follow intent.
          seedAppliedTodoIds(loadId, todoCallIdsFromMessages(messagesRef.current));
          // Backup: restore Build/AcceptEdits/Plan approval cards mid-turn.
          restorePendingInteractive(loadId, loadGeneration);
          // API turn 已 admit(会话已建):通知 App 刷新侧栏,让新建会话实时出现。
          onLiveTurnDone?.();
        }
        if (event.type === 'text' || event.type === 'reasoning') {
          ensureAssistantBubbleForWatch();
        }
        if (skipSecondHandle) {
          timelineFollow.changed();
          return;
        }
        // Restore permission/user-input for every non-Auto mode that parks.
        handleEvent(event, { requireReplayDedup: idleNeedsDedup });
        // Keep the main scroller pinned while we are following (user can scroll
        // up mid-turn to release follow).
        timelineFollow.changed();
        if (
          event.type === 'done' ||
          event.type === 'stopped' ||
          event.type === 'error'
        ) {
          terminalSeen = true;
          // 游标会话级递增，跨回合不清（清了就没法续传断线期间的内容）。
          idleWatchFlashDisconnectsRef.current.delete(loadId);
          // 回合结束:回空闲态重新待机,保证下一个 API turn 一 admit 就被推到。
          settleToIdleWatch(projectHash, loadId, loadGeneration);
        }
      },
      abort.signal,
      // 刷新时 /chat/active 可能还没标上这个会话。standby 会跳过已经在跑的回放，
      // 思考和正文要等下一次落盘。第一次连接先要完整回放；回合真的空闲时服务端
      // 没有回放缓冲，仍然只是待机。
      { standbyOnly: opts?.replayIfLive !== true, afterSeq: idleAfterSeq },
    ).then(() => {
      // 连接在未收到终端事件的情况下被服务端关闭(Live-dying 竞态 / daemon
      // 重启 / 网络断)。若当前还是这条连接的 controller,说明没人接手——
      // 回到空闲态重新待机,别让下一个 turn 失联。
      if (idleWatchAbortRef.current === abort || detachedWatchAbortRef.current === abort) {
        idleWatchAbortRef.current = null;
        if (activated && !terminalSeen) {
          idleWatchFlashDisconnectsRef.current.delete(loadId);
          settleToIdleWatch(projectHash, loadId, loadGeneration);
        } else {
          // 本端自己的 turn 刚结束:busy 可能尚未复位(流关闭与 /chat done 处理
          // 竞态),直接绕过 busy 守卫重新待机;待机连接不会干扰 busy 状态管理。
          busyRef.current = false;
          const duration = Date.now() - connectedAt;
          if (duration > 3000) {
            idleWatchFlashDisconnectsRef.current.delete(loadId);
          }
          const isFlash = duration <= 3000;
          if (isFlash) {
            const cur = idleWatchFlashDisconnectsRef.current.get(loadId) ?? { count: 0, lastFailedAt: 0 };
            cur.count += 1;
            cur.lastFailedAt = Date.now();
            idleWatchFlashDisconnectsRef.current.set(loadId, cur);
            if (cur.count >= 3) {
              console.warn(`[watch] Idle watch circuit breaker triggered for ${loadId} after ${cur.count} consecutive flash disconnects.`);
              return;
            }
          }
          const retryDelay = isFlash ? 1000 : 200;
          idleWatchTimerRef.current = setTimeout(() => {
            idleWatchTimerRef.current = null;
            if (activeIdRef.current === loadId && sessionGenerationRef.current === loadGeneration) {
              startIdleWatch(projectHash, loadId, loadGeneration);
            }
          }, retryDelay);
        }
      }
    }).catch((err) => {
      if (err?.name === 'AbortError') return;
      // 静默失败：不阻塞空闲态使用，下一次会话聚焦/刷新会重建。
    });
  }
  // Cache of session messages, used to preserve in-progress streaming turns when switching sessions.
  const messageCacheRef = useRef<Map<string, Message[]>>(new Map());
  // Mirror of messages state to read the latest value without dependency tracking.
  const messagesRef = useRef<Message[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    return () => {
      stopDetachedHistoryPoll();
      stopBackgroundFinishWatch();
    };
  }, []);
  // 实时（/live）总线对应的会话 id（来自 snapshot）。用于门控实时事件：仅当用户当前
  // 查看的就是这个实时会话时才把输出渲染进画布——否则用户从侧栏打开了别的历史会话，
  // 实时输出会串进错误页面、且刷新即消失（刷新会按真实会话重载）。
  const liveSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    onLiveReview?.({
      sessionId: sessionId ?? activeIdRef.current ?? liveSessionIdRef.current,
      permission: livePending,
      userInput: userInputReq,
    });
  }, [onLiveReview, sessionId, livePending, userInputReq]);
  // 跨实例增量：待交互卡在别处被解决时，同步清掉本画布的待批准/待回答状态；同步压缩状态。
  // 同时监听全局 activity 终态：当后台会话结束时，即时在后台同步磁盘最新历史并刷新该会话缓存。
  useEffect(
    () =>
      onGlobalEvent((event) => {
        if (event.type === 'activity') {
          const sid = activeIdRef.current;
          if (sid && event.session_id === sid) {
            setIsCompacting(event.status === 'compacting');
          }
          if (!event.running || event.terminal) {
            const targetSid = event.session_id;
            backgroundRunningSessionsRef.current.delete(targetSid);
            localTurnSessionsRef.current.delete(targetSid);
            onLiveRunningChange?.(targetSid, false);
            sessionWatchersRef.current.get(targetSid)?.abort();
            sessionWatchersRef.current.delete(targetSid);
            localActiveStreamsBySessionRef.current.delete(targetSid);

            const ph =
              projectHashBySessionRef.current.get(targetSid) ||
              viewedProjectHashRef.current ||
              activeSession?.project_hash ||
              '';
            if (ph) {
              void syncSessionCacheFromDisk(ph, targetSid);
            }
          }
        }
        if (event.type !== 'review_resolved' || event.request_id == null) return;
        setLivePending((cur) =>
          cur && cur.request_id === event.request_id ? null : cur,
        );
        setUserInputReq((cur) =>
          cur && cur.request_id === event.request_id ? null : cur,
        );
      }),
    [activeSession?.project_hash, onLiveRunningChange, syncSessionCacheFromDisk],
  );
  /** Project hash for the session on screen, including before App metadata arrives. */
  const viewedProjectHashRef = useRef<string | null>(activeSession?.project_hash ?? null);
  /** Last freshness signature we already parsed. Unchanged files are not read. */
  const freshnessSigRef = useRef('');
  /** Snapshot of a finished transcript. Ignore a leftover `state.running=true`
   * in the same reconnect replay so a completed session does not steal the
   * sidebar spinner or arm the stop button. */
  const liveIdleSnapshotRef = useRef(false);
  /** User echo held because it repeated the previous prompt during an idle
   *  snapshot. Released only when a delta is not already painted, so a
   *  finished turn's thinking replay cannot open a second bubble. */
  const heldDuplicateUserRef = useRef<string | null>(null);
  /** Once an idle-snapshot delta is recognized as more of the current
   *  assistant, a later token must not be treated as the next turn. */
  const replayBoundToAssistantRef = useRef(false);
  function attachedToLiveRuntime(): boolean {
    // Sync views the unique session as an observer. Send/stop always go
    // through /live for the session on screen — never a second runtime.
    return syncRef.current && activeIdRef.current != null;
  }
  // 是否已为「当前会话」上报过乐观侧栏条目。每次切换/新建会话时复位，
  // 避免同一会话第二条消息（尤其 sync 路径本地不落消息）重复上报、改写标题。
  const optimisticFiredRef = useRef(false);
  // Sync path: text of a message THIS tab just optimistically appended (so the
  // view leaves the "new conversation" landing page instantly instead of waiting
  // for the server `user` echo, which only arrives after VL preprocessing). The
  // matching self-echo is deduped in the `user` case so we don't render it twice.
  // Turns are serialized (hub `turn_active`), so the next `user` echo after a send
  // is this tab's own; a peer's message (different text, or after the ref clears)
  // still appends normally.
  const pendingSelfEchoRef = useRef<Array<{ id: string; text: string }>>([]);
  // Artifact (code block) streaming: the daemon's ArtifactDetector strips fenced
  // code blocks from TextDelta and emits them as artifact_start / content / end.
  // Stream the reconstructed fence incrementally so a mid-turn cancel still
  // keeps whatever code already arrived (buffering until artifact_end used to
  // swallow the whole block).
  const artifactOpenRef = useRef(false);
  const artifactFenceLenRef = useRef(3);
  const artifactOpenBySessionRef = useRef<Map<string, number>>(new Map());

  // 切换/恢复会话时重置画布并加载历史。依赖 project_hash：刷新后 sessionId 先于
  // 元数据就绪，此时只显示提示；待 App 从会话列表回填 project_hash，本 effect 因
  // 依赖变化重跑，再真正拉取历史。
  useEffect(() => {
    // 会话 id 变化（外部切换 / 新建按钮）才重置画布。本 Chat 自建会话首条消息完成后
    // sessionId 变成自己的 id（activeIdRef 已同步），不重置，以免清空刚看到的对话。
    if (sessionId !== activeIdRef.current) {
      blockQueueDrainRef.current = true;
      const prevId = activeIdRef.current;
      if (!isFirstMountRef.current) {
        saveComposerDraft(prevId, {
          text: inputRef.current,
          images: pendingImageData(pendingAttachRef.current),
        });
      } else {
        isFirstMountRef.current = false;
      }
      if (prevId && provider) {
        providerCacheRef.current.set(prevId, provider);
      }
      if (pendingSteersRef.current.length > 0 && prevId) {
        pendingSteersBySessionRef.current.set(prevId, [...pendingSteersRef.current]);
      }
      if (prevId) {
        stashSessionQueued(queuedBySessionRef.current, prevId, queuedRef.current);
      }
      if (prevId) {
        if (turnOutlineRef.current.length > 0) {
          turnOutlineBySessionRef.current.set(prevId, turnOutlineRef.current);
        } else {
          turnOutlineBySessionRef.current.delete(prevId);
        }
        historyOffsetBySessionRef.current.set(prevId, historyOffsetRef.current);
        historyTotalBySessionRef.current.set(prevId, historyTotalRef.current);
        const prevHasOlder = historyOffsetRef.current > 0 || hasOlder;
        hasOlderBySessionRef.current.set(prevId, prevHasOlder);
      }
      const detachedController = abortRef.current;
      // Prefer the ref: disk settlement writes it immediately, while React
      // state can still be the longer partial canvas from before the turn ended.
      const leavingMessages = messagesRef.current.length > 0 ? messagesRef.current : messages;
      const prevWasRunning = !!(prevId && (
        busyRef.current ||
        localTurnSessionsRef.current.has(prevId) ||
        backgroundRunningSessionsRef.current.has(prevId)
      ));
      if (
        prevId &&
        activeSession?.id === prevId &&
        activeSession.project_hash
      ) {
        projectHashBySessionRef.current.set(prevId, activeSession.project_hash);
      }
      if (prevId && leavingMessages.length > 0) {
        const sticky = activeTodosRef.current;
        const allDone = !!(sticky && sticky.length > 0 && sticky.every((t) => t.status === 'completed'));
        let cached: Message[];
        if (sticky && sticky.length > 0 && prevWasRunning) {
          // 回合还在跑：勾完也不归档，切回来画板还在。
          activeTodosBySessionRef.current.set(prevId, sticky);
          cached = detachUnfinishedTodoFromLatestAssistant(leavingMessages);
        } else if (allDone && sticky) {
          const doc = liveTodoDoc(prevId);
          cached = placeArchivedTodos(leavingMessages, sticky, doc?.revision ?? null);
          writeLiveTodo(prevId, null);
        } else if (sticky && sticky.length > 0) {
          activeTodosBySessionRef.current.set(prevId, sticky);
          cached = detachUnfinishedTodoFromLatestAssistant(leavingMessages);
        } else {
          activeTodosBySessionRef.current.delete(prevId);
          cached = detachUnfinishedTodoFromLatestAssistant(leavingMessages);
        }
        // Stamp the leaving session's live stopwatch into its cache. The
        // following setBusyAndClock(false) must NOT write elapsed onto the
        // destination session's messages.
        if (turnStartedAtRef.current != null) {
          turnStartedAtBySessionRef.current.set(prevId, turnStartedAtRef.current);
          cached = stampLastAssistantElapsed(cached, Date.now() - turnStartedAtRef.current);
        }
        messageCacheRef.current.set(prevId, cached);
      } else if (prevId) {
        if (turnStartedAtRef.current != null) {
          turnStartedAtBySessionRef.current.set(prevId, turnStartedAtRef.current);
        }
        const sticky = activeTodosRef.current;
        if (sticky && sticky.length > 0 && (prevWasRunning || sticky.some((t) => t.status !== 'completed'))) {
          activeTodosBySessionRef.current.set(prevId, sticky);
        }
      }

      // Invalidate in-flight /chat event handlers for the session we are leaving
      // (isCurrentChatStream checks generation). Do this BEFORE rebinding ids so
      // a late SSE chunk cannot paint into the destination session. Capture the
      // post-bump generation for async switch callbacks (A→B→A races).
      sessionGenerationRef.current += 1;
      freshnessSigRef.current = '';
      const switchGeneration = sessionGenerationRef.current;
      if (prevId && tokensRef.current) {
        saveTokenSnapshot(prevId, tokensAuthoritativeRef.current);
      }
      tokenSaveGenerationRef.current = switchGeneration;
      resetTokenTelemetry();
      if (prevId && abortRef.current && activeStreamRequestIdRef.current) {
        localActiveStreamsBySessionRef.current.set(prevId, {
          abortController: abortRef.current,
          requestId: activeStreamRequestIdRef.current,
        });
      }
      if (prevId && pendingSelfEchoRef.current.length > 0) {
        pendingSelfEchoBySessionRef.current.set(prevId, [...pendingSelfEchoRef.current]);
      } else if (prevId) {
        pendingSelfEchoBySessionRef.current.delete(prevId);
      }
      activeIdRef.current = sessionId;
      restoreProviderForSession(sessionId);

      // 恢复新会话的输入框草稿
      const nextDraft = loadComposerDraft(sessionId);
      setInput(nextDraft?.text ?? '');
      setPendingAttach(nextDraft?.images ? imagesToPending(nextDraft.images) : []);
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        if (nextDraft?.text) {
          window.requestAnimationFrame(() => {
            if (textareaRef.current) {
              textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`;
            }
          });
        }
      }

      // 恢复新会话的气泡编辑草稿
      const nextBubbleDraft = sessionId ? loadBubbleEditDraft(sessionId) : null;
      setBubbleEditDraft(nextBubbleDraft);
      setEditingSourceIndex(nextBubbleDraft?.sourceIndex ?? null);
      const stashedSteers = sessionId
        ? (pendingSteersBySessionRef.current.get(sessionId) || getStoredSteers(sessionId))
        : undefined;
      if (stashedSteers?.length && sessionId) {
        setPendingSteers(stashedSteers);
      } else {
        setPendingSteers([]);
      }
      loadedForRef.current = null;
      const openFence = sessionId ? artifactOpenBySessionRef.current.get(sessionId) : undefined;
      artifactOpenRef.current = openFence != null;
      artifactFenceLenRef.current = openFence || 3;
      if (!prevWasRunning && prevId) {
        sessionWatchersRef.current.get(prevId)?.abort();
        sessionWatchersRef.current.delete(prevId);
      }
      stopIdleWatch();
      optimisticFiredRef.current = false;
      const restoredActiveStream = sessionId ? localActiveStreamsBySessionRef.current.get(sessionId) : undefined;
      if (restoredActiveStream && !restoredActiveStream.abortController.signal.aborted) {
        abortRef.current = restoredActiveStream.abortController;
        activeStreamRequestIdRef.current = restoredActiveStream.requestId;
      } else {
        abortRef.current = null;
        activeStreamRequestIdRef.current = null;
        if (sessionId) localActiveStreamsBySessionRef.current.delete(sessionId);
      }
      pendingSelfEchoRef.current = sessionId
        ? (pendingSelfEchoBySessionRef.current.get(sessionId) ?? [])
        : [];
      // An existing session stays send-locked until `/chat/active` proves it
      // has no detached operation. Its canonical id is already a safe stop
      // alias, including while the discovery request is pending or unavailable.
      requestIdRef.current = sessionId;
      transitionChatRecovery({ type: 'session_switch', hasSession: sessionId !== null });
      // 离开会话时，不再粗暴 abort 正在运行中的后台会话读者流！
      // 后台流在存活状态下继续接收事件并通过 applyEventToSessionCache 实时同步进缓存，
      // 彻底消除切回会话时正文丢失、状态断层的顽疾。
      // （仅在用户主动点击「停止」按钮时才显式 abort）
      if (prevWasRunning && prevId) {
        backgroundRunningSessionsRef.current.add(prevId);
        onLiveRunningChange?.(prevId, true);
        ensureBackgroundFinishWatch();
      }
      const cached = sessionId ? messageCacheRef.current.get(sessionId) : undefined;
      const destRunning = !!(
        sessionId &&
        (backgroundRunningSessionsRef.current.has(sessionId) ||
          localTurnSessionsRef.current.has(sessionId))
      );
      const destElapsed = destRunning
        ? [...(cached ?? [])].reverse().find((m) => m.role === 'assistant')?.elapsedMs
        : undefined;
      liveLifecycleRef.current = destRunning
        ? { running: true, terminalConsumed: false }
        : createLiveLifecycleState();
      finishTurnClock({ stamp: false });
      if (destRunning) {
        const sessionStarted = sessionId ? turnStartedAtBySessionRef.current.get(sessionId) : undefined;
        // Fallback to the latest user message's send timestamp if stashed clock is absent
        const lastUserTs = [...(cached ?? [])].reverse().find((m) => m.role === 'user')?.ts;
        const started = sessionStarted ?? lastUserTs ?? resumeTurnStartedAt(Date.now(), destElapsed);
        if (sessionId) {
          turnStartedAtBySessionRef.current.set(sessionId, started);
        }
        turnStartedAtRef.current = started;
        setTurnStartedAt(started);
        busyRef.current = true;
        setBusy(true);
      } else {
        // Do NOT eagerly delete turnStartedAtBySessionRef here if the session might still be active
        // or reconnecting via detached watch; only reset when truly idle or terminal
        busyRef.current = false;
        setBusy(false);
      }
      // 恢复该会话暂存的排队消息（含等待当前步骤完成的转向卡片）。
      // 关键防线：只有内容已经正式作为用户提问出现在历史中的卡片（已落盘/已渲染），才需要剔除；
      // 尚在内核缓冲区排队等待当前步骤完成的转向卡片（kind === 'steer'），必须屹立不倒，继续展示「转向已排队」和取消按钮！
      const allKnown = [
        ...messagesRef.current,
        ...(sessionId ? (messageCacheRef.current.get(sessionId) ?? []) : []),
      ];
      const canvasUserMsgs = allKnown.filter((m) => m.role === 'user');
      const canvasUserTexts = canvasUserMsgs
        .flatMap((m) => m.parts?.filter((p) => p.kind === 'text').map((p) => visibleUserText(p.text || '').trim()) ?? []);
      const isAlreadyOnCanvas = (text: string) => {
        const clean = visibleUserText(text).trim();
        return !!clean && canvasUserTexts.some((t) => t === clean || userTextsMatch(t, clean));
      };
      // 纯图片 / 空文本卡片无法用文本判定：按图片集合精确匹配，避免已消费卡片
      // 复活；文本为空且无图时不再直接判 false（避免误删尚未对账的 steer 卡片）。
      const queuedItemOnCanvas = (item: QueuedMessage) => {
        if (isAlreadyOnCanvas(item.text)) return true;
        if (visibleUserText(item.text).trim()) return false;
        if (!item.images || item.images.length === 0) return false;
        return canvasUserMsgs.some((m) => sameImageSet(m.images, item.images));
      };

      const stashedQueued = restoreSessionQueued(queuedBySessionRef.current, sessionId).filter(
        (item) => !queuedItemOnCanvas(item),
      );
      setQueued(stashedQueued);
      // 异步与后端同步队列（跨设备/换手机打开该会话时无缝同步恢复）
      if (sessionId) {
        void getChatQueue(sessionId).then((serverItems) => {
          if (activeIdRef.current === sessionId && serverItems && serverItems.length > 0) {
            setQueued((current) => {
              // 排除已经在正文消息流中出现的已发送提问，杜绝已被消费的卡片复活
              const validServerItems = (serverItems.map(deserializeQueuedCard) as unknown as QueuedMessage[]).filter(
                (item) => !queuedItemOnCanvas(item),
              );
              if (validServerItems.length === 0) return current;
              if (current.length === 0) {
                return validServerItems;
              }
              // 合并服务端队列项，避免重复
              const existingIds = new Set(current.map((item) => String(item.id)));
              const existingTexts = new Set(current.map((item) => visibleUserText(item.text).trim()));
              const toAdd = validServerItems.filter(
                (item) => !existingIds.has(String(item.id)) && !existingTexts.has(visibleUserText(item.text).trim())
              );
              return toAdd.length > 0 ? [...current, ...toAdd] : current;
            });
          }
        });
      }
      setLivePending(null);
      setUserInputReq(null);
      onPermissionResolved?.(null);
      applySessionStickyTodos(
        sessionId,
        sessionId ? activeTodosBySessionRef.current.get(sessionId) ?? null : null,
      );
      timelineFollow.reset();
      if (cached && cached.length > 0) {
        messagesRef.current = cached;
        setMessages(cached);
        // Schedule the cached history after layout without overriding reader intent.
        pinTimelineToBottom(1200);
      } else {
        const localActive = sessionId && (localTurnSessionsRef.current.has(sessionId) || backgroundRunningSessionsRef.current.has(sessionId));
        if (localActive && messagesRef.current.length > 0) {
          // 当前轮次正在活跃生成中且画布已有提问，坚决保留当前画布，绝不抹成 []
        } else {
          messagesRef.current = [];
          setMessages([]);
          atBottomRef.current = true;
          setShowJumpBtn(false);
          const el = scrollRef.current;
          if (el) el.scrollTop = 0;
        }
      }

      cancelTurnNavScroll();
      setTurnNavQuery('');
      setActiveTurnId(null);
      turnNavPinUntilRef.current = 0;
      const cachedOffset = sessionId ? (historyOffsetBySessionRef.current.get(sessionId) ?? 0) : 0;
      const cachedTotal = sessionId ? (historyTotalBySessionRef.current.get(sessionId) ?? 0) : 0;
      const cachedHasOlder = sessionId
        ? (cachedOffset > 0 || (hasOlderBySessionRef.current.get(sessionId) === true))
        : false;
      setHasOlder(cachedHasOlder);
      setLoadingOlder(false);
      historyOffsetRef.current = cachedOffset;
      historyTotalRef.current = cachedTotal;
      pendingJumpIdRef.current = null;
      const cachedOutline = sessionId ? turnOutlineBySessionRef.current.get(sessionId) : undefined;
      setTurnOutline(cachedOutline ?? []);

      // bot review P2: 切换会话时重置搜索状态,避免残留关键词过滤新会话、matchIdx 超界致计数错乱。
      setSearch('');
      setMatchIdx(0);
      setHistoryHint(null);
      setPersistenceWarning(null);
      applySessionTokens(sessionId, cached && cached.length > 0 ? cached : []);
      // 切到有内容的历史会话才进「加载中」抑制落地页。新建/draft（message_count=0）
      // 以及元数据尚未对齐的 id 必须保持落地，否则会闪一下空聊天框再跳回落地页。
      setLoading(
        sessionId != null &&
          !cached &&
          !stayOnNewSessionLanding({ sessionId, activeSession }),
      );
      // View switch is observation of that session's unique runtime.
      // Reuse the open /live SSE only when we are already watching it;
      // otherwise subscribe `/live?session_id=` so send/stop hit this session.
      if (
        sync &&
        sessionId &&
        !shouldReuseLiveStream({
          sync: true,
          sessionId,
          liveSessionId: liveSessionIdRef.current,
          streamOpen: liveAbortRef.current != null && !liveAbortRef.current.signal.aborted,
        })
      ) {
        liveSessionIdRef.current = sessionId;
      }
    }

    if (!sessionId) {
      requestIdRef.current = null;
      return;
    }
    // 已为该会话加载过历史（或它是本 Chat 自建会话）→ 不重复加载、不覆盖。
    if (loadedForRef.current === sessionId) return;

    // ── 架构核心改进：会话来回切换（Warm Switch）属于内存热切换，绝不算冷启动！──
    // 只要当前会话在内存缓存中已有数据，0ms 瞬间恢复画布，完全不需要等待 project_hash 或向后台发网络请求（getSession），
    // 极大减轻后台与磁盘 I/O 压力，消除切会话时的多余闪烁与重绘，彻底拔除老架构将内存缓存阻塞在 projectHash 门禁后的隐患！
    const cached = messageCacheRef.current.get(sessionId);
    if (cached && cached.length > 0) {
      loadedForRef.current = sessionId;
      const effectiveHash =
        activeSession?.project_hash ||
        projectHashBySessionRef.current.get(sessionId) ||
        viewedProjectHashRef.current ||
        '';
      if (effectiveHash) projectHashBySessionRef.current.set(sessionId, effectiveHash);

      setLoading(false);
      messagesRef.current = cached;
      setMessages(cached);
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
      timelineFollow.jump();

      const savedOffset = historyOffsetBySessionRef.current.get(sessionId) ?? 0;
      const savedTotal = historyTotalBySessionRef.current.get(sessionId) ?? 0;
      const savedHasOlder =
        savedOffset > 0 ||
        (hasOlderBySessionRef.current.get(sessionId) === true) ||
        (activeSession?.id === sessionId && (activeSession.message_count ?? 0) > cached.length);
      historyOffsetRef.current = savedOffset;
      historyTotalRef.current = savedTotal;
      setHasOlder(savedHasOlder);

      const cachedTurns = turnOutlineBySessionRef.current.get(sessionId);
      if (cachedTurns && cachedTurns.length > 0) {
        setTurnOutline(cachedTurns);
      }
      const cachedProv = providerCacheRef.current.get(sessionId);
      if (cachedProv) {
        setProvider(cachedProv);
        providerPinnedRef.current = true;
      }
      const isRunning =
        backgroundRunningSessionsRef.current.has(sessionId) ||
        localTurnSessionsRef.current.has(sessionId);
      if (isRunning) {
        setBusyAndClock(true);
        busyRef.current = true;
        requestIdRef.current = sessionId;
        if (!sessionWatchersRef.current.has(sessionId)) {
          startDetachedHistoryPoll(effectiveHash, sessionId, sessionGenerationRef.current);
        }
        const cachedTodos = activeTodosBySessionRef.current.get(sessionId);
        applySessionStickyTodos(sessionId, cachedTodos ?? null);
      } else {
        setBusyAndClock(false);
        busyRef.current = false;
        // 空闲会话不挂历史清单。未完成项等服务端对账后再放回画板。
        writeLiveTodo(sessionId, null);
        startIdleWatch(effectiveHash, sessionId, sessionGenerationRef.current);
        // SWR (Stale-While-Revalidate)：会话切回且处于空闲态时，0ms 呈现已有缓存的同时在后台静默核验磁盘权威转录，
        // 纠偏可能遗留的未结工具状态（如 run_command 转圈卡死）与最终回答，彻底免除手动刷新。
        if (effectiveHash) {
          const switchGen = sessionGenerationRef.current;
          void getSession(effectiveHash, sessionId, { tail: HISTORY_PAGE }).then((res) => {
            if (
              activeIdRef.current !== sessionId ||
              sessionGenerationRef.current !== switchGen
            ) {
              return;
            }
            if (res && Array.isArray(res.messages)) {
              const diskOffset = res.offset ?? 0;
              const diskTotal = res.message_count ?? (res.messages.length + diskOffset);
              const olderExists = diskOffset > 0;
              historyOffsetRef.current = diskOffset;
              historyTotalRef.current = diskTotal;
              setHasOlder(olderExists);
              historyOffsetBySessionRef.current.set(sessionId, diskOffset);
              historyTotalBySessionRef.current.set(sessionId, diskTotal);
              hasOlderBySessionRef.current.set(sessionId, olderExists);

              const loaded = sessionMessagesToDisplay(res.messages, res.offset ?? 0);
              const lastCur = messagesRef.current[messagesRef.current.length - 1];
              const lastLoaded = loaded[loaded.length - 1];
              const hasUnfinishedTool = lastCur?.parts?.some(
                (p) => p.kind === 'tool' && p.tool?.status === 'pending'
              );
              const shouldUpdate =
                loaded.length !== messagesRef.current.length ||
                hasUnfinishedTool ||
                JSON.stringify(lastLoaded?.parts) !== JSON.stringify(lastCur?.parts);
              if (shouldUpdate) {
                messageCacheRef.current.set(sessionId, loaded);
                messagesRef.current = loaded;
                setMessages(loaded);
                if (res.turns && res.turns.length > 0) {
                  turnOutlineBySessionRef.current.set(sessionId, res.turns);
                  setTurnOutline(res.turns);
                }
                if (res.token_usage) {
                  applySessionTokens(sessionId, loaded, res.token_usage);
                }
                void saveSessionCache(
                  effectiveHash,
                  sessionId,
                  loaded,
                  res.todos,
                  undefined,
                  res.turns,
                  res.token_usage,
                  diskOffset,
                  diskTotal,
                );
                if (scrollRef.current && atBottomRef.current) {
                  scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
                }
              }
              writeLiveTodo(sessionId, reduceLiveTodo(null, { type: 'hydrate', items: res.todos ?? [] }));
            }
          }).catch(() => {});
        }
      }
      return;
    }

    const projectHash = activeSession?.project_hash;
    const hideLoadChrome = stayOnNewSessionLanding({ sessionId, activeSession });
    if (hideLoadChrome) {
      setHistoryHint(null);
      setLoading(false);
    }
    if (!projectHash || !activeSession || activeSession.id !== sessionId) {
      // SSE 可能先把 id 推过来；等 activeSession 对齐后再加载，期间保持落地页。
      return;
    }

    // 标记已为该会话发起加载，避免并发/重复。
    loadedForRef.current = sessionId;
    if (projectHash) projectHashBySessionRef.current.set(sessionId, projectHash);

    // ── 冷启动优化：优先从 IndexedDB 异步直出首屏（1~3ms），杜绝白屏与加载中等待 ──
    const loadId = sessionId;
    const loadGeneration = sessionGenerationRef.current;
    if (!hideLoadChrome) {
      getSessionCache(projectHash, loadId).then((idb) => {
        if (idb && idb.messages.length > 0 && activeIdRef.current === loadId && sessionGenerationRef.current === loadGeneration) {
          if (!messageCacheRef.current.has(loadId)) {
            messageCacheRef.current.set(loadId, idb.messages);
            messagesRef.current = idb.messages;
            setMessages(idb.messages);
            setLoading(false);
            if (scrollRef.current) {
              scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            }
            timelineFollow.jump();
          }
          if (idb.turns && idb.turns.length > 0) {
            turnOutlineBySessionRef.current.set(loadId, idb.turns);
            setTurnOutline(idb.turns);
          }
          if (idb.historyOffset !== undefined) {
            const diskOffset = idb.historyOffset;
            const diskTotal = idb.historyTotal ?? (idb.messages.length + diskOffset);
            const olderExists = diskOffset > 0;
            historyOffsetRef.current = diskOffset;
            historyTotalRef.current = diskTotal;
            setHasOlder(olderExists);
            historyOffsetBySessionRef.current.set(loadId, diskOffset);
            historyTotalBySessionRef.current.set(loadId, diskTotal);
            hasOlderBySessionRef.current.set(loadId, olderExists);
          }
          if (idb.todos && idb.todos.length > 0 && idb.todos.some((t: any) => t.status !== 'completed')) {
            applySessionStickyTodos(loadId, idb.todos);
          } else {
            applySessionStickyTodos(loadId, null);
          }
          if (idb.tokenUsage) {
            applySessionTokens(loadId, idb.messages, idb.tokenUsage);
          }
        }
      });
      if (!messageCacheRef.current.has(loadId)) {
        setLoading(true);
      }
    }
    Promise.allSettled([getSession(projectHash, loadId, { tail: HISTORY_PAGE }), getActiveChatSessions()])
      .then(([sessionResult, activeResult]) => {
        // Generation also covers A -> B -> A; id equality alone is insufficient.
        if (
          activeIdRef.current !== loadId ||
          sessionGenerationRef.current !== loadGeneration
        ) return;

        let nextHint: string | null = null;
        let resumeClockFrom: number | undefined;
        const currentCached = messageCacheRef.current.get(loadId);
        const serverActive =
          activeResult.status === 'fulfilled'
            ? activeResult.value.includes(loadId)
            : null;
        if (serverActive === false) {
          localTurnSessionsRef.current.delete(loadId);
          backgroundRunningSessionsRef.current.delete(loadId);
          onLiveRunningChange?.(loadId, false);
        }
        const isLiveSession =
          syncRef.current &&
          (liveSessionIdRef.current === loadId ||
            liveSyncOwnsViewedSession({
              sync: syncRef.current,
              viewedSessionId: loadId,
              liveSessionId: liveSessionIdRef.current,
            }));
        if (sessionResult.status === 'fulfilled' && sessionResult.value && Array.isArray(sessionResult.value.messages)) {
          const preferred = sessionResult.value.preferred_model;
          if (preferred) {
            setProvider(preferred);
            providerCacheRef.current.set(loadId, preferred);
            providerPinnedRef.current = true;
          } else {
            const cachedProv = providerCacheRef.current.get(loadId);
            if (cachedProv) {
              setProvider(cachedProv);
              providerPinnedRef.current = true;
            } else {
              restoreProviderForSession(loadId);
            }
          }
          // Live reconnect restores from the /live snapshot. Disk history can
          // race that snapshot (stale, missing in-flight turns) and must not
          // overlay a canvas that already has turns. If the live projection is
          // empty (view-only hub snapshot) the canvas is also empty — then disk
          // is the recovery path after switching away and back.
          // When serverActive === false, the turn finished while away; disk history
          // is authoritative and must replace any stale in-flight cache.
          const canvasEmpty =
            messagesRef.current.length === 0 &&
            !(currentCached && currentCached.length > 0);
          if (!isLiveSession || canvasEmpty || serverActive === false) {
            const loaded = sessionMessagesToDisplay(
              sessionResult.value.messages,
              sessionResult.value.offset ?? 0,
            );
            const totalOnDisk = sessionResult.value.message_count ?? loaded.length;
            const diskOffset = sessionResult.value.offset ?? 0;
            const olderExists = diskOffset > 0;
            historyTotalRef.current = totalOnDisk;
            historyOffsetRef.current = diskOffset;
            setHasOlder(olderExists);
            historyOffsetBySessionRef.current.set(loadId, diskOffset);
            historyTotalBySessionRef.current.set(loadId, totalOnDisk);
            hasOlderBySessionRef.current.set(loadId, olderExists);
            if (sessionResult.value.turns && sessionResult.value.turns.length > 0) {
              setTurnOutline(sessionResult.value.turns);
              turnOutlineBySessionRef.current.set(loadId, sessionResult.value.turns);
            }
            // 运行中的会话磁盘尚未落盘本轮未结消息，绝不能用落后磁盘历史覆盖缓存！
            if (serverActive === false) {
              void saveSessionCache(
                projectHash,
                loadId,
                loaded,
                sessionResult.value.todos,
                undefined,
                sessionResult.value.turns,
                sessionResult.value.token_usage,
                diskOffset,
                totalOnDisk,
              );
            }
            let displayMessages: Message[] = currentCached && currentCached.length > 0 ? currentCached : loaded;

            if (currentCached && currentCached.length > 0) {
              const turnActive =
                serverActive !== null
                  ? serverActive
                  : localTurnSessionsRef.current.has(loadId) ||
                    backgroundRunningSessionsRef.current.has(loadId) ||
                    liveSessionIdRef.current === loadId;

              const diskHasUser = diskHasCanvasUser(loaded, currentCached);
              const cacheInFlight = transcriptHasInFlightAssistant(currentCached);

              const cachedUserCount = currentCached.filter((m) => m.role === 'user').length;
              const loadedUserCount = loaded.filter((m) => m.role === 'user').length;
              // 缓存中包含尚未在磁盘落盘的在途用户提问，绝不能被落后磁盘历史覆盖！
              const cacheHasInFlightUser = turnActive && cachedUserCount > loadedUserCount;
              // 外部新增了轮次（例如其他标签页或 TUI 新增了提问）
              const cacheMissingUser = loadedUserCount > cachedUserCount;
              // 磁盘内容比内存缓存多出新的结算内容
              const diskHasNewContent = transcriptTextLen(loaded) > transcriptTextLen(currentCached);
              // 切走时留下的残缺缓存缺少了后台跑完后落盘的最终正文消息
              const cacheMissingSettled = (!turnActive || serverActive === false) && diskHasUser && cacheMissingSettledAssistant(currentCached, loaded);
              // 关键修复：当会话未处于活跃轮次时，如果磁盘与缓存的消息结构或内容不一致（例如发生删除、改写或截断），以磁盘持久化为最高真相源！
              const diskCountDiffer = (!turnActive || serverActive === false) && !cacheInFlight && loaded.length !== currentCached.length;
              const diskUserDiffer = (!turnActive || serverActive === false) && !cacheInFlight && loadedUserCount !== cachedUserCount;
              // 上下文压缩会把硬盘上的老消息换成一条摘要 → 硬盘比画布**更短**。
              // 显示只增不减：这种情况绝不能用硬盘覆盖画布（否则显示被阑割）。
              const diskShrank = diskHasUser && transcriptTextLen(loaded) < transcriptTextLen(currentCached);
              const cacheContentStale = !diskShrank && (!turnActive || serverActive === false) && !cacheInFlight && (
                diskCountDiffer || diskUserDiffer || (diskHasUser && transcriptTextLen(loaded) !== transcriptTextLen(currentCached))
              );

              // 仅当缓存落后于磁盘最新状态，或磁盘内容被改写/删除产生结构差异时采用磁盘覆盖；
              // 否则如果缓存已经完整且一致，保持内存真相源，消除切换时的双重冲刷闪烁！
              const shouldAdoptDisk = !cacheHasInFlightUser && !diskShrank && (cacheMissingUser || cacheMissingSettled || (!turnActive && !cacheInFlight && diskHasUser && diskHasNewContent) || cacheContentStale);

              if (shouldAdoptDisk) {
                displayMessages = loaded;
                messagesRef.current = loaded;
                messageCacheRef.current.set(loadId, loaded);
                setMessages(loaded);
                if (scrollRef.current) {
                  scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
                }
                timelineFollow.jump();
              } else {
                displayMessages = currentCached;
                // 仅当当前画布尚未与缓存对齐时才更新，杜绝重复 setMessages 造成的 DOM 重绘与跳动
                if (messagesRef.current !== currentCached) {
                  messagesRef.current = currentCached;
                  setMessages(currentCached);
                  timelineFollow.jump();
                }
                const effectiveOlder = diskOffset > 0;
                historyOffsetRef.current = diskOffset;
                historyTotalRef.current = totalOnDisk;
                setHasOlder(effectiveOlder);
                historyOffsetBySessionRef.current.set(loadId, diskOffset);
                historyTotalBySessionRef.current.set(loadId, totalOnDisk);
                hasOlderBySessionRef.current.set(loadId, effectiveOlder);
              }
            } else if (loaded.length > 0) {
              // 无痕模式首开或新会话首次进入：无本地缓存，一次性直接渲染磁盘加载内容，无任何闪烁
              displayMessages = loaded;
              messagesRef.current = loaded;
              messageCacheRef.current.set(loadId, loaded);
              setMessages(loaded);
              pinTimelineToBottom(1200);
            }
            // Seed the sticky panel from transcript only when this view has
            // nothing yet, or the turn is already finished. A running turn's
            // panel is owned by `/chat/watch` tool_start after the optimistic
            // switch-back seed — disk must not overlay that live list.
            const turnStillRunning =
              serverActive === true ||
              localTurnSessionsRef.current.has(loadId) ||
              backgroundRunningSessionsRef.current.has(loadId);
            const backendTodos = sessionResult.value.todos;
            if (turnStillRunning) {
              if (!liveTodoDoc(loadId) && backendTodos && backendTodos.length > 0) {
                writeLiveTodo(loadId, reduceLiveTodo(null, { type: 'hydrate', items: backendTodos }));
              }
            } else {
              writeLiveTodo(loadId, reduceLiveTodo(null, { type: 'hydrate', items: backendTodos ?? [] }));
              seedAppliedTodoIds(loadId, todoCallIdsFromMessages(displayMessages));
            }
            applySessionTokens(loadId, displayMessages, sessionResult.value.token_usage ?? undefined);
            resumeClockFrom = [...displayMessages].reverse().find((m) => m.role === 'user')?.ts;
          }
          const origin = sessionResult.value.origin;
          protocolSessionRef.current = origin === 'protocol';
          if (!modeState.pendingMode) {
            setModeState(
              initModeState(
                origin === 'protocol'
                  ? modeForSessionOrigin(origin)
                  : nativeModeRef.current,
              ),
            );
          }
        } else if (!isLiveSession) {
          // Draft / brand-new empty sessions 404 on disk until first persist —
          // that is not "continue a historical session".
          const isEmptyNew =
            activeSession?.id === loadId && (activeSession?.message_count ?? 0) === 0;
          loadedForRef.current = isEmptyNew ? loadId : null;
          if (isEmptyNew) {
            protocolSessionRef.current = false;
            setModeState(initModeState(nativeModeRef.current));
          }
          if (!isEmptyNew) {
            nextHint = t('chat.continueSession', { id: loadId.slice(0, 8) });
          }
        }

        if (activeResult.status === 'fulfilled') {
          const active = activeResult.value.includes(loadId);
          const isLocalTurn = localTurnSessionsRef.current.has(loadId);
          const ownsTurn = thisTabOwnsTurn({ isLiveSession, isLocalTurn });
          transitionChatRecovery({
            type: 'active_check_succeeded',
            active: shouldLockSendAsDetached({ turnActive: active, thisTabOwnsTurn: ownsTurn }),
          });
          if (active) {
            backgroundRunningSessionsRef.current.add(loadId);
            onLiveRunningChange?.(loadId, true);
            liveIdleSnapshotRef.current = false;
            heldDuplicateUserRef.current = null;
            liveLifecycleRef.current = { running: true, terminalConsumed: false };
            const opened = ensureWorkingAssistant(messagesRef.current);
            if (opened !== messagesRef.current) {
              messagesRef.current = opened;
              messageCacheRef.current.set(loadId, opened);
              setMessages(opened);
            }
            const effectiveResumeTs =
              resumeClockFrom ??
              [...messagesRef.current].reverse().find((m) => m.role === 'user')?.ts;
            setBusyAndClock(true, effectiveResumeTs);
            busyRef.current = true;
            requestIdRef.current = loadId;
            setQueued(queueAfterSessionActiveCheck({
              restored: queuedRef.current,
              sessionActive: true,
            }));
            if (effectiveResumeTs) {
              adoptTurnUserTs(effectiveResumeTs, true);
            }
              // 彻底贯彻后台推送机制：只要后台处于活跃中，连入后台推送流（/chat/watch），
              // 让后台把离开期间积累的 Replay 快照和后续实时事件（工具调用、thinking等）源源不断推给前台。
              // 必须严格守护：若当前页面持有活跃的本地发送流（abortRef 存在），绝对禁止重连 watch，
              // 彻底消除主流（POST /chat）与辅流（GET /chat/watch）双重叠加、重复重播导致正文重叠撕裂的顽疾！
              const hasLocalActiveStream =
                abortRef.current !== null ||
                activeStreamRequestIdRef.current !== null ||
                localActiveStreamsBySessionRef.current.has(loadId) ||
                localTurnSessionsRef.current.has(loadId);
              if (!hasLocalActiveStream) {
                startDetachedHistoryPoll(projectHash, loadId, loadGeneration, {
                  localReattach: ownsTurn,
                });
              }
          } else if (!active) {
            // 关键防线：若当前页面持有活跃的本地发送流（abortRef 存在、activeStreamRequestIdRef 存在，
            // 或该会话在 localTurnSessionsRef 中登记为本端轮次），则该任务在本端真切活跃，
            // 绝不允许仅仅因为后端活跃列表同步微秒级滞后或生成耗时超过 2.5 秒就误杀并解除 busy！
            const isLocalActiveInFlight =
              abortRef.current !== null ||
              activeStreamRequestIdRef.current !== null ||
              localActiveStreamsBySessionRef.current.has(loadId) ||
              localTurnSessionsRef.current.has(loadId);
            if (isLocalActiveInFlight) {
              setBusyAndClock(true);
              busyRef.current = true;
            } else {
              localTurnSessionsRef.current.delete(loadId);
              backgroundRunningSessionsRef.current.delete(loadId);
              onLiveRunningChange?.(loadId, false);
              liveLifecycleRef.current = createLiveLifecycleState();
              setBusyAndClock(false);
              busyRef.current = false;
              if (requestIdRef.current === loadId) requestIdRef.current = null;
              onLiveTurnDone?.();
            }
          } else if (requestIdRef.current === loadId) {
            requestIdRef.current = null;
          }
        } else if (!isLiveSession) {
          // `/chat` has no stream reattach endpoint. The registry is authoritative
          // when available; if discovery fails, keep the canonical stop alias and
          // fail closed instead of allowing a possibly concurrent send.
          requestIdRef.current = loadId;
          transitionChatRecovery({ type: 'active_check_failed' });
          if (!syncRef.current) setBusyAndClock(false);
          setQueued(queueAfterSessionActiveCheck({
            restored: queuedRef.current,
            sessionActive: false,
          }));
          nextHint = t('chat.activeCheckFailed', { error: String(activeResult.reason) });
          pushCommandNotice(nextHint);
          // Allow a later metadata/session refresh to retry discovery.
          loadedForRef.current = null;
        }

        setHistoryHint(nextHint);
        setLoading(false);
        // 空闲态（非 active、非 sync）：维持待机 watch，收到对端 turn 推送即升级。
        // 关键防线：若本页面正在执行本地发送主流（abortRef/activeStream 存在，或 localTurnSessions 包含本会话），
        // 坚决杜绝创建任何待机 watch 连接，彻底斩断双流并行与撕裂隐患！
        if (
          activeResult.status === 'fulfilled' &&
          !activeResult.value.includes(loadId) &&
          liveSessionIdRef.current !== loadId &&
          abortRef.current === null &&
          activeStreamRequestIdRef.current === null &&
          !localActiveStreamsBySessionRef.current.has(loadId) &&
          !localTurnSessionsRef.current.has(loadId)
        ) {
          startIdleWatch(projectHash, loadId, loadGeneration, { replayIfLive: true });
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, activeSession?.project_hash]);

  // History responses may arrive after the user starts reading: only the
  // session reset (above), or an explicit jump/send, may re-enable following.
  const pinTimelineToBottom = (_forceDuration = 1200) => timelineFollow.changed();
  const scrollToBottom = (_behavior: ScrollBehavior = 'auto') => timelineFollow.jump();
  useEffect(() => {
    timelineFollow.changed();
  }, [messages, tokens, timelineFollow]);

  // 消息变化且当前无精确 tokens（如切会话、加载历史）时，根据消息或内存快照恢复 tokens。
  useEffect(() => {
    const sid = activeIdRef.current;
    if (!sid || tokens || messages.length === 0) return;
    applySessionTokens(sid, messages);
  }, [messages, tokens, sessionId]);

  // 同 session 内 tokens 变化时写入内存快照（切换回来在 getSession 返回前也能恢复）。
  useEffect(() => {
    const sid = activeIdRef.current;
    if (!sid || !tokens || sessionId !== sid) return;
    if (sessionGenerationRef.current !== tokenSaveGenerationRef.current) return;
    const prev = tokenUsageCacheRef.current.get(sid);
    if (!tokensAuthoritativeRef.current && !sessionTokensRunning(sid)) {
      // Idle non-authoritative deltas must not replace a persisted authoritative snapshot.
      if (prev?.authoritative) return;
    }
    saveTokenSnapshot(sid, tokensAuthoritativeRef.current);
  }, [tokens, sessionId]);

  // Abort the live (/live) stream + cancel any pending reconnect timer if the
  // component unmounts while sync is on.
  useEffect(() => () => {
    liveAbortRef.current?.abort();
    if (reconnectTimerRef.current !== null) clearTimeout(reconnectTimerRef.current);
  }, []);

  // ── 空闲智能预热器 (Idle Prefetcher)：当前无会话运行/打字时，静默预加载前 3~5 个高频会话 ──
  useEffect(() => {
    const curHash = activeSession?.project_hash || projectHashBySessionRef.current.get(sessionId || '') || viewedProjectHashRef.current;
    if (!curHash || loading || busy) return;
    let timer: number | null = null;
    let cancelled = false;

    timer = window.setTimeout(async () => {
      if (cancelled || busy || !curHash) return;
      try {
        const projectSessions = await listProjectSessions(curHash);
        const candidates = (projectSessions || []).slice(0, 5);
        for (const cand of candidates) {
          if (cancelled || busy) break;
          if (cand.id === sessionId) continue;
          if (messageCacheRef.current.has(cand.id)) continue;
          const existing = await getSessionCache(curHash, cand.id);
          if (existing) continue;

          // 随机 5~10 秒延迟加载一个，防网络与 I/O 拥塞
          const delay = 5000 + Math.random() * 5000;
          await new Promise((r) => setTimeout(r, delay));
          if (cancelled || busy) break;

          const res = await getSession(curHash, cand.id, { tail: HISTORY_PAGE });
          if (res && Array.isArray(res.messages)) {
            const loaded = sessionMessagesToDisplay(res.messages, res.offset ?? 0);
            messageCacheRef.current.set(cand.id, loaded);
            await saveSessionCache(curHash, cand.id, loaded, res.todos, undefined, res.turns, res.token_usage);
          }
        }
      } catch {}
    }, 4000);

    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [activeSession?.project_hash, sessionId, loading, busy]);

  // Ctrl + F5 强制清理所有本地会话缓存
  useEffect(() => {
    const onHardReload = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'F5') {
        void clearAllSessionCache();
      }
    };
    window.addEventListener('keydown', onHardReload);
    return () => window.removeEventListener('keydown', onHardReload);
  }, []);

  // 页面进入隐藏（切后台/挂起）的时刻；仅用于判定失焦重进是否需要重连 watch。
  const pageHiddenSinceRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    getApprovalMode()
      .then((current) => {
        if (cancelled || protocolSessionRef.current) return;
        nativeModeRef.current = current;
        setModeState(initModeState(current));
      })
      .catch(() => {});

    const applyIncomingMode = (nextMode: ApprovalMode) => {
      if (cancelled || protocolSessionRef.current) return;
      setModeState((cur) => {
        if (cur.pendingMode || cur.confirmedMode === nextMode) return cur;
        nativeModeRef.current = nextMode;
        if (nextMode === 'bypass') {
          setLivePending(null);
          onPermissionResolved?.(null);
        }
        return initModeState(nextMode);
      });
    };

    const handleCustomEvent = (e: Event) => {
      const mode = (e as CustomEvent<ApprovalMode>).detail;
      if (mode) applyIncomingMode(mode);
    };

    window.addEventListener('jeikcode:approval_mode_changed', handleCustomEvent);

    let bc: BroadcastChannel | null = null;
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        bc = new BroadcastChannel('jeikcode_approval_mode');
        bc.onmessage = (ev) => {
          if (ev.data?.type === 'mode' && ev.data.mode) {
            applyIncomingMode(ev.data.mode);
          }
        };
      }
    } catch {
      // ignore
    }

    const refreshOnFocus = () => {
      if (document.visibilityState !== 'visible') {
        // 记录挂起起点：手机后台/休眠场景下面向“可能需要重连 watch”的判定。
        pageHiddenSinceRef.current = Date.now();
        return;
      }
      const hiddenForLong =
        pageHiddenSinceRef.current != null &&
        Date.now() - pageHiddenSinceRef.current >= WATCH_REATTACH_AFTER_HIDDEN_MS;
      pageHiddenSinceRef.current = null;
      {
        getApprovalMode()
          .then((current) => {
            if (!cancelled) applyIncomingMode(current);
          })
          .catch(() => {});

        const sid = activeIdRef.current;
        const projectHash =
          (sid ? projectHashBySessionRef.current.get(sid) : undefined) ||
          viewedProjectHashRef.current ||
          activeSession?.project_hash;
        if (sid && projectHash) {
          // 手机/移动端切回前台：静默检测后端会话是否活跃，无缝自动恢复断开的 watch 连接
          getActiveChatSessions()
            .then((activeSessions) => {
              if (cancelled || activeIdRef.current !== sid) return;
              const isRunning = Array.isArray(activeSessions) && activeSessions.includes(sid);
              if (isRunning) {
                // 关键防线：本会话的 watch 通道仍然健在时绝不再订阅一次。
                // `startDetachedHistoryPoll` 会 abort 旧 watcher 并重新订阅，后端随即
                // 把整轮事件 replay 回来，把已画完的正文/思考重复落到最新 agent 消息上。
                // 只有通道真的断了，或页面长时间挂起（连接可能静默半开）才无缝重连。
                const watcher = sessionWatchersRef.current.get(sid);
                const watcherAlive = !!watcher && !watcher.signal.aborted;
                if (watcherAlive && !hiddenForLong) return;
                if (
                  abortRef.current === null &&
                  activeStreamRequestIdRef.current === null &&
                  !localTurnSessionsRef.current.has(sid)
                ) {
                  startDetachedHistoryPoll(projectHash, sid, sessionGenerationRef.current);
                }
              } else {
                // 后端已结束或处于空闲态：静默更新一次磁盘最新消息，消除切后台期间跑完的内容未更新问题
                void catchUpFromDisk(projectHash, sid);
              }
            })
            .catch(() => {});
        }
      }
    };

    window.addEventListener('focus', refreshOnFocus);
    document.addEventListener('visibilitychange', refreshOnFocus);

    return () => {
      cancelled = true;
      window.removeEventListener('jeikcode:approval_mode_changed', handleCustomEvent);
      window.removeEventListener('focus', refreshOnFocus);
      document.removeEventListener('visibilitychange', refreshOnFocus);
      try {
        bc?.close();
      } catch {
        // ignore
      }
    };
  }, []);

  // 斜杠菜单：点击外部关闭
  useEffect(() => {
    if (!slashOpen) return;
    const h = (e: MouseEvent) => {
      if (slashRef.current && !slashRef.current.contains(e.target as Node)) {
        setSlashOpen(false);
      }
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [slashOpen]);

  // @ 菜单：点击外部关闭
  useEffect(() => {
    if (!atOpen) return;
    const h = (e: MouseEvent) => {
      if (atRef.current && !atRef.current.contains(e.target as Node)) {
        setAtOpen(false);
      }
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [atOpen]);

  // @ 文件菜单：把 @ 后文本拆成「目录段 + 过滤词」，以支持进入子目录 / 返回上级。
  // 例如 "examples/fo" → 列 cwd/examples 的内容，并按前缀 "fo" 过滤。
  const { scopeDir: atDirPart, filter: atFilter } = splitAtToken(atQuery);
  const atTargetDir =
    atDirPart === ''
      ? effectiveWorkingDir
      : atDirPart.startsWith('/') || atDirPart.startsWith('~')
        ? atDirPart
        : effectiveWorkingDir.replace(/\/+$/, '') + '/' + atDirPart;

  // 目录变化（cwd 切换 / 进入子目录）时重新拉取；仅过滤词变化不触发。后端会 canonicalize `..`。
  useEffect(() => {
    if (!atOpen) return;
    let cancelled = false;
    setAtLoading(true);
    listDir(atTargetDir)
      .then((r) => {
        if (cancelled) return;
        const items: { name: string; is_dir: boolean }[] = [];
        for (const d of r.dirs) items.push({ name: d, is_dir: true });
        if (r.files) for (const f of r.files) items.push({ name: f, is_dir: false });
        items.sort((a, b) => a.name.localeCompare(b.name));
        setAtItems(items);
      })
      .catch(() => { if (!cancelled) setAtItems([]); })
      .finally(() => { if (!cancelled) setAtLoading(false); });
    return () => { cancelled = true; };
  }, [atOpen, atTargetDir]);

  // 菜单可见行：进入子目录后首行为「..」返回上级（仅无过滤词时展示）；其余按过滤词前缀匹配。
  const atRows: { name: string; is_dir: boolean; up?: boolean }[] = [];
  if (atDirPart && atFilter === '') atRows.push({ name: '..', is_dir: true, up: true });
  for (const it of atItems) {
    if (it.name.toLowerCase().startsWith(atFilter.toLowerCase())) atRows.push(it);
  }

  useEffect(() => {
    if (!atOpen) return;
    requestAnimationFrame(() => {
      const container = atRef.current;
      const active = container?.querySelector<HTMLButtonElement>('.at-row.active');
      if (container && active) ensureActiveDescendantVisible(container, active);
    });
  }, [atIndex, atOpen, atRows.length]);

  // ── 遗留的 /live 实时流逻辑已彻底退役，统一收敛至 Single Event Bus (/chat/watch) ──


  // 同步模式已移除。画布只走 /chat + /chat/watch 这一条链路。
  // 旧书签里的 ?sync=1 不再打开第二条实时流，挂载时清掉。
  useEffect(() => {
    try {
      const url = new URL(location.href);
      if (!url.searchParams.has('sync')) return;
      url.searchParams.delete('sync');
      history.replaceState(history.state, '', url.toString());
    } catch { /* URL/history 不可用时忽略 */ }
  }, []);

  // 彻底废除 busy 期间的 2s 磁盘轮询 (catchUpFromDisk)，
  // 全权由后端的流式推送与事件机制推进画布，杜绝磁盘未落盘数据覆盖内存导致的跳变与重复渲染。
  useEffect(() => {
    // Disk polling during active turns is permanently deactivated to avoid races with SSE streams.
  }, []);

  // ── Shared history → display conversion (reused by session load AND live snapshot) ──
  function sessionMessagesToDisplay(msgs: SessionMessage[], sourceOffset = 0): Message[] {
    const loaded: Message[] = [];
    // Running session-level todo list across turns.
    // Baseline is the last full plan; subsequent actions fold over it.
    let sessionTodoList: TodoItem[] = [];
    // 未完成清单跨大轮保留。只有全部完成时才贴到当前最后一条助手消息，然后清空，下一轮从空清单开始。
    const closeCompletedTurnTodos = () => {
      const list = sessionTodoList;
      const isAllDone = list.length > 0 && list.every((t) => t.status === 'completed');
      if (!isAllDone) return;
      sessionTodoList = [];
      for (let i = loaded.length - 1; i >= 0; i--) {
        if (loaded[i]!.role !== 'assistant') continue;
        loaded[i] = {
          ...loaded[i]!,
          parts: withTrailingTodoList(loaded[i]!.parts, list),
        };
        break;
      }
    };
    let userTurnOrdinal = 0;
    for (const [rawIndex, msg] of msgs.entries()) {
      if (msg.role === 'user') {
        if (!msg.synthetic && !isInternalHistoryUserMessage(msg.content ?? '', msg.synthetic)) {
          closeCompletedTurnTodos();
        }
        if (isInternalHistoryUserMessage(msg.content ?? '', msg.synthetic)) continue;
        const visible = stripSteerEnvelopeForDisplay(
          stripInjectedRemindersForDisplay(
            stripVisionAnnotation(msg.content ?? ''),
          ),
        );
        if (!visible && !(msg.images && msg.images.length)) continue;
        const turnNavOrdinal = userTurnOrdinal++;
        loaded.push({
          role: 'user',
          parts: [{ kind: 'text', text: visible }],
          images: msg.images && msg.images.length ? msg.images : undefined,
          ts: msg.created_at,
          sourceIndex: sourceOffset + rawIndex,
          turnNavOrdinal,
          id: msg.id,
        });
      } else if (msg.role === 'assistant') {
        if (isInternalHistoryAssistantMessage(msg)) continue;
        const origin = msg.internal_origin ?? msg.internalOrigin;
        if (origin === 'turn_diagnostic') {
          const text = (msg.content ?? '').trim();
          if (text) {
            loaded.push({
              role: 'assistant',
              parts: [{ kind: 'notice', text }],
              ts: msg.created_at,
              elapsedMs: msg.elapsed_ms,
              id: msg.id,
            });
          }
          continue;
        }
        // Text comes first (the LLM speaks, then calls tools), so the part
        // order for a persisted round is [reasoning?, text, tool, tool, …].
        // 段编号必须与线协议一致（`{轮id}:{段序}:{类型}`，段序「类型变化才 +1」）：
        // 有思考时正文是 2，没思考时正文是 1。补上编号后，回放帧能按 id 精确对号
        // 入座（而不需要拿文本拼接去猜），且压缩/重写历史也不会让路由失效。
        const parts: MsgPart[] = [];
        if (msg.reasoning) {
          parts.push({
            kind: 'reasoning',
            text: msg.reasoning,
            ...(msg.id ? { id: `${msg.id}:1:reasoning` } : {}),
          });
        }
        if (msg.content) {
          parts.push({
            kind: 'text',
            text: msg.content,
            ...(msg.id ? { id: `${msg.id}:${msg.reasoning ? 2 : 1}:text` } : {}),
          });
        }
        for (const tc of msg.tool_calls ?? []) {
          const rawArgs = tc.arguments || tc.display || '';
          // Rebuild parallel subagent panel for `task` (same as live tool_start).
          const subtasks =
            tc.name === 'task' ? subtasksFromTaskArgs(rawArgs) ?? undefined : undefined;
          parts.push({
            kind: 'tool',
            tool: {
              id: tc.id,
              name: tc.name,
              // Keep raw JSON for expand/debug, but UI prefers subtasks panel.
              args: rawArgs,
              status: 'done',
              ...(subtasks ? { subtasks } : {}),
            },
          });
          if (isTodoTool(tc.name)) {
            sessionTodoList = foldTodoToolCall(sessionTodoList, tc.name, rawArgs) ?? [];
          }
        }
        loaded.push({
          role: 'assistant',
          parts,
          ts: msg.created_at,
          elapsedMs: msg.elapsed_ms,
          sourceIndex: sourceOffset + rawIndex,
          id: msg.id,
        });
      } else if (msg.role === 'tool' && msg.tool_result) {
        const result = msg.tool_result;
        // Prefer full `content` over truncated `summary` so history reload still
        // shows multi-line SQL/table output (API always sends both).
        const output =
          (msg.content && msg.content.length > 0 ? msg.content : null) ??
          result.summary ??
          '';
        let todoResult = false;
        outer: for (let i = loaded.length - 1; i >= 0; i--) {
          const m = loaded[i];
          if (m.role !== 'assistant') continue;
          for (const p of m.parts) {
            if (p.kind === 'tool' && p.tool.id === result.call_id) {
              p.tool.output = output;
              p.tool.status = toolResultStatus(result.success, output, p.tool.name);
              todoResult = isTodoTool(p.tool.name);
              // History path: fold `<task id=… state=completed>` into subtasks panel.
              if (p.tool.subtasks && p.tool.subtasks.length > 0) {
                p.tool.subtasks = applySubtaskResultsFromOutput(
                  p.tool.subtasks,
                  output,
                );
              } else if (p.tool.name === 'task') {
                const seeded = subtasksFromTaskArgs(p.tool.args);
                if (seeded) {
                  p.tool.subtasks = applySubtaskResultsFromOutput(
                    seeded,
                    output,
                  );
                }
              }
              break outer;
            }
          }
        }
        if (todoResult) {
          const authoritative = parseTodosFromOutput(output);
          if (authoritative && authoritative.length > 0) {
            sessionTodoList = authoritative;
          }
        }
      }
      // system messages: skip
    }
    closeCompletedTurnTodos();
    return loaded;
  }

  // ── Live SSE adapter: map LiveWireEvent → SSEEvent (for variants that overlap) ──

  function flushHeldDuplicateUser(text: string) {
    const userText = visibleUserText(text) || text;
    const now = Date.now();
    setMessages((prev) => {
      const next = paintUserMessage(prev, userText, now, (base) => {
        const turnIndex = nextTurnNavIndex(base);
        const turnOrdinal = nextTurnNavOrdinal(base);
        rememberTurnOutline(userText, turnIndex, turnOrdinal);
        return {
          role: 'user' as const,
          parts: [{ kind: 'text', text: userText }],
          ts: now,
          sourceIndex: turnIndex,
          turnNavOrdinal: turnOrdinal,
        };
      });
      messagesRef.current = next;
      return next;
    });
  }

  // ── Live event handler ──

  // ── Sync mode removed as obsolete / redundant ──

  // Identity stamping (`withAssistantIdentity`) lives in the projection module so the
  // background-cache path (`applyEventToSessionCache`) and this live path share one contract.

  function appendToLastAssistant(
    content: string,
    opts?: { skipReplayDedup?: boolean; requireReplayDedup?: boolean },
    ids?: { messageId?: string; partId?: string },
  ) {
    const replay = opts?.requireReplayDedup === true && opts?.skipReplayDedup !== true;
    setMessages((prev) => {
      const next = withAssistantIdentity(
        paintAssistantText(prev, content, replay, ids?.messageId, ids?.partId),
        ids?.messageId,
        ids?.partId,
      );
      messagesRef.current = next;
      return next;
    });
  }

  // 命令输出以独立 system 消息追加进转录，与 assistant 消息分离。
  // 若流式 assistant 回复正在进行（busy），把 notice 插到它之前，
  // 确保 appendToLastAssistant 始终以真正的 assistant 气泡为最后一条。
  function pushCommandNotice(text: string) {
    setMessages((prev) => {
      const note: Message = { role: 'system', parts: [{ kind: 'notice', text }], ts: Date.now() };
      const last = prev[prev.length - 1];
      // Keep an in-flight streaming assistant reply as the last element so
      // appendToLastAssistant still targets IT, not this notice.
      if (last && last.role === 'assistant' && busyRef.current) {
        return [...prev.slice(0, -1), note, last];
      }
      return [...prev, note];
    });
  }

  const slashCommandMap = useMemo(() => buildCommandMap(FRONTEND_COMMANDS), []);
  const turnNavItems = useMemo(
    () => {
      if (turnOutline.length > 0) return buildTurnNavItemsFromOutline(turnOutline);
      return buildTurnNavItems(
        messages.map((m) => ({
          role: m.role,
          text: messageText(m),
          sourceIndex: m.sourceIndex,
          turnNavOrdinal: m.turnNavOrdinal,
        })),
        historyOffsetRef.current,
      );
    },
    [turnOutline, messages],
  );
  const [turnNavQuery, setTurnNavQuery] = useState('');
  const filteredTurnNavItems = useMemo(
    () => filterTurnNavItems(turnNavItems, turnNavQuery),
    [turnNavItems, turnNavQuery],
  );
  const [activeTurnId, setActiveTurnIdState] = useState<string | null>(null);
  const activeTurnIdRef = useRef<string | null>(null);
  const turnNavItemsRef = useRef(turnNavItems);
  turnNavItemsRef.current = turnNavItems;
  const turnNavByIndex = useMemo(
    () => new Map(turnNavItems.map((item) => [item.index, item])),
    [turnNavItems],
  );
  const turnNavByOrdinal = useMemo(
    () => new Map(turnNavItems.map((item) => [item.ordinal, item])),
    [turnNavItems],
  );
  const turnNavPinUntilRef = useRef(0);
  const turnNavScrollCleanupRef = useRef<(() => void) | null>(null);

  // Track whether the current workspace has any git repositories (single repo or multi-repo)
  const [hasGitRepos, setHasGitRepos] = useState<boolean>(false);
  const hasGitReposRef = useRef<boolean>(false);

  useEffect(() => {
    let unmounted = false;
    if (!effectiveWorkingDir) {
      setHasGitRepos(false);
      hasGitReposRef.current = false;
      return;
    }
    fetchGitRepos(effectiveWorkingDir)
      .then((res) => {
        if (unmounted) return;
        const hasGit = Array.isArray(res.repos) && res.repos.length > 0;
        setHasGitRepos(hasGit);
        hasGitReposRef.current = hasGit;
      })
      .catch(() => {
        if (!unmounted) {
          setHasGitRepos(false);
          hasGitReposRef.current = false;
        }
      });
    return () => {
      unmounted = true;
    };
  }, [effectiveWorkingDir]);

  // Right Inspector Panel: Multi-tab ('questions' | 'git' | 'terminal' | 'preview'), resizable, collapsible
  const [rightPanelTab, setRightPanelTabState] = useState<'questions' | 'git' | 'terminal' | 'preview'>(() => {
    try {
      const saved = localStorage.getItem('jeikcode:right-panel-tab');
      if (saved === 'git' || saved === 'questions' || saved === 'terminal' || saved === 'preview') return saved;
    } catch {}
    return 'questions';
  });
  const setRightPanelTab = (tab: 'questions' | 'git' | 'terminal' | 'preview') => {
    setRightPanelTabState(tab);
    try {
      localStorage.setItem('jeikcode:right-panel-tab', tab);
    } catch {}
  };

  // 游标眼睛按钮悬停拖拽自动选中与打开
  const [eyeDragOver, setEyeDragOver] = useState(false);
  const handleEyeDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
    setEyeDragOver(true);
    if (rightPanelTab !== 'preview' || rightPanelCollapsed) {
      setRightPanelTab('preview');
      setRightPanelCollapsed(false);
    }
  };
  const handleEyeDragLeave = () => {
    setEyeDragOver(false);
  };
  const handleEyeDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setEyeDragOver(false);
    setRightPanelTab('preview');
    setRightPanelCollapsed(false);
    try {
      const raw = e.dataTransfer?.getData('application/jeikcode-tab');
      const data = raw ? JSON.parse(raw) : (window as any).__jeikcode_dragged_tab;
      const targetPath = data?.filePath || e.dataTransfer?.getData('text/plain');
      if (targetPath) {
        window.dispatchEvent(
          new CustomEvent('jeikcode:preview:open_file', {
            detail: typeof data === 'object' && data?.filePath ? data : { filePath: targetPath },
          }),
        );
        return;
      }
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        for (let i = 0; i < e.dataTransfer.files.length; i++) {
          const file = e.dataTransfer.files[i];
          const p = (file as any).path || file.name;
          if (p) {
            window.dispatchEvent(
              new CustomEvent('jeikcode:preview:open_file', {
                detail: { filePath: p, fileName: file.name },
              }),
            );
          }
        }
      }
    } catch {}
  };

  // 中间主区域拖拽文件支持（彻底杜绝桌面端与浏览器拖动时鼠标出现禁止/被Ban警告）
  const handleMainStageDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
  };
  const handleMainStageDrop = (e: DragEvent) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      const raw = e.dataTransfer?.getData('application/jeikcode-tab');
      const data = raw ? JSON.parse(raw) : (window as any).__jeikcode_dragged_tab;
      const targetPath = data?.filePath || e.dataTransfer?.getData('text/plain');
      if (targetPath && typeof targetPath === 'string' && targetPath.trim()) {
        window.dispatchEvent(new CustomEvent('jeikcode:open_file', { detail: { path: targetPath.trim() } }));
        return;
      }
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        for (let i = 0; i < e.dataTransfer.files.length; i++) {
          const file = e.dataTransfer.files[i];
          const p = (file as any).path || file.name;
          if (p) {
            window.dispatchEvent(new CustomEvent('jeikcode:open_file', { detail: { path: p } }));
          }
        }
      }
    } catch {}
  };

  const [rightPanelCollapsed, setRightPanelCollapsedState] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('jeikcode:right-panel-collapsed');
      if (saved === 'false') return false;
      // 默认收起：用浮动入口打开 Git / 提问历史，避免一进会话就把主栏拆成两列
      return true;
    } catch {}
    return true;
  });
  const setRightPanelCollapsed = (val: boolean) => {
    setRightPanelCollapsedState(val);
    try {
      localStorage.setItem('jeikcode:right-panel-collapsed', String(val));
    } catch {}
  };

  // 监听全局切右侧面板 Tab 事件 (如 AI 画布点击文件链接自动切至 preview 眼睛标签并展开)
  useEffect(() => {
    const handleSwitchRightTab = (e: CustomEvent<string>) => {
      const tab = e.detail;
      if (tab === 'preview' || tab === 'terminal' || tab === 'git' || tab === 'questions') {
        setRightPanelTab(tab as any);
        setRightPanelCollapsed(false);
      }
    };
    window.addEventListener('jeikcode:switch_right_tab', handleSwitchRightTab as EventListener);
    return () => window.removeEventListener('jeikcode:switch_right_tab', handleSwitchRightTab as EventListener);
  }, []);

  const [rightPanelWidth, setRightPanelWidthState] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('jeikcode:right-panel-width');
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (parsed >= 200 && parsed <= 1200) return parsed;
      }
    } catch {}
    return 480;
  });
  const rightPanelWidthRef = useRef(rightPanelWidth);
  rightPanelWidthRef.current = rightPanelWidth;

  // 浮动 Git / 提问入口：自由拖到视口任意位置，记忆 left/top。
  const [widgetPos, setWidgetPos] = useState<{ left: number; top: number }>(() => {
    try {
      const raw = localStorage.getItem('jeikcode:floating-widget-pos');
      if (raw) {
        const parsed = JSON.parse(raw) as { left?: number; top?: number };
        if (Number.isFinite(parsed.left) && Number.isFinite(parsed.top)) {
          return { left: parsed.left as number, top: parsed.top as number };
        }
      }
      const legacyTop = localStorage.getItem('jeikcode:floating-widget-top');
      if (legacyTop) {
        const top = parseInt(legacyTop, 10);
        if (Number.isFinite(top)) {
          const zoom = getPageZoom() || 1.0;
          const left = typeof window !== 'undefined' ? Math.max(8, Math.round(window.innerWidth / zoom) - 52) : 8;
          return { left, top };
        }
      }
    } catch {}
    const zoom = getPageZoom() || 1.0;
    const left = typeof window !== 'undefined' ? Math.max(8, Math.round(window.innerWidth / zoom) - 52) : 8;
    return { left, top: 130 };
  });
  const widgetPosRef = useRef(widgetPos);
  widgetPosRef.current = widgetPos;

  const handleWidgetMouseDown = (e: MouseEvent | TouchEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const point = 'touches' in e ? (e as TouchEvent).touches[0] : (e as MouseEvent);
    if (!point) return;
    const startX = point.clientX;
    const startY = point.clientY;
    const start = widgetPosRef.current;
    const rail = (e.currentTarget as HTMLElement).closest('.draggable-floating-widget') as HTMLElement | null;
    const railW = rail?.offsetWidth ?? 40;
    const railH = rail?.offsetHeight ?? 88;

    const onMove = (moveEv: MouseEvent | TouchEvent) => {
      const cur = 'touches' in moveEv ? (moveEv as TouchEvent).touches[0] : (moveEv as MouseEvent);
      if (!cur) return;
      const zoom = getPageZoom() || 1.0;
      const maxLeft = Math.max(8, Math.round(window.innerWidth / zoom) - railW - 8);
      const maxTop = Math.max(48, Math.round(window.innerHeight / zoom) - railH - 8);
      const left = Math.max(8, Math.min(maxLeft, start.left + (cur.clientX - startX) / zoom));
      const top = Math.max(48, Math.min(maxTop, start.top + (cur.clientY - startY) / zoom));
      setWidgetPos({ left, top });
    };

    const onEnd = () => {
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove as any);
      window.removeEventListener('mouseup', onEnd);
      window.removeEventListener('touchmove', onMove as any);
      window.removeEventListener('touchend', onEnd);
      try {
        localStorage.setItem('jeikcode:floating-widget-pos', JSON.stringify(widgetPosRef.current));
      } catch {}
    };

    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove as any);
    window.addEventListener('mouseup', onEnd);
    window.addEventListener('touchmove', onMove as any, { passive: false });
    window.addEventListener('touchend', onEnd);
  };

  useEffect(() => {
    const clamp = () => {
      const railW = 40;
      const railH = 96;
      const zoom = getPageZoom() || 1.0;
      setWidgetPos((p) => {
        const maxLeft = Math.max(8, Math.round(window.innerWidth / zoom) - railW - 8);
        const maxTop = Math.max(48, Math.round(window.innerHeight / zoom) - railH - 8);
        const left = Math.max(8, Math.min(maxLeft, p.left));
        const top = Math.max(48, Math.min(maxTop, p.top));
        if (left === p.left && top === p.top) return p;
        return { left, top };
      });
    };
    window.addEventListener('resize', clamp);
    window.addEventListener('jeikcode:zoom_change', clamp);
    clamp();
    return () => {
      window.removeEventListener('resize', clamp);
      window.removeEventListener('jeikcode:zoom_change', clamp);
    };
  }, []);

  const setRightPanelWidth = (w: number) => {
    const clamped = Math.max(200, Math.min(1200, Math.round(w)));
    setRightPanelWidthState(clamped);
    rightPanelWidthRef.current = clamped;
  };

  useEffect(() => {
    onRightPanelLayoutChange?.({
      collapsed: rightPanelCollapsed,
      width: rightPanelWidth,
    });
  }, [rightPanelCollapsed, rightPanelWidth, onRightPanelLayoutChange]);

  // Git refresh trigger (incremented when turn finishes, branch switches,
  // or a tool that can change the worktree / index has just finished).
  const [gitRefreshTrigger, setGitRefreshTrigger] = useState(0);
  const scheduleGitRefresh = (immediate = false) => {
    gitStore.scheduleRefresh(effectiveWorkingDir, { immediate });
    setGitRefreshTrigger((n) => n + 1);
  };

  // Auto-refresh Git state whenever turnNavItems length changes or turns complete
  useEffect(() => {
    setGitRefreshTrigger((n) => n + 1);
  }, [turnNavItems.length]);

  const prevLoadingRef = useRef(loading);
  useEffect(() => {
    if (prevLoadingRef.current && !loading) {
      setGitRefreshTrigger((n) => n + 1);
    }
    prevLoadingRef.current = loading;
  }, [loading]);

  const stageRef = useRef<HTMLDivElement>(null);
  const isResizingRef = useRef(false);

  const handleResizerMouseDown = (e: MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isResizingRef.current || !stageRef.current) return;
      const rect = stageRef.current.getBoundingClientRect();
      const newWidth = rect.right - moveEvent.clientX;
      setRightPanelWidth(newWidth);
    };

    const handleMouseUp = () => {
      isResizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      try {
        localStorage.setItem('jeikcode:right-panel-width', String(rightPanelWidthRef.current));
      } catch {}
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const isRightPanelVisible = !rightPanelCollapsed;

  // Open Diff Tabs (VSCode style tabs for inspecting commit file diffs)
  interface OpenDiffTab {
    id: string; // `${commit.short_hash}:${file.path}`
    commitHash: string;
    commitShortHash: string;
    commitMessage: string;
    filePath: string;
    fileName: string;
    fileStatus: string;
    diffText: string;
    loading: boolean;
  }

  const [internalDiffTabs, setInternalDiffTabs] = useState<OpenDiffTab[]>([]);
  const diffTabs = externalDiffTabs ?? internalDiffTabs;
  const setDiffTabs = externalSetDiffTabs ?? setInternalDiffTabs;

  const [internalActiveMainTabId, setInternalActiveMainTabId] = useState<string>('chat');
  const activeMainTabId = externalActiveMainTabId ?? internalActiveMainTabId;
  useEffect(() => { timelineFollow.changed(); }, [activeMainTabId, timelineFollow]);
  const setActiveMainTabId = externalSetActiveMainTabId ?? setInternalActiveMainTabId;

  const handleOpenFileDiff = async (commit: GitCommitItem, file: GitCommitFile, repoRoot?: string) => {
    const projectRoot = effectiveWorkingDir || cwd || '';
    const fullRelativePath = getRelativePathToProject(file.path, repoRoot, projectRoot);
    const tabId = `${commit.short_hash}:${fullRelativePath}`;
    const targetCwd = repoRoot || cwd;
    const existing = diffTabs.find((t) => t.id === tabId);
    if (existing) {
      setActiveMainTabId(tabId);
      return;
    }

    const fileName = file.path.split('/').pop() || file.path;
    const newTab: OpenDiffTab = {
      id: tabId,
      commitHash: commit.hash,
      commitShortHash: commit.short_hash,
      commitMessage: commit.message,
      filePath: fullRelativePath,
      fileName,
      fileStatus: file.status,
      diffText: '',
      loading: true,
    };

    setDiffTabs((prev: OpenDiffTab[]) => [...prev, newTab]);
    setActiveMainTabId(tabId);

    try {
      const res = await fetchGitFileDiff(commit.hash, file.path, targetCwd);
      setDiffTabs((prev: OpenDiffTab[]) =>
        prev.map((t: OpenDiffTab) => (t.id === tabId ? { ...t, diffText: res.diff, loading: false } : t))
      );
    } catch (err: any) {
      setDiffTabs((prev: OpenDiffTab[]) =>
        prev.map((t: OpenDiffTab) =>
          t.id === tabId ? { ...t, diffText: `Error: ${err?.message || 'Failed to load diff'}`, loading: false } : t
        )
      );
    }
  };

  const handleOpenWorkingDiff = async (file: GitStatusItem, staged: boolean, repoRoot?: string) => {
    const projectRoot = effectiveWorkingDir || cwd || '';
    const fullRelativePath = getRelativePathToProject(file.path, repoRoot, projectRoot);
    const tabId = `working:${staged ? 'staged' : 'unstaged'}:${fullRelativePath}`;
    const targetCwd = repoRoot || cwd;
    const existing = diffTabs.find((t) => t.id === tabId);
    if (existing) {
      setActiveMainTabId(tabId);
      return;
    }

    const fileName = file.path.split('/').pop() || file.path;
    const newTab: OpenDiffTab = {
      id: tabId,
      commitHash: staged ? 'STAGED' : 'WORKING',
      commitShortHash: staged ? 'Staged' : 'Working Tree',
      commitMessage: staged ? t('git.stagedChanges') : t('git.workingTree'),
      filePath: fullRelativePath,
      fileName,
      fileStatus: file.status === '?' ? 'U' : file.status,
      diffText: '',
      loading: true,
    };

    setDiffTabs((prev: OpenDiffTab[]) => [...prev, newTab]);
    setActiveMainTabId(tabId);

    try {
      const res = await fetchGitWorkingDiff(file.path, staged, targetCwd);
      setDiffTabs((prev: OpenDiffTab[]) =>
        prev.map((t: OpenDiffTab) => (t.id === tabId ? { ...t, diffText: res.diff, loading: false } : t))
      );
    } catch (err: any) {
      setDiffTabs((prev: OpenDiffTab[]) =>
        prev.map((t: OpenDiffTab) =>
          t.id === tabId ? { ...t, diffText: `Error: ${err?.message || 'Failed to load diff'}`, loading: false } : t
        )
      );
    }
  };

  const handleCloseDiffTab = (tabId: string) => {
    setDiffTabs((prev: OpenDiffTab[]) => {
      const next = prev.filter((t: OpenDiffTab) => t.id !== tabId);
      if (activeMainTabId === tabId) {
        if (next.length > 0) {
          setActiveMainTabId(next[next.length - 1]!.id);
        } else {
          setActiveMainTabId('chat');
        }
      }
      return next;
    });
  };
  function setActiveTurnId(id: string | null) {
    activeTurnIdRef.current = id;
    setActiveTurnIdState(id);
  }
  function syncTurnNavFromScroll() {
    if (Date.now() < turnNavPinUntilRef.current) return;
    const root = scrollRef.current;
    const items = turnNavItemsRef.current;
    if (!root || items.length === 0) return;
    const rootRect = root.getBoundingClientRect();
    const next = resolveActiveTurnId(
      items,
      (id) => {
        const el = root.querySelector(`[data-turn-nav="${id}"]`);
        if (!el) return undefined;
        return el.getBoundingClientRect().top - rootRect.top + root.scrollTop;
      },
      { scrollTop: root.scrollTop, clientHeight: root.clientHeight, scrollHeight: root.scrollHeight },
    );
    if (next && next !== activeTurnIdRef.current) setActiveTurnId(next);
  }
  function rememberTurnOutline(text: string, index: number, ordinal: number) {
    const clean = stripSteerEnvelopeForDisplay(stripInjectedRemindersForDisplay(text));
    const compact = compactTurnNavText(clean);
    if (!compact) return;
    setTurnOutline((prev) => {
      if (
        prev.some(
          (item, position) =>
            (item.ordinal ?? position) === ordinal ||
            item.index === index ||
            (position === prev.length - 1 && item.text.trim() === compact.trim()),
        )
      ) {
        return prev;
      }
      return [...prev, { ordinal, index, text: compact }].sort(
        (a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0),
      );
    });
  }

  function nextTurnNavIndex(current: Message[] = messagesRef.current): number {
    let next = historyTotalRef.current;
    for (const message of current) {
      if (message.sourceIndex != null) next = Math.max(next, message.sourceIndex + 1);
    }
    for (const item of turnNavItemsRef.current) next = Math.max(next, item.index + 1);
    return next;
  }

  function nextTurnNavOrdinal(current: Message[] = messagesRef.current): number {
    let next = 0;
    for (const message of current) {
      if (message.turnNavOrdinal != null) {
        next = Math.max(next, message.turnNavOrdinal + 1);
      }
    }
    for (const item of turnNavItemsRef.current) next = Math.max(next, item.ordinal + 1);
    return next;
  }

  function foldSteeredInputs(
    inputs: { text: string; images?: ImageData[]; message_id?: string }[],
    clientInputIds?: Array<string | null>,
    targetSessionId?: string,
  ) {
    const steeredInputs = (inputs ?? []).map((input) => ({
      text: stripSteerEnvelopeForDisplay(input.text || ''),
      images: input.images ?? [],
      // 内核回传的落盘消息 id（优先于本地 client id，让 id 收敛不依赖文本启发）
      messageId: input.message_id,
    }));
    if (steeredInputs.length === 0) return;

    const sid = targetSessionId || activeIdRef.current;
    const isCurrentView = !!sid && activeIdRef.current === sid;

    // 1. 从排队消息 queued 中移除已被内核 fold 的转向消息，并暂存其携带的多模态原图
    const matchedQueuedItems: (QueuedMessage | undefined)[] = [];
    const updateQueuedList = (prevQueued: QueuedMessage[]): QueuedMessage[] => {
      let nextQueued = prevQueued.slice();
      for (let i = 0; i < steeredInputs.length; i++) {
        const s = steeredInputs[i];
        const clean = s.text.trim();
        const cid = clientInputIds?.[i];
        // 优先按 client_input_id 精确剔除（Phase 4），文本匹配仅作兜底。
        // 多卡/重复文本/纯图片时不再"任选一张"错配。
        let matchIdx = cid ? nextQueued.findIndex((q) => q.clientInputId === cid) : -1;
        if (matchIdx < 0) matchIdx = nextQueued.findIndex((q) => q.text.trim() === clean);
        if (matchIdx >= 0) {
          matchedQueuedItems.push(nextQueued[matchIdx]);
          nextQueued.splice(matchIdx, 1);
        } else {
          matchedQueuedItems.push(undefined);
        }
      }
      return nextQueued;
    };

    if (sid) {
      updateQueuedForSession(sid, updateQueuedList);
    }
    if (isCurrentView) {
      setQueued(updateQueuedList);
    }

    // 2. 将转向消息作为真实普通用户消息发送并追加到会话中，并在其后紧跟新的 assistant 占位
    const foldIntoMessageList = (prev: Message[]): Message[] => {
      let next = prev.slice();
      const now = Date.now();
      for (let i = 0; i < steeredInputs.length; i++) {
        const s = steeredInputs[i];
        let cleanText = s.text.trim();
        const matchedItem = matchedQueuedItems[i];
        // 优先保留多模态原图（避免纯文本模型经过 VL 预处理后丢失图片实体展示）
        const resolvedImages = (s.images && s.images.length > 0)
          ? s.images
          : (matchedItem?.images && matchedItem.images.length > 0)
            ? matchedItem.images
            : undefined;

        // 若为纯图片转向，剥离占位文案，直接以纯图片气泡展示
        if (cleanText === '（用户附加了新的图片）' && resolvedImages && resolvedImages.length > 0) {
          cleanText = '';
        }

        if (!cleanText && (!resolvedImages || resolvedImages.length === 0)) continue;

        const alreadyPresent = next.some(
          (m) => m.role === 'user' && m.parts?.some((p) => p.kind === 'text' && (p.text.trim() === cleanText || userTextsMatch(p.text, cleanText)))
        );
        if (alreadyPresent) {
          // 乐观气泡已存在（本地发送时已画）：清 pending 标记 + 采纳落盘身份，
          // 让后续刷新/切换/回放按 id 收敛，而非回退文本启发。
          const storedId = s.messageId;
          next = next.map((m) => {
            const isMatch =
              m.role === 'user' &&
              m.parts?.some(
                (p) => p.kind === 'text' && (p.text.trim() === cleanText || userTextsMatch(p.text, cleanText)),
              );
            if (isMatch) {
              const patched: Message = { ...m, pendingSteerId: undefined };
              // 唯一性守卫：同一个落盘 id 绝不贴到第二条消息上。
              if (storedId && !next.some((other) => other.id === storedId)) {
                patched.id = storedId;
              }
              return patched;
            }
            return m.pendingSteerId ? { ...m, pendingSteerId: undefined } : m;
          });
          continue;
        }

        const turnIndex = nextTurnNavIndex(next);
        const turnOrdinal = nextTurnNavOrdinal(next);
        if (isCurrentView) {
          rememberTurnOutline(cleanText || '[图片]', turnIndex, turnOrdinal);
        }

        next.push({
          role: 'user',
          parts: [{ kind: 'text', text: cleanText }],
          images: resolvedImages,
          ts: now,
          sourceIndex: turnIndex,
          turnNavOrdinal: turnOrdinal,
          // 内核身份优先；旧 daemon 无此字段时退回本地 client id。
          id: s.messageId ?? clientInputIds?.[i] ?? undefined,
        });
        next.push({
          role: 'assistant',
          parts: [],
          sourceIndex: turnIndex + 1,
        });
      }
      return next;
    };

    if (isCurrentView) {
      setMessages((prev) => {
        const next = foldIntoMessageList(prev);
        messagesRef.current = next;
        if (sid) {
          messageCacheRef.current.set(sid, next);
        }
        return next;
      });
    } else if (sid) {
      const msgs = messageCacheRef.current.get(sid) ?? [];
      if (msgs.length > 0) {
        const next = foldIntoMessageList(msgs);
        messageCacheRef.current.set(sid, next);
      }
    }

    // 3. 消费 pendingSteers
    if (sid) {
      const curSteers = pendingSteersBySessionRef.current.get(sid) ?? [];
      const nextSteers = acknowledgeLiveSteers(curSteers, steeredInputs, clientInputIds);
      if (nextSteers.length > 0) {
        pendingSteersBySessionRef.current.set(sid, nextSteers);
        setStoredSteers(sid, nextSteers);
      } else {
        pendingSteersBySessionRef.current.delete(sid);
        setStoredSteers(sid, []);
      }
    }
    if (isCurrentView) {
      setPendingSteers((pending) => acknowledgeLiveSteers(pending, steeredInputs, clientInputIds));
    }
  }

  function cancelTurnNavScroll() {
    const cleanup = turnNavScrollCleanupRef.current;
    turnNavScrollCleanupRef.current = null;
    cleanup?.();
  }

  /** Scroll only the transcript container. `scrollIntoView` also scrolls outer
   * ancestors and races the bottom-follow observer during session replacement. */
  function scrollToTurnId(id: string, behavior: ScrollBehavior = 'smooth'): boolean {
    const root = scrollRef.current;
    if (!root) return false;
    let target = root.querySelector(`[data-turn-nav="${id}"]`);
    if (!target) {
      target = root.querySelector(`#${id}`);
    }
    if (!target) {
      // 智能容错：若热重载中序号丢失，尝试从大纲中找到对应文本模糊命中 user 气泡
      const item = turnNavItemsRef.current.find((it) => it.id === id);
      if (item && item.text) {
        const clean = item.text.slice(0, 15).toLowerCase();
        const bubbles = root.querySelectorAll('.user-message-wrapper');
        for (const bubble of bubbles) {
          if (bubble.textContent?.toLowerCase().includes(clean)) {
            target = bubble;
            break;
          }
        }
      }
    }
    if (!(target instanceof HTMLElement)) return false;

    cancelTurnNavScroll();
    timelineFollow.pause();
    const top = turnNavScrollTop(
      root.scrollTop,
      root.getBoundingClientRect().top,
      target.getBoundingClientRect().top,
    );
    root.scrollTo({ top, behavior });

    // 醒目视觉高亮反馈，让用户明确感知跳到了目标
    target.classList.add('is-active-search-match');
    window.setTimeout(() => target?.classList.remove('is-active-search-match'), 2000);

    let timer: number | null = null;
    const cleanup = () => {
      root.removeEventListener('scrollend', finish);
      if (timer != null) window.clearTimeout(timer);
      if (turnNavScrollCleanupRef.current === cleanup) {
        turnNavScrollCleanupRef.current = null;
      }
    };
    const finish = () => {
      cleanup();
      turnNavPinUntilRef.current = 0;
      syncTurnNavFromScroll();
    };
    root.addEventListener('scrollend', finish, { once: true });
    timer = window.setTimeout(finish, 1600);
    turnNavScrollCleanupRef.current = cleanup;
    return true;
  }

  async function ensureHistoryIncludes(index: number): Promise<boolean> {
    const projectHash = activeSession?.project_hash;
    const sid = sessionId;
    if (!projectHash || !sid) return false;
    const generation = sessionGenerationRef.current;
    const prevOffset = historyOffsetRef.current;
    if (index >= prevOffset) return true;
    setLoadingOlder(true);
    try {
      const detail = await getSession(projectHash, sid, {
        offset: index,
        limit: prevOffset - index,
      });
      if (
        activeIdRef.current !== sid ||
        sessionGenerationRef.current !== generation
      ) return false;
      const older = sessionMessagesToDisplay(detail.messages, detail.offset ?? index);
      const newOffset = detail.offset ?? index;
      const newTotal = detail.message_count ?? historyTotalRef.current;
      const olderExists = newOffset > 0;
      historyOffsetRef.current = newOffset;
      historyTotalRef.current = newTotal;
      setHasOlder(olderExists);
      historyOffsetBySessionRef.current.set(sid, newOffset);
      historyTotalBySessionRef.current.set(sid, newTotal);
      hasOlderBySessionRef.current.set(sid, olderExists);
      if (detail.turns && detail.turns.length > 0) setTurnOutline(detail.turns);
      setMessages((prev) => {
        const next = [...older, ...prev];
        messagesRef.current = next;
        messageCacheRef.current.set(sid, next);
        return next;
      });
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      return true;
    } catch {
      return false;
    } finally {
      if (
        activeIdRef.current === sid &&
        sessionGenerationRef.current === generation
      ) setLoadingOlder(false);
    }
  }

  async function jumpToTurn(id: string) {
    const item = turnNavItemsRef.current.find((candidate) => candidate.id === id);
    if (!item) return;
    const index = item.index;
    const sid = activeIdRef.current;
    const generation = sessionGenerationRef.current;
    pendingJumpIdRef.current = id;
    setActiveTurnId(id);
    turnNavPinUntilRef.current = Date.now() + 1800;
    if (index < historyOffsetRef.current) {
      await ensureHistoryIncludes(index);
    }
    if (
      activeIdRef.current !== sid ||
      sessionGenerationRef.current !== generation
    ) {
      if (pendingJumpIdRef.current === id) pendingJumpIdRef.current = null;
      return;
    }
    // The messages effect may already have completed the pending jump after a
    // history prepend. Otherwise try the current DOM and then bounded retries.
    if (pendingJumpIdRef.current === id && scrollToTurnId(id)) {
      pendingJumpIdRef.current = null;
      return;
    }
    for (const ms of [50, 150, 300]) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, ms));
      if (
        activeIdRef.current !== sid ||
        sessionGenerationRef.current !== generation ||
        pendingJumpIdRef.current !== id
      ) return;
      if (scrollToTurnId(id)) {
        pendingJumpIdRef.current = null;
        return;
      }
    }
  }
  // 提问导航取消与滚动同步由主 session-switch effect 维护大纲生命周期。
  useEffect(() => () => cancelTurnNavScroll(), []);
  useEffect(() => {
    const id = requestAnimationFrame(() => syncTurnNavFromScroll());
    return () => cancelAnimationFrame(id);
  }, [turnNavItems]);

  // After older messages load (or any messages change), scroll to the pending
  // turn-jump target that couldn't be resolved immediately.
  useEffect(() => {
    const id = pendingJumpIdRef.current;
    if (id == null) return;
    if (!scrollToTurnId(id)) return;
    pendingJumpIdRef.current = null;
  }, [messages]);

  // Reload one session's transcript from disk into the view, guarded against a
  // session switch racing the async fetch. Mirrors the session-load effect's activeIdRef guard.
  async function loadOlderMessages() {
    const projectHash = activeSession?.project_hash;
    const id = sessionId;
    if (!projectHash || !id || loadingOlder || historyOffsetRef.current <= 0) return;
    const generation = sessionGenerationRef.current;
    const prevOffset = historyOffsetRef.current;
    const page = Math.min(HISTORY_PAGE, prevOffset);
    const nextOffset = prevOffset - page;
    setLoadingOlder(true);
    const root = scrollRef.current;
    const prevHeight = root?.scrollHeight ?? 0;
    const prevTop = root?.scrollTop ?? 0;
    try {
      const detail = await getSession(projectHash, id, { offset: nextOffset, limit: page });
      if (
        activeIdRef.current !== id ||
        sessionGenerationRef.current !== generation
      ) return;
      const older = sessionMessagesToDisplay(detail.messages, detail.offset ?? nextOffset);
      const newOffset = detail.offset ?? nextOffset;
      const newTotal = detail.message_count ?? historyTotalRef.current;
      const olderExists = newOffset > 0;
      historyOffsetRef.current = newOffset;
      historyTotalRef.current = newTotal;
      setHasOlder(olderExists);
      historyOffsetBySessionRef.current.set(id, newOffset);
      historyTotalBySessionRef.current.set(id, newTotal);
      hasOlderBySessionRef.current.set(id, olderExists);
      if (detail.turns && detail.turns.length > 0) setTurnOutline(detail.turns);
      setMessages((prev) => {
        const next = [...older, ...prev];
        messagesRef.current = next;
        messageCacheRef.current.set(id, next);
        if (projectHash) {
          void saveSessionCache(
            projectHash,
            id,
            next,
            undefined,
            undefined,
            detail.turns,
            undefined,
            newOffset,
            newTotal,
          );
        }
        return next;
      });
      requestAnimationFrame(() => {
        if (
          activeIdRef.current !== id ||
          sessionGenerationRef.current !== generation
        ) return;
        const el = scrollRef.current;
        if (!el) return;
        el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
      });
    } catch {
      if (
        activeIdRef.current === id &&
        sessionGenerationRef.current === generation
      ) historyOffsetRef.current = prevOffset;
    } finally {
      if (
        activeIdRef.current === id &&
        sessionGenerationRef.current === generation
      ) setLoadingOlder(false);
    }
  }

  async function reloadSessionTranscript(id: string) {
    const projectHash = activeSession?.project_hash;
    if (!projectHash) return;
    const generation = sessionGenerationRef.current;
    try {
      const detail = await getSession(projectHash, id, {
        offset: historyOffsetRef.current,
      });
      if (
        activeIdRef.current === id &&
        sessionGenerationRef.current === generation
      ) {
        const newTotal = detail.message_count ?? detail.messages.length;
        const newOffset = detail.offset ?? historyOffsetRef.current;
        const olderExists = (detail.offset ?? 0) > 0;
        historyTotalRef.current = newTotal;
        historyOffsetRef.current = newOffset;
        setHasOlder(olderExists);
        historyOffsetBySessionRef.current.set(id, newOffset);
        historyTotalBySessionRef.current.set(id, newTotal);
        hasOlderBySessionRef.current.set(id, olderExists);
        const reloaded = sessionMessagesToDisplay(
          detail.messages,
          detail.offset ?? historyOffsetRef.current,
        );
        messagesRef.current = reloaded;
        messageCacheRef.current.set(id, reloaded);
        setMessages(reloaded);
        writeLiveTodo(id, reduceLiveTodo(null, { type: 'hydrate', items: detail.todos ?? [] }));
        seedAppliedTodoIds(id, todoCallIdsFromMessages(reloaded));
      }
    } catch { /* refresh failure is non-fatal; the notice still gives feedback */ }
  }

  // ── Shared mode / provider switch helpers ──────────────────────────────────
  // Defined in render scope (not memoized) so they always close over the latest
  // modeState / sync. Both call sites — ModeSelector.onChange / slashHandlers
  // and ModelSelector.onChange / slashHandlers — call these directly.

  /** Initiate a mode switch. onConfirmed is called with the server-confirmed
   *  mode after the backend round-trip completes (used by slash commands to
   *  emit a notice with the ACTUAL confirmed mode, not the requested one). */
  function switchMode(m: ApprovalMode, onConfirmed?: (confirmed: ApprovalMode) => void) {
    if (modeState.pendingMode) return;
    const nextState = beginModeSwitch(modeState, m);
    if (nextState === modeState) return;
    setModeState(nextState);
    if (!protocolSessionRef.current) nativeModeRef.current = m;
    if (m === 'bypass') {
      setLivePending(null);
      onPermissionResolved?.(null);
    }
    void postLiveMode(m)
      .then((confirmed) => {
        setModeState((cur) => completeModeSwitch(cur, confirmed));
        onConfirmed?.(confirmed);
        if (confirmed === 'bypass') {
          setLivePending(null);
          onPermissionResolved?.(null);
        }
        // Backend may reject (runtime busy) and echo the previous mode — surface that.
        if (confirmed !== m) {
          pushCommandNotice(
            t('cmd.mode.rejected', { requested: m, confirmed }),
          );
        }
      })
      .catch(() => {
        setModeState((cur) => failModeSwitch(cur));
        pushCommandNotice(t('cmd.mode.failed'));
      });
  }

  /** Switch the active provider and notify the backend immediately so default model persists and syncs. */
  function switchProvider(name: string) {
    providerPinnedRef.current = true;
    providerCacheRef.current.set(providerCacheKey(sessionId), name);
    const previous = provider;
    setProvider(name);
    void postLiveProvider(name, sessionId).then((res) => {
      if (res.ok) return;
      if (res.activeTurn) {
        pushCommandNotice(t('cmd.model.deferred'));
        return;
      }
      setProvider(previous);
      providerPinnedRef.current = false;
      if (previous) {
        providerCacheRef.current.set(providerCacheKey(sessionId), previous);
      } else {
        providerCacheRef.current.delete(providerCacheKey(sessionId));
      }
      pushCommandNotice(res.error ?? t('cmd.model.syncBusy'));
    }).catch((error) => {
      setProvider(previous);
      providerPinnedRef.current = false;
      if (previous) {
        providerCacheRef.current.set(providerCacheKey(sessionId), previous);
      } else {
        providerCacheRef.current.delete(providerCacheKey(sessionId));
      }
      setHistoryHint(t('chat.connError', { msg: String(error) }));
    });
  }

  const slashHandlers: SlashHandlers = useMemo(
    () => ({
      // setMode: 委托给 switchMode；notice 用后端确认的模式（非请求的模式）。
      setMode: (m) => {
        switchMode(m, (confirmed) => pushCommandNotice(t('cmd.mode.done', { mode: confirmed })));
      },
      // openModelPicker: ModelSelector 是自包含组件，无法从外部以编程方式打开。
      openModelPicker: () => { pushCommandNotice(t('cmd.model.openHint')); },
      // setProvider: 委托给 switchProvider（实时同步 + 本地状态）。
      setProvider: (name) => {
        switchProvider(name);
      },
      // changeDir: 直接调 api.ts 的 changeDir（POST /cd），并把新目录上报给 App。
      changeDir: async (path) => {
        const res = await changeDir(path);
        if (res.success) {
          onCwdChanged?.(res.current_dir);
          pushCommandNotice(t('cmd.cd.done', { dir: res.current_dir }));
        } else {
          pushCommandNotice(res.message);
        }
      },
      // openSessionSidebar: 侧栏开关状态在 App，Chat 无此 prop。
      openSessionSidebar: () => { onOpenSidebar?.(); },
      openNewSession: () => { onNewSession?.(); },
      clearScreen: () => { pushCommandNotice(t('cmd.clear.desc')); },
      // reloadConfig: POST /config/reload（服务端同时重挂 MCP / skills）。
      reloadConfig: async () => {
        await postConfigReload();
        pushCommandNotice(t('cmd.reload.done'));
      },
      mcpCommand: async (arg) => {
        const sub = arg.trim().toLowerCase();
        const tt = t as (k: string, p?: Record<string, string | number>) => string;
        try {
          if (sub === 'reload' || sub === 'refresh') {
            await postMcpReload();
            const status = await getMcpStatus();
            pushCommandNotice(`${t('cmd.mcp.reload.done')}\n${formatMcpStatusText(status.servers, status.blocked, tt)}`);
            return;
          }
          if (sub === 'trust') {
            const result = await postLiveMcpTrust();
            if (result.ok) {
              try { await postMcpReload(); } catch { /* older daemon */ }
              const status = await getMcpStatus();
              pushCommandNotice(`${t('cmd.mcp.trust.ok')}\n${formatMcpStatusText(status.servers, status.blocked, tt)}`);
            } else {
              pushCommandNotice(t('cmd.mcp.trust.failed', { error: result.error ?? 'trust failed' }));
            }
            return;
          }
          const status = await getMcpStatus();
          pushCommandNotice(formatMcpStatusText(status.servers, status.blocked, tt));
        } catch (e) {
          pushCommandNotice(t('cmd.mcp.reload.failed', { error: e instanceof Error ? e.message : String(e) }));
        }
      },
      openSlashSkillsMenu: () => {
        // Open a pure SKILLS browser (not the full '/' command list — that's what
        // made running /skills look like it "reset to /"). Input stays '/', but the
        // menu shows only skills; typing anything drops back to normal filtering.
        // Trigger the skills fetch if it hasn't been loaded yet.
        setInput('/');
        setSlashQuery('');
        setSlashIndex(0);
        setSlashSkillsOnly(true);
        if (slashSkills === null && !slashLoading) {
          setSlashLoading(true);
          getSkills()
            .then(setSlashSkills)
            .catch(() => setSlashSkills([]))
            .finally(() => setSlashLoading(false));
        }
        setSlashOpen(true);
        requestAnimationFrame(() => {
          const ta = textareaRef.current;
          if (!ta) return;
          ta.focus();
          ta.setSelectionRange(1, 1);
          ta.style.height = 'auto';
          ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
        });
      },
      notice: (text) => pushCommandNotice(text),
      submitPrompt: (text) => {
        if (busyRef.current) {
          setQueued((q) => [
            ...q,
            {
              id: queueIdRef.current++,
              text,
              approvalMode: modeState.confirmedMode,
              kind: 'queue' as const,
            },
          ]);
          return;
        }
        return deliver(text, [], modeState.confirmedMode).then(() => undefined);
      },
      execServerCommand: async (command, arg) => {
        const SESSION_MUTATING = new Set(['undo', 'compact']);
        if (SESSION_MUTATING.has(command)) {
          if (busyRef.current) { pushCommandNotice(t('cmd.session.busy')); return; }
          if (attachedToLiveRuntime()) {
            // sync 模式：compact 派发到共享实时运行时（结果经 /live 的 Warning 事件
            // 渲染压缩标记）；undo 暂无实时路径，维持拒绝。
            if (command === 'compact') {
              // Keep a handle on the pending notice so a failed dispatch can retract
              // it — otherwise a stale "Compacting…" line lingers next to the error.
              const pendingNote: Message = {
                role: 'system',
                parts: [{ kind: 'notice', text: t('cmd.compact.pending') }],
                ts: Date.now(),
              };
              setMessages((prev) => [...prev, pendingNote]);
              // Gate sendMessage while the dispatch is in flight, mirroring the
              // non-sync path (compactingRef guards the submit handler).
              compactingRef.current = true;
              try {
                const { accepted } = await postLiveCompact();
                if (!accepted) pushCommandNotice(t('cmd.compact.syncNoRuntime'));
              } catch (e) {
                setMessages((prev) => prev.filter((m) => m !== pendingNote));
                pushCommandNotice(t('chat.connError', { msg: e instanceof Error ? e.message : String(e) }));
              } finally {
                compactingRef.current = false;
              }
              return;
            }
            pushCommandNotice(t('cmd.session.syncUnsupported'));
            return;
          }
        }
        if (command === 'compact') pushCommandNotice(t('cmd.compact.pending'));
        const isCompact = command === 'compact';
        if (isCompact) compactingRef.current = true;
        try {
          let res: CommandResult;
          try {
            res = await postCommand({
              command,
              arg,
              session_id: sessionId ?? undefined,
              working_dir: effectiveWorkingDir ?? undefined,
              project_hash: activeSession?.project_hash ?? undefined,
              provider: provider ?? undefined,
            });
          } catch (e) {
            pushCommandNotice(t('chat.connError', { msg: e instanceof Error ? e.message : String(e) }));
            return;
          }
          if (res.kind === 'error') { pushCommandNotice(res.message); return; }
          if (res.kind === 'undo') {
            if (res.undone > 0 && sessionId) await reloadSessionTranscript(sessionId);
            pushCommandNotice(res.undone > 0 ? t('cmd.undo.done', { n: res.undone }) : t('cmd.undo.none'));
            return;
          }
          if (res.kind === 'remember') { pushCommandNotice(t('cmd.remember.done', { scope: res.scope })); return; }
          if (res.kind === 'forget') { pushCommandNotice(t('cmd.forget.done', { n: res.removed.length })); return; }
          if (res.kind === 'memory') {
            const lines = [...res.global.map((e) => `[global] ${e}`), ...res.project.map((e) => `[project] ${e}`)];
            pushCommandNotice(lines.length ? `${t('cmd.memory.header')}\n${lines.join('\n')}` : t('cmd.memory.empty'));
            return;
          }
          if (res.kind === 'compact') {
            if (res.applied) {
              if (sessionId) await reloadSessionTranscript(sessionId);
              pushCommandNotice(t('cmd.compact.done', { n: res.removed_messages, before: res.before_tokens, after: res.after_tokens }));
              tokenCacheRef.current = resetTokenCacheState(res.after_tokens);
              setTokens({ prompt: res.after_tokens, completion: 0, total: res.after_tokens, cached: 0, cached_estimated: false });
            } else {
              pushCommandNotice(t('cmd.compact.none'));
            }
            return;
          }
          if (res.kind === 'context') {
            pushCommandNotice(
              t('cmd.context.body', {
                used: res.used_tokens, msgs: res.total_messages,
                pct: Math.round(res.utilization * 100),
                window: res.ctx_window, name: res.ctx_name,
              })
            );
            tokenCacheRef.current = resetTokenCacheState(res.used_tokens);
            setTokens({ prompt: res.used_tokens, completion: 0, total: res.used_tokens, cached: 0, cached_estimated: false });
            return;
          }
          if (res.kind === 'whoami') {
            pushCommandNotice(res.logged_in
              ? t('cmd.whoami.body', { name: res.name ?? res.username ?? '', user: res.username ?? '', email: res.email ?? '—' })
              : t('cmd.whoami.none'));
            return;
          }
          if (res.kind === 'status') {
            pushCommandNotice(res.text);
            return;
          }
          if (res.kind === 'config') { pushCommandNotice(t('cmd.config.body', { path: res.path, provider: res.provider || '—' })); return; }
          if (res.kind === 'diff') { pushCommandNotice(res.stat.trim() ? res.stat : t('cmd.diff.clean')); return; }
          if (res.kind === 'cost') { pushCommandNotice(t('cmd.cost.body', { tokens: res.total_tokens, turns: res.turn_count })); return; }
          if (res.kind === 'todo') {
            if (!res.items.length) { pushCommandNotice(t('cmd.todo.empty')); return; }
            const mark = (s: string) => (s === 'completed' ? '[√]' : s === 'in_progress' ? '[~]' : '[ ]');
            pushCommandNotice(`${t('cmd.todo.header')}\n${res.items.map((i) => `${mark(i.status)} ${i.content}`).join('\n')}`);
            return;
          }
        } finally {
          if (isCompact) compactingRef.current = false;
        }
      },
      initProject: () => {
        setConfirmModal({
          open: true,
          title: t('confirm.initTitle'),
          body: t('confirm.initBody'),
          icon: '🗺️',
          danger: false,
          confirmLabel: t('confirm.confirmedBtn'),
          cancelLabel: t('common.cancel'),
          onConfirm: async () => {
            setRightPanelCollapsed(false);
            setRightPanelTab('terminal');
            requestAnimationFrame(() => {
              window.dispatchEvent(
                new CustomEvent('jeikcode:terminal:run_command', {
                  detail: {
                    command: 'jeikcode init --force',
                  },
                })
              );
            });
          },
        });
      },
      t,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, modeState, sync, onCwdChanged, slashSkills, slashLoading, sessionId, cwd, activeSession, provider, messages.length],
  );

  // Append a non-fatal advisory as its OWN notice part (never merged into a text run,
  // never styled as an error). Mirrors appendToLastAssistant's last-assistant guard.
  function pushNoticeToLastAssistant(text: string, messageId?: string) {
    setMessages((prev) => {
      const next = paintAssistantNotice(prev, text, messageId);
      messagesRef.current = next;
      const currentSid = liveSessionIdRef.current ?? sessionId ?? activeIdRef.current;
      if (currentSid) {
        messageCacheRef.current.set(currentSid, next);
      }
      return next;
    });
  }

  function pushRateLimitedToLastAssistant(text: string, messageId?: string) {
    setMessages((prev) => {
      if (prev.length === 0) {
        const next: Message[] = [{ role: 'assistant', parts: [{ kind: 'rate_limited', text }] }];
        messagesRef.current = next;
        return next;
      }
      const last = prev[prev.length - 1];
      let next: Message[];
      if (last.role === 'assistant') {
        const parts: MsgPart[] = [...last.parts, { kind: 'rate_limited', text }];
        next = [...prev.slice(0, -1), { ...last, parts }];
      } else {
        next = [...prev, { role: 'assistant', parts: [{ kind: 'rate_limited', text }] }];
      }
      messagesRef.current = next;
      const currentSid = liveSessionIdRef.current ?? sessionId ?? activeIdRef.current;
      if (currentSid) {
        messageCacheRef.current.set(currentSid, next);
      }
      return next;
    });
  }

  function updateToolInLastAssistant(
    id: string,
    update: Partial<ToolRow>,
  ) {
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      for (let i = prev.length - 1; i >= 0; i--) {
        const m = prev[i];
        if (m.role === 'assistant' && m.parts?.some((p) => p.kind === 'tool' && p.tool?.id === id)) {
          const parts = m.parts.map((p) =>
            p.kind === 'tool' && p.tool?.id === id
              ? { kind: 'tool' as const, tool: { ...p.tool, ...update } }
              : p,
          );
          const next = prev.slice();
          next[i] = { ...m, parts };
          return next;
        }
      }
      return prev;
    });
  }

  function finalizePendingToolsOnCanvas() {
    setMessages((prev) =>
      prev.map((m) =>
        m.role === 'assistant' ? { ...m, parts: finalizeToolsAfterTurn(m.parts) } : m,
      ),
    );
  }

  function closeOpenArtifactFence() {
    if (!artifactOpenRef.current) return;
    artifactOpenRef.current = false;
    const fenceLen = artifactFenceLenRef.current || 3;
    const marker = '`'.repeat(fenceLen);
    appendToLastAssistant('\n' + marker + '\n', { skipReplayDedup: true });
    artifactFenceLenRef.current = 3;
    if (activeIdRef.current) artifactOpenBySessionRef.current.delete(activeIdRef.current);
  }

  function addToolToLastAssistant(tool: ToolRow, messageId?: string) {
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      let next: Message[] = prev;
      // 优先就地更新历史中已存在的 tool（防止 watch 重播旧工具时在末尾重复新建）
      for (let i = prev.length - 1; i >= 0; i--) {
        const m = prev[i];
        if (m.role === 'assistant' && m.parts?.some((p) => p.kind === 'tool' && p.tool?.id === tool.id)) {
          const updated = prev.slice();
          updated[i] = { ...m, parts: upsertToolPart(m.parts, tool) };
          next = updated;
          messagesRef.current = next;
          return next;
        }
      }
      // 管线身份直连：带 message_id 的工具行必须回到它所属的那一轮 assistant 消息。
      // 回合中途的 steer 气泡会把“最后一条”变成用户行；若在 steer 下方另开新消息，
      // 上一回合迟到的工具就会渲染到 steer 之后（错序/重复的根因）。
      const owner = identifiedAssistantIndex(prev, messageId);
      if (owner >= 0) {
        const updated = prev.slice();
        updated[owner] = { ...prev[owner]!, parts: upsertToolPart(prev[owner]!.parts, tool) };
        messagesRef.current = updated;
        return updated;
      }
      // 历史中不存在：新工具。若末尾是 assistant 则追加，若末尾是 user（如 Steer）则安全开启新 assistant。
      // 新行同样要带上管线身份（含同 id 已在别处时的唯一性守卫），否则这一轮此后
      // 无法被重放/增量按 id 定位，只能落到“最后一条 assistant”上（串轮元凶）。
      const last = prev[prev.length - 1];
      if (last && last.role === 'assistant') {
        next = [...prev.slice(0, -1), { ...last, parts: upsertToolPart(last.parts, tool) }];
      } else {
        next = [
          ...prev,
          { role: 'assistant' as const, parts: [{ kind: 'tool' as const, tool }] },
        ];
      }
      next = withAssistantIdentity(next, messageId);
      messagesRef.current = next;
      return next;
    });
  }

  /**
   * 对标 opencode 多会话后台推送体系：
   * 当用户切到其他会话时，本会话的流式读者在后台持续存活并接收事件，
   * 实时将事件（text, reasoning, tool_start, tool_output, tool_result, done）沉淀进对应会话的缓存字典中。
   * 彻底实现：后台任务完成后切回会话，最后一条正文与工具结果 0ms 纯内存即现，无需刷新，绝不丢失！
   */
  function applyEventToSessionCache(targetSid: string, event: SSEEvent) {
    if (event.type === 'steered') {
      foldSteeredInputs(event.inputs ?? [], event.client_input_ids, targetSid);
      return;
    }
    const msgs = messageCacheRef.current.get(targetSid);
    if (!msgs || msgs.length === 0) return;
    if (event.type === 'user_identified') {
      messageCacheRef.current.set(targetSid, bindUserMessageIdentity(msgs, event.message_id));
      return;
    }
    if (event.type === 'text') {
      // 后台缓存与画布共用同一套身份盖章：行上盖住 message_id，后续 watch 重放
      // 才能回到自己那一轮，而不是被当成“新内容”追加到最新 agent 消息里。
      messageCacheRef.current.set(targetSid, paintCachedAssistantDelta(msgs, 'text', event.content, {
        messageId: event.message_id,
        partId: event.part_id,
      }));
      return;
    }
    if (event.type === 'artifact_start') {
      if (event.id?.startsWith('file-')) {
        artifactOpenBySessionRef.current.delete(targetSid);
        return;
      }
      const lang = (event.language ?? '').trim();
      const fenceLen = typeof event.fence_len === 'number' && event.fence_len >= 3 ? event.fence_len : 3;
      const marker = '`'.repeat(fenceLen);
      const fence = (lang ? marker + lang : marker) + '\n';
      const lastMsg = msgs[msgs.length - 1];
      let prefix = '';
      if (lastMsg && lastMsg.role === 'assistant') {
        const lastPart = lastMsg.parts[lastMsg.parts.length - 1];
        if (lastPart && lastPart.kind === 'text' && lastPart.text && !lastPart.text.endsWith('\n')) {
          prefix = '\n';
        }
      }
      messageCacheRef.current.set(targetSid, paintCachedAssistantDelta(msgs, 'text', prefix + fence));
      artifactOpenBySessionRef.current.set(targetSid, fenceLen);
      return;
    }
    if (event.type === 'artifact_content') {
      if (event.id?.startsWith('file-')) return;
      messageCacheRef.current.set(targetSid, paintCachedAssistantDelta(msgs, 'text', event.content));
      return;
    }
    if (event.type === 'artifact_end') {
      if (event.id?.startsWith('file-')) {
        artifactOpenBySessionRef.current.delete(targetSid);
        return;
      }
      const fenceLen = artifactOpenBySessionRef.current.get(targetSid) || 3;
      const marker = '`'.repeat(fenceLen);
      messageCacheRef.current.set(targetSid, paintCachedAssistantDelta(msgs, 'text', '\n' + marker + '\n'));
      artifactOpenBySessionRef.current.delete(targetSid);
      return;
    }
    if (event.type === 'reasoning') {
      messageCacheRef.current.set(targetSid, paintCachedAssistantDelta(msgs, 'reasoning', event.content, {
        messageId: event.message_id,
        partId: event.part_id,
      }));
      return;
    }
    if (event.type === 'warning') {
      messageCacheRef.current.set(
        targetSid,
        paintAssistantNotice(msgs, t('chat.warning', { msg: event.message }), event.message_id)
      );
      return;
    }
    if (event.type === 'user') {
      const created = event.created_at && event.created_at > 0 ? event.created_at : Date.now();
      messageCacheRef.current.set(targetSid, paintUserMessage(msgs, event.content, created, () => ({
        role: 'user',
        parts: [{ kind: 'text', text: visibleUserText(event.content) }],
        ts: created,
      })));
      return;
    }
    if (event.type === 'tool_result' && isTodoTool(event.name)) {
      const fromOutput = parseTodosFromOutput(event.output);
      if (fromOutput && fromOutput.length > 0) {
        writeLiveTodo(
          targetSid,
          reduceLiveTodo(liveTodoDoc(targetSid), { type: 'result', callId: event.id, items: fromOutput }),
        );
      } else if (fromOutput && fromOutput.length === 0) {
        writeLiveTodo(
          targetSid,
          reduceLiveTodo(liveTodoDoc(targetSid), { type: 'clear' }),
        );
      }
    } else if (event.type === 'tool_start' && isTodoTool(event.name)) {
      const argsStr = formatArgs(event.arguments);
      if (argsStr) {
        const appliedIds = appliedTodoIdsFor(targetSid);
        const curTodos = activeTodosBySessionRef.current.get(targetSid) ?? null;
        const nextTodos = foldLiveTodo({
          state: curTodos,
          remembered: curTodos,
          name: event.name,
          args: argsStr,
          callId: event.id,
          appliedIds,
        });
        // 后台会话的折叠同样要落盘幂等键（跨会话重放也不能把清单打回旧状态）。
        persistAppliedTodoIds();
        if (nextTodos && nextTodos.length > 0) {
          writeLiveTodo(
            targetSid,
            reduceLiveTodo(liveTodoDoc(targetSid), { type: 'preview', callId: event.id, items: nextTodos }),
          );
        }
      }
    }

    let next: Message[] = msgs.slice();

    // 针对工具事件（tool_start, tool_output, tool_result）：优先全局按 tool id 就地更新已有卡片，
    // 绝不在末尾是 Steer 用户气泡时盲目 new 一个新 assistant 并把旧工具塞进去！
    if (event.type === 'tool_result' || event.type === 'tool_output' || event.type === 'tool_start') {
      const toolId = event.id;
      if (toolId) {
        for (let i = next.length - 1; i >= 0; i--) {
          const m = next[i];
          if (m.role === 'assistant' && m.parts?.some((p) => p.kind === 'tool' && p.tool?.id === toolId)) {
            const parts = m.parts.map((p) => {
              if (p.kind === 'tool' && p.tool?.id === toolId) {
                if (event.type === 'tool_result') {
                  const nextSubtasks = event.name === 'task' ? applySubtaskResultsFromOutput(p.tool.subtasks, event.output) : undefined;
                  return {
                    ...p,
                    tool: {
                      ...p.tool,
                      status: toolResultStatus(event.success, event.output, event.name),
                      output: event.output,
                      ...(nextSubtasks ? { subtasks: nextSubtasks } : {}),
                    },
                  };
                }
                if (event.type === 'tool_output') {
                  return {
                    ...p,
                    tool: {
                      ...p.tool,
                      output: (p.tool.output ?? '') + event.chunk,
                    },
                  };
                }
                if (event.type === 'tool_start') {
                  const argsStr = formatArgs(event.arguments);
                  const subtasks = event.name === 'task' ? subtasksFromTaskArgs(argsStr) ?? undefined : undefined;
                  return {
                    ...p,
                    tool: {
                      ...p.tool,
                      name: event.name,
                      args: argsStr,
                      ...(subtasks ? { subtasks } : {}),
                    },
                  };
                }
              }
              return p;
            });
            next[i] = { ...m, parts };
            messageCacheRef.current.set(targetSid, next);
            return;
          }
        }
      }
    }

    // 管线身份直连：带 message_id 的新工具行直接落到它所属的那一轮（steer 气泡之后
    // 绝不能另开一条 assistant，否则上一回合迟到的事件会被渲染到 steer 下方）。
    if (event.type === 'tool_start' && event.message_id) {
      const owner = identifiedAssistantIndex(next, event.message_id);
      if (owner >= 0) {
        const argsStr = formatArgs(event.arguments);
        const subtasks = event.name === 'task' ? subtasksFromTaskArgs(argsStr) ?? undefined : undefined;
        const updated = next.slice();
        updated[owner] = {
          ...next[owner]!,
          parts: upsertToolPart(next[owner]!.parts, {
            id: event.id,
            name: event.name,
            args: argsStr,
            status: 'pending',
            ...(subtasks ? { subtasks } : {}),
          }),
        };
        messageCacheRef.current.set(targetSid, updated);
        return;
      }
    }

    let last = next[next.length - 1];

    if (!last || last.role !== 'assistant') {
      last = { role: 'assistant', parts: [] };
      next.push(last);
    } else {
      last = { ...last, parts: last.parts ? [...last.parts] : [] };
      next[next.length - 1] = last;
    }

    switch (event.type) {
      case 'tool_start': {
        const argsStr = formatArgs(event.arguments);
        const subtasks = event.name === 'task' ? subtasksFromTaskArgs(argsStr) ?? undefined : undefined;
        last.parts.push({
          kind: 'tool',
          tool: {
            id: event.id,
            name: event.name,
            args: argsStr,
            status: 'pending',
            ...(subtasks ? { subtasks } : {}),
          },
        });
        // 工具行同样盖上管线身份：纯工具回合的行也要能被后续重放/增量按 id 定位。
        next = withAssistantIdentity(next, event.message_id);
        messageCacheRef.current.set(targetSid, next);
        break;
      }
      case 'tool_output': {
        last.parts = appendToolOutput(last.parts, event.id, event.chunk);
        messageCacheRef.current.set(targetSid, next);
        break;
      }
      case 'tool_result': {
        const toolPart = last.parts.find((p) => p.kind === 'tool' && 'tool' in p && p.tool?.id === event.id);
        if (toolPart && 'tool' in toolPart && toolPart.tool) {
          toolPart.tool.status = toolResultStatus(event.success, event.output, event.name);
          toolPart.tool.output = event.output;
        }
        messageCacheRef.current.set(targetSid, next);
        break;
      }
      case 'done':
      case 'stopped':
      case 'error': {
        const openFence = artifactOpenBySessionRef.current.get(targetSid);
        if (openFence) {
          artifactOpenBySessionRef.current.delete(targetSid);
          const marker = '`'.repeat(openFence);
          const msgsAfter = messageCacheRef.current.get(targetSid);
          if (msgsAfter && msgsAfter.length > 0) {
            messageCacheRef.current.set(
              targetSid,
              paintCachedAssistantDelta(msgsAfter, 'text', '\n' + marker + '\n')
            );
          }
        }
        backgroundRunningSessionsRef.current.delete(targetSid);
        localTurnSessionsRef.current.delete(targetSid);
        onLiveRunningChange?.(targetSid, false);
        const liveDoc = liveTodoDoc(targetSid);
        const settled = settleLiveTodo(liveDoc);
        if (settled.archive) {
          next = placeArchivedTodos(next, settled.archive, liveDoc?.revision ?? null);
          writeLiveTodo(targetSid, settled.next);
        }
        messageCacheRef.current.set(targetSid, next);
        const ph = projectHashBySessionRef.current.get(targetSid) || viewedProjectHashRef.current || activeSession?.project_hash || '';
        if (ph) {
          void syncSessionCacheFromDisk(ph, targetSid);
        }
        const folder = (effectiveWorkingDir ?? '').split(/[\\/]/).filter((p) => p.length > 0).pop() ?? '';
        const sessionName = activeSession?.name || folder || 'JeikCode';
        const previewText = event.type === 'error' ? (event.message || 'Error occurred') : 'Task completed';
        dispatchSystemNotification({
          title: sessionName,
          body: previewText,
          sessionId: targetSid,
          tag: `${targetSid}:done`,
          postSystemNotifyFn: postSystemNotify,
        });
        break;
      }
    }
  }

  /**
   * 画布反哺缓存（防抖 800ms）。
   *
   * 断点续传只保证「不再重发已画过的帧」，它不负责把画布存下来：如果画布不落缓存，
   * 刷新后画布会退回旧缓存，而游标却已超前 —— 服务器就只补新帧，中间那段直接丢。
   * 所以每处理完一帧就排队一次缓存写入（L1 同步、L2 异步），回合收尾另有强制写入。
   */
  const canvasCacheTimerRef = useRef<number | null>(null);
  function scheduleCanvasCacheSave() {
    if (canvasCacheTimerRef.current != null) return;
    canvasCacheTimerRef.current = window.setTimeout(() => {
      canvasCacheTimerRef.current = null;
      const target = activeIdRef.current ?? sessionId;
      if (!target) return;
      const hash =
        projectHashBySessionRef.current.get(target) ??
        activeSession?.project_hash ??
        viewedProjectHashRef.current ??
        '';
      if (!hash) return;
      const outline =
        turnOutlineRef.current.length > 0
          ? turnOutlineRef.current
          : turnOutlineBySessionRef.current.get(target) ?? [];
      void saveSessionCache(
        hash,
        target,
        messagesRef.current,
        activeTodosRef.current,
        undefined,
        outline,
        tokensAuthoritativeRef.current,
      );
    }, 800);
  }

  /** @param opts.observerOnly Reserved for pure third-party observers that must
   *  not own interactive modals. /chat/watch reattach after refresh MUST call
   *  without this flag so Build-mode permission_request is restored. */
  function handleEvent(event: SSEEvent, opts?: { observerOnly?: boolean; requireReplayDedup?: boolean; repeatUserAfterSettled?: boolean }) {
    const observerOnly = opts?.observerOnly === true;
    const requireReplayDedup = opts?.requireReplayDedup === true;
    switch (event.type) {
      case 'runtime_info':
        setProvider(event.provider);
        break;
      case 'session_assigned':
        // Bind a brand-new `/chat` conversation before model/provider work can
        // fail or the SSE transport can disappear. Mark the current canvas as
        // already loaded so the App state update cannot replace the optimistic
        // first turn with an empty history fetch.
        // Watch replay also emits this event. Only the tab that already owns
        // POST /chat may claim the turn; an observer or a refresh must keep
        // receiving the rest of the replay.
        {
          const previousId = activeIdRef.current;
          const claim = sessionAssignedClaimsLocalTurn({
            ownsOpenStream:
              abortRef.current !== null || activeStreamRequestIdRef.current !== null,
            previousIdIsLocalTurn: !!(
              previousId && localTurnSessionsRef.current.has(previousId)
            ),
          });
          if (previousId && messageCacheRef.current.has(previousId) && previousId !== event.session_id) {
            const cached = messageCacheRef.current.get(previousId);
            if (cached) messageCacheRef.current.set(event.session_id, cached);
          }
          if (claim) localTurnSessionsRef.current.add(event.session_id);
        }
        activeIdRef.current = event.session_id;
        loadedForRef.current = event.session_id;
        onSessionId(event.session_id);
        break;
      case 'command_output':
        pushCommandNotice(event.text);
        break;
      case 'session_renamed':
        if (!activeIdRef.current || event.session_id === activeIdRef.current) {
          onSessionRenamed?.(event.name);
        }
        break;

      case 'user': {
        // Fan-out / `/chat/watch` admitted-user event. Own `/chat` turns also
        // receive this on the primary SSE after we added fanout — must not
        // re-append or drop the optimistic empty assistant (that made text /
        // reasoning appends no-op while sticky todos still updated).
        const userText = visibleUserText(event.content);
        const echoIdx = pendingSelfEchoRef.current.findIndex(
          (p) => userTextsMatch(p.text, event.content) || visibleUserText(p.text) === userText,
        );
        if (echoIdx >= 0) {
          pendingSelfEchoRef.current.splice(echoIdx, 1);
          break;
        }
        const userDelta = estimateTextTokens(userText);
        lastUserTokensRef.current = userDelta;
        if (userDelta > 0) {
          setTokens((prev) => mergeLocalTokens(prev, {
            prompt: (prev?.prompt ?? 0) + userDelta,
            completion: prev?.completion ?? 0,
            total: (prev?.total ?? 0) + userDelta,
            reasoning: 0,
          }));
        }
        const userTs =
          event.created_at && Number.isFinite(event.created_at) && event.created_at > 0
            ? event.created_at
            : Date.now();
        adoptTurnUserTs(userTs, event.created_at != null && event.created_at > 0);
        setMessages((prev) => {
          const next = paintUserMessage(prev, event.content, userTs, (base) => {
            const turnIndex = nextTurnNavIndex(base);
            const turnOrdinal = nextTurnNavOrdinal(base);
            rememberTurnOutline(userText, turnIndex, turnOrdinal);
            return {
              role: 'user' as const,
              parts: [{ kind: 'text', text: userText }],
              ts: userTs,
              sourceIndex: turnIndex,
              turnNavOrdinal: turnOrdinal,
            };
          }, { repeatAfterSettled: opts?.repeatUserAfterSettled ?? false });
          messagesRef.current = next;
          return next;
        });
        break;
      }

      case 'steered': {
        foldSteeredInputs(event.inputs ?? [], event.client_input_ids);
        break;
      }

      case 'user_identified': {
        // 身份回传：把乐观用户气泡绑定到落盘消息 id（刷新/切换/回放时按 id 收敛，
        // 不再回退文本启发）。受唯一性守卫保护，幂等。
        setMessages((prev) => {
          const next = bindUserMessageIdentity(prev, event.message_id);
          if (next === prev) return prev;
          messagesRef.current = next;
          const currentSid = liveSessionIdRef.current ?? sessionId ?? activeIdRef.current;
          if (currentSid) messageCacheRef.current.set(currentSid, next);
          return next;
        });
        break;
      }

      case 'text': {
        appendToLastAssistant(
          event.content,
          { requireReplayDedup },
          { messageId: event.message_id, partId: event.part_id },
        );
        const textDelta = estimateTextTokens(event.content);
        if (textDelta > 0) {
          setTokens((prev) => mergeLocalTokens(prev, {
            prompt: prev?.prompt ?? 0,
            completion: (prev?.completion ?? 0) + textDelta,
            total: (prev?.total ?? 0) + textDelta,
          }));
        }
        break;
      }

      case 'reasoning': {
        // Thinking / chain-of-thought stream — collapsible block in the UI.
        setMessages((prev) => {
          const next = withAssistantIdentity(
            paintAssistantReasoning(prev, event.content, requireReplayDedup, event.message_id, event.part_id),
            event.message_id,
            event.part_id,
          );
          messagesRef.current = next;
          return next;
        });
        const rDelta = estimateTextTokens(event.content);
        if (rDelta > 0) {
          setTokens((prev) => mergeLocalTokens(prev, {
            prompt: prev?.prompt ?? 0,
            completion: (prev?.completion ?? 0) + rDelta,
            total: (prev?.total ?? 0) + rDelta,
            reasoning: (prev?.reasoning ?? 0) + rDelta,
          }));
        }
        break;
      }

      case 'tool_start': {
        const argsStr = formatArgs(event.arguments);
        const subtasks =
          event.name === 'task' ? subtasksFromTaskArgs(argsStr) ?? undefined : undefined;
        addToolToLastAssistant({
          id: event.id,
          name: event.name,
          args: argsStr,
          status: 'pending',
          ...(subtasks ? { subtasks } : {}),
        }, event.message_id);
        if (isTodoTool(event.name)) {
          const appliedIds = appliedTodoIdsFor(activeIdRef.current);
          setActiveTodos((cur) => {
            const next = foldLiveTodo({
              state: cur,
              remembered: activeTodosRef.current,
              name: event.name,
              args: argsStr,
              callId: event.id,
              appliedIds,
            });
            // 折叠消费了 callId → 立即落盘，刷新后仍能挡住同一帧的重放。
            persistAppliedTodoIds();
            const sid = activeIdRef.current;
            const doc = reduceLiveTodo(
              liveTodoDoc(sid),
              next && next.length > 0
                ? { type: 'preview', callId: event.id, items: next }
                : { type: 'clear' },
            );
            if (sid) {
              if (doc) todoLiveBySessionRef.current.set(sid, doc);
              else todoLiveBySessionRef.current.delete(sid);
              if (doc) activeTodosBySessionRef.current.set(sid, doc.items);
              else activeTodosBySessionRef.current.delete(sid);
            }
            activeTodosRef.current = doc?.items ?? null;
            return doc?.items ?? null;
          });
        }
        break;
      }

      case 'tool_output': {
        const callId = event.id;
        setMessages((prev) => {
          if (prev.length === 0) return prev;
          const replayChunk = (parts: MsgPart[]) =>
            visibleToolChunk(parts, callId, event.chunk, requireReplayDedup);
          if (callId) {
            for (let i = prev.length - 1; i >= 0; i--) {
              const m = prev[i];
              if (m.role === 'assistant' && m.parts?.some((p) => p.kind === 'tool' && p.tool?.id === callId)) {
                const chunk = replayChunk(m.parts);
                if (!chunk) return prev;
                let parts = appendToolOutput(m.parts, callId, chunk);
                parts = parts.map((p) => {
                  if (p.kind === 'tool' && p.tool.id === callId && p.tool.subtasks) {
                    const next = applySubtaskProgress(p.tool.subtasks, chunk);
                    if (next !== p.tool.subtasks) {
                      return { kind: 'tool' as const, tool: { ...p.tool, subtasks: next } };
                    }
                  }
                  return p;
                });
                const next = prev.slice();
                next[i] = { ...m, parts };
                return next;
              }
            }
          }
          const last = prev[prev.length - 1];
          if (last.role !== 'assistant') return prev;
          const chunk = replayChunk(last.parts);
          if (!chunk) return prev;
          let parts = appendToolOutput(last.parts, callId, chunk);
          if (callId) {
            parts = parts.map((p) => {
              if (p.kind === 'tool' && p.tool.id === callId && p.tool.subtasks) {
                const next = applySubtaskProgress(p.tool.subtasks, chunk);
                if (next !== p.tool.subtasks) {
                  return { kind: 'tool' as const, tool: { ...p.tool, subtasks: next } };
                }
              }
              return p;
            });
          }
          return [...prev.slice(0, -1), { ...last, parts }];
        });
        break;
      }

      case 'tool_progress':
        setMessages((prev) => {
          if (prev.length === 0) return prev;
          for (let i = prev.length - 1; i >= 0; i--) {
            const m = prev[i];
            if (m.role === 'assistant' && m.parts?.some((p) => p.kind === 'tool' && p.tool?.id === event.id)) {
              let patch: Partial<ToolRow> | undefined;
              for (const p of m.parts) {
                if (p.kind === 'tool' && p.tool.id === event.id && p.tool.subtasks) {
                  const next = applySubtaskProgress(p.tool.subtasks, event.progress);
                  if (next !== p.tool.subtasks) patch = { subtasks: next };
                  break;
                }
              }
              const next = prev.slice();
              next[i] = {
                ...m,
                parts: updateToolProgress(m.parts, event.id, event.progress, patch),
              };
              return next;
            }
          }
          return prev;
        });
        break;

      case 'tool_result': {
        let nextSubtasks: import('../lib/subtasks').SubtaskItem[] | undefined;
        if (event.name === 'task') {
          let existingSubtasks: import('../lib/subtasks').SubtaskItem[] | undefined;
          for (let i = messagesRef.current.length - 1; i >= 0; i--) {
            const m = messagesRef.current[i];
            if (m.role === 'assistant' && m.parts) {
              const tp = m.parts.find((p) => p.kind === 'tool' && 'tool' in p && p.tool?.id === event.id);
              if (tp && 'tool' in tp && tp.tool?.subtasks) {
                existingSubtasks = tp.tool.subtasks;
                break;
              }
            }
          }
          nextSubtasks = applySubtaskResultsFromOutput(existingSubtasks, event.output);
        }
        updateToolInLastAssistant(event.id, {
          status: toolResultStatus(event.success, event.output, event.name),
          duration_ms: event.duration_ms,
          output: event.output,
          progress: undefined,
          ...(nextSubtasks ? { subtasks: nextSubtasks } : {}),
        });
        if (isTodoTool(event.name)) {
          const authoritativeFromOutput = parseTodosFromOutput(event.output);
          if (authoritativeFromOutput && authoritativeFromOutput.length > 0) {
            writeLiveTodo(
              activeIdRef.current,
              reduceLiveTodo(liveTodoDoc(activeIdRef.current), {
                type: 'result',
                callId: event.id,
                items: authoritativeFromOutput,
              }),
            );
          } else if (authoritativeFromOutput && authoritativeFromOutput.length === 0) {
            writeLiveTodo(
              activeIdRef.current,
              reduceLiveTodo(liveTodoDoc(activeIdRef.current), {
                type: 'clear',
              }),
            );
            applySessionStickyTodos(activeIdRef.current, null);
          } else {
            // 兜底回退：若输出中没有标准清单格式，再使用本地折叠
            let foundToolPart: ToolRow | undefined;
            for (let i = messagesRef.current.length - 1; i >= 0; i--) {
              const m = messagesRef.current[i];
              if (m.role === 'assistant' && m.parts) {
                const tp = m.parts.find((p) => p.kind === 'tool' && 'tool' in p && p.tool?.id === event.id);
                if (tp && 'tool' in tp && tp.tool) {
                  foundToolPart = tp.tool;
                  break;
                }
              }
            }
            if (foundToolPart?.args) {
              const toolArgs = foundToolPart.args;
              setActiveTodos((cur) => {
                const base = todoBaselineForLiveApply(cur, activeTodosRef.current);
                const next = foldTodoToolCall(base, event.name, toolArgs);
                const sid = activeIdRef.current;
                const doc = reduceLiveTodo(
                  liveTodoDoc(sid),
                  next && next.length > 0
                    ? { type: 'result', callId: event.id, items: next }
                    : { type: 'clear' },
                );
                if (sid) {
                  if (doc) todoLiveBySessionRef.current.set(sid, doc);
                  else todoLiveBySessionRef.current.delete(sid);
                  if (doc) activeTodosBySessionRef.current.set(sid, doc.items);
                  else activeTodosBySessionRef.current.delete(sid);
                }
                activeTodosRef.current = doc?.items ?? null;
                return doc?.items ?? null;
              });
            }
          }
        }
        // 改文件或跑 shell（含 git add / commit）结束后立刻刷新 Git 面板与资源管理器，
        // 不等整轮对话结束。连续工具合并成一次请求。
        if (toolTouchesWorktree(event.name)) {
          scheduleGitRefresh();
          try {
            window.dispatchEvent(new CustomEvent('jeikcode:worktree_touch'));
          } catch {}
        }
        // 工具已执行完 → 其审批必已解决，清掉 /chat 残留的同 call_id 审批卡片。
        onPermissionResolved?.(event.id);
        if (toolResultClearsUserInput(event.name)) {
          setUserInputReq(null);
        }
        // Tool output is folded into the next provider usage event. Do not bump
        // prompt locally — that inflates the footer and poisons session snapshots.
        break;
      }

      case 'tokens': {
        const resolved = resolveTokenCache(
          { prompt: event.prompt, cached: event.cached },
          tokenCacheRef.current,
        );
        tokenCacheRef.current = resolved.nextState;
        tokensAuthoritativeRef.current = true;
        setTokens((prev) => ({
          prompt: event.prompt,
          completion: event.completion,
          total: event.total,
          cached: resolved.cached,
          cached_estimated: resolved.cached_estimated,
          reasoning: prev?.reasoning ?? 0,
          loop_prompt: resolved.nextState.turnPromptSum,
          loop_cached: resolved.nextState.turnCachedSum,
        }));
        break;
      }

      case 'permission_request':
        // Always mark the tool row; restore the modal unless a pure observer
        // explicitly opts out (reattach/watch must NOT pass observerOnly — that
        // previously deadlocked Build turns after refresh).
        if (
          nativeModeRef.current === 'bypass'
          || modeState.confirmedMode === 'bypass'
          || transcriptToolCallIsResolved(messagesRef.current, event.call_id)
        ) {
          break;
        }
        updateToolInLastAssistant(event.call_id, {
          status: 'waiting_approval',
        });
        if (!observerOnly) {
          onPermission(event as PermissionRequestEvent);
        }
        {
          const folder = (effectiveWorkingDir ?? '').split(/[\\/]/).filter((part) => part.length > 0).pop() ?? '';
          const sessionName = activeSession?.name || folder || 'JeikCode';
          const sid = (event as any).session_id || activeIdRef.current;
          dispatchSystemNotification({
            title: t('notify.review.title'),
            body: t('notify.review.body', { session: sessionName, detail: event.tool_name }),
            sessionId: sid,
            tag: `${sid}:review:${event.call_id}`,
            approvalId: event.approval_id,
            postSystemNotifyFn: postSystemNotify,
          });
        }
        break;

      case 'user_input_request':
        if (observerOnly) break;
        setUserInputReq(event);
        {
          const folder = (effectiveWorkingDir ?? '').split(/[\\/]/).filter((part) => part.length > 0).pop() ?? '';
          const sessionName = activeSession?.name || folder || 'JeikCode';
          const sid = (event as any).session_id || activeIdRef.current;
          const detail = (event as any).question || (event as any).header || 'Input requested';
          dispatchSystemNotification({
            title: t('notify.ask.title'),
            body: t('notify.ask.body', { session: sessionName, detail }),
            sessionId: sid,
            tag: `${sid}:ask:${(event as any).request_id}`,
            postSystemNotifyFn: postSystemNotify,
          });
        }
        break;

      case 'done': {
        // 标记这是本 Chat 自己产生的会话 id，避免下面的 useEffect 误把当前对话清空，
        // 并标记其历史「已就位」（就是当前画布），防止 project_hash 回填后重新加载覆盖。
        if (event.session_id) {
          activeIdRef.current = event.session_id;
          loadedForRef.current = event.session_id;
          onSessionId(event.session_id);
        }
        if (event.tokens) {
          if (typeof event.tokens === 'number' && event.tokens > 0) {
            setTokens((prev) => ({
              prompt: prev?.prompt ?? 0,
              completion: prev?.completion ?? (event.tokens as number),
              total: Math.max(prev?.total ?? 0, event.tokens as number),
              cached: prev?.cached ?? 0,
              reasoning: prev?.reasoning ?? 0,
            }));
          } else if (typeof event.tokens === 'object') {
            const tok = event.tokens as any;
            if (typeof tok.total === 'number' && tok.total > 0) {
              const prompt = tok.prompt ?? tok.input ?? 0;
              applyAuthoritativeTokenUsage({
                prompt,
                completion: tok.completion ?? tok.output ?? 0,
                total: tok.total,
                cached: tok.cached ?? tok.cached_input,
                reasoning: tok.reasoning ?? 0,
              });
            }
          }
        }
        const terminal = classifyChatDone({
          stopReason: event.stop_reason,
          message: event.message,
        });
        if (terminal.discardQueued) {
          // 异常终端：停止自动向后 drain，但安全保留用户的排队与转向卡片，
          // 贯彻「真的消息发出去了才从硬盘删除」宗旨，用户仍可手动立即发送或编辑
          blockQueueDrainRef.current = true;
          pushNoticeToLastAssistant(t('chat.incomplete', { msg: terminal.detail }));
        } else {
          // 未被回合内并入的转向消息，还原为普通排队消息，回合结束后由 drain 自动发送；
          // 但已并入正文（文本/图片命中画布）的卡片必须直接销毁，绝不复活成 queue。
          setQueued((q) => q
            .filter((item) => {
              if (item.kind !== 'steer' && item.kind !== 'steering') return true;
              const merged = messagesRef.current.some((m) => {
                if (m.role !== 'user') return false;
                if (item.images && item.images.length > 0 && sameImageSet(m.images, item.images)) return true;
                const clean = visibleUserText(item.text).trim();
                return !!clean && m.parts.some((p) => p.kind === 'text' && userTextsMatch(p.text, clean));
              });
              return !merged;
            })
            .map((item) => (
              item.kind === 'steer' || item.kind === 'steering'
                ? { ...item, kind: 'queue' as const }
                : item
            )));
        }
        transitionChatRecovery({ type: 'authoritative_terminal' });
        localTurnSessionsRef.current.delete(event.session_id);
        backgroundRunningSessionsRef.current.delete(event.session_id);
        onLiveRunningChange?.(event.session_id, false);
        turnStartedAtBySessionRef.current.delete(event.session_id);
        if (activeIdRef.current === event.session_id) {
          saveTokenSnapshot(event.session_id, tokensAuthoritativeRef.current);
        }
        setIsCompacting(false);
        setBusyAndClock(false);
        if (event.session_id) {
          markSessionTerminalSettled(event.session_id);
        }
        closeOpenArtifactFence();
        finalizePendingToolsOnCanvas();
        commitActiveTodosIntoLastAssistant();
        const doneSid = event.session_id || activeIdRef.current;
        const donePh = activeSession?.project_hash || (doneSid ? projectHashBySessionRef.current.get(doneSid) : '') || '';
        if (doneSid && donePh) {
          const currentOutline = turnOutlineRef.current.length > 0 ? turnOutlineRef.current : (turnOutlineBySessionRef.current.get(doneSid) ?? []);
          void saveSessionCache(donePh, doneSid, messagesRef.current, activeTodosRef.current, undefined, currentOutline, tokensAuthoritativeRef.current);
        }
        onPermissionResolved?.(null); // 回合结束：兜底清掉任何残留审批卡片
        setUserInputReq(null);

        // 前台正看着这个会话时不发。最小化或窗口不在前台时，即使还选中它也发。
        // 标签与通知坞的完成边一致，守护进程 8 秒内只弹一条。
        if (shouldOsNotifyTerminal({
          sessionId: event.session_id,
          activeSessionId: activeIdRef.current,
          windowAway: isWindowAway(),
        })) {
          const folder = (effectiveWorkingDir ?? '').split(/[\\/]/).filter((part) => part.length > 0).pop() ?? '';
          const sessionName = activeSession?.name || folder || 'JeikCode';
          const title = t('notify.done.title');
          const body = t('notify.done.body', { session: sessionName });
          dispatchSystemNotification({
            title,
            body,
            sessionId: event.session_id,
            tag: `${event.session_id}:completed`,
            postSystemNotifyFn: postSystemNotify,
          });
        }
        break;
      }

      case 'session_status': {
        const compacting = (event as { status?: string }).status === 'compacting';
        setIsCompacting(compacting);
        break;
      }

      case 'stopped':
        transitionChatRecovery({ type: 'authoritative_terminal' });
        setIsCompacting(false);
        if (activeIdRef.current) {
          backgroundRunningSessionsRef.current.delete(activeIdRef.current);
          localTurnSessionsRef.current.delete(activeIdRef.current);
          onLiveRunningChange?.(activeIdRef.current, false);
          turnStartedAtBySessionRef.current.delete(activeIdRef.current);
        }
        setBusyAndClock(false);
        closeOpenArtifactFence();
        finalizePendingToolsOnCanvas();
        commitActiveTodosIntoLastAssistant();
        if (consumesProgrammaticStopMark(programmaticStopMarkRef.current, activeIdRef.current ?? sessionId, Date.now())) {
          // 程序化停止（排队卡「立即发送」）：本次 stopped 是本端为换发新消息而主动触发的，
          // 其余排队卡片与已投递的转向必须原地保留。队首卡片交给紧随其后的 drain 投递，
          // 绝不整段回吐到输入框（那是用户主动按「停止」的语义）。
          programmaticStopMarkRef.current = null;
        } else {
          restoreQueuedToComposer(); // 用户中止：排队内容回到输入框，而不是丢掉
        }
        onPermissionResolved?.(null);
        setUserInputReq(null);
        break;

      case 'error':
        closeOpenArtifactFence();
        appendToLastAssistant('\n\n' + t('chat.error', { msg: event.message }));
        transitionChatRecovery({ type: 'authoritative_terminal' });
        if (activeIdRef.current) {
          backgroundRunningSessionsRef.current.delete(activeIdRef.current);
          localTurnSessionsRef.current.delete(activeIdRef.current);
          onLiveRunningChange?.(activeIdRef.current, false);
          turnStartedAtBySessionRef.current.delete(activeIdRef.current);
        }
        setBusyAndClock(false);
        finalizePendingToolsOnCanvas();
        commitActiveTodosIntoLastAssistant();
        blockQueueDrainRef.current = true; // 出错时暂停自动 drain，但保留排队消息不丢失
        onPermissionResolved?.(null);
        setUserInputReq(null);
        break;

      case 'warning':
        // 非致命提示（如"已自动压缩上下文"）：渲染成淡色 notice 行 —— 不染红、不并进
        // 回复文本、不结束回合（任务继续）。对齐 TUI 的黄色 "!" 提示。
        pushNoticeToLastAssistant(t('chat.warning', { msg: event.message }), event.message_id);
        break;

      case 'persistence_warning':
        setPersistenceWarning(event.message);
        break;

      case 'rate_limited': {
        // 限流暂停：渲染成暗色中性卡片，非红色 error 样式；保留已完成内容，不结束回合。
        // auto_resuming=true → WaitAndRetry (kernel will sleep then retry)
        // A provider quota verdict carries window data (reset time and/or a
        // window label); a generic 429 carries neither. Only claim
        // "window exhausted" when those fields are present.
        const time = event.reset_at_display;
        const hasQuotaWindow = !!time || !!event.reset_label;
        const secs = event.secs_until_reset;
        // Bare compact h/m/s (locale-neutral), then wrap in a localized suffix so the
        // English notice doesn't leak a Chinese "（还有 …）" fragment.
        const durRaw = secs == null ? '' :
          secs >= 3600 ? `${Math.floor(secs / 3600)}h${Math.floor((secs % 3600) / 60)}m` :
          secs >= 60 ? `${Math.floor(secs / 60)}m` : `${secs}s`;
        const dur = durRaw ? t('chat.rateLimited.remaining', { dur: durRaw }) : '';
        let text: string;
        if (event.auto_resuming) {
          text = t('chat.rateLimited.waiting', { secs: String(event.secs_until_reset ?? 0) });
        } else if (!hasQuotaWindow) {
          // Generic 429: surface the provider's own reason when present.
          const reason = event.server_message?.trim() ? `：${event.server_message.trim()}` : '';
          text = `${t('chat.rateLimited.generic')}${reason}${dur} · ${t('chat.rateLimited.hint')}`;
        } else if (time) {
          text = `${t('chat.rateLimited.paused', { time })} · ${t('chat.rateLimited.hint')}`;
        } else {
          text = `${t('chat.rateLimited.pausedNoTime')}${dur} · ${t('chat.rateLimited.hint')}`;
        }
        pushRateLimitedToLastAssistant(text);
        break;
      }

      // Artifact events: the daemon's ArtifactDetector strips fenced code blocks
      // (and HTML/SVG) from TextDelta and emits them as separate artifact_* events.
      // Without handling these, the code content is silently lost in the WebUI.
      case 'artifact_start': {
        if (event.id?.startsWith('file-')) {
          artifactOpenRef.current = false;
          break;
        }
        const lang = (event.language ?? '').trim();
        const fenceLen = typeof event.fence_len === 'number' && event.fence_len >= 3
          ? event.fence_len
          : 3;
        const marker = '`'.repeat(fenceLen);
        const fence = (lang ? marker + lang : marker) + '\n';
        // 关键防御：确保代码块开启围栏始终独立成行，杜绝与前置文本粘连导致代码块被炸开为正文
        const curMessages = messagesRef.current;
        const lastMsg = curMessages[curMessages.length - 1];
        let prefix = '';
        if (lastMsg && lastMsg.role === 'assistant') {
          const lastPart = lastMsg.parts[lastMsg.parts.length - 1];
          if (lastPart && lastPart.kind === 'text' && lastPart.text && !lastPart.text.endsWith('\n')) {
            prefix = '\n';
          }
        }
        appendToLastAssistant(prefix + fence, {
          skipReplayDedup: true,
        });
        artifactOpenRef.current = true;
        artifactFenceLenRef.current = fenceLen;
        if (activeIdRef.current) artifactOpenBySessionRef.current.set(activeIdRef.current, fenceLen);
        break;
      }
      case 'artifact_content': {
        if (event.id?.startsWith('file-')) break;
        appendToLastAssistant(event.content, { skipReplayDedup: true });
        break;
      }
      case 'artifact_end': {
        if (event.id?.startsWith('file-')) {
          artifactOpenRef.current = false;
          break;
        }
        if (artifactOpenRef.current) {
          const fenceLen = artifactFenceLenRef.current || 3;
          const marker = '`'.repeat(fenceLen);
          appendToLastAssistant('\n' + marker + '\n', { skipReplayDedup: true });
        }
        artifactOpenRef.current = false;
        artifactFenceLenRef.current = 3;
        if (activeIdRef.current) artifactOpenBySessionRef.current.delete(activeIdRef.current);
        break;
      }
      case 'session_mutation': {
        const mutation = event as SessionMutationEvent;
        // 会话变更改写了权威转录：本会话的续传游标立即作废（两条流都作废），
        // 否则带旧游标重连会把变更前发出的旧帧补回来 —— 已删内容会复活。
        clearStreamCursor(mutation.session_id);
        clearStreamCursor(mutation.session_id, 'sync');
        // Update cached session in memory if exists
        const cached = messageCacheRef.current.get(mutation.session_id);
        let updatedCached: Message[] | undefined = undefined;
        if (cached) {
          const nextCached = cached.slice();
          if (mutation.action === 'patch') {
            const idx = nextCached.findIndex((m) =>
              mutation.source_index != null
                ? m.sourceIndex === mutation.source_index
                : false
            );
            if (idx !== -1) {
              nextCached[idx] = {
                ...nextCached[idx],
                parts: [{ kind: 'text', text: mutation.text ?? '' }],
                images: mutation.images,
              };
              messageCacheRef.current.set(mutation.session_id, nextCached);
              updatedCached = nextCached;
            }
          } else if (mutation.action === 'delete') {
            const idx = nextCached.findIndex((m) =>
              mutation.source_index != null
                ? m.sourceIndex === mutation.source_index
                : false
            );
            if (idx !== -1) {
              if (mutation.delete_turn) {
                let end = idx + 1;
                while (end < nextCached.length && nextCached[end]?.role !== 'user') {
                  end += 1;
                }
                nextCached.splice(idx, end - idx);
              } else {
                nextCached.splice(idx, 1);
              }
              messageCacheRef.current.set(mutation.session_id, nextCached);
              updatedCached = nextCached;
            }
          } else if (mutation.action === 'truncate') {
            if (mutation.target_index != null) {
              const idx = nextCached.findIndex((m) => (m.sourceIndex ?? 0) >= mutation.target_index!);
              if (idx !== -1) {
                const nextTruncated = nextCached.slice(0, idx);
                messageCacheRef.current.set(mutation.session_id, nextTruncated);
                updatedCached = nextTruncated;
              }
            }
          }
        }

        // If this mutation belongs to the currently active session on screen:
        if (mutation.session_id === activeIdRef.current) {
          if (mutation.action === 'patch') {
            setMessages((prev) => {
              const next = prev.slice();
              const idx = next.findIndex((m) =>
                mutation.source_index != null
                  ? m.sourceIndex === mutation.source_index
                  : false
              );
              if (idx !== -1) {
                next[idx] = {
                  ...next[idx],
                  parts: [{ kind: 'text', text: mutation.text ?? '' }],
                  images: mutation.images,
                };
              }
              messagesRef.current = next;
              return next;
            });
          } else if (mutation.action === 'delete') {
            setMessages((prev) => {
              const idx = prev.findIndex((m) =>
                mutation.source_index != null
                  ? m.sourceIndex === mutation.source_index
                  : false
              );
              if (idx === -1) return prev;
              const next = prev.slice();
              if (mutation.delete_turn) {
                let end = idx + 1;
                while (end < next.length && next[end]?.role !== 'user') {
                  end += 1;
                }
                next.splice(idx, end - idx);
              } else {
                next.splice(idx, 1);
              }
              messagesRef.current = next;
              return next;
            });
            if (mutation.delete_turn && mutation.source_index != null) {
              const filteredTurns = turnOutlineRef.current.filter((t) => t.index !== mutation.source_index);
              turnOutlineRef.current = filteredTurns;
              turnOutlineBySessionRef.current.set(mutation.session_id, filteredTurns);
              setTurnOutline(filteredTurns);
            }
          } else if (mutation.action === 'truncate') {
            setMessages((prev) => {
              if (mutation.target_index == null) return prev;
              const idx = prev.findIndex((m) => (m.sourceIndex ?? 0) >= mutation.target_index!);
              if (idx !== -1) {
                const next = prev.slice(0, idx);
                messagesRef.current = next;
                return next;
              }
              return prev;
            });
            if (mutation.target_index != null) {
              const filteredTurns = turnOutlineRef.current.filter((t) => t.index < mutation.target_index!);
              turnOutlineRef.current = filteredTurns;
              turnOutlineBySessionRef.current.set(mutation.session_id, filteredTurns);
              setTurnOutline(filteredTurns);
            }
          }
        }

        // 同步持久化写入 IndexedDB (确保异地/后台实例及离线存储实时一致)
        if (updatedCached) {
          const ph =
            activeSession?.project_hash ||
            projectHashBySessionRef.current.get(mutation.session_id) ||
            viewedProjectHashRef.current ||
            '';
          if (ph) {
            const currentOutline =
              mutation.session_id === activeIdRef.current
                ? turnOutlineRef.current
                : turnOutlineBySessionRef.current.get(mutation.session_id) ?? [];
            void saveSessionCache(
              ph,
              mutation.session_id,
              updatedCached,
              activeTodosRef.current,
              undefined,
              currentOutline,
              tokensAuthoritativeRef.current,
            );
          }
        }
        break;
      }

      default:
        // Ignore tool_batch, etc.
        break;
    }
    // 反哺缓存：断点续传的游标只负责「新帧」，画布本身必须同步落进 L1/L2 缓存 ——
    // 否则刷新后「画布来自旧缓存 + 游标已超前」会把中间那段内容整段跳过（丢帧）。
    scheduleCanvasCacheSave();
  }

  // 实际投递一条消息（同步 / 常规两条路径）；busy 由各自的事件流复位。
  async function deliver(
    text: string,
    images: ImageData[],
    approvalMode: ApprovalMode = modeState.confirmedMode,
    onAccepted?: (acceptedSessionId?: string) => void,
    overrideProvider?: string,
    opts?: { alreadyOnCanvas?: boolean; preserveCanvasOnBusy?: boolean },
  ): Promise<'ok' | 'busy' | 'error'> {
    if (!chatRecoveryPolicy(chatRecoveryRef.current).allowSend) {
      pushCommandNotice(
        chatRecoveryRef.current === 'detached_active'
          ? t('chat.detachedSendBlocked')
          : t('chat.recoveryBlocked'),
      );
      return 'error';
    }
    // 画到上一条消息尾部只发生在正式 stop 且全部勾完之后，不在发送下一条时提前归档。
    if (sessionId) idleWatchFlashDisconnectsRef.current.delete(sessionId);
    // Actually sending a message (immediate OR drained from the queue) re-engages
    // auto-follow — the user wants to see their message + the reply. Placed HERE, not in
    // sendMessage, so merely QUEUEING a message while reading history doesn't yank them.
    timelineFollow.jump();

    // 发送聊天后自动判定右侧栏展示模式：
    // 如果是非 Git 仓库或非多 Git 仓库（repos.length === 0），则默认选择提问历史模式 ('questions')；否则才为 'git'
    if (effectiveWorkingDir) {
      setRightPanelTab(hasGitReposRef.current ? 'git' : 'questions');
      fetchGitRepos(effectiveWorkingDir)
        .then((res) => {
          const hasGit = Array.isArray(res.repos) && res.repos.length > 0;
          hasGitReposRef.current = hasGit;
          setHasGitRepos(hasGit);
          setRightPanelTab(hasGit ? 'git' : 'questions');
        })
        .catch(() => {
          hasGitReposRef.current = false;
          setHasGitRepos(false);
          setRightPanelTab('questions');
        });
    } else {
      setRightPanelTab('questions');
    }
    // 本会话首条消息：用消息前 10 字做临时标题，立刻通知 App 乐观插入侧栏，
    // 让会话「一发送就出现在左侧」。回合 done 后列表刷新会换成后端自动命名。
    if (!optimisticFiredRef.current && messages.length === 0) {
      optimisticFiredRef.current = true;
      const title = (text.split('\n')[0]?.trim() ?? '').slice(0, 10);
      if (title) onOptimisticSession?.(title);
    }

    if (attachedToLiveRuntime()) {
      // ── Sync path: send to /live/message. Optimistically append the user
      //    message NOW so the view leaves the "new conversation" landing page
      //    immediately (the server `user` echo — which keeps OTHER tabs in sync —
      //    only arrives after VL preprocessing, so waiting for it leaves the
      //    sender stuck on the empty page). Our own echo is deduped in the `user`
      //    case via `pendingSelfEchoRef`.
      // 立即发送已经画好用户气泡。此时 busy 往往还没落下，不能再登记成 pending steer，
      // 否则停止收尾会把这条气泡撤掉，只剩刷新后的磁盘副本。
      const steering = busyRef.current && opts?.alreadyOnCanvas !== true;
      const sid = liveSessionIdRef.current ?? sessionId ?? activeIdRef.current;
      if (steering && sid) {
        recordUserSteer(sid);
      }
      setBusyAndClock(true);
      liveIdleSnapshotRef.current = false;
      liveLifecycleRef.current = { running: true, terminalConsumed: false };
      if (activeIdRef.current) localTurnSessionsRef.current.add(activeIdRef.current);
      const now = Date.now();
      const pendingSteer: PendingLiveSteer = {
        id: crypto.randomUUID(),
        text,
        images: images.length ? images : undefined,
        confirmed: false,
      };
      pendingSelfEchoRef.current.push({ id: pendingSteer.id, text });
      const turnIndex = nextTurnNavIndex();
      const turnOrdinal = nextTurnNavOrdinal();
      if (!opts?.alreadyOnCanvas) {
      rememberTurnOutline(text, turnIndex, turnOrdinal);
      setMessages((prev) => {
        const next = [
          ...prev,
          {
            role: 'user' as const,
            parts: [{ kind: 'text' as const, text }],
            images: images.length ? images : undefined,
            ts: now,
            pendingSteerId: pendingSteer.id,
            id: pendingSteer.id,
            sourceIndex: turnIndex,
            turnNavOrdinal: turnOrdinal,
          },
        ];
        messagesRef.current = next;
        const currentSid = liveSessionIdRef.current ?? sessionId ?? activeIdRef.current;
        if (currentSid) {
          messageCacheRef.current.set(currentSid, next);
          const targetPh = activeSession?.project_hash || projectHashBySessionRef.current.get(currentSid) || '';
          if (targetPh) {
            const currentOutline = turnOutlineRef.current.length > 0 ? turnOutlineRef.current : (turnOutlineBySessionRef.current.get(currentSid) ?? []);
            void saveSessionCache(targetPh, currentSid, next, activeTodosRef.current, undefined, currentOutline, tokensAuthoritativeRef.current);
          }
        }
        return next;
      });
      // Register before the HTTP round-trip. A very fast round boundary can
      // emit `steered` on SSE before the submit response reaches this tab.
      setPendingSteers((pending) => [...pending, pendingSteer]);
      }
      try {
        const receipt = await postLiveMessage(
          text,
          images.length ? images : undefined,
          provider ?? undefined,
          activeIdRef.current,
          pendingSteer.id,
        );
        onAccepted?.(sid ?? undefined);
        // The receipt is authoritative. The browser's busy flag can race a
        // terminal event, so reconcile pending ownership in either direction.
        if (receipt.disposition === 'started') {
          setPendingSteers((pending) => pending.filter((item) => item.id !== pendingSteer.id));
        } else {
          setPendingSteers((pending) => pending.map((item) => (
            item.id === pendingSteer.id ? { ...item, confirmed: true } : item
          )));
        }
        // Receipt is authoritative: the runtime has the input. A stale
        // `running=false` (TUI froze and stopped publishing state events)
        // used to call restorePendingSteers and swallow the message.
        if (liveSubmitKeepsTurn(receipt.disposition)) {
          liveLifecycleRef.current = { running: true, terminalConsumed: false };
          liveIdleSnapshotRef.current = false;
          setBusyAndClock(true);
          if (activeIdRef.current) {
            backgroundRunningSessionsRef.current.add(activeIdRef.current);
            onLiveRunningChange?.(activeIdRef.current, true);
          }
        }
      } catch (error) {
        if (opts?.alreadyOnCanvas) {
          setHistoryHint(t('chat.connError', { msg: String(error) }));
          return 'error';
        }
        // Roll back the optimistic append — the send never reached the server.
        const echoIndex = pendingSelfEchoRef.current.findIndex(
          (pending) => pending.id === pendingSteer.id,
        );
        if (echoIndex >= 0) pendingSelfEchoRef.current.splice(echoIndex, 1);
        setMessages((prev) => prev.filter((message) => message.pendingSteerId !== pendingSteer.id));
        setPendingSteers((pending) => pending.filter((item) => item.id !== pendingSteer.id));
        if (steering) {
          setInput((current) => [text, current].filter(Boolean).join('\n'));
          setPendingAttach((current) => [...imagesToPending(images), ...current]);
        } else {
          setBusyAndClock(false);
        }
        setQueued([]);
        setHistoryHint(t('chat.connError', { msg: String(error) }));
        return 'error';
      }
      return 'ok';
    }

    // ── Normal path ──
    const turnOwnerSid = sessionId ?? activeIdRef.current;
    if (turnOwnerSid) {
      stopDetachedHistoryPoll(turnOwnerSid);
    } else {
      stopDetachedHistoryPoll();
    }
    stopIdleWatch();
    // 新回合已进入投递：程序化停止（立即发送）的抑制标记到此为止，绝不能影响后续真实的用户停止。
    // 立即发送要等 stopped 先吃掉标记；这里提前清掉会让终态把其余排队卡片回吐到输入框。
    if (!opts?.alreadyOnCanvas) {
      programmaticStopMarkRef.current = null;
    }
    const now = Date.now();
    setBusyAndClock(true, now);
    busyRef.current = true;
    if (turnOwnerSid) {
      localTurnSessionsRef.current.add(turnOwnerSid);
      onLiveRunningChange?.(turnOwnerSid, true);
    }

    // Push user message + empty assistant placeholder.
    // 立即发送在点击时已经画过用户气泡：这里只补一个空的 assistant，避免再叠一条。
    const turnIndex = nextTurnNavIndex();
    const turnOrdinal = nextTurnNavOrdinal();
    const paintedAlready = opts?.alreadyOnCanvas === true && messagesRef.current.some((m) => (
      m.role === 'user' && m.parts.some((p) => p.kind === 'text' && userTextsMatch(p.text || '', text))
    ));
    if (!paintedAlready) rememberTurnOutline(text, turnIndex, turnOrdinal);
    setMessages((prev) => {
      let next: Message[] = prev;
      if (!paintedAlready) {
        next = [
          ...prev,
          { role: 'user', parts: [{ kind: 'text', text }], images: images.length ? images : undefined, ts: now, sourceIndex: turnIndex, turnNavOrdinal: turnOrdinal },
          { role: 'assistant', parts: [], sourceIndex: turnIndex + 1 },
        ];
      } else if (prev[prev.length - 1]?.role !== 'assistant') {
        next = [...prev, { role: 'assistant', parts: [], sourceIndex: nextTurnNavIndex(prev) }];
      }
      if (next === prev) return prev;
      messagesRef.current = next;
      const targetSid = sessionId ?? activeIdRef.current;
      if (targetSid) {
        messageCacheRef.current.set(targetSid, next);
        const targetPh = activeSession?.project_hash || projectHashBySessionRef.current.get(targetSid) || '';
        if (targetPh) {
          const currentOutline = turnOutlineRef.current.length > 0 ? turnOutlineRef.current : (turnOutlineBySessionRef.current.get(targetSid) ?? []);
          void saveSessionCache(targetPh, targetSid, next, activeTodosRef.current, undefined, currentOutline, tokensAuthoritativeRef.current);
        }
      }
      return next;
    });

    const controller = new AbortController();
    abortRef.current = controller;
    // Not crypto.randomUUID(): unavailable on http://LAN-IP (non-secure context).
    const requestId = randomUUID();
    requestIdRef.current = requestId;
    activeStreamRequestIdRef.current = requestId;
    const requestGeneration = sessionGenerationRef.current;
    if (turnOwnerSid) {
      localActiveStreamsBySessionRef.current.set(turnOwnerSid, {
        abortController: controller,
        requestId,
      });
    }
    // Fan-out / primary SSE User echo: register optimistic text so handleEvent
    // does not append a second user bubble or drop the empty assistant.
    pendingSelfEchoRef.current.push({ id: requestId, text });
    let boundSessionId = sessionId ?? activeIdRef.current;
    let acceptedWithoutSession = false;
    let keepStopAlias = false;

    try {
      const targetProvider = overrideProvider || provider || undefined;
      const body = {
        message: text,
        ...(sessionId ? { session_id: sessionId } : {}),
        request_id: requestId,
        ...(effectiveWorkingDir ? { working_dir: effectiveWorkingDir } : {}),
        ...(targetProvider ? { provider: targetProvider } : {}),
        ...(images.length ? { images } : {}),
        approval_mode: approvalMode,
      };

      const ack = await postChatPrompt(body, controller.signal);
      const effectiveSid = ack.session_id || boundSessionId || turnOwnerSid;
      if (effectiveSid) {
        boundSessionId = effectiveSid;
        activeIdRef.current = effectiveSid;
        loadedForRef.current = effectiveSid;
        localTurnSessionsRef.current.add(effectiveSid);
        messageCacheRef.current.set(effectiveSid, messagesRef.current);
        onSessionId(effectiveSid);
        onLiveRunningChange?.(effectiveSid, true);
      }
      if (!sessionId || acceptedWithoutSession) {
        acceptedWithoutSession = false;
        if (boundSessionId) onAccepted?.(boundSessionId);
      }
      // 单事件总线架构：提问由后端承认（202 Accepted）并自动发布至广播总线，
      // 前端统一由 watchChatSession 接收全量实时事件与回放，彻底杜绝双流竞态。
      const currentProjectHash =
        activeSession?.project_hash ||
        viewedProjectHashRef.current ||
        (effectiveSid ? projectHashBySessionRef.current.get(effectiveSid) : undefined) ||
        '';
      if (effectiveSid) {
        startDetachedHistoryPoll(currentProjectHash, effectiveSid, sessionGenerationRef.current);
      }
    } catch (err: unknown) {
      const stillCurrent =
        !controller.signal.aborted &&
        (!boundSessionId || !activeIdRef.current || activeIdRef.current === boundSessionId) &&
        (activeStreamRequestIdRef.current === requestId ||
          requestIdRef.current === requestId ||
          (boundSessionId && requestIdRef.current === boundSessionId) ||
          isCurrentChatStream(
            requestId,
            requestGeneration,
            requestIdRef.current,
            sessionGenerationRef.current,
            controller.signal.aborted,
          ));
      const aborted = err instanceof Error && err.name === 'AbortError';
      const msg = err instanceof Error ? err.message : String(err);
      const isConflict =
        (err as any)?.status === 409 ||
        (err as any)?.code === 'session_busy' ||
        msg.includes('409') ||
        msg.includes('Conflict') ||
        msg.includes('session_busy') ||
        msg.includes('already has an active chat operation');
      if (!aborted && stillCurrent && isConflict && opts?.preserveCanvasOnBusy) {
        // 气泡已经在画布上。撤回再退回队列会让它消失，直到刷新才从磁盘回来。
        keepStopAlias = true;
        blockQueueDrainRef.current = true;
        setBusyAndClock(true);
        busyRef.current = true;
        if (turnOwnerSid) {
          backgroundRunningSessionsRef.current.add(turnOwnerSid);
          onLiveRunningChange?.(turnOwnerSid, true);
        }
        return 'busy';
      }
      if (!aborted && stillCurrent) {
        keepStopAlias = true;
        transitionChatRecovery({ type: 'transport_lost' });
        if (isConflict) {
          // 409 Conflict：目标会话当前正在运行其他轮次，绝不能作为连接错误打在助手气泡里！
          // 撤回乐观追加的空 assistant 和 user 气泡，并把未成功发送的消息退回排队队列，保证用户输入不丢失且绝不产生幽灵双份！
          setMessages((prev) => {
            let next = prev.slice();
            if (next.length > 0 && next[next.length - 1].role === 'assistant') {
              const last = next[next.length - 1];
              if (!last.parts || last.parts.length === 0) {
                next.pop();
              }
            }
            if (next.length > 0 && next[next.length - 1].role === 'user') {
              const lastUser = next[next.length - 1];
              const cleanLast = lastUser.parts?.filter((p) => p.kind === 'text').map((p) => p.text || '').join('') ?? '';
              if (cleanLast.trim() === text.trim()) {
                next.pop();
              }
            }
            messagesRef.current = next;
            const currentSid = boundSessionId || turnOwnerSid || activeIdRef.current;
            if (currentSid) {
              messageCacheRef.current.set(currentSid, next);
              const ph = activeSession?.project_hash || projectHashBySessionRef.current.get(currentSid) || '';
              if (ph) {
                const currentOutline = turnOutlineRef.current.length > 0 ? turnOutlineRef.current : (turnOutlineBySessionRef.current.get(currentSid) ?? []);
                void saveSessionCache(ph, currentSid, next, activeTodosRef.current, undefined, currentOutline, tokensAuthoritativeRef.current);
              }
            }
            return next;
          });
          setQueued((prev) => {
            if (prev.some((q) => q.text === text)) return prev;
            return [...prev, { id: queueIdRef.current++, text, images, approvalMode, kind: 'queue' as const }];
          });
          pushCommandNotice(t('chat.sessionBusyQueued'));
        } else {
          appendToLastAssistant('\n\n' + t('chat.connError', { msg }));
        }
      }
      if (stillCurrent) {
        const errorSid = boundSessionId || turnOwnerSid || activeIdRef.current;
        if (errorSid) {
          sessionWatchersRef.current.get(errorSid)?.abort();
          sessionWatchersRef.current.delete(errorSid);
          localActiveStreamsBySessionRef.current.delete(errorSid);
          pendingSelfEchoBySessionRef.current.delete(errorSid);
        }
        pendingSelfEchoRef.current = pendingSelfEchoRef.current.filter((p) => p.id !== requestId);
        if (isConflict) {
          // 会话仍处于活跃执行中，维持 busy 状态与看门狗，安全挂起自动 drain
          setBusyAndClock(true);
          busyRef.current = true;
          if (turnOwnerSid) {
            backgroundRunningSessionsRef.current.add(turnOwnerSid);
            onLiveRunningChange?.(turnOwnerSid, true);
          }
        } else {
          setBusyAndClock(false);
          if (turnOwnerSid) {
            localTurnSessionsRef.current.delete(turnOwnerSid);
            onLiveRunningChange?.(turnOwnerSid, false);
          }
        }
        blockQueueDrainRef.current = true; // 连接错误或并发冲突：暂停自动 drain，但坚决保留排队与转向消息不丢失
        // 中止/连接错误时流被掐断，不会再有 done/stopped 事件 → 兜底清掉审批卡片，
        // 否则点「停止」时若正挂着审批卡片，它会一直残留。
        onPermissionResolved?.(null);
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (activeStreamRequestIdRef.current === requestId) activeStreamRequestIdRef.current = null;
      if (
        requestIdRef.current === requestId &&
        sessionGenerationRef.current === requestGeneration &&
        !keepStopAlias
      ) requestIdRef.current = null;
    }
    return 'ok';
  }

  async function sendMessage(explicitText?: string | Event) {
    const rawText = typeof explicitText === 'string' ? explicitText : input;
    const currentTargetSid = sessionId ?? activeIdRef.current;
    if (currentTargetSid) {
      clearManualStopGuard(currentTargetSid);
    }
    const originalInput = rawText;
    const submittedContext = historyContext;
    const recordAcceptedInput = (acceptedSessionId?: string) => inputHistoryRef.current.record(
      !sessionId && acceptedSessionId ? inputHistoryKey(historyProject, acceptedSessionId) : submittedContext,
      originalInput,
    );
    const text = rawText.trim();
    const attach = pendingAttach;
    const images = pendingImageData(attach);
    const files = attach.filter((item): item is PendingFile => item.kind === 'file');
    if (modeState.pendingMode) return;
    if (compactingRef.current) return;
    if (uploading) return;
    if (!text && attach.length === 0) return;

    // 斜杠命令拦截：命中已知命令则执行且不作为聊天发送。带附件时不拦截。
    if (attach.length === 0) {
      const parsed = parseSlashCommand(text);
      if (parsed && slashCommandMap.has(parsed.name)) {
        setInput('');
        setPendingAttach([]);
        clearComposerDraft(activeIdRef.current || sessionId);
        clearComposerDraft(null);
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
        setSlashOpen(false);
        setHistoryHint(null);
        try {
          const result = await dispatchSlashCommand(text, slashCommandMap, slashHandlers);
          if (result.handled) recordAcceptedInput();
        } catch (e) {
          pushCommandNotice(t('chat.connError', { msg: e instanceof Error ? e.message : String(e) }));
        }
        return;
      }
    }

    if (!chatRecoveryPolicy(chatRecoveryRef.current).allowSend) {
      pushCommandNotice(
        chatRecoveryRef.current === 'detached_active'
          ? t('chat.detachedSendBlocked')
          : t('chat.recoveryBlocked'),
      );
      return;
    }

    let messageText = text;
    if (files.length > 0) {
      if (!effectiveWorkingDir) {
        setAttachError(t('attach.noCwd'));
        return;
      }
      setAttachError(null);
      setInput('');
      setPendingAttach([]);
      clearComposerDraft(activeIdRef.current || sessionId);
      clearComposerDraft(null);
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
      setUploading(true);
      try {
        const paths = await uploadSessionFiles(
          effectiveWorkingDir,
          files.map((item) => item.file),
          setUploadProgress,
        );
        messageText = formatUserMessageWithAttachments(text, paths);
      } catch (error) {
        setPendingAttach((current) => {
          if (current.length === 0) return attach;
          const seen = new Set(current.map((item) => item.id));
          return [...attach.filter((item) => !seen.has(item.id)), ...current];
        });
        setInput((current) => current.trim() ? current : text);
        setAttachError(t('attach.uploadFailed', { msg: error instanceof Error ? error.message : String(error) }));
        setUploading(false);
        setUploadProgress(null);
        return;
      }
      setUploading(false);
      setUploadProgress(null);
    } else {
      // 清空输入框（无论立即发送还是排队）。有文件时已在上传开始时清过，避免覆盖用户新输入。
      setInput('');
      setPendingAttach([]);
      clearComposerDraft(activeIdRef.current || sessionId);
      clearComposerDraft(null);
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    }
    setHistoryHint(null);

    const userDelta = estimateTextTokens(messageText);
    lastUserTokensRef.current = userDelta;
    // New user turn: keep lastPrompt so the first LLM round can estimate
    // prefix cache; zero the loop accumulators (industrial Σ-over-steps).
    tokenCacheRef.current = startTokenTurn(tokenCacheRef.current);
    if (userDelta > 0) {
      setTokens((prev) => mergeLocalTokens(prev, {
        prompt: (prev?.prompt ?? 0) + userDelta,
        completion: prev?.completion ?? 0,
        total: (prev?.total ?? 0) + userDelta,
        reasoning: 0,
      }));
    }

    // Sync mode shares the native runtime, so an active-turn submit is an
    // authoritative steer. The legacy /chat path has no steer transport and
    // intentionally keeps its next-turn queue semantics.
    if (busy) {
      if (attachedToLiveRuntime()) {
        await deliver(messageText, images, modeState.confirmedMode, recordAcceptedInput);
        return;
      }
      setQueued((q) => [
        ...q,
        {
          id: queueIdRef.current++,
          text: messageText,
          images: images.length ? images : undefined,
          approvalMode: modeState.confirmedMode,
          kind: 'queue',
        },
      ]);
      recordAcceptedInput(); // Accepted into this session's next-turn queue.
      return;
    }

    await deliver(messageText, images, modeState.confirmedMode, recordAcceptedInput);
  }

  // 当前回合结束(done)后，依次发送仍在排队的消息。已转向的消息由内核在下一步并入本轮，不再另开一回合。
  useEffect(() => {
    if (blockQueueDrainRef.current) {
      blockQueueDrainRef.current = false;
      return;
    }
    const currentSid = activeIdRef.current || sessionId;
    const isSessionLoading = loading || (currentSid != null && loadedForRef.current !== currentSid);
    const isSessionRunning =
      busy ||
      (currentSid != null && (
        backgroundRunningSessionsRef.current.has(currentSid) ||
        localTurnSessionsRef.current.has(currentSid)
      ));
    if (
      isSessionRunning ||
      queued.length === 0 ||
      modeState.pendingMode ||
      isSessionLoading ||
      !chatRecoveryPolicy(chatRecoveryRef.current).allowQueueDrain
    ) return;

    // 关键防线：比对内容必须采用 visibleUserText 规范化与 userTextsMatch，
    // 不仅检查当前的 messages state，还要检查 messageCacheRef 中的完整缓存！
    const allKnownMessages = [
      ...messages,
      ...(currentSid ? (messageCacheRef.current.get(currentSid) ?? []) : []),
    ];
    const hasTextInMessages = (text: string) => {
      const clean = visibleUserText(text).trim();
      if (!clean) return false;
      return allKnownMessages.some((m) => {
        if (m.role !== 'user') return false;
        const msgText = visibleUserText(
          m.parts?.filter((p) => p.kind === 'text').map((p) => p.text || '').join('') ?? ''
        ).trim();
        return msgText === clean || userTextsMatch(msgText, clean);
      });
    };

    const alreadyDelivered = queued.filter((item) => !item.forceSend && hasTextInMessages(item.text));
    if (alreadyDelivered.length > 0) {
      setQueued((current) => current.filter((item) => item.forceSend || !hasTextInMessages(item.text)));
      return;
    }

    const next = queuedRef.current.find((item) => item.kind === 'queue' && item.forceSend)
      ?? queuedRef.current.find((item) => item.kind === 'queue');
    if (!next) return;
    if (!next.forceSend && hasTextInMessages(next.text)) {
      setQueued((current) => current.filter((item) => item.id !== next.id));
      return;
    }
    dispatchQueuedCard(next);
    // deliver 为组件内函数声明，闭包始终取最新渲染值；仅以 busy/queued 触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, queued, messages, loading, modeState.pendingMode, chatRecovery]);

  /** Stop / 外部停止：把还没发出去的队列（含尚未确认的转向）整段还回输入框。 */
  function restoreQueuedToComposer() {
    const items = queuedRef.current;
    if (items.length === 0) return;
    blockQueueDrainRef.current = true;
    const steerItems = items.filter((item) => item.kind === 'steer' || item.kind === 'steering');
    if (steerItems.length > 0) {
      const targetSid = sessionId ?? activeIdRef.current ?? requestIdRef.current;
      if (targetSid) {
        for (const item of steerItems) {
          void cancelChatSteer(targetSid, item.text);
        }
      }
    }
    setQueued([]);
    setInput((current) => mergeQueuedIntoDraft(items, current, []).text);
    const queuedImages = items.flatMap((item) => item.images ?? []);
    if (queuedImages.length > 0) {
      setPendingAttach((current) => [
        ...current,
        ...imagesToPending(queuedImages),
      ]);
    }
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 240)}px`;
      }
    }, 0);
  }

  /** 用户点击排队消息上的 × 撤回：从队列移除并完整回填文字与全部图片到输入框，避免输入前功尽弃。 */
  function handleCancelQueuedMessage(q: QueuedMessage) {
    // 关键防线：如果该消息已经作为转向投递给了后端（kind === 'steer' 或 'steering'），
    // 必须立即通知后端撤回内核缓冲区中的该转向，防止下一小步或下一轮被执行！
    if (q.kind === 'steer' || q.kind === 'steering') {
      const targetSid = sessionId ?? activeIdRef.current ?? requestIdRef.current;
      if (targetSid) {
        void cancelChatSteer(targetSid, q.text);
      }
    }

    setQueued((arr) => arr.filter((x) => x.id !== q.id));
    const targetSid = sessionId ?? activeIdRef.current ?? requestIdRef.current;
    if (targetSid) {
      const currentList = queuedBySessionRef.current.get(targetSid) ?? [];
      const updatedList = currentList.filter((item) => item.id !== q.id);
      if (updatedList.length > 0) {
        queuedBySessionRef.current.set(targetSid, updatedList);
      } else {
        queuedBySessionRef.current.delete(targetSid);
      }
      saveQueuedToStorage(queuedBySessionRef.current);
      void saveChatQueue(targetSid, updatedList.map(serializeQueuedCard) as QueuedMessageApiItem[]);
    }

    if (q.text) {
      setInput((current) => (current.trim() ? `${q.text}\n${current}` : q.text));
    }

    if (q.images && q.images.length > 0) {
      const restoredImages: PendingAttach[] = q.images.map((img, idx) => ({
        id: `restored-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
        kind: 'image' as const,
        image: img,
      }));
      setPendingAttach((current) => [...current, ...restoredImages]);
    }

    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 240)}px`;
      }
    }, 0);
  }

  /**
   * Steer a queued follow-up into the running turn.
   * The daemon does not cancel the in-flight model call or tool batch; the kernel
   * folds the text (plus a short course-correction note) in at the next step.
   */
  async function handleSteerQueuedMessage(q: QueuedMessage) {
    if (q.kind !== 'queue') return;
    // request id is an admission alias before session_assigned lands on a new chat.
    const sid = sessionId ?? activeIdRef.current ?? requestIdRef.current;
    if (sid) {
      recordUserSteer(sid);
    }
    if (!sid) {
      pushCommandNotice(t('chat.steerFailed', { msg: 'no session' }));
      return;
    }
    const targetSid = sid;
    // 客户端关联键：随卡片持久化，刷新后与内核回传的 client_input_ids 对账。
    const clientInputId = q.clientInputId ?? randomUUID();
    const updateTargetQueued = (updater: (item: QueuedMessage) => QueuedMessage) =>
      // 定向更新目标会话队列：前台/后台两态与 localStorage、后端 `/chat/queue` 三处同步。
      updateQueuedForSession(targetSid, (items) =>
        items.map((item) => (item.id === q.id ? updater(item) : item)),
      );

    updateTargetQueued((item) => ({ ...item, kind: 'steering' as const, clientInputId }));
    try {
      await postChatSteer(targetSid, q.text, q.images, clientInputId);
      // 成功投递后，卡片保留并更新为 'steer' 状态（展示「转向已排队 · 等待当前步骤完成」与取消按钮）！
      updateTargetQueued((item) => ({ ...item, kind: 'steer' as const }));
    } catch (error) {
      updateTargetQueued((item) => (item.kind === 'steering' ? { ...item, kind: 'queue' as const } : item));
      pushCommandNotice(t('chat.steerFailed', { msg: error instanceof Error ? error.message : String(error) }));
    }
  }

  /**
   * 停止运行中的回合：WebUI「停止」按钮与排队卡「立即发送」共用的唯一停止通道。
   *
   * 别名策略见 `runningTurnStopAliases`：本端回合被 /chat admit（202 已受理）之后 requestIdRef
   * 即被清空，会话 id 才是长期有效的停止别名，只认 request id 会让停止被整体跳过。
   * 后端 /chat/stop 经由 stop_and_wait 同步等待上一回合完全退出注册表，await 返回即代表槽位已释放，
   * 调用方可以 0 延迟发起新的投递（绝不 409 抢跑）。
   */
  async function stopRunningTurn(currentSid: string | null, requestAlias: string | null): Promise<boolean> {
    const stopPromises: Promise<boolean>[] = runningTurnStopAliases({
      requestAlias,
      sessionId: currentSid,
    }).map((alias) => stopChat(alias).then((result) => stopAliasAllowsNextTurn(result), () => false));
    // 运行时（native live）回合由 /live 停止兜底，与「停止」按钮的历史行为保持一致。
    if (currentSid && (attachedToLiveRuntime() || liveSessionIdRef.current)) {
      stopPromises.push(postLiveStop(currentSid).then(() => true, () => false));
    }
    if (stopPromises.length === 0) return true; // 无停止目标：本就空闲
    const results = await Promise.all(stopPromises);
    return results.every(Boolean);
  }

  /**
   * 队列卡片的唯一投递出口：出队（内存 / localStorage / 后端三处同步）后立刻作为新回合发出。
   * 卡片随消息真正成为正文而自然销毁——drain 自动发送与「立即发送」共用此通道。
   */
  function dispatchQueuedCard(item: QueuedMessage) {
    // 以 ref 为准做去重：两个投递入口可能在同一批渲染里竞争同一张卡片。
    if (!queuedRef.current.some((entry) => entry.id === item.id)) return;
    setQueued((current) => current.filter((entry) => entry.id !== item.id));
    const opts = item.forceSend
      ? { alreadyOnCanvas: true, preserveCanvasOnBusy: true as const }
      : undefined;
    void deliver(item.text, item.images ?? [], item.approvalMode ?? modeState.confirmedMode, undefined, undefined, opts)
      .then((outcome) => {
        if (outcome !== 'busy' || !item.forceSend) return;
        blockQueueDrainRef.current = true;
        setQueued((current) => (
          current.some((entry) => entry.id === item.id) ? current : [item, ...current]
        ));
      });
  }

  /** 立即发送：点击当下就把卡片画成用户气泡，不等停止和投递的网络往返。 */
  function paintSendNowUserBubble(text: string, images: ImageData[]) {
    const clean = visibleUserText(text).trim();
    if (clean && messagesRef.current.some((m) => (
      m.role === 'user'
      && m.parts.some((p) => p.kind === 'text' && userTextsMatch(p.text || '', clean))
    ))) {
      return;
    }
    const now = Date.now();
    const turnIndex = nextTurnNavIndex();
    const turnOrdinal = nextTurnNavOrdinal();
    rememberTurnOutline(text, turnIndex, turnOrdinal);
    const next: Message[] = [
      ...messagesRef.current,
      {
        role: 'user',
        parts: [{ kind: 'text', text }],
        images: images.length ? images : undefined,
        ts: now,
        sourceIndex: turnIndex,
        turnNavOrdinal: turnOrdinal,
      },
    ];
    messagesRef.current = next;
    const sid = activeIdRef.current ?? sessionId;
    if (sid) messageCacheRef.current.set(sid, next);
    setMessages(next);
    timelineFollow.jump();
  }

  /**
   * 立即发送 = 卡片立刻变成用户气泡，停掉当前回合，再把这条消息作为新回合发出。
   * 右下角「已停止」通知仍被抑制。槽位一时没松开就短重试；气泡不再等到刷新才出现。
   */
  async function handleSendImmediately(q: QueuedMessage) {
    const viewSid = activeIdRef.current ?? sessionId ?? null;
    const currentSid = liveSessionIdRef.current ?? viewSid;

    const targetIds = [currentSid, sessionId, liveSessionIdRef.current, activeIdRef.current, requestIdRef.current].filter(Boolean) as string[];
    for (const sid of targetIds) {
      recordUserManualStop(sid);
      recordUserSteer(sid);
    }

    if (queuedRef.current.some((item) => item.id === q.id)) {
      setQueued((items) => items.filter((item) => item.id !== q.id));
    } else if (currentSid) {
      updateQueuedForSession(currentSid, (items) => items.filter((item) => item.id !== q.id));
    }
    paintSendNowUserBubble(q.text, q.images ?? []);

    // 标记必须用 stopped 处理器比对的那个会话 id，否则终态会把队列回吐到输入框。
    if (viewSid) {
      programmaticStopMarkRef.current = {
        sessionId: viewSid,
        expiresAt: Date.now() + PROGRAMMATIC_STOP_MARK_TTL_MS,
      };
    }
    abortRef.current?.abort();

    if (currentSid && (q.kind === 'steer' || q.kind === 'steering')) {
      try {
        await cancelChatSteer(currentSid, q.text);
      } catch {
        // 取消失败不阻断：下面仍会停掉旧回合，再作为新回合发出。
      }
    }

    const text = q.text;
    const images = q.images ?? [];
    const mode = q.approvalMode ?? modeState.confirmedMode;
    for (let attempt = 0; attempt < 5; attempt++) {
      const released = await stopRunningTurn(currentSid, requestIdRef.current);
      if (!released) {
        await new Promise((resolve) => window.setTimeout(resolve, 250));
        continue;
      }
      const outcome = await deliver(text, images, mode, undefined, undefined, {
        alreadyOnCanvas: true,
        preserveCanvasOnBusy: true,
      });
      if (outcome !== 'busy') return;
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
    const card: QueuedMessage = { ...q, kind: 'queue', forceSend: true };
    setQueued((current) => (
      current.some((entry) => entry.id === card.id) ? current : [...current, card]
    ));
  }

  function handleBubbleDraftChange(
    sourceIndex: number,
    text: string,
    images: ImageData[],
    selectedModel?: string,
  ) {
    if (
      bubbleEditDraft &&
      bubbleEditDraft.sourceIndex === sourceIndex &&
      bubbleEditDraft.text === text &&
      bubbleEditDraft.selectedModel === selectedModel &&
      (bubbleEditDraft.images?.length ?? 0) === (images?.length ?? 0)
    ) {
      return;
    }
    const draft: BubbleEditDraft = {
      sourceIndex,
      text,
      images,
      selectedModel,
    };
    setBubbleEditDraft(draft);
    const sid = activeIdRef.current || sessionId || activeSession?.id;
    if (sid) {
      saveBubbleEditDraft(sid, draft);
    }
  }

  async function handleSaveRewrite(sourceIndex: number, newText: string, newImages: ImageData[]) {
    const sid = activeIdRef.current || sessionId || activeSession?.id;
    const effectiveHash =
      projectHashBySessionRef.current.get(sid || '') ||
      viewedProjectHashRef.current ||
      activeSession?.project_hash ||
      '';
    if (!sid || !effectiveHash) return;

    const targetMsg = messagesRef.current.find((m) => m.sourceIndex === sourceIndex);
    const expectedText = targetMsg ? messageText(targetMsg) : undefined;

    try {
      await patchSessionMessage(effectiveHash, sid, sourceIndex, {
        text: newText,
        images: newImages,
        expected_text: expectedText,
        expected_role: 'user',
      });
      // 乐观更新：画布与内存缓存同步更新！
      let nextMessages: Message[] = [];
      setMessages((prev) => {
        const next = prev.slice();
        const idx = next.findIndex((m) => m.sourceIndex === sourceIndex);
        if (idx !== -1) {
          next[idx] = {
            ...next[idx],
            parts: [{ kind: 'text', text: newText }],
            images: newImages.length ? newImages : undefined,
          };
        }
        messagesRef.current = next;
        messageCacheRef.current.set(sid, next);
        nextMessages = next;
        return next;
      });
      // 权威反向灌入缓存：同步覆盖 L1 内存和 L2 IndexedDB (杜绝刷新延时与时间差)
      const currentOutline = turnOutlineRef.current.length > 0 ? turnOutlineRef.current : (turnOutlineBySessionRef.current.get(sid) ?? []);
      void saveSessionCache(effectiveHash, sid, nextMessages, activeTodosRef.current, undefined, currentOutline, tokensAuthoritativeRef.current);
      setEditingSourceIndex(null);
      setBubbleEditDraft(null);
      clearBubbleEditDraft(sid);
    } catch (e) {
      showToast(t('common.error') + ': ' + (e instanceof Error ? e.message : String(e)), 'error');
    }
  }

  function handleRollbackSubmit(
    sourceIndex: number,
    newText: string,
    newImages: ImageData[],
    tempModel?: string,
  ) {
    const sid = activeIdRef.current || sessionId || activeSession?.id;
    const effectiveHash =
      projectHashBySessionRef.current.get(sid || '') ||
      viewedProjectHashRef.current ||
      activeSession?.project_hash ||
      'default';
    if (!sid) return;

    const targetMsg = messagesRef.current.find((m) => m.sourceIndex === sourceIndex);
    const expectedText = targetMsg ? messageText(targetMsg) : undefined;

    setConfirmModal({
      open: true,
      title: t('confirm.rollbackTitle'),
      body: t('confirm.rollbackDesc'),
      danger: true,
      confirmLabel: t('confirm.confirmBtn'),
      cancelLabel: t('common.cancel'),
      onConfirm: async () => {
        await truncateSession(effectiveHash, sid, {
          target_index: sourceIndex,
          expected_text: expectedText,
          expected_role: 'user',
          inclusive: false,
        });
        // 乐观截断：画布与内存缓存同步截断！
        let truncated: Message[] = [];
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.sourceIndex === sourceIndex);
          if (idx !== -1) {
            const next = prev.slice(0, idx);
            messagesRef.current = next;
            messageCacheRef.current.set(sid, next);
            truncated = next;
            return next;
          }
          return prev;
        });
        // 权威反向灌入缓存
        const filteredTurns = turnOutlineRef.current.filter((t) => t.index < sourceIndex);
        turnOutlineRef.current = filteredTurns;
        turnOutlineBySessionRef.current.set(sid, filteredTurns);
        setTurnOutline(filteredTurns);
        void saveSessionCache(effectiveHash, sid, truncated, activeTodosRef.current, undefined, filteredTurns, tokensAuthoritativeRef.current);
        setEditingSourceIndex(null);
        setBubbleEditDraft(null);
        clearBubbleEditDraft(sid);
        // Deliver the updated prompt
        window.setTimeout(() => {
          void deliver(newText, newImages, modeState.confirmedMode, undefined, tempModel);
        }, 100);
      },
    });
  }

  function handleDeleteUserMessage(sourceIndex: number, expectedText?: string) {
    const sid = activeIdRef.current || sessionId || activeSession?.id;
    const effectiveHash =
      projectHashBySessionRef.current.get(sid || '') ||
      viewedProjectHashRef.current ||
      activeSession?.project_hash ||
      '';
    if (!sid || !effectiveHash) return;

    const targetMsg = messagesRef.current.find((m) => m.sourceIndex === sourceIndex);
    const expected = expectedText || (targetMsg ? messageText(targetMsg) : undefined);

    setConfirmModal({
      open: true,
      title: t('confirm.deleteTurnTitle'),
      body: t('confirm.deleteTurnDesc'),
      danger: true,
      confirmLabel: t('confirm.confirmBtn'),
      cancelLabel: t('common.cancel'),
      onConfirm: async () => {
        try {
          await deleteSessionMessage(effectiveHash, sid, sourceIndex, {
            delete_turn: true,
            expected_text: expected,
            expected_role: 'user',
          });
        } catch (err) {
          console.warn('[Chat] Failed to delete session turn on backend:', err);
        }
        let nextMessages: Message[] = [];
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.sourceIndex === sourceIndex);
          if (idx === -1) return prev;
          const next = prev.slice();
          let end = idx + 1;
          while (end < next.length && next[end]?.role !== 'user') {
            end += 1;
          }
          next.splice(idx, end - idx);
          messagesRef.current = next;
          messageCacheRef.current.set(sid, next);
          nextMessages = next;
          return next;
        });
        // 权威反向灌入缓存：同步覆盖 L1 内存和 L2 IndexedDB 与轮次导航！
        const currentOutline = (turnOutlineRef.current.length > 0 ? turnOutlineRef.current : (turnOutlineBySessionRef.current.get(sid) ?? []))
          .filter((t) => t.index !== sourceIndex);
        turnOutlineRef.current = currentOutline;
        turnOutlineBySessionRef.current.set(sid, currentOutline);
        setTurnOutline(currentOutline);
        void saveSessionCache(effectiveHash, sid, nextMessages, activeTodosRef.current, undefined, currentOutline, tokensAuthoritativeRef.current);
        if (editingSourceIndex === sourceIndex) {
          setEditingSourceIndex(null);
          setBubbleEditDraft(null);
          clearBubbleEditDraft(sid);
        }
      },
    });
  }

  function handleRegenerateAssistant(sourceIndex: number, assistantOrigIdx: number) {
    const sid = activeIdRef.current || sessionId || activeSession?.id;
    const effectiveHash =
      projectHashBySessionRef.current.get(sid || '') ||
      viewedProjectHashRef.current ||
      activeSession?.project_hash ||
      '';
    if (!sid || !effectiveHash) return;

    // Find preceding user message
    let userMsgIdx = -1;
    for (let i = assistantOrigIdx - 1; i >= 0; i--) {
      if (messages[i]?.role === 'user') {
        userMsgIdx = i;
        break;
      }
    }
    if (userMsgIdx === -1) return;
    const userMsg = messages[userMsgIdx];
    const userText = messageText(userMsg);
    const userImages = userMsg.images ?? [];
    const userSourceIndex = userMsg.sourceIndex ?? userMsgIdx;

    setConfirmModal({
      open: true,
      title: t('confirm.rollbackTitle'),
      body: t('confirm.rollbackDesc'),
      danger: false,
      confirmLabel: t('confirm.confirmBtn'),
      cancelLabel: t('common.cancel'),
      onConfirm: async () => {
        await truncateSession(effectiveHash, sid, {
          target_index: userSourceIndex,
          expected_text: userText,
          expected_role: 'user',
          inclusive: false,
        });
        let nextMessages: Message[] = [];
        setMessages((prev) => {
          const next = prev.slice(0, userMsgIdx);
          messagesRef.current = next;
          messageCacheRef.current.set(sid, next);
          nextMessages = next;
          return next;
        });
        // 权威反向灌入缓存
        const filteredTurns = turnOutlineRef.current.filter((t) => t.index < userSourceIndex);
        turnOutlineRef.current = filteredTurns;
        turnOutlineBySessionRef.current.set(sid, filteredTurns);
        setTurnOutline(filteredTurns);
        void saveSessionCache(effectiveHash, sid, nextMessages, activeTodosRef.current, undefined, filteredTurns, tokensAuthoritativeRef.current);
        window.setTimeout(() => {
          void deliver(userText, userImages, modeState.confirmedMode);
        }, 100);
      },
    });
  }

  function handleDeleteAssistantMessage(sourceIndex: number, origIdx: number) {
    const sid = activeIdRef.current || sessionId || activeSession?.id;
    const effectiveHash =
      projectHashBySessionRef.current.get(sid || '') ||
      viewedProjectHashRef.current ||
      activeSession?.project_hash ||
      '';
    if (!sid || !effectiveHash) return;

    const targetMsg = messagesRef.current[origIdx];
    // 优先提取助手正文文本进行精准对齐，兜底采用全文（包含思考过程）
    const mainText = targetMsg?.parts.filter((p) => p.kind === 'text').map((p) => p.text).join('\n').trim();
    const expected = mainText || (targetMsg ? messageText(targetMsg).trim() : undefined);

    // 向上寻找前置 user 消息以确定该轮次助手的起点坐标
    let userSourceIndex: number | undefined;
    for (let i = origIdx - 1; i >= 0; i--) {
      if (messagesRef.current[i]?.role === 'user') {
        userSourceIndex = messagesRef.current[i]?.sourceIndex;
        break;
      }
    }
    const resolvedIndex = targetMsg?.sourceIndex ?? (userSourceIndex != null ? userSourceIndex + 1 : sourceIndex);

    setConfirmModal({
      open: true,
      title: t('confirm.deleteTitle'),
      body: t('confirm.deleteDesc'),
      danger: true,
      confirmLabel: t('confirm.confirmBtn'),
      cancelLabel: t('common.cancel'),
      onConfirm: async () => {
        try {
          await deleteSessionMessage(effectiveHash, sid, resolvedIndex, {
            delete_turn: false,
            expected_text: expected,
            expected_role: 'assistant',
          });
        } catch (err) {
          console.warn('[Chat] Failed to delete assistant message on backend:', err);
        }
        let nextMessages: Message[] = [];
        setMessages((prev) => {
          const next = prev.slice();
          if (origIdx >= 0 && origIdx < next.length) {
            next.splice(origIdx, 1);
          }
          messagesRef.current = next;
          messageCacheRef.current.set(sid, next);
          nextMessages = next;
          return next;
        });
        // 权威反向灌入缓存
        const currentOutline = turnOutlineRef.current.length > 0 ? turnOutlineRef.current : (turnOutlineBySessionRef.current.get(sid) ?? []);
        void saveSessionCache(effectiveHash, sid, nextMessages, activeTodosRef.current, undefined, currentOutline, tokensAuthoritativeRef.current);
      },
    });
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;

    // 斜杠菜单导航（使用与渲染层一致的合并列表：本地命令 + 远程技能）
    if (slashOpen) {
      const mergedItems = buildSlashMenuItems(FRONTEND_COMMANDS, slashSkills ?? [], slashQuery, t as (k: string) => string, slashSkillsOnly);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((i) => Math.min(i + 1, mergedItems.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter' && mergedItems.length > 0) {
        e.preventDefault();
        const selected = mergedItems[slashIndex];
        const cmdDef = selected.kind === 'command' ? FRONTEND_COMMANDS.find((c) => c.name === selected.name) : undefined;
        // 如果是无必选参数的命令（如 /init, /plan, /build, /new, /clear 等），按下回车直接执行
        if (selected.kind === 'command' && cmdDef && !cmdDef.argHint) {
          setSlashOpen(false);
          setInput('');
          void sendMessage(`/${selected.name}`);
          return;
        }
        insertSkill(selected.name);
        return;
      }
      if (e.key === 'Escape') {
        setSlashOpen(false);
        return;
      }
    }

    // @ 菜单导航
    if (atOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAtIndex((i) => Math.min(i + 1, atRows.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAtIndex((i) => Math.max(i - 1, 0));
        return;
      }
      // Enter/Tab：目录→进入，文件→选定。Tab 便于逐级深入。
      if ((e.key === 'Enter' || e.key === 'Tab') && atRows.length > 0) {
        e.preventDefault();
        chooseAtRow(atRows[Math.min(atIndex, atRows.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        setAtOpen(false);
        return;
      }
    }

    if (canNavigateInputHistory({
      key: e.key, defaultPrevented: e.defaultPrevented, isComposing: e.isComposing,
      keyCode: e.keyCode, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey,
      shiftKey: e.shiftKey, currentTarget: textareaRef.current,
    })) {
      inputHistoryRef.current.switchContext(historyContext);
      const direction = e.key === 'ArrowUp' ? 'up' : 'down';
      const next = inputHistoryRef.current.navigate(direction, input);
      if (next !== null) {
        e.preventDefault();
        const position = direction === 'up' ? 0 : next.length;
        if (next === input) {
          textareaRef.current?.setSelectionRange(position, position);
        } else {
          pendingHistoryCaretRef.current = { context: historyContext, value: next, position };
          setInput(next);
        }
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      if (e.isComposing || e.keyCode === 229) {
        return;
      }
      const isMobileDevice = typeof window !== 'undefined' && (
        window.innerWidth <= 768 || ('ontouchstart' in window && window.innerWidth <= 1024)
      );
      if (isMobileDevice) {
        // 移动端/触控屏软键盘上回车为真实换行，避免误触发自动发送
        return;
      }
      e.preventDefault();
      sendMessage();
    }
  }

  async function handleStop() {
    const currentSid = liveSessionIdRef.current ?? sessionId ?? activeIdRef.current;
    const requestAlias = requestIdRef.current;
    // 用户主动停止：无论此前是否发生过程序化停止，都复位抑制标记，保证排队内容照常回吐输入框。
    programmaticStopMarkRef.current = null;
    if (currentSid) {
      markSessionManuallyStopped(currentSid);
      sessionWatchersRef.current.get(currentSid)?.abort();
      sessionWatchersRef.current.delete(currentSid);
      localActiveStreamsBySessionRef.current.delete(currentSid);
      localTurnSessionsRef.current.delete(currentSid);
      backgroundRunningSessionsRef.current.delete(currentSid);
      onLiveRunningChange?.(currentSid, false);
    }
    if (requestAlias && requestAlias !== currentSid) {
      markSessionManuallyStopped(requestAlias);
      localActiveStreamsBySessionRef.current.delete(requestAlias);
      localTurnSessionsRef.current.delete(requestAlias);
      backgroundRunningSessionsRef.current.delete(requestAlias);
      onLiveRunningChange?.(requestAlias, false);
    }
    restoreQueuedToComposer();

    const localStream = currentSid ? localActiveStreamsBySessionRef.current.get(currentSid) : undefined;
    localStream?.abortController.abort();
    abortRef.current?.abort();
    abortRef.current = null;
    activeStreamRequestIdRef.current = null;
    requestIdRef.current = null;
    stopDetachedHistoryPoll(currentSid ?? undefined);
    stopIdleWatch();

    // 乐观立即复位界面状态：红色停止方块立刻变回白蓝色发送箭头，提供确定的即时反馈
    setBusyAndClock(false);
    busyRef.current = false;
    transitionChatRecovery({ type: 'stop_succeeded' });
    onPermissionResolved?.(null);
    pushCommandNotice(t('chat.detachedStopped'));

    try {
      await stopRunningTurn(currentSid, requestAlias);
    } catch (error) {
      pushNoticeToLastAssistant(t('chat.cancelFailed', { error: String(error) }));
    } finally {
      finalizePendingToolsOnCanvas();
      // 强制确保终态归位，防止任何意外残留状态
      setBusyAndClock(false);
      busyRef.current = false;
      transitionChatRecovery({ type: 'stop_succeeded' });
      if (currentSid) {
        backgroundRunningSessionsRef.current.delete(currentSid);
        localTurnSessionsRef.current.delete(currentSid);
        onLiveRunningChange?.(currentSid, false);
      }
      if (requestAlias) {
        backgroundRunningSessionsRef.current.delete(requestAlias);
        localTurnSessionsRef.current.delete(requestAlias);
        onLiveRunningChange?.(requestAlias, false);
      }
      const projectHash =
        activeSession?.project_hash ||
        viewedProjectHashRef.current ||
        (currentSid ? projectHashBySessionRef.current.get(currentSid) : undefined) ||
        '';
      const loadGeneration = sessionGenerationRef.current;
      if (projectHash && currentSid) {
        startIdleWatch(projectHash, currentSid, loadGeneration);
        // 停止通道已 await 后端真实释放（快照已落盘）：立刻磁盘对账一次，
        // 把被 abort 掉的那条流可能丢掉的最后一段正文补回画布（无需刷新/失焦）。
        settleDiskCatchUp(projectHash, currentSid);
      }
    }
  }

  // 从光标前的 / 替换为选中的技能名。
  function insertSkill(name: string) {
    const ta = textareaRef.current;
    if (!ta) return;
    const pos = ta.selectionStart ?? ta.value.length;
    const before = ta.value.slice(0, pos);
    const after = ta.value.slice(pos);
    const slashIdx = before.lastIndexOf('/');
    const next = before.slice(0, slashIdx) + `/${name} ` + after;
    setInput(next);
    setSlashOpen(false);
    requestAnimationFrame(() => {
      ta.focus();
      const newPos = slashIdx + name.length + 2;
      ta.setSelectionRange(newPos, newPos);
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
    });
  }

  // 把当前 @ 段替换为相对路径 rel，不自动追加空格，目录可继续下钻补全。
  function setAtMention(rel: string, isDir: boolean) {
    const ta = textareaRef.current;
    if (!ta) return;
    const pos = ta.selectionStart ?? ta.value.length;
    const range = detectAtMentionRange(ta.value, pos);
    if (!range) return;
    const next = applyAtMentionSelection(ta.value, range, rel, isDir);
    setInput(next.text);
    setAtOpen(next.keepOpen);
    setAtQuery(next.query);
    if (next.keepOpen) setAtItems([]);
    setAtIndex(0);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(next.cursor, next.cursor);
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
    });
  }

  // 选择 @ 菜单某一行：「..」仍用于返回上级；目录/文件都插入完整相对路径。
  function chooseAtRow(row: { name: string; is_dir: boolean; up?: boolean }) {
    if (row.up) {
      const trimmed = atDirPart.replace(/\/+$/, '');
      const idx = trimmed.lastIndexOf('/');
      const parent = idx >= 0 ? trimmed.slice(0, idx + 1) : '';
      const ta = textareaRef.current;
      if (!ta) return;
      const range = detectAtMentionRange(ta.value, ta.selectionStart ?? ta.value.length);
      if (!range) return;
      const nextText = ta.value.slice(0, range.start) + `@${parent}` + ta.value.slice(range.end);
      setInput(nextText);
      setAtQuery(parent);
      setAtIndex(0);
      requestAnimationFrame(() => {
        ta.focus();
        const cursor = range.start + 1 + parent.length;
        ta.setSelectionRange(cursor, cursor);
      });
    } else {
      setAtMention(atDirPart + row.name + (row.is_dir ? '/' : ''), row.is_dir);
    }
  }

  // Auto-resize textarea + slash-command + @-mention detection
  function handleInput(e: Event) {
    const ta = e.target as HTMLTextAreaElement;
    const val = ta.value;
    inputHistoryRef.current.edit(val);
    pendingHistoryCaretRef.current = null;
    setInput(val);
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';

    const pos = ta.selectionStart ?? val.length;
    const before = val.slice(0, pos);

    // 检测光标前是否有 /（行首 或 空格后）
    const slashIdx = before.lastIndexOf('/');
    if (slashIdx >= 0 && (slashIdx === 0 || before[slashIdx - 1] === ' ')) {
      const query = before.slice(slashIdx + 1);
      if (!query.includes(' ') && query.length <= 30) {
        if (slashSkills === null && !slashLoading) {
          setSlashLoading(true);
          getSkills()
            .then(setSlashSkills)
            .catch(() => setSlashSkills([]))
            .finally(() => setSlashLoading(false));
        }
        setAtOpen(false);
        setSlashQuery(query);
        setSlashIndex(0);
        setSlashOpen(true);
        // Any real keystroke exits the pure-skills browser → normal mixed filtering.
        setSlashSkillsOnly(false);
        return;
      }
    }

    // 检测光标前是否有 @（行首 或 空格后）。@ 后文本可含 "/" 以进入子目录；
    // 实际列目录/过滤由派生的 atTargetDir + useEffect 处理（见上）。
    const atRange = detectAtMentionRange(val, pos);
    if (atRange) {
      const query = atRange.token;
      if (query.length <= 120) {
        setSlashOpen(false);
        setAtQuery(query);
        setAtIndex(0);
        setAtOpen(true);
        return;
      }
    }

    setSlashOpen(false);
    setAtOpen(false);
  }

  // 在 textarea 光标处插入文本（skill 命令 / 文件路径），并复位高度、聚焦。
  // 若 `replaceSkill` 为 true，先清空输入框再插入，避免反复选择技能时累加。
  function insertAtCursor(text: string, replaceSkill = false) {
    const ta = textareaRef.current;
    if (replaceSkill) {
      setInput(text);
    } else if (!ta) {
      setInput((v) => v + text);
    } else {
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? ta.value.length;
      setInput(ta.value.slice(0, start) + text + ta.value.slice(end));
    }
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const pos = replaceSkill ? text.length : (ta?.selectionStart ?? el.value.length) + text.length;
      el.setSelectionRange(pos, pos);
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 160) + 'px';
    });
  }

  // 追加本地附件（粘贴 / 拖拽 / 文件选择）：图片立刻转成预览用 base64，
  // 其它文件只挂在输入框里，等用户点发送才写入 .jeikcode_store。
  async function addLocalFiles(files: File[] | FileList) {
    const arr = Array.from(files);
    if (arr.length === 0) return;
    const imageFiles = arr.filter((f) => isImageFile(f));
    const otherFiles = arr.filter((f) => !isImageFile(f));
    const oversizedImages = imageFiles.filter((f) => f.size > MAX_IMAGE_BYTES);
    if (oversizedImages.length > 0) {
      setAttachError(t('attach.tooLarge', { mb: String(MAX_IMAGE_MB) }));
    } else {
      setAttachError(null);
    }
    const allowedImages = imageFiles.filter((f) => f.size <= MAX_IMAGE_BYTES);
    const parsed = (await Promise.all(allowedImages.map(fileToImageData))).filter(
      (x): x is ImageData => x !== null,
    );
    const counts = countPending(pendingAttach);
    const nextImages = parsed.slice(0, Math.max(0, MAX_IMAGES - counts.images));
    const added: PendingAttach[] = [
      ...nextImages.map((image) => ({ id: randomUUID(), kind: 'image' as const, image })),
      ...otherFiles.map((file) => ({
        id: randomUUID(),
        kind: 'file' as const,
        name: file.name || 'upload.bin',
        size: file.size,
        file,
      })),
    ];
    if (added.length) setPendingAttach((prev) => [...prev, ...added]);
  }

  function removePendingAttach(id: string) {
    setPendingAttach((prev) => prev.filter((item) => item.id !== id));
  }

  // 粘贴图文/文件：QQ/Telegram 风格 — 图片进缩略图，其它文件进附件图标，文字进输入框。
  // HTTP `--host`（局域网/公网 IP）下复制走 text/html data-URL，这里一并还原成文件。
  function handlePaste(e: ClipboardEvent) {
    const dt = e.clipboardData;
    if (!dt) return;
    const files = collectClipboardFiles(dt);
    if (files.length === 0) return;
    e.preventDefault();
    void addLocalFiles(files);
    const pastedText = dt.getData('text/plain');
    if (pastedText) insertAtCursor(pastedText);
  }

  // 输入框文字全选复制时，自动协同打包全部多媒体附件与文本，下次粘贴无缝还原多图+文本
  function handleInputCopy(e: ClipboardEvent) {
    const ta = textareaRef.current || (e.target as HTMLTextAreaElement);
    if (!ta) return;
    const start = ta.selectionStart ?? 0;
    const end = ta.selectionEnd ?? 0;
    const val = ta.value ?? '';
    const isAllSelected = (val.length > 0 && start === 0 && end >= val.length) || (val.length === 0);

    const attachedImages = pendingImageData(pendingAttach);
    if (isAllSelected && attachedImages.length > 0) {
      e.preventDefault();
      const dataUrls = attachedImages.map((img) => `data:${img.media_type};base64,${img.data}`);
      const html = buildCopyHtml(dataUrls, val);
      if (e.clipboardData) {
        e.clipboardData.setData('text/plain', val);
        e.clipboardData.setData('text/html', html);
      }
      void copyTextAndImages(val, attachedImages);
      showToast(t('copy.copiedWithMedia'), 'info');
    }
  }

  function handleDragOver(e: DragEvent) {
    if (![...Array.from(e.dataTransfer?.types ?? [])].includes('Files')) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  }

  function handleDragLeave(e: DragEvent) {
    const next = e.relatedTarget as Node | null;
    if (next && (e.currentTarget as HTMLElement).contains(next)) return;
    setDragOver(false);
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const files = e.dataTransfer?.files;
    if (files && files.length) void addLocalFiles(files);
  }

  const lastIdx = messages.length - 1;

  // 会话内搜索: Cmd/Ctrl+F 呼出浮动搜索框,Esc/× 关闭;输入关键词改变字符背景并高亮,
  // Enter/Shift+Enter(或 ↑/↓)在匹配消息间跳转并滚动定位(反查定位)。关闭态
  // 完全不占布局空间,不挤压消息区。仅前端,不动后端。
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchTrim = search.trim().toLowerCase();
  // 不过滤时间线，而是展示完整消息流
  const visibleMessages = useMemo(() => messages.map((m, origIdx) => ({ msg: m, origIdx })), [messages]);
  const lastVisibleIdx = visibleMessages.length - 1;
  // 全量内容搜索：涵盖用户提问、深度思考、正文文本、工具输入输出、通知错误等纯对话内所有元素
  function messageSearchableFullText(m: Message): string {
    const parts: string[] = [];
    for (const p of m.parts) {
      if (p.kind === 'text') {
        parts.push(p.text);
      } else if (p.kind === 'reasoning') {
        parts.push(p.text);
      } else if (p.kind === 'notice') {
        parts.push(p.text);
      } else if (p.kind === 'tool') {
        parts.push(p.tool.name);
        if (p.tool.args) parts.push(p.tool.args);
        if (p.tool.output) parts.push(p.tool.output);
        if (p.tool.progress) parts.push(p.tool.progress);
      }
    }
    return parts.join(' ').toLowerCase();
  }

  // 计算匹配的原始消息索引列表
  const matchPositions = useMemo(() => {
    if (!searchOpen || !searchTrim) return [];
    const positions: number[] = [];
    messages.forEach((m, idx) => {
      if (messageSearchableFullText(m).includes(searchTrim)) {
        positions.push(idx);
      }
    });
    return positions;
  }, [messages, searchTrim, searchOpen]);
  // 匹配消息 origIdx → DOM 节点,供 ↑/↓/Enter 滚动定位。每次渲染重填。
  const matchRefs = useRef<Record<number, HTMLElement | null>>({});
  const [matchIdx, setMatchIdxState] = useState(0);
  // P3 修复: 用 ref 镜像 matchIdx,让事件处理器在快速连击时永远读到最新值
  const matchIdxRef = useRef(0);
  const setMatchIdx = (v: number) => { matchIdxRef.current = v; setMatchIdxState(v); };
  const closeSearch = () => { setSearch(''); setMatchIdx(0); setSearchOpen(false); };
  // 搜索导航 helper: 对标浏览器原生体验的精准容器居中平滑滚动与思考自动展开
  const navMatch = (delta: number) => {
    const n = matchPositions.length;
    if (n === 0) return;
    const newIdx = (matchIdxRef.current + delta + n) % n;
    setMatchIdx(newIdx);
    const targetOrigIdx = matchPositions[newIdx];
    const node = matchRefs.current[targetOrigIdx];
    const container = scrollRef.current;
    if (node && container) {
      timelineFollow.pause();
      const containerRect = container.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      const targetTop =
        container.scrollTop +
        (nodeRect.top - containerRect.top) -
        (container.clientHeight / 2 - nodeRect.height / 2);
      container.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });

      // 如果当前消息包含思考过程且命中了思考内容，自动展开思考块
      const reasoningBtn = node.querySelector<HTMLButtonElement>('.reasoning-toggle');
      if (reasoningBtn && reasoningBtn.getAttribute('aria-expanded') === 'false') {
        const targetMsg = messages[targetOrigIdx];
        if (targetMsg?.parts.some((p) => p.kind === 'reasoning' && p.text.toLowerCase().includes(searchTrim))) {
          reasoningBtn.click();
        }
      }
    }
  };

  // Cmd/Ctrl+F 打开搜索并聚焦;Esc 关闭。绑定在 window 层级,焦点在输入框/按钮/
  // 消息气泡时都生效;阻止浏览器默认查找以免误触原生 UI。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'f') {
        if (activeMainTabId !== 'chat') return;
        const target = e.target as HTMLElement | null;
        if (target && target.closest('.code-editor-root, .file-explorer-root, .terminal-panel-root, .xterm')) return;
        if (messages.length === 0) return;
        e.preventDefault();
        setSearchOpen(true);
        // 下一帧再聚焦,等 input 挂载。
        requestAnimationFrame(() => searchInputRef.current?.focus());
      } else if (e.key === 'Escape' && searchOpen) {
        e.preventDefault();
        closeSearch();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen, messages.length, activeMainTabId]);

  // 落地态：对话为空就用 claude.ai 风格的居中落地页（无论是否已有 session id —
  // 新建会话、空的同步会话、空的历史会话都适用）。
  // 抑制条件：正在拉历史（loading，避免切到有内容会话时闪屏）、restoring（刷新还原中）、
  // 已有 historyHint（无法加载、提示去 TUI/磁盘续聊）。
  const landing = messages.length === 0 && !historyHint && !restoring && !loading && activeMainTabId === 'chat';

  // 上报落地态给 App（决定是否显示会话标题头）。
  useEffect(() => {
    onLanding?.(landing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landing]);

  // 侧栏「技能」菜单选中 → 把 `/name ` 插入输入框（按 seq 去重，避免重复插入）。
  // replaceSkill=true 会先清除已有的技能前缀，避免反复选择时累加。
  const lastSkillSeqRef = useRef<number | null>(null);
  useEffect(() => {
    if (!skillInsert) return;
    if (lastSkillSeqRef.current === skillInsert.seq) return;
    lastSkillSeqRef.current = skillInsert.seq;
    insertAtCursor(`/${skillInsert.name} `, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillInsert]);

  // 落地页副标题：项目名 + 缩写路径（剥掉 Windows `\\?\` 扩展前缀）。
  const projName = pathBasename(effectiveWorkingDir);
  const projPath = displayPath(effectiveWorkingDir);

  // 输入框只渲染一份，按落地/常规两处择一挂载（避免两个 textarea 抢同一 ref）。
  const inputBox = (
    <div
      class={'input-box' + (dragOver ? ' drag-over' : '')}
      onDragEnter={handleDragOver}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragOver && (
        <div class="input-drop-hint" aria-hidden="true">{t('attach.dropHint')}</div>
      )}
      {uploading && uploadProgress && (
        <div class="input-upload-progress" role="status">
          <div class="input-upload-progress-label">
            {t('attach.uploading', {
              name: uploadProgress.fileName,
              current: String(uploadProgress.current),
              total: String(uploadProgress.total),
              percent: String(uploadProgress.percent),
            })}
          </div>
          <div class="input-upload-progress-track">
            <div
              class="input-upload-progress-fill"
              style={{ width: `${uploadProgress.percent}%` }}
            />
          </div>
        </div>
      )}
      {attachError && (
        <div class="input-attach-error" role="alert">
          <span>{attachError}</span>
          <button
            class="input-attach-error-close"
            onClick={() => setAttachError(null)}
            aria-label={t('attach.dismissError')}
          >
            ×
          </button>
        </div>
      )}
      {pendingAttach.length > 0 && (
        <div class="input-thumbs">
          {pendingAttach.map((item) => (
            <div key={item.id} class={'input-thumb' + (item.kind === 'file' ? ' input-thumb-file' : '')}>
              {item.kind === 'image' ? (
                <MsgImage img={item.image} />
              ) : (
                <>
                  <span class="input-thumb-file-icon" aria-hidden="true">📄</span>
                  <span class="input-thumb-file-name" title={item.name}>{item.name}</span>
                </>
              )}
              <button
                class="input-thumb-remove"
                onClick={() => removePendingAttach(item.id)}
                title={item.kind === 'image' ? t('attach.removeImage') : t('attach.removeFile')}
                aria-label={item.kind === 'image' ? t('attach.removeImage') : t('attach.removeFile')}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {atOpen && (
        <div class="at-popover" ref={atRef}>
          {atLoading && <div class="at-loading">Loading...</div>}
          {!atLoading && atRows.map((item, i) => (
            <button
              key={(item.up ? 'up:' : item.is_dir ? 'd:' : 'f:') + item.name}
              class={'at-row' + (i === atIndex ? ' active' : '')}
              // stopPropagation: this mousedown is an INSIDE click. Without it the
              // event bubbles to the document click-outside handler, whose
              // `contains(target)` guard fails once `setAtMention` clears+refetches
              // the list (the clicked row detaches), so it wrongly closes the menu —
              // a directory then can't drill in via mouse (keyboard was immune since
              // it never triggers a document mousedown). preventDefault keeps focus.
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); chooseAtRow(item); }}
              onMouseEnter={() => setAtIndex(i)}
              type="button"
              title={item.up ? '..' : atDirPart + item.name + (item.is_dir ? '/' : '')}
            >
              <span class="at-icon">{item.up ? '⬆' : item.is_dir ? '📁' : '📄'}</span>
              <span class="at-name">{item.up ? '..' : atDirPart + item.name + (item.is_dir ? '/' : '')}</span>
            </button>
          ))}
          {!atLoading && atRows.length === 0 && (
            <div class="at-empty">No files found</div>
          )}
        </div>
      )}
      {slashOpen && (
        <div class="slash-popover" ref={slashRef}>
          {buildSlashMenuItems(FRONTEND_COMMANDS, slashSkills ?? [], slashQuery, t as (k: string) => string, slashSkillsOnly).map((item, i) => (
            <button
              key={`${item.kind}:${item.name}`}
              class={'slash-row' + (i === slashIndex ? ' active' : '')}
              // stopPropagation for the same reason as the @-menu rows above: keep
              // this inside-click from reaching the document click-outside handler.
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); insertSkill(item.name); }}
              onMouseEnter={() => setSlashIndex(i)}
              type="button"
              title={item.description || ''}
            >
              <span class={'slash-name' + (item.kind === 'skill' ? ' notranslate' : '')} translate={item.kind === 'skill' ? false : undefined}>/{item.name}</span>
              {item.description && (
                <span class={'slash-desc' + (item.kind === 'skill' ? ' notranslate' : '')} translate={item.kind === 'skill' ? false : undefined}>
                  {item.description}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {/* 文本输入框主体：靠左对齐，单行起步随输入多行自适应 */}
      <textarea
        ref={textareaRef}
        class="message-input"
        rows={1}
        placeholder={t('chat.inputPlaceholder')}
        value={input}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onCopy={handleInputCopy}
      />

      {/* 底部功能栏：左侧上传附件，右侧紧凑元数据 + 模式选择 + 发送控制 */}
      <div class="input-footer">
        <div class="input-footer-primary">
          <input
            ref={nativeFileInputRef}
            type="file"
            multiple
            accept={ACCEPTED_IMAGE_INPUT_ACCEPT}
            style={{ display: 'none' }}
            onChange={(e) => {
              const input = e.target as HTMLInputElement;
              if (input.files && input.files.length) {
                void addLocalFiles(input.files);
              }
              input.value = '';
            }}
          />
          <button
            type="button"
            class="btn-native-upload"
            onClick={() => nativeFileInputRef.current?.click()}
            title={t('chat.attachFiles')}
            aria-label={t('chat.attachFiles')}
          >
            <svg
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
        </div>

        <div class="input-footer-actions">
          {tokens && (
            <div class="composer-meta-group">
              {(() => {
                const prompt = tokens.prompt ?? 0;
                const completion = tokens.completion ?? 0;
                const cached = tokens.cached ?? 0;
                const isEstimated = Boolean(tokens.cached_estimated);
                const reasoning = tokens.reasoning ?? 0;
                const total = tokens.total ?? (prompt + completion);
                const loopPrompt = tokens.loop_prompt ?? tokenCacheRef.current.turnPromptSum ?? prompt;
                const loopCached = tokens.loop_cached ?? tokenCacheRef.current.turnCachedSum ?? cached;
                const stepPct = formatCacheHitRate(cached, prompt, isEstimated);
                const loopPct = formatCacheHitRate(loopCached, loopPrompt, isEstimated);
                const multiStep = loopPrompt > prompt;
                const cachedPct = stepPct;
                const pctOfLimit = contextLimit && contextLimit > 0 ? Math.min(100, Math.round((total / contextLimit) * 100)) : null;
                const billable = completion + Math.max(0, prompt - cached);

                const promptStr = prompt.toLocaleString();
                const completionStr = completion.toLocaleString();
                const cachedStr = cached.toLocaleString();
                const reasoningStr = reasoning.toLocaleString();
                const totalStr = total.toLocaleString();
                const limitStr = contextLimit ? contextLimit.toLocaleString() : null;
                const billableStr = billable.toLocaleString();

                const tooltipLines: string[] = [
                  t('tokens.tooltipTitle'),
                  '──────────────────────────────',
                  `${t('tokens.inputLabel')}: ${promptStr}`,
                ];
                if (cached > 0) {
                  if (isEstimated) {
                    tooltipLines.push(`⚡ ${t('tokens.estimatedCache')}: ${cachedStr} (${stepPct} ${t('tokens.estBadge')})`);
                  } else {
                    tooltipLines.push(`⚡ ${t('tokens.onlineCacheHit')}: ${cachedStr} (${stepPct} ${t('tokens.hitBadge')})`);
                  }
                }
                if (multiStep && loopPct) {
                  tooltipLines.push(`⚡ ${t('tokens.loopSavingsLabel')}: ${loopCached.toLocaleString()} / ${loopPrompt.toLocaleString()} (${loopPct})`);
                }
                if (reasoning > 0) {
                  tooltipLines.push(`💭 ${t('tokens.reasoningTooltip', { n: reasoningStr })}`);
                }
                tooltipLines.push(
                  `📤 ${t('tokens.outputLabel')}: ${completionStr}`,
                  `🎯 ${t('tokens.totalTooltip', { total: totalStr })}`,
                );
                if (contextLimit) {
                  tooltipLines.push(
                    t('tokens.totalLimitTooltip', {
                      total: totalStr,
                      limit: limitStr ?? '',
                      pct: pctOfLimit ?? 0,
                    }),
                  );
                }
                tooltipLines.push(`💡 ${t('tokens.billableTokens')}: ${billableStr}`);

                return (
                  <div class="composer-tokens-anchor">
                    <button
                      type="button"
                      class={'footer-tokens composer-compact-tokens' + (showTokenDetails ? ' is-active' : '')}
                      title={tooltipLines.join('\n')}
                      aria-label={t('tokens.popoverTitle')}
                      aria-haspopup="dialog"
                      aria-expanded={showTokenDetails}
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowTokenDetails((v) => !v);
                      }}
                    >
                      <span class="token-pill token-cached is-green">
                        <span class="token-icon">⚡</span>
                        <span>{cachedPct != null ? cachedPct : formatTokenMetric(cached)}</span>
                      </span>
                      <span class="token-pill token-total">
                        <span class="token-icon">🎯</span>
                        <span>{formatTokenMetric(total)}{contextLimit ? `/${formatTokenMetric(contextLimit)}` : ''}</span>
                      </span>
                    </button>

                    {showTokenDetails && (
                      <div
                        class="token-details-popover"
                        ref={tokenPopoverRef}
                        role="dialog"
                        aria-label={t('tokens.popoverTitle')}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div class="token-popover-header">
                          <div class="token-popover-title">
                            <span class="token-popover-icon">📊</span>
                            <span>{t('tokens.popoverTitle')}</span>
                          </div>
                          <button
                            type="button"
                            class="token-popover-close"
                            onClick={(e) => {
                              e.stopPropagation();
                              setShowTokenDetails(false);
                            }}
                            title={t('tokens.close')}
                            aria-label={t('tokens.close')}
                          >
                            ✕
                          </button>
                        </div>

                        {contextLimit && (
                          <div class="token-popover-progress-box">
                            <div class="token-popover-progress-labels">
                              <span class="token-popover-progress-title">{t('tokens.budgetTitle')}</span>
                              <span class="token-popover-progress-val">
                                {totalStr} / {limitStr} ({pctOfLimit}%)
                              </span>
                            </div>
                            <div class="token-popover-progress-track">
                              <div
                                class="token-popover-progress-fill"
                                style={{
                                  width: `${Math.min(100, Math.max(2, pctOfLimit ?? 0))}%`,
                                  backgroundColor:
                                    (pctOfLimit ?? 0) > 85
                                      ? '#ef4444'
                                      : (pctOfLimit ?? 0) > 65
                                      ? '#f59e0b'
                                      : 'var(--app-brand-accent, #10a37f)',
                                }}
                              />
                            </div>
                          </div>
                        )}

                        <div class="token-popover-grid">
                          <div class="token-popover-row">
                            <div class="token-popover-row-left">
                              <span class="token-row-icon">📥</span>
                              <span class="token-row-label">{t('tokens.inputLabel')}</span>
                            </div>
                            <span class="token-popover-row-val">{promptStr}</span>
                          </div>

                          {cached > 0 && (
                            <div class="token-popover-row is-cached">
                              <div class="token-popover-row-left">
                                <span class="token-row-icon">⚡</span>
                                <span class="token-row-label">
                                  {isEstimated ? t('tokens.estimatedCache') : t('tokens.onlineCacheHit')}
                                </span>
                              </div>
                              <div class="token-popover-row-val-group">
                                <span class="token-popover-row-val">{cachedStr}</span>
                                <span class="token-popover-row-badge">
                                  {stepPct} {isEstimated ? t('tokens.estBadge') : t('tokens.hitBadge')}
                                </span>
                              </div>
                            </div>
                          )}

                          {multiStep && loopPct && (
                            <div class="token-popover-row is-cached">
                              <div class="token-popover-row-left">
                                <span class="token-row-icon">⚡</span>
                                <span class="token-row-label">{t('tokens.loopHitLabel')}</span>
                              </div>
                              <div class="token-popover-row-val-group">
                                <span class="token-popover-row-val">
                                  {loopCached.toLocaleString()} / {loopPrompt.toLocaleString()}
                                </span>
                                <span class="token-popover-row-badge">{loopPct}</span>
                              </div>
                            </div>
                          )}

                          <div class="token-popover-row">
                            <div class="token-popover-row-left">
                              <span class="token-row-icon">📤</span>
                              <span class="token-row-label">{t('tokens.outputLabel')}</span>
                            </div>
                            <div class="token-popover-row-val-group">
                              <span class="token-popover-row-val">{completionStr}</span>
                              {reasoning > 0 && (
                                <span class="token-popover-row-sub">
                                  {t('tokens.contentReasoning', { content: Math.max(0, completion - reasoning).toLocaleString(), reasoning: reasoningStr })}
                                </span>
                              )}
                            </div>
                          </div>

                          <div class="token-popover-row is-total">
                            <div class="token-popover-row-left">
                              <span class="token-row-icon">🎯</span>
                              <span class="token-row-label">{t('tokens.totalContext')}</span>
                            </div>
                            <span class="token-popover-row-val">
                              {totalStr}
                              {contextLimit ? ` / ${limitStr}` : ''}
                            </span>
                          </div>

                          <div class="token-popover-row is-billable">
                            <div class="token-popover-row-left">
                              <span class="token-row-icon">💡</span>
                              <span class="token-row-label">{t('tokens.billableTokens')}</span>
                            </div>
                            <span class="token-popover-row-val">{billableStr}</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          )}

          <ModeSelector
            value={modeState.displayMode}
            disabled={Boolean(modeState.pendingMode)}
            onChange={(m) => switchMode(m)}
          />
          <div class="input-turn-controls">
            {busy || recoveryPolicy.allowStop ? (
              <>
                {recoveryPolicy.allowSend && (input.trim() || pendingAttach.length > 0) && (
                  <button
                    class="btn-send"
                    onClick={sendMessage}
                    disabled={Boolean(modeState.pendingMode) || uploading}
                    title={t('chat.queue')}
                    aria-label={t('chat.queue')}
                  >
                    ↑
                  </button>
                )}
                <button class="btn-stop" onClick={handleStop} title={t('chat.stop')} aria-label={t('chat.stop')}>
                  <span class="stop-square" />
                </button>
              </>
            ) : (
              <button
                class="btn-send"
                onClick={sendMessage}
                disabled={!recoveryPolicy.allowSend || Boolean(modeState.pendingMode) || uploading || (!input.trim() && pendingAttach.length === 0)}
                title={recoveryPolicy.allowSend ? t('chat.send') : t('chat.recoveryBlocked')}
                aria-label={recoveryPolicy.allowSend ? t('chat.send') : t('chat.recoveryBlocked')}
              >
                ↑
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  // 落地页快捷提示胶囊：点击把文本填入输入框并聚焦（不自动发送，便于二次编辑）。
  const quickChips: { label: string; insert: string }[] = [
    { label: t('chat.chipReview'), insert: '/review ' },
    { label: t('chat.chipExplain'), insert: t('chat.chipExplain') },
    { label: t('chat.chipTest'), insert: t('chat.chipTest') },
  ];
  function fillInput(text: string) {
    setInput(text);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      const pos = text.length;
      ta.setSelectionRange(pos, pos);
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
    });
  }

  const topModelChrome = (() => {
    const slot = topModelSlot || (typeof document !== 'undefined' ? document.getElementById('top-nav-model-slot') : null);
    if (!slot) return null;
    return createPortal(
      <div class="top-model-row">
        <ModelSelector
          value={provider}
          onChange={(p) => switchProvider(p)}
          onDefaultChange={followDefaultProvider}
          sessionId={sessionId ?? activeIdRef.current}
          direction="down"
          onOpenModelConfig={onOpenModelConfig}
        />
      </div>,
      slot,
    );
  })();

  if (landing) {
    return (
      <>
        <div
          ref={stageRef}
          class={'chat-stage' + (isRightPanelVisible ? ' has-right-panel' : '')}
          style={isRightPanelVisible ? ({ '--right-panel-width': `${rightPanelWidth}px` } as any) : undefined}
          onDragOver={handleMainStageDragOver as any}
          onDrop={handleMainStageDrop as any}
        >
          <div class="chat-main-column">
            <div class="chat-landing">
              <div class="landing-inner">
                <div class="landing-brand">
                  <span class="landing-brand-name">JeikCode</span>
                </div>
                <div class="landing-tagline">{t('chat.greeting')}</div>
                {cwd && (
                  <div class="landing-cwd" title={cwd}>
                    <span class="landing-cwd-label">
                      {t('chat.sessionCwd', { path: '' }).trim()}
                    </span>
                    <span class="landing-cwd-path">{cwd}</span>
                  </div>
                )}
                <div class="landing-input">
                  {inputBox}
                </div>
                <div class="landing-chips">
                  {quickChips.map((c) => (
                    <button key={c.label} class="landing-chip" onClick={() => fillInput(c.insert)}>
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Right Inspector Multi-Tab Panel (Landing 页保活常驻) */}
          {isRightPanelVisible && (
            <div
              class="right-inspector-backdrop"
              onClick={() => setRightPanelCollapsed(true)}
              aria-hidden="true"
            />
          )}
          <aside
            class={'right-inspector-panel' + (rightPanelCollapsed ? ' is-collapsed-hidden' : '')}
            style={{ display: rightPanelCollapsed ? 'none' : 'flex' }}
            aria-label={rightPanelTab === 'questions' ? t('panel.questions') : t('panel.git')}
          >
            {/* Draggable Resizer on left edge */}
            <div
              class="right-panel-resizer"
              onMouseDown={handleResizerMouseDown as any}
              title="Drag to resize panel"
            />

            {/* Header Tab Bar */}
            <div class="right-panel-header">
              <div class="right-panel-tabs">
                <button
                  type="button"
                  class={'right-panel-tab-btn' + (rightPanelTab === 'git' ? ' active' : '')}
                  onClick={() => setRightPanelTab('git')}
                  title={t('panel.git')}
                  aria-label={t('panel.git')}
                >
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                    <path fill-rule="evenodd" clip-rule="evenodd" d="M11.75 3a1.75 1.75 0 1 0-1.07 3.13 4.25 4.25 0 0 1-2.93 2.12v-1.5a1.75 1.75 0 1 0-1.5 0v4.5a1.75 1.75 0 1 0 1.5 0V9.8a5.75 5.75 0 0 0 3.75-2.67A1.75 1.75 0 0 0 11.75 3zm-6.25 10a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zm0-7a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zm6.25-2a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5z" />
                  </svg>
                </button>

                <button
                  type="button"
                  class={'right-panel-tab-btn' + (rightPanelTab === 'terminal' ? ' active' : '')}
                  onClick={() => setRightPanelTab('terminal')}
                  title={t('panel.terminal') || '终端'}
                  aria-label={t('panel.terminal') || '终端'}
                >
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M3 5l4 3-4 3m6 0h4" />
                  </svg>
                </button>

                <button
                  type="button"
                  class={'right-panel-tab-btn' + (rightPanelTab === 'preview' ? ' active' : '') + (eyeDragOver ? ' is-drag-over-eye' : '')}
                  onClick={() => setRightPanelTab('preview')}
                  onDragEnter={handleEyeDragOver as any}
                  onDragOver={handleEyeDragOver as any}
                  onDragLeave={handleEyeDragLeave as any}
                  onDrop={handleEyeDrop as any}
                  title={t('panel.preview') || '预览'}
                  aria-label={t('panel.preview') || '预览'}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                </button>

                <button
                  type="button"
                  class={'right-panel-tab-btn' + (rightPanelTab === 'questions' ? ' active' : '')}
                  onClick={() => setRightPanelTab('questions')}
                  title={t('panel.questions')}
                  aria-label={t('panel.questions')}
                >
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                    <circle cx="8" cy="8" r="6.2" />
                    <path d="M6 6.5a2 2 0 0 1 3.8.8c0 1.2-1.8 1.5-1.8 2.5" />
                    <circle cx="8" cy="12.2" r="0.7" fill="currentColor" />
                  </svg>
                  {turnNavItems.length > 0 && <span class="tab-badge">{turnNavItems.length}</span>}
                </button>
              </div>

              <span class="right-panel-title">
                {rightPanelTab === 'questions' ? t('turnNav.title') : rightPanelTab === 'git' ? t('git.title') : rightPanelTab === 'terminal' ? (t('panel.terminal') || '终端') : (t('panel.preview') || '预览')}
              </span>

              <button
                type="button"
                class="right-panel-collapse-btn"
                onClick={() => setRightPanelCollapsed(true)}
                title={t('panel.collapse')}
                aria-label={t('panel.collapse')}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                  <path d="M6 4l4 4-4 4" />
                </svg>
              </button>
            </div>

            {/* Body */}
            <div class="right-panel-body">
              <div style={{ display: rightPanelTab === 'questions' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0, height: '100%', width: '100%' }}>
                <nav class="turn-nav" aria-label={t('turnNav.title')}>
                  <div class="turn-nav-header">
                    <input
                      class="turn-nav-search"
                      type="text"
                      value={turnNavQuery}
                      placeholder={t('turnNav.searchPlaceholder')}
                      aria-label={t('turnNav.searchPlaceholder')}
                      onInput={(e) => setTurnNavQuery((e.target as HTMLInputElement).value)}
                    />
                  </div>
                  <div class="turn-nav-list">
                    {filteredTurnNavItems.length === 0 ? (
                      <div class="turn-nav-empty">
                        {turnNavItems.length === 0 ? t('turnNav.empty') : t('turnNav.noMatch')}
                      </div>
                    ) : (
                      filteredTurnNavItems.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          class={'turn-nav-item' + (item.id === activeTurnId ? ' active' : '')}
                          title={item.text}
                          onClick={() => jumpToTurn(item.id)}
                        >
                          {item.label}
                        </button>
                      ))
                    )}
                  </div>
                </nav>
              </div>

              <div style={{ display: rightPanelTab === 'git' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0, height: '100%', width: '100%' }}>
                <Suspense
                  fallback={
                    <div class="git-empty-state">
                      <div class="git-spinner" />
                      <span>{t('git.loading')}</span>
                    </div>
                  }
                >
                  <GitPanel
                    cwd={effectiveWorkingDir}
                    refreshTrigger={gitRefreshTrigger}
                    onBranchChanged={(newB) => {
                      setGitRefreshTrigger((n) => n + 1);
                      onCwdChanged?.(effectiveWorkingDir || '');
                    }}
                    onOpenFileDiff={handleOpenFileDiff}
                    onOpenWorkingDiff={handleOpenWorkingDiff}
                  />
                </Suspense>
              </div>

              <div style={{ display: rightPanelTab === 'terminal' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0, height: '100%', width: '100%' }}>
                <TerminalPanel cwd={effectiveWorkingDir || cwd} active={rightPanelTab === 'terminal' && !rightPanelCollapsed} />
              </div>

              <div style={{ display: rightPanelTab === 'preview' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0, height: '100%', width: '100%' }}>
                <PreviewPanel
                  cwd={effectiveWorkingDir || cwd}
                  onOpenInMainEditor={(filePath) => {
                    window.dispatchEvent(new CustomEvent('jeikcode:open_file', { detail: { path: filePath } }));
                  }}
                />
              </div>
            </div>
          </aside>
        </div>

        {/* 落地页常驻折叠悬浮游标 */}
        {rightPanelCollapsed && (
          <div
            class="right-panel-collapsed-rail draggable-floating-widget"
            role="toolbar"
            aria-label={t('chat.inspectorTabs')}
            style={{ top: `${widgetPos.top}px`, left: `${widgetPos.left}px`, right: 'auto' }}
          >
            <div
              class="widget-drag-handle"
              onMouseDown={handleWidgetMouseDown as any}
              onTouchStart={handleWidgetMouseDown as any}
              title={t('common.drag')}
              aria-label={t('common.dragHandle')}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="4" r="1.5" />
                <circle cx="11" cy="4" r="1.5" />
                <circle cx="5" cy="8" r="1.5" />
                <circle cx="11" cy="8" r="1.5" />
                <circle cx="5" cy="12" r="1.5" />
                <circle cx="11" cy="12" r="1.5" />
              </svg>
            </div>
            <button
              type="button"
              class="right-panel-tab-btn"
              onClick={() => {
                setRightPanelTab('git');
                setRightPanelCollapsed(false);
              }}
              title={t('panel.git')}
              aria-label={t('panel.git')}
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path fill-rule="evenodd" clip-rule="evenodd" d="M11.75 3a1.75 1.75 0 1 0-1.07 3.13 4.25 4.25 0 0 1-2.93 2.12v-1.5a1.75 1.75 0 1 0-1.5 0v4.5a1.75 1.75 0 1 0 1.5 0V9.8a5.75 5.75 0 0 0 3.75-2.67A1.75 1.75 0 0 0 11.75 3zm-6.25 10a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zm0-7a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zm6.25-2a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5z" />
              </svg>
              <span class="rail-tab-text">Git</span>
            </button>
            <button
              type="button"
              class="right-panel-tab-btn"
              onClick={() => {
                setRightPanelTab('terminal');
                setRightPanelCollapsed(false);
              }}
              title={t('panel.terminal') || '终端'}
              aria-label={t('panel.terminal') || '终端'}
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3 5l4 3-4 3m6 0h4" />
              </svg>
              <span class="rail-tab-text">{t('panel.terminal') || '终端'}</span>
            </button>
            <button
              type="button"
              class={'right-panel-tab-btn' + (eyeDragOver ? ' is-drag-over-eye' : '')}
              onClick={() => {
                setRightPanelTab('preview');
                setRightPanelCollapsed(false);
              }}
              onDragEnter={handleEyeDragOver as any}
              onDragOver={handleEyeDragOver as any}
              onDragLeave={handleEyeDragLeave as any}
              onDrop={handleEyeDrop as any}
              title={t('panel.preview') || '预览'}
              aria-label={t('panel.preview') || '预览'}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <span class="rail-tab-text">{t('panel.preview') || '预览'}</span>
            </button>
            <button
              type="button"
              class="right-panel-tab-btn"
              onClick={() => {
                setRightPanelTab('questions');
                setRightPanelCollapsed(false);
              }}
              title={t('panel.questions')}
              aria-label={t('panel.questions')}
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                <circle cx="8" cy="8" r="6.2" />
                <path d="M6 6.5a2 2 0 0 1 3.8.8c0 1.2-1.8 1.5-1.8 2.5" />
                <circle cx="8" cy="12.2" r="0.7" fill="currentColor" />
              </svg>
              <span class="rail-tab-text">{t('turnNav.title')}</span>
              {turnNavItems.length > 0 && <span class="tab-badge">{turnNavItems.length}</span>}
            </button>
          </div>
        )}
        {topModelChrome}
        {confirmModal.open && (
          <ConfirmDialog
            title={confirmModal.title}
            body={confirmModal.body}
            confirmLabel={confirmModal.confirmLabel ?? t('confirm.confirmBtn')}
            cancelLabel={confirmModal.cancelLabel ?? t('common.cancel')}
            danger={confirmModal.danger ?? true}
            icon={confirmModal.icon}
            onConfirm={confirmModal.onConfirm}
            onClose={() => setConfirmModal((prev) => ({ ...prev, open: false }))}
          />
        )}
      </>
    );
  }

  const stickyTodoPanel =
    activeTodos && activeTodos.length > 0 ? <SessionTodoPanel items={activeTodos} /> : null;

  return (
    <>
      <div
        ref={stageRef}
        class={'chat-stage' + (isRightPanelVisible ? ' has-right-panel' : '') + (activeMainTabId !== 'chat' ? ' is-editor-mode' : '')}
        style={isRightPanelVisible ? ({ '--right-panel-width': `${rightPanelWidth}px` } as any) : undefined}
        onDragOver={handleMainStageDragOver as any}
        onDrop={handleMainStageDrop as any}
      >
      {/* Main chat / editor stage column */}
      <div class="chat-main-column">
        {/* Message timeline */}
        <div
          class="messages-container"
          ref={attachTimeline}
          style={activeMainTabId !== 'chat' ? { display: 'none' } : undefined}
          onScroll={syncTurnNavFromScroll}
        >
        <div class="timeline-inner">
        {messages.length === 0 && !historyHint && !restoring && loading && (
          <div class="messages-empty">
            <div>
              {t('chat.startHint')}
            </div>
          </div>
        )}

        {messages.length === 0 && historyHint && (
          <div class="messages-empty">
            <div>
              {historyHint}
              <div class="sub">{t('chat.continueHint')}</div>
            </div>
          </div>
        )}

        {messages.length > 0 && historyHint && (
          <div class="history-banner" role="status">
            {historyHint}
          </div>
        )}

        {hasOlder && (
          <div class="history-load-older">
            <button
              type="button"
              class="history-load-older-btn"
              disabled={loadingOlder}
              onClick={() => void loadOlderMessages()}
            >
              {loadingOlder
                ? t('chat.loadingOlder')
                : t('chat.loadOlder', { n: String(historyOffsetRef.current) })}
            </button>
          </div>
        )}

        {(() => {
          // Pre-compute per-turn text for assistant messages: collect all text
          // from consecutive assistant messages between two user messages, so
          // the copy button can copy the entire LLM turn (not just one chunk).
          // system messages are transparent — they don't end an assistant turn.
          const turnTexts = new Map<number, string>();
          // 计算每个回合的文本（区分最后回答与全部正文），供复制按钮使用。
          const turnLastTexts = new Map<number, string>();
          const turnAllTexts = new Map<number, string>();
          {
            let start = -1;
            let textParts: string[] = [];
            let fallbackParts: string[] = [];
            for (let i = 0; i < messages.length; i++) {
              if (messages[i].role === 'assistant') {
                if (start < 0) start = i;
                for (const p of messages[i].parts) {
                  if (p.kind === 'text' && p.text.trim()) {
                    textParts.push(p.text);
                  }
                }
                const raw = messageFullText(messages[i]);
                if (raw) fallbackParts.push(raw);
              } else if (messages[i].role === 'user') {
                // Only a user message ends the current assistant turn.
                if (start >= 0) {
                  const targetList = textParts.length > 0 ? textParts : fallbackParts;
                  const lastText = targetList.length > 0 ? targetList[targetList.length - 1] : '';
                  const allText = targetList.join('\n\n');
                  for (let j = start; j < i; j++) {
                    turnLastTexts.set(j, lastText);
                    turnAllTexts.set(j, allText);
                  }
                  start = -1;
                  textParts = [];
                  fallbackParts = [];
                }
              }
              // role === 'system': transparent — do not flush the turn.
            }
            // Flush the last turn
            if (start >= 0) {
              const targetList = textParts.length > 0 ? textParts : fallbackParts;
              const lastText = targetList.length > 0 ? targetList[targetList.length - 1] : '';
              const allText = targetList.join('\n\n');
              for (let j = start; j < messages.length; j++) {
                turnLastTexts.set(j, lastText);
                turnAllTexts.set(j, allText);
              }
            }
          }

          // Helper: skip system messages when looking for the "next role".
          // Needed so a trailing system notice doesn't hide the copy button
          // on the real last AI reply of the turn.
          function nextNonSystemRole(from: number): string | undefined {
            for (let k = from; k < messages.length; k++) {
              if (messages[k].role !== 'system') return messages[k].role;
            }
            return undefined;
          }

          return visibleMessages.map(({ msg, origIdx }, idx) => {
            const isLast = idx === lastVisibleIdx;
            const setMatchRef = (el: HTMLElement | null) => { matchRefs.current[origIdx] = el; };
            const timeLabel = formatMsgTime(msg.ts, t);
            const timeFull = formatMsgTimeFull(msg.ts);
            const isActiveSearchMatch = searchOpen && searchTrim ? (origIdx === matchPositions[matchIdx]) : false;

            if (msg.role === 'user') {
              const turnIndex = msg.sourceIndex ?? historyOffsetRef.current + origIdx;
              const turnItem = msg.turnNavOrdinal != null
                ? turnNavByOrdinal.get(msg.turnNavOrdinal)
                : turnNavByIndex.get(turnIndex);
              const anchorId = turnItem?.id ?? turnNavId(msg.turnNavOrdinal ?? origIdx);
              const isEditing = editingSourceIndex === turnIndex;
              const hasActiveDraft = isEditing && bubbleEditDraft?.sourceIndex === turnIndex;
              return (
                <UserMessageView
                  key={anchorId ?? turnIndex}
                  msg={msg}
                  anchorId={anchorId}
                  turnNavIdx={turnIndex}
                  searchRef={setMatchRef}
                  timeLabel={timeLabel}
                  timeFull={timeFull}
                  search={search}
                  isActiveSearchMatch={isActiveSearchMatch}
                  isEditing={isEditing}
                  draftText={hasActiveDraft ? bubbleEditDraft.text : undefined}
                  draftImages={hasActiveDraft ? bubbleEditDraft.images : undefined}
                  draftModel={hasActiveDraft ? bubbleEditDraft.selectedModel : undefined}
                  onDraftChange={(draftText, draftImages, draftModel) => {
                    handleBubbleDraftChange(turnIndex, draftText, draftImages, draftModel);
                  }}
                  onStartEdit={() => {
                    const initDraft: BubbleEditDraft = {
                      sourceIndex: turnIndex,
                      text: messageText(msg),
                      images: msg.images || [],
                      selectedModel: provider || defaultProviderName() || undefined,
                    };
                    setEditingSourceIndex(turnIndex);
                    setBubbleEditDraft(initDraft);
                    const sid = activeIdRef.current || sessionId || activeSession?.id;
                    if (sid) saveBubbleEditDraft(sid, initDraft);
                  }}
                  onCancelEdit={() => {
                    setEditingSourceIndex(null);
                    setBubbleEditDraft(null);
                    const sid = activeIdRef.current || sessionId || activeSession?.id;
                    if (sid) clearBubbleEditDraft(sid);
                  }}
                  onSaveRewrite={(newText, newImages) => void handleSaveRewrite(turnIndex, newText, newImages)}
                  onRollbackSubmit={(newText, newImages, tempModel) => void handleRollbackSubmit(turnIndex, newText, newImages, tempModel)}
                  onDelete={() => void handleDeleteUserMessage(turnIndex, messageText(msg))}
                  models={modelCatalog}
                  currentModel={provider || defaultProviderName() || ''}
                  disabled={busy}
                  cwd={effectiveWorkingDir || cwd}
                />
              );
            }

            // system messages render as a standalone notice row (no copy button,
            // no turn grouping, no streaming cursor).
            if (msg.role === 'system') {
              const fullText = msg.parts.map((p) => (p.kind === 'notice' ? p.text : '')).join('');
              const sysCls = 'msg-notice command-output' + (isActiveSearchMatch ? ' is-active-search-match' : '');
              return (
                <div class={sysCls} key={msg.id ?? origIdx} ref={setMatchRef}>
                  {highlightText(fullText, search)}
                </div>
              );
            }

            // Determine if this assistant message is the last one in the current
            // turn (i.e. the next NON-SYSTEM message is a user message, or there
            // are no more non-system messages). Only the last assistant message in
            // a turn gets the copy button, so one user turn → one copy button.
            // 用 origIdx(原数组索引)查 turnTexts 与判断 isLastInTurn,
            // 因为这两者是基于完整 messages 序列算的。
            const nextRole = nextNonSystemRole(origIdx + 1);
            const isLastInTurn = nextRole === 'user' || nextRole === undefined;
            const userTs = precedingUserTs(messages, origIdx);
            // Live bubble: wall-clock from this turn's user send → now.
            // Intermediate tool results / thinking must not restart the clock.
            const liveFromUser =
              isLastInTurn && busy && isLast
                ? turnDurationMs(userTs ?? turnStartedAt ?? undefined, nowMs)
                : undefined;
            const doneTotal = isLastInTurn && !busy
              ? turnTotalElapsedMs(userTs, msg.ts, msg.elapsedMs)
              : undefined;

            return (
              <AssistantMessageView
                key={msg.id ?? origIdx}
                msg={msg}
                isLast={isLast}
                busy={busy}
                lastIdx={lastIdx}
                isLastInTurn={isLastInTurn}
                turnLastText={turnLastTexts.get(origIdx) ?? ''}
                turnAllText={turnAllTexts.get(origIdx) ?? ''}
                searchRef={setMatchRef}
                timeLabel={isLastInTurn ? timeLabel : undefined}
                timeFull={isLastInTurn ? timeFull : undefined}
                liveElapsedMs={liveFromUser}
                turnTotalMs={doneTotal}
                isCompacting={isCompacting}
                search={search}
                isActiveSearchMatch={isActiveSearchMatch}
                onRegenerate={isLastInTurn && !busy ? () => void handleRegenerateAssistant(msg.sourceIndex ?? origIdx, origIdx) : undefined}
                onDelete={isLastInTurn && !busy ? () => void handleDeleteAssistantMessage(msg.sourceIndex ?? origIdx, origIdx) : undefined}
                cwd={effectiveWorkingDir || cwd}
              />
            );
          });
        })()}

        {/* 排队中的消息：执行中输入、待当前回合结束后自动发送，卡片下方提供立即发送、转向、取消按钮。 */}
        {queued.map((q) => (
          <div key={`q-${q.id}`} class="user-message-wrapper queued">
            <div class="user-message-bubble queued-bubble">
              {q.images && q.images.length > 0 && (
                <div class="msg-images">
                  {q.images.map((img, i) => (
                    <MsgImage key={i} img={img} />
                  ))}
                </div>
              )}
              <div class="queued-head">
                <span class="queued-tag">
                  {q.kind === 'steer'
                    ? t('chat.steered')
                    : q.kind === 'steering'
                      ? t('chat.steering')
                      : t('chat.queued')}
                </span>
              </div>
              <div class="queued-text-content">
                {q.text}
              </div>
              <div class="queued-footer-actions">
                {q.kind === 'queue' && (
                  <button
                    type="button"
                    class="queued-action-btn queued-btn-steer"
                    onClick={() => void handleSteerQueuedMessage(q)}
                    title={t('chat.steerQueued')}
                    aria-label={t('chat.steerAction')}
                  >
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M3 11.5V8.5a3.5 3.5 0 0 1 3.5-3.5H12" />
                      <path d="M9.5 2.5 12.5 5 9.5 7.5" />
                    </svg>
                    <span>{t('chat.steerAction')}</span>
                  </button>
                )}

                {(q.kind === 'queue' || q.kind === 'steer') && (
                  <button
                    type="button"
                    class="queued-action-btn queued-btn-send-now"
                    onClick={() => void handleSendImmediately(q)}
                    title={t('chat.sendNowTitle')}
                    aria-label={t('chat.sendNow')}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <polygon points="5 3 19 12 5 21 5 3" fill="currentColor" />
                    </svg>
                    <span>{t('chat.sendNow')}</span>
                  </button>
                )}

                <button
                  type="button"
                  class="queued-action-btn queued-btn-cancel"
                  onClick={() => handleCancelQueuedMessage(q)}
                  disabled={q.kind === 'steering'}
                  title={t('chat.removeQueued')}
                  aria-label={t('chat.cancelAction')}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                  <span>{t('chat.cancelAction')}</span>
                </button>
              </div>
            </div>
          </div>
        ))}

        {pendingSteers.some((item) => item.confirmed) && (
          <div class="steer-pending-status" role="status">
            {t('chat.steerPending', {
              count: pendingSteers.filter((item) => item.confirmed).length,
            })}
          </div>
        )}

        <div ref={bottomRef} />
        </div>
      </div>

      {/* VSCode Diff Viewer or Code Editor Stage */}
      {activeMainTabId !== 'chat' && (() => {
        const currentDiffTab = diffTabs.find((t) => t.id === activeMainTabId);
        if (!currentDiffTab) return null;
        if (currentDiffTab.type === 'editor') {
          return (
            <div class="vscode-diff-view-stage">
              <CodeEditorTab
                key={`${currentDiffTab.id}_${currentDiffTab.startLine || 0}_${currentDiffTab.endLine || 0}`}
                filePath={currentDiffTab.filePath}
                cwd={cwd}
                startLine={currentDiffTab.startLine}
                endLine={currentDiffTab.endLine}
                onClose={() => handleCloseDiffTab?.(currentDiffTab.id)}
              />
            </div>
          );
        }
        return (
          <div class="vscode-diff-view-stage">
            {currentDiffTab.loading ? (
              <div class="diff-loading-wrap">
                <div class="git-spinner" />
                <span>{t('git.loading')}</span>
              </div>
            ) : (
              <Suspense
                fallback={
                  <div class="diff-loading-wrap">
                    <div class="git-spinner" />
                    <span>{t('git.loading')}</span>
                  </div>
                }
              >
                <DiffViewer
                  diffText={currentDiffTab.diffText}
                  filePath={currentDiffTab.filePath}
                  commitHash={currentDiffTab.commitHash}
                  commitMessage={currentDiffTab.commitMessage}
                />
              </Suspense>
            )}
          </div>
        );
      })()}
      </div>

      {/* Right Inspector Multi-Tab Panel (Keep-Alive 保活：常驻 DOM，CSS 显隐切换，杜绝卸载重载与蹦图) */}
      {isRightPanelVisible && (
        <div
          class="right-inspector-backdrop"
          onClick={() => setRightPanelCollapsed(true)}
          aria-hidden="true"
        />
      )}
      <aside
        class={'right-inspector-panel' + (rightPanelCollapsed ? ' is-collapsed-hidden' : '')}
        style={{ display: rightPanelCollapsed ? 'none' : 'flex' }}
        aria-label={rightPanelTab === 'questions' ? t('panel.questions') : t('panel.git')}
      >
        {/* Draggable Resizer on left edge */}
        <div
          class="right-panel-resizer"
          onMouseDown={handleResizerMouseDown as any}
          title="Drag to resize panel"
        />

        {/* Header Tab Bar */}
        <div class="right-panel-header">
          <div class="right-panel-tabs">
            <button
              type="button"
              class={'right-panel-tab-btn' + (rightPanelTab === 'questions' ? ' active' : '')}
              onClick={() => setRightPanelTab('questions')}
              title={t('panel.questions')}
              aria-label={t('panel.questions')}
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                <circle cx="8" cy="8" r="6.2" />
                <path d="M6 6.5a2 2 0 0 1 3.8.8c0 1.2-1.8 1.5-1.8 2.5" />
                <circle cx="8" cy="12.2" r="0.7" fill="currentColor" />
              </svg>
              {turnNavItems.length > 0 && <span class="tab-badge">{turnNavItems.length}</span>}
            </button>

            <button
              type="button"
              class={'right-panel-tab-btn' + (rightPanelTab === 'git' ? ' active' : '')}
              onClick={() => setRightPanelTab('git')}
              title={t('panel.git')}
              aria-label={t('panel.git')}
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path fill-rule="evenodd" clip-rule="evenodd" d="M11.75 3a1.75 1.75 0 1 0-1.07 3.13 4.25 4.25 0 0 1-2.93 2.12v-1.5a1.75 1.75 0 1 0-1.5 0v4.5a1.75 1.75 0 1 0 1.5 0V9.8a5.75 5.75 0 0 0 3.75-2.67A1.75 1.75 0 0 0 11.75 3zm-6.25 10a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zm0-7a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zm6.25-2a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5z" />
              </svg>
            </button>

            <button
              type="button"
              class={'right-panel-tab-btn' + (rightPanelTab === 'terminal' ? ' active' : '')}
              onClick={() => setRightPanelTab('terminal')}
              title={t('panel.terminal') || '终端'}
              aria-label={t('panel.terminal') || '终端'}
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3 5l4 3-4 3m6 0h4" />
              </svg>
            </button>

            <button
              type="button"
              class={'right-panel-tab-btn' + (rightPanelTab === 'preview' ? ' active' : '') + (eyeDragOver ? ' is-drag-over-eye' : '')}
              onClick={() => setRightPanelTab('preview')}
              onDragEnter={handleEyeDragOver as any}
              onDragOver={handleEyeDragOver as any}
              onDragLeave={handleEyeDragLeave as any}
              onDrop={handleEyeDrop as any}
              title={t('panel.preview') || '预览'}
              aria-label={t('panel.preview') || '预览'}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
          </div>

          <span class="right-panel-title">
            {rightPanelTab === 'questions' ? t('turnNav.title') : rightPanelTab === 'git' ? t('git.title') : rightPanelTab === 'terminal' ? (t('panel.terminal') || '终端') : (t('panel.preview') || '预览')}
          </span>

          <button
            type="button"
            class="right-panel-collapse-btn"
            onClick={() => setRightPanelCollapsed(true)}
            title={t('panel.collapse')}
            aria-label={t('panel.collapse')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
              <path d="M6 4l4 4-4 4" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div class="right-panel-body">
          <div style={{ display: rightPanelTab === 'questions' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0, height: '100%', width: '100%' }}>
            <nav class="turn-nav" aria-label={t('turnNav.title')}>
              <div class="turn-nav-header">
                <input
                  class="turn-nav-search"
                  type="text"
                  value={turnNavQuery}
                  placeholder={t('turnNav.searchPlaceholder')}
                  aria-label={t('turnNav.searchPlaceholder')}
                  onInput={(e) => setTurnNavQuery((e.target as HTMLInputElement).value)}
                />
              </div>
              <div class="turn-nav-list">
                {filteredTurnNavItems.length === 0 ? (
                  <div class="turn-nav-empty">
                    {turnNavItems.length === 0 ? t('turnNav.empty') : t('turnNav.noMatch')}
                  </div>
                ) : (
                  filteredTurnNavItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      class={'turn-nav-item' + (item.id === activeTurnId ? ' active' : '')}
                      title={item.text}
                      onClick={() => jumpToTurn(item.id)}
                    >
                      {item.label}
                    </button>
                  ))
                )}
              </div>
            </nav>
          </div>

          <div style={{ display: rightPanelTab === 'git' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0, height: '100%', width: '100%' }}>
            <Suspense
              fallback={
                <div class="git-empty-state">
                  <div class="git-spinner" />
                  <span>{t('git.loading')}</span>
                </div>
              }
            >
              <GitPanel
                cwd={effectiveWorkingDir}
                refreshTrigger={gitRefreshTrigger}
                onBranchChanged={(newB) => {
                  setGitRefreshTrigger((n) => n + 1);
                  onCwdChanged?.(effectiveWorkingDir || '');
                }}
                onOpenFileDiff={handleOpenFileDiff}
                onOpenWorkingDiff={handleOpenWorkingDiff}
              />
            </Suspense>
          </div>

          <div style={{ display: rightPanelTab === 'terminal' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0, height: '100%', width: '100%' }}>
            <TerminalPanel cwd={effectiveWorkingDir || cwd} active={rightPanelTab === 'terminal' && !rightPanelCollapsed} />
          </div>

          <div style={{ display: rightPanelTab === 'preview' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0, height: '100%', width: '100%' }}>
            <PreviewPanel
              cwd={effectiveWorkingDir || cwd}
              onOpenInMainEditor={(filePath) => {
                window.dispatchEvent(new CustomEvent('jeikcode:open_file', { detail: { path: filePath } }));
              }}
            />
          </div>
        </div>
      </aside>

      {/* 折叠收起悬浮条 */}
      {rightPanelCollapsed && (
        <div
          class="right-panel-collapsed-rail draggable-floating-widget"
          role="toolbar"
          aria-label={t('chat.inspectorTabs')}
          style={{ top: `${widgetPos.top}px`, left: `${widgetPos.left}px`, right: 'auto' }}
        >
          <div
            class="widget-drag-handle"
            onMouseDown={handleWidgetMouseDown as any}
            onTouchStart={handleWidgetMouseDown as any}
            title={t('common.drag')}
            aria-label={t('common.dragHandle')}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <circle cx="5" cy="4" r="1.5" />
              <circle cx="11" cy="4" r="1.5" />
              <circle cx="5" cy="8" r="1.5" />
              <circle cx="11" cy="8" r="1.5" />
              <circle cx="5" cy="12" r="1.5" />
              <circle cx="11" cy="12" r="1.5" />
            </svg>
          </div>
          <button
            type="button"
            class="right-panel-tab-btn"
            onClick={() => {
              setRightPanelTab('git');
              setRightPanelCollapsed(false);
            }}
            title={t('panel.git')}
            aria-label={t('panel.git')}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path fill-rule="evenodd" clip-rule="evenodd" d="M11.75 3a1.75 1.75 0 1 0-1.07 3.13 4.25 4.25 0 0 1-2.93 2.12v-1.5a1.75 1.75 0 1 0-1.5 0v4.5a1.75 1.75 0 1 0 1.5 0V9.8a5.75 5.75 0 0 0 3.75-2.67A1.75 1.75 0 0 0 11.75 3zm-6.25 10a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zm0-7a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zm6.25-2a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5z" />
            </svg>
            <span class="rail-tab-text">Git</span>
          </button>
          <button
            type="button"
            class="right-panel-tab-btn"
            onClick={() => {
              setRightPanelTab('terminal');
              setRightPanelCollapsed(false);
            }}
            title={t('panel.terminal') || '终端'}
            aria-label={t('panel.terminal') || '终端'}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 5l4 3-4 3m6 0h4" />
            </svg>
            <span class="rail-tab-text">{t('panel.terminal') || '终端'}</span>
          </button>
          <button
            type="button"
            class={'right-panel-tab-btn' + (eyeDragOver ? ' is-drag-over-eye' : '')}
            onClick={() => {
              setRightPanelTab('preview');
              setRightPanelCollapsed(false);
            }}
            onDragEnter={handleEyeDragOver as any}
            onDragOver={handleEyeDragOver as any}
            onDragLeave={handleEyeDragLeave as any}
            onDrop={handleEyeDrop as any}
            title={t('panel.preview') || '预览'}
            aria-label={t('panel.preview') || '预览'}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <span class="rail-tab-text">{t('panel.preview') || '预览'}</span>
          </button>
          <button
            type="button"
            class="right-panel-tab-btn"
            onClick={() => {
              setRightPanelTab('questions');
              setRightPanelCollapsed(false);
            }}
            title={t('panel.questions')}
            aria-label={t('panel.questions')}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
              <circle cx="8" cy="8" r="6.2" />
              <path d="M6 6.5a2 2 0 0 1 3.8.8c0 1.2-1.8 1.5-1.8 2.5" />
              <circle cx="8" cy="12.2" r="0.7" fill="currentColor" />
            </svg>
            <span class="rail-tab-text">{t('turnNav.title')}</span>
            {turnNavItems.length > 0 && <span class="tab-badge">{turnNavItems.length}</span>}
          </button>
        </div>
      )}

      {/* 浮动搜索框:默认隐藏,Cmd/Ctrl+F 呼出,Esc/× 关闭。仿浏览器 Find-in-page 样式:
          长条胶囊、无图标、右侧依次 ↑ ↓ ×。position:absolute 钉在容器右上角,不占布局空间。
          Enter/↓ 下一条,Shift+Enter/↑ 上一条;零匹配时计数显示提示,导航按钮隐藏。 */}
      {searchOpen && messages.length > 0 && (
        <div class="msg-search-float" role="search" aria-label={t('chat.searchPlaceholder')}>
          <input
            class="msg-search-input"
            // type="text" 而非 "search"——后者在 Firefox 仍显示默认清除按钮,
            // 与自定义 × 重复。type="text" 全浏览器一致,清除仅走自定义路径。
            type="text"
            ref={searchInputRef}
            value={search}
            placeholder={t('chat.searchPlaceholder')}
            onInput={(e) => { setSearch((e.target as HTMLInputElement).value); setMatchIdx(0); }}
            onKeyDown={(e) => {
              // Enter/↓ = 下一条;Shift+Enter/↑ = 上一条。输入框内 ↑/↓ 不移动光标
              // (单行输入无光标位置歧义),直接在匹配间跳转。
              if (e.key === 'Enter') {
                if (searchTrim && matchPositions.length > 0) {
                  e.preventDefault();
                  navMatch(e.shiftKey ? -1 : 1);
                }
              } else if (e.key === 'ArrowDown' && searchTrim && matchPositions.length > 0) {
                e.preventDefault();
                navMatch(1);
              } else if (e.key === 'ArrowUp' && searchTrim && matchPositions.length > 0) {
                e.preventDefault();
                navMatch(-1);
              }
            }}
            aria-label={t('chat.searchPlaceholder')}
          />
          <span class="msg-search-count">
            {searchTrim
              ? (matchPositions.length > 0
                  ? `${matchIdx + 1}/${matchPositions.length}`
                  : t('chat.searchNoMatch'))
              : ''}
          </span>
          <button
            class="msg-search-nav"
            onClick={() => navMatch(-1)}
            title={t('chat.searchPrev')}
            aria-label={t('chat.searchPrev')}
            type="button"
            disabled={!searchTrim || matchPositions.length === 0}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="5 12 12 5 19 12" />
            </svg>
          </button>
          <button
            class="msg-search-nav"
            onClick={() => navMatch(1)}
            title={t('chat.searchNext')}
            aria-label={t('chat.searchNext')}
            type="button"
            disabled={!searchTrim || matchPositions.length === 0}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19" />
              <polyline points="19 12 12 19 5 12" />
            </svg>
          </button>
          <button
            class="msg-search-close"
            onClick={closeSearch}
            title={t('chat.searchClose')}
            aria-label={t('chat.searchClose')}
            type="button"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}

      {/* Jump-to-bottom: shown only when the user has scrolled up (follow released). */}
      {showJumpBtn && (
        <button
          class="jump-to-bottom"
          onClick={() => scrollToBottom('smooth')}
          title={t('chat.jumpToBottom')}
          aria-label={t('chat.jumpToBottom')}
        >
          ↓
        </button>
      )}

      {/* Floating input */}
      {persistenceWarning && (
        <div class="persistence-warning" role="status">
          <span aria-hidden="true">⚠</span>
          <span>{persistenceWarning}</span>
          <button
            type="button"
            class="persistence-warning-dismiss"
            aria-label={t('common.dismiss')}
            onClick={() => setPersistenceWarning(null)}
          >
            ×
          </button>
        </div>
      )}
      {historyHint && (
        <div class="persistence-warning history-hint-warning" role="status">
          <span aria-hidden="true">⚠</span>
          <span>{historyHint}</span>
          <button
            type="button"
            class="persistence-warning-dismiss"
            aria-label={t('common.dismiss')}
            onClick={() => setHistoryHint(null)}
          >
            ×
          </button>
        </div>
      )}
      {activeMainTabId === 'chat' && (
        <div class="input-container">
          <div class="input-wrap">
            {stickyTodoPanel}
            {inputBox}
          </div>
        </div>
      )}
      </div>
      {topModelChrome}
      {confirmModal.open && (
        <ConfirmDialog
          title={confirmModal.title}
          body={confirmModal.body}
          confirmLabel={confirmModal.confirmLabel ?? t('confirm.confirmBtn')}
          cancelLabel={confirmModal.cancelLabel ?? t('common.cancel')}
          danger={confirmModal.danger ?? true}
          icon={confirmModal.icon}
          onConfirm={confirmModal.onConfirm}
          onClose={() => setConfirmModal((prev) => ({ ...prev, open: false }))}
        />
      )}
    </>
  );
}

/** Render an assistant message's ordered parts in chronological order: each
 *  text run becomes Markdown; runs of consecutive tool calls share one
 *  `.tool-list` container. This is what preserves the text→tool→text→tool
 *  interleaving (matching the TUI) instead of grouping all tools at the head. */
function AssistantMessageView({
  msg,
  isLast,
  busy,
  lastIdx: _lastIdx,
  isLastInTurn,
  turnLastText,
  turnAllText,
  searchRef,
  timeLabel,
  timeFull,
  liveElapsedMs,
  turnTotalMs,
  isCompacting,
  search,
  isActiveSearchMatch,
  onRegenerate,
  onDelete,
  cwd,
}: {
  msg: Message;
  isLast: boolean;
  busy: boolean;
  lastIdx: number;
  isLastInTurn: boolean;
  turnLastText: string;
  turnAllText: string;
  searchRef?: (el: HTMLElement | null) => void;
  timeLabel?: string;
  timeFull?: string;
  liveElapsedMs?: number;
  /** User-bubble → this final answer. Only set on the last assistant of the turn. */
  turnTotalMs?: number;
  isCompacting?: boolean;
  search: string;
  isActiveSearchMatch: boolean;
  onRegenerate?: () => void;
  onDelete?: () => void;
  cwd?: string;
}) {
  const t = useT();
  const text = messageText(msg);
  const trimmed = text.trim();
  const isError =
    !messageHasTools(msg) &&
    !msg.parts.some((p) => p.kind === 'reasoning') &&
    (trimmed.startsWith('[错误:') ||
      trimmed.startsWith('[连接错误:') ||
      trimmed.startsWith('[Error:') ||
      trimmed.startsWith('[Connection error:'));
  const streaming = isLast && busy;
  // 终条且简短（无工具、单行）时，去掉多余 of "时间线末端"橙点，只留一个起始点。
  const terse =
    isLast && !streaming && !messageHasTools(msg) && !text.includes('\n');
  const dotClass = isError ? 'dot-error' : 'dot-brand';
  const cls =
    'timeline-message ' +
    dotClass +
    (streaming ? ' dot-blink' : '') +
    (isLast ? ' is-last' : '') +
    (terse ? ' is-terse' : '') +
    (isActiveSearchMatch ? ' is-active-search-match' : '');

  // Copy buttons: only shown on the last assistant message in a turn.
  // 1. 复制最后正文回答 (Copy final response)
  // 2. 复制所有正文 (Copy all responses)
  const [copiedLast, setCopiedLast] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);

  function handleCopyLast() {
    const target = turnLastText || turnAllText;
    if (!target) return;
    void copyTextToClipboard(target).then((ok) => {
      if (ok) {
        setCopiedLast(true);
        setTimeout(() => setCopiedLast(false), 2000);
      } else {
        // Surface failure — silent .catch previously made the button look dead.
        showToast(t('copy.failed'), 'error');
      }
    });
  }

  function handleCopyAll() {
    const target = turnAllText || turnLastText;
    if (!target) return;
    void copyTextToClipboard(target).then((ok) => {
      if (ok) {
        setCopiedAll(true);
        setTimeout(() => setCopiedAll(false), 2000);
      } else {
        showToast(t('copy.failed'), 'error');
      }
    });
  }

  const copyBtn = isLastInTurn && !isError && !streaming && (turnLastText || turnAllText || onRegenerate || onDelete) ? (
    <div class="msg-actions msg-actions-left assistant-footer-actions">
      {(turnLastText || turnAllText) && (
        <>
          <button
            class={'msg-copy-btn' + (copiedLast ? ' copied' : '')}
            onClick={handleCopyLast}
            title={copiedLast ? t('copy.copiedLast') : t('copy.copyLast')}
            aria-label={copiedLast ? t('copy.copiedLast') : t('copy.copyLast')}
          >
            {copiedLast ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" stroke="currentColor" stroke-width="1.2" />
                <path d="M2.5 10.5V3.5A1.5 1.5 0 0 1 4 2h7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
              </svg>
            )}
          </button>
          <button
            class={'msg-copy-btn' + (copiedAll ? ' copied' : '')}
            onClick={handleCopyAll}
            title={copiedAll ? t('copy.copiedAll') : t('copy.copyAll')}
            aria-label={copiedAll ? t('copy.copiedAll') : t('copy.copyAll')}
          >
            {copiedAll ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="4.5" y="4.5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.2" />
                <path d="M2.5 10.5V3A1.5 1.5 0 0 1 4 1.5h6.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
                <path d="M7 7.5h4M7 9.5h4M7 11.5h2.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" />
              </svg>
            )}
          </button>
        </>
      )}
      {onRegenerate && (
        <button
          type="button"
          class="msg-action-btn btn-regenerate"
          onClick={onRegenerate}
          title={t('chat.regenerate')}
          aria-label={t('chat.regenerate')}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          </svg>
        </button>
      )}
      {onDelete && (
        <button
          type="button"
          class="msg-action-btn btn-delete"
          onClick={onDelete}
          title={t('chat.deleteMessage')}
          aria-label={t('chat.deleteMessage')}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      )}
    </div>
  ) : null;

  const hasContent = msg.parts.some(
    (p) => (p.kind === 'text' && p.text.trim().length > 0) || p.kind === 'tool' || p.kind === 'reasoning',
  );

  return (
    <div class={cls} ref={searchRef}>
      {/* Error turns are pure injected text — render flat. */}
      {isError ? (
        <div class="error-message-content">
          {highlightText(text, search)}
          {streaming && !hasContent && (
            <span class="codex-shimmer-status" aria-live="polite">
              Working...
            </span>
          )}
        </div>
      ) : (
        <>
          {/* Segments in chronological order: text→tool→text→tool,
              matching the TUI. Consecutive tools share one tool-list. */}
          {renderAssistantParts(msg.parts, search, cwd)}
          {streaming && !hasContent && (
            <span class="codex-shimmer-status" aria-live="polite">
              {isCompacting ? 'Compacting...' : 'Working...'}
            </span>
          )}
          {streaming && hasContent && isCompacting && (
            <span class="codex-shimmer-status" aria-live="polite" style={{ display: 'block', marginTop: '6px' }}>
              Compacting...
            </span>
          )}
        </>
      )}
      <div class="msg-footer-row assistant-footer-row">
        {/* 只在本轮最后一条助手消息上显示时刻和用时。中间的工具/思考/分段正文不要时间。 */}
        {isLastInTurn && timeLabel && !streaming && !isError && (
          <span class="msg-time" title={timeFull}>
            <span class="msg-clock">{timeLabel}</span>
            {turnTotalMs != null && (
              <span class="msg-turn-elapsed">
                {t('chat.turnElapsedDone', { time: formatTurnElapsed(turnTotalMs) })}
              </span>
            )}
          </span>
        )}
        {isLastInTurn && !timeLabel && !streaming && turnTotalMs != null && !isError && (
          <span class="msg-time">
            <span class="msg-turn-elapsed">
              {t('chat.turnElapsedDone', { time: formatTurnElapsed(turnTotalMs) })}
            </span>
          </span>
        )}
        {isLastInTurn && streaming && liveElapsedMs != null && (
          <span class="msg-time is-live" aria-live="polite">
            <span class="msg-turn-elapsed">
              {t('chat.turnElapsedLive', { time: formatTurnElapsed(liveElapsedMs) })}
            </span>
          </span>
        )}
        {copyBtn}
      </div>
    </div>
  );
}

function renderAssistantParts(parts: MsgPart[], search: string, cwd?: string): VNode[] {
  const out: VNode[] = [];
  let trailingTodos: { kind: 'todo_list'; items: TodoItem[] } | null = null;
  let i = 0;
  while (i < parts.length) {
    const p = parts[i];
    if (p.kind === 'todo_list') {
      trailingTodos = p;
      i++;
      continue;
    }
    if (p.kind === 'tool') {
      const groupKey = i;
      const tools: ToolRow[] = [];
      while (i < parts.length) {
        const q = parts[i];
        if (q.kind === 'todo_list') {
          trailingTodos = q;
          i++;
          continue;
        }
        if (q.kind !== 'tool') break;
        tools.push(q.tool);
        i++;
      }
      if (tools.length > 0) {
        out.push(
          <ToolGroupView key={`tg-${groupKey}`} tools={tools} />
        );
      }
    } else if (p.kind === 'reasoning') {
      out.push(<ReasoningBlock key={`rs-${i}`} text={p.text} search={search} />);
      i++;
    } else if (p.kind === 'notice') {
      out.push(
        <div class="msg-notice" key={`nt-${i}`}>
          {highlightText(p.text, search)}
        </div>,
      );
      i++;
    } else if (p.kind === 'rate_limited') {
      out.push(
        <div class="rate-limited-notice" key={`rl-${i}`}>
          {highlightText(p.text, search)}
        </div>,
      );
      i++;
    } else if (p.kind === 'text') {
      if (p.text) out.push(<Markdown key={`tx-${i}`} content={p.text} search={search} cwd={cwd} targetContext="chat" />);
      i++;
    } else {
      i++;
    }
  }

  // 待办清单是整轮任务的最终成果核对单，始终且必然沉淀在助手回复的最末尾（所有思考、工具卡片、最终文本的最下方）！
  if (trailingTodos && trailingTodos.items.length > 0) {
    out.push(
      <SessionTodoPanel key="td-trailing" items={trailingTodos.items} embedded />,
    );
  }

  return out;
}

/** Collapsible thinking / reasoning block (chain-of-thought stream). */
function ReasoningBlock({ text, search }: { text: string; search: string }) {
  const t = useT();
  // Default expanded while streaming (short / growing); collapse once settled
  // if the user prefers — start open so live thinking is visible.
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Follow latest tokens at the bottom until the user scrolls up (same policy
  // as the main timeline: sticky follow, release on manual up-scroll).
  const followBottomRef = useRef(true);
  const REASONING_BOTTOM_SLACK = 48;
  const recomputeFollow = () => {
    const el = bodyRef.current;
    if (!el) return;
    followBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= REASONING_BOTTOM_SLACK;
  };
  useEffect(() => {
    if (!open) return;
    const el = bodyRef.current;
    if (!el || !followBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [text, open]);
  if (!text.trim()) return null;
  return (
    <div class={'reasoning-block' + (open ? ' is-open' : '')}>
      <button
        type="button"
        class="reasoning-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span class="reasoning-icon" aria-hidden="true">
          ✦
        </span>
        <span class="reasoning-label">{t('chat.thinking')}</span>
        <span class={'reasoning-chevron' + (open ? ' expanded' : '')}>▾</span>
      </button>
      {open && (
        <div class="reasoning-body" ref={bodyRef} onScroll={recomputeFollow}>
          {highlightText(text, search)}
        </div>
      )}
    </div>
  );
}

/**
 * Todo panel — sticky above the composer (live turn) or embedded at the
 * bottom of a frozen assistant reply (after the user advanced).
 */
function SessionTodoPanel({
  items,
  embedded = false,
}: {
  items: TodoItem[];
  embedded?: boolean;
}) {
  const t = useT();
  const { completed, inProgress, total } = todoCounts(items);
  // 默认展开以展示完整的多步骤任务树，不再因移动端窄屏默认收起导致误判为「只有单张卡片」
  const [collapsed, setCollapsed] = useState(false);

  const activeTask = items.find((i) => i.status === 'in_progress');

  return (
    <div
      class={'session-todo-panel' + (embedded ? ' is-embedded' : '') + (collapsed ? ' is-collapsed' : '')}
      role="region"
      aria-label={t('todo.panelTitle')}
    >
      <div
        class="session-todo-header"
        onClick={() => setCollapsed(!collapsed)}
        title={t(collapsed ? 'panel.expand' : 'panel.collapse')}
      >
        <span class="session-todo-collapse-icon" aria-hidden="true">
          {collapsed ? '▸' : '▾'}
        </span>
        <span class="session-todo-title">{t('todo.panelTitle')}</span>
        {collapsed && activeTask && (
          <span class="session-todo-active-snippet" title={activeTask.content}>
            • {activeTask.content}
          </span>
        )}
        <span class="session-todo-summary">
          {t('todo.summary', {
            done: String(completed),
            active: String(inProgress),
            total: String(total),
          })}
        </span>
      </div>
      {!collapsed && (
        <div class="session-todo-list">
          {items.map((item, i) => (
            <div class={'session-todo-row status-' + item.status} key={i}>
              <span class="session-todo-glyph" aria-hidden="true">
                {item.status === 'completed' ? '√' : item.status === 'in_progress' ? '•' : '○'}
              </span>
              <span class="session-todo-content">{item.content}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function highlightText(text: string, search: string) {
  if (!search.trim()) return text;
  const searchLower = search.toLowerCase();
  const index = text.toLowerCase().indexOf(searchLower);
  if (index === -1) return text;
  
  const parts: (string | VNode)[] = [];
  let lastIndex = 0;
  let idx = index;
  let key = 0;
  while (idx !== -1) {
    if (idx > lastIndex) {
      parts.push(text.substring(lastIndex, idx));
    }
    parts.push(
      <mark key={key++} class="msg-search-highlight">
        {text.substring(idx, idx + search.length)}
      </mark>
    );
    lastIndex = idx + search.length;
    idx = text.toLowerCase().indexOf(searchLower, lastIndex);
  }
  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex));
  }
  return parts;
}

function UserMessageView({
  msg,
  anchorId,
  turnNavIdx,
  searchRef,
  timeLabel,
  timeFull,
  search,
  isActiveSearchMatch,
  isEditing,
  draftText,
  draftImages,
  draftModel,
  onDraftChange,
  onStartEdit,
  onCancelEdit,
  onSaveRewrite,
  onRollbackSubmit,
  onDelete,
  models,
  currentModel,
  disabled,
  cwd,
}: {
  msg: Message;
  anchorId?: string;
  turnNavIdx?: number;
  searchRef?: (el: HTMLElement | null) => void;
  timeLabel?: string;
  timeFull?: string;
  search: string;
  isActiveSearchMatch: boolean;
  isEditing?: boolean;
  draftText?: string;
  draftImages?: ImageData[];
  draftModel?: string;
  onDraftChange?: (text: string, images: ImageData[], selectedModel?: string) => void;
  onStartEdit?: () => void;
  onCancelEdit?: () => void;
  onSaveRewrite?: (text: string, images: ImageData[]) => void;
  onRollbackSubmit?: (text: string, images: ImageData[], tempModel?: string) => void;
  onDelete?: () => void;
  models?: ModelInfo[];
  currentModel?: string;
  disabled?: boolean;
  cwd?: string;
}) {
  const t = useT();
  // 技能/文档型消息默认折叠为一行徽章，点击展开查看原文。
  const text = messageText(msg);
  const skillTitle = detectSkillContent(text);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    void copyUserMessage(text, msg.images).then((ok) => {
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } else {
        showToast(t('copy.failed'), 'error');
      }
    });
  }

  // 气泡内全选文本快捷键/右键复制时，连同多图附件一块打包入剪贴板
  function handleBubbleCopy(e: ClipboardEvent) {
    if (!msg.images || msg.images.length === 0) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const selText = sel.toString().trim();
    const fullText = text.trim();
    if (selText && (selText === fullText || selText.length >= fullText.length)) {
      e.preventDefault();
      const dataUrls = msg.images.map((img) => `data:${img.media_type};base64,${img.data}`);
      const html = buildCopyHtml(dataUrls, text);
      if (e.clipboardData) {
        e.clipboardData.setData('text/plain', text);
        e.clipboardData.setData('text/html', html);
      }
      void copyUserMessage(text, msg.images);
      showToast(t('copy.copiedWithMedia'), 'info');
    }
  }

  const images = msg.images && msg.images.length > 0 && (
    <div class="msg-images">
      {msg.images.map((img, i) => (
        <MsgImage key={i} img={img} />
      ))}
    </div>
  );

  const copyBtn = (
    <button
      class={'msg-copy-btn' + (copied ? ' copied' : '')}
      onClick={handleCopy}
      title={copied ? t('copy.copied') : t('copy.copy')}
      aria-label={copied ? t('copy.copied') : t('copy.copy')}
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" stroke="currentColor" stroke-width="1.2" />
          <path d="M2.5 10.5V3.5A1.5 1.5 0 0 1 4 2h7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
        </svg>
      )}
    </button>
  );

  const wrapperClass = 'user-message-wrapper' + (isActiveSearchMatch ? ' is-active-search-match' : '');

  if (isEditing && onSaveRewrite && onRollbackSubmit && onCancelEdit) {
    return (
      <div class={wrapperClass + ' is-editing'} id={anchorId} data-turn-nav={anchorId || undefined} data-turn-nav-idx={turnNavIdx} ref={searchRef}>
        <InlineBubbleEditor
          initialText={draftText ?? text}
          initialImages={draftImages ?? msg.images}
          models={models ?? []}
          currentModel={draftModel ?? currentModel ?? ''}
          onSaveRewrite={onSaveRewrite}
          onRollbackSubmit={onRollbackSubmit}
          onCancel={onCancelEdit}
          onDraftChange={onDraftChange}
          disabled={disabled}
        />
      </div>
    );
  }

  if (skillTitle && !expanded) {
    return (
      <div class={wrapperClass} id={anchorId} data-turn-nav={anchorId || undefined} data-turn-nav-idx={turnNavIdx} ref={searchRef}>
        {images}
        <button
          class="skill-badge"
          onClick={() => setExpanded(true)}
          title={t('chat.skillExpand')}
        >
          <span class="skill-badge-icon" aria-hidden="true">⚡</span>
          <span class="skill-badge-label notranslate" translate={false}>{skillTitle}</span>
          <span class="skill-badge-hint">{t('chat.skillExpand')}</span>
        </button>
        {timeLabel && <div class="msg-time msg-time-user" title={timeFull}>{timeLabel}</div>}
      </div>
    );
  }

  return (
    <div class={wrapperClass} id={anchorId} data-turn-nav={anchorId || undefined} data-turn-nav-idx={turnNavIdx} ref={searchRef}>
      <div
        class={'user-message-bubble' + (skillTitle ? ' is-markdown' : '')}
        onCopy={handleBubbleCopy}
      >
        {images}
        {skillTitle && (
          <button class="skill-collapse" onClick={() => setExpanded(false)}>
            {t('chat.skillCollapse')}
          </button>
        )}
        {/* 技能/文档型内容本就是 markdown（注入的 SKILL.md），渲染它；
            普通用户消息保持逐字纯文本（不把用户输入当 markdown 解析）。 */}
        {skillTitle ? <Markdown content={text} search={search} cwd={cwd} targetContext="chat" /> : highlightText(text, search)}
      </div>
      <div class="msg-footer-row user-footer-row">
        {timeLabel && <span class="msg-time msg-time-user" title={timeFull}>{timeLabel}</span>}
        <div class="user-footer-actions">
          {copyBtn}
          {onStartEdit && !disabled && (
            <button
              type="button"
              class="msg-action-btn btn-edit"
              onClick={onStartEdit}
              title={t('chat.editMessage')}
              aria-label={t('chat.editMessage')}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>
          )}
          {onDelete && !disabled && (
            <button
              type="button"
              class="msg-action-btn btn-delete"
              onClick={onDelete}
              title={t('chat.deleteMessage')}
              aria-label={t('chat.deleteMessage')}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Status glyph: a check when done, a cross on error, otherwise a spinner that
// animates while the call is pending / awaiting approval.
function ToolStatusIcon({ cls }: { cls: string }) {
  const spin = cls === 'pending' || cls === 'waiting';
  return (
    <svg
      class={'tool-status-icon' + (spin ? ' spin' : '')}
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {cls === 'success' ? (
        <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
      ) : cls === 'error' ? (
        <path d="M4 4l8 8M12 4l-8 8" />
      ) : cls === 'warning' ? (
        <path d="M8 2.5 14 13H2L8 2.5ZM8 6v3.5M8 11.5h.01" />
      ) : (
        <path d="M8 2.5a5.5 5.5 0 1 1-5.18 3.65" />
      )}
    </svg>
  );
}

function DiffStatBadge({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  if (additions === 0 && deletions === 0) return null;
  return (
    <span class="diff-stat-badge" aria-label={`+${additions} -${deletions}`}>
      {additions > 0 && <span class="diff-stat-add">+{additions}</span>}
      {deletions > 0 && <span class="diff-stat-del">-{deletions}</span>}
    </span>
  );
}

function ToolGroupView({ tools }: { tools: ToolRow[] }) {
  const t = useT();
  const [batchExpanded, setBatchExpanded] = useState<boolean | null>(null);
  const [batchVersion, setBatchVersion] = useState(0);

  const doneCount = tools.filter((tool) => tool.status === 'done').length;
  const errorCount = tools.filter((tool) => tool.status === 'error' || tool.status === 'incomplete').length;
  const runningCount = tools.filter((tool) => tool.status === 'pending' || tool.status === 'waiting_approval').length;

  // 关键过滤：只有真正执行了写/编辑/全局替换类工具或命令时，才计入“修改文件数”；git diff 等只读检查绝不计入已修改文件数！
  const writingTools = tools.filter((tool) => isWritingTool(tool.name, tool.args));
  const hasWritingTools = writingTools.length > 0;
  const allDiffStats = writingTools.map((tool) => computeToolDiffStats(tool.name, tool.output, tool.args));
  const totalAdditions = allDiffStats.reduce((sum, s) => sum + (s?.additions ?? 0), 0);
  const totalDeletions = allDiffStats.reduce((sum, s) => sum + (s?.deletions ?? 0), 0);
  const hasDiffStats = totalAdditions > 0 || totalDeletions > 0;

  return (
    <div class="tool-list">
      {tools.length > 1 && (
        <div class="tool-group-header">
          <span class="tool-group-summary">
            <span class="tool-group-icon" aria-hidden="true">⚡</span>
            <span>
              {hasWritingTools && writingTools.length === tools.length
                ? t('tool.filesChanged', { count: String(writingTools.length) })
                : t('tool.groupSummary', {
                    total: String(tools.length),
                    done: String(doneCount),
                  })}
            </span>
            {hasDiffStats && (
              <DiffStatBadge additions={totalAdditions} deletions={totalDeletions} />
            )}
            {runningCount > 0 && (
              <span class="tool-group-badge running">
                {runningCount} {t('tool.running')}
              </span>
            )}
            {errorCount > 0 && (
              <span class="tool-group-badge error">
                {errorCount} {t('tool.failed')}
              </span>
            )}
          </span>
          <div class="tool-group-actions">
            <button
              type="button"
              class="tool-group-btn"
              onClick={() => {
                setBatchExpanded(true);
                setBatchVersion((v) => v + 1);
              }}
            >
              {t('tool.expandAll')}
            </button>
            <span class="tool-group-sep">·</span>
            <button
              type="button"
              class="tool-group-btn"
              onClick={() => {
                setBatchExpanded(false);
                setBatchVersion((v) => v + 1);
              }}
            >
              {t('tool.collapseAll')}
            </button>
          </div>
        </div>
      )}
      {tools.map((tool) => (
        <ToolRowView
          key={tool.id}
          tool={tool}
          forceExpanded={batchExpanded}
          forceVersion={batchVersion}
        />
      ))}
    </div>
  );
}

function ToolRowView({
  tool,
  forceExpanded = null,
  forceVersion = 0,
}: {
  tool: ToolRow;
  forceExpanded?: boolean | null;
  forceVersion?: number;
}) {
  const t = useT();
  const userCollapsedRef = useRef(false);
  const userManuallyExpandedRef = useRef(false);
  const outputRef = useRef<HTMLPreElement>(null);
  const hasSubtasks = !!(tool.subtasks && tool.subtasks.length > 0);
  const category = toolCategory(tool.name);
  const glyph = toolGlyph(tool.name);
  // 关键过滤：仅当工具实际写入文件（isWritingTool）、属于纯展示的合法 shell diff（如 git diff），
  // 或作为专用差异渲染工具（如 edit/write）时才计算变更指标；常规只读终端命令绝不显示 +N -M 徽章。
  const shouldComputeDiff =
    category !== 'terminal'
      ? toolRendersAsDiff(tool.name) ||
        tool.name === 'write' ||
        tool.name === 'write_file' ||
        tool.name === 'create_file'
      : isWritingTool(tool.name, tool.args) ||
        isViewOnlyShellDiff(tool.name, tool.output, tool.args);
  const diffStats = shouldComputeDiff
    ? computeToolDiffStats(tool.name, tool.output, tool.args)
    : null;

  // Default: collapsed! Only auto-expand if status is error/incomplete so problems are immediately visible.
  const [expanded, setExpanded] = useState(
    () => tool.status === 'error' || tool.status === 'incomplete',
  );

  // Batch expand/collapse support from parent ToolGroupView
  const prevBatchVersionRef = useRef(forceVersion);
  useEffect(() => {
    if (forceVersion !== prevBatchVersionRef.current) {
      prevBatchVersionRef.current = forceVersion;
      if (forceExpanded !== null) {
        setExpanded(forceExpanded);
        userCollapsedRef.current = !forceExpanded;
        userManuallyExpandedRef.current = forceExpanded;
      }
    }
  }, [forceExpanded, forceVersion]);

  // When a tool transitions to error/incomplete during live execution,
  // auto-expand it to alert the user (unless they explicitly collapsed it).
  useEffect(() => {
    if (userCollapsedRef.current) return;
    if (tool.status === 'error' || tool.status === 'incomplete') {
      setExpanded(true);
    }
  }, [tool.status]);

  useEffect(() => {
    if (!expanded || !tool.output || !outputRef.current) return;
    outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [expanded, tool.output]);

  let annotation: { cls: string; label: string } | null = null;
  if (tool.status === 'waiting_approval') {
    annotation = { cls: 'waiting', label: t('tool.waiting') };
  } else if (tool.status === 'pending') {
    annotation = { cls: 'pending', label: t('tool.running') };
  } else if (tool.status === 'done') {
    annotation = { cls: 'success', label: t('tool.done') };
  } else if (tool.status === 'error') {
    annotation = { cls: 'error', label: t('tool.failed') };
  } else if (tool.status === 'incomplete') {
    annotation = { cls: 'warning', label: t('tool.incomplete') };
  }

  const hasDetail = hasSubtasks ? false : !!(tool.args || tool.output);
  const showFlatProgress =
    tool.status === 'pending' && !!tool.progress && !hasSubtasks;

  const counts = hasSubtasks ? subtaskCounts(tool.subtasks!) : null;
  const headerDetail = counts
    ? t('subtask.summary', {
        done: String(counts.completed),
        total: String(counts.total),
        running: String(counts.running),
        pending: String(counts.pending),
        failed: String(counts.failed),
      })
    : abbreviateArgs(formatToolDetail(tool.name, tool.args));

  return (
    <div class={'tool-body kind-' + category}>
      <div
        class="tool-header"
        onClick={() => {
          if (!hasDetail) return;
          setExpanded((e) => {
            const next = !e;
            userCollapsedRef.current = !next;
            userManuallyExpandedRef.current = next;
            return next;
          });
        }}
      >
        <span class="tool-glyph" aria-hidden="true">{glyph}</span>
        <span class="tool-name notranslate" translate={false}>{displayToolName(tool.name)}</span>
        <ToolArgPreview text={headerDetail} />
        {diffStats && (
          <DiffStatBadge additions={diffStats.additions} deletions={diffStats.deletions} />
        )}
        {annotation && (
          <span class={'tool-annotation ' + annotation.cls}>
            <ToolStatusIcon cls={annotation.cls} />
            {annotation.label}
          </span>
        )}
        {hasDetail && (
          <span class={'tool-chevron' + (expanded ? ' expanded' : '')}>▾</span>
        )}
      </div>
      {hasSubtasks && <SubtaskPanel items={tool.subtasks!} />}
      {showFlatProgress && (
        <div class="tool-progress" title={tool.progress}>{tool.progress}</div>
      )}
      {expanded && hasDetail && (
        <ToolExpandedBody tool={tool} outputRef={outputRef} />
      )}
    </div>
  );
}

function CopyableCodeBlock({
  text,
  lang,
  live,
  outputRef,
}: {
  text: string;
  lang?: string;
  live?: boolean;
  outputRef?: { current: HTMLPreElement | null };
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return (
    <div class="code-block-wrapper tool-code-block">
      <pre ref={outputRef} class={live ? 'is-live' : undefined}>
        <code class={lang ? `language-${lang}` : undefined}>{text}</code>
      </pre>
      <button
        type="button"
        class="copy-button"
        onClick={(e) => {
          e.stopPropagation();
          void copyTextToClipboard(text).then((ok) => {
            if (!ok) {
              showToast(t('copy.failed'), 'error');
              return;
            }
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? t('copy.copied') : t('copy.copy')}
      </button>
    </div>
  );
}

function DiffBody({
  lines,
  raw,
  variant = 'applied',
  caption,
}: {
  lines: DiffPreviewLine[];
  raw?: string;
  variant?: 'applied' | 'planned';
  caption?: string;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div class={'code-block-wrapper tool-code-block tool-diff-block is-' + variant}>
      {caption ? <div class="tool-diff-caption">{caption}</div> : null}
      <pre class="tool-diff-body">
        {lines.map((line, i) => {
          if (line.kind === 'meta') {
            return (
              <span key={i} class="diff-line diff-meta">
                <span class="diff-ln" />
                <span class="diff-content">
                  <span class="diff-code">{line.text || ' '}</span>
                </span>
              </span>
            );
          }
          const ln = line.kind === 'del' ? line.oldLine : (line.newLine ?? line.oldLine);
          const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
          const body = line.text.replace(/^[-+ ]/, '');
          return (
            <span key={i} class={'diff-line diff-' + line.kind}>
              <span class="diff-ln">{ln != null ? ln : ''}</span>
              <span class="diff-content">
                <span class="diff-sign">{sign}</span>
                <span class="diff-code">{body || ' '}</span>
              </span>
            </span>
          );
        })}
      </pre>
      {raw ? (
        <button
          type="button"
          class="copy-button"
          onClick={(e) => {
            e.stopPropagation();
            void copyTextToClipboard(raw).then((ok) => {
              if (!ok) {
                showToast(t('copy.failed'), 'error');
                return;
              }
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? t('copy.copied') : t('copy.copy')}
        </button>
      ) : null}
    </div>
  );
}

function formatTerminalOutput(raw?: string): string {
  if (!raw) return '';
  let text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (text.includes('#< CLIXML')) {
    const lines = text.split('\n');
    const filtered: string[] = [];
    let inError = false;
    let errorBuf = '';
    for (const line of lines) {
      if (line.startsWith('#< CLIXML')) continue;
      if (line.includes('<S S="Error">')) {
        inError = true;
        const start = line.indexOf('<S S="Error">') + '<S S="Error">'.length;
        const remainder = line.slice(start);
        const end = remainder.indexOf('</S>');
        if (end !== -1) {
          errorBuf += remainder.slice(0, end);
          inError = false;
        } else {
          errorBuf += remainder;
        }
        continue;
      }
      if (inError) {
        const end = line.indexOf('</S>');
        if (end !== -1) {
          errorBuf += line.slice(0, end);
          inError = false;
        } else {
          errorBuf += line;
        }
        continue;
      }
      if (line.trim().startsWith('<') && line.trim().endsWith('>')) continue;
      if (line.trim()) filtered.push(line);
    }
    if (errorBuf) {
      const cleaned = errorBuf
        .replace(/_x000D__x000A_/g, '\n')
        .replace(/_x000D_/g, '\n')
        .replace(/_x000A_/g, '\n')
        .replace(/_x0020_/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .trim();
      if (cleaned) filtered.push(cleaned);
    }
    text = filtered.join('\n');
  }
  return text;
}

function ToolTerminalBody({
  tool,
  outputRef,
  hideOutput = false,
}: {
  tool: ToolRow;
  outputRef: { current: HTMLPreElement | null };
  hideOutput?: boolean;
}) {
  const t = useT();
  const live = tool.status === 'pending';
  const cmd = jsonArgString(tool.args, 'command') || tool.args;
  const summary = jsonArgString(tool.args, 'summary').trim();
  const [copied, setCopied] = useState(false);
  const terminalOut = useMemo(() => formatTerminalOutput(tool.output), [tool.output]);

  const handleCopy = (e: MouseEvent) => {
    e.stopPropagation();
    const contentToCopy = terminalOut || cmd || '';
    if (!contentToCopy) return;
    void copyTextToClipboard(contentToCopy).then((ok) => {
      if (!ok) {
        showToast(t('copy.failed'), 'error');
        return;
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div class={'tool-terminal' + (live ? ' is-live' : '')}>
      {summary && <div class="tool-terminal-cmd">{summary}</div>}
      {cmd && <div class="tool-terminal-cmd">$ {cmd}</div>}
      {terminalOut && !hideOutput ? (
        <div class="code-block-wrapper tool-code-block">
          <pre ref={outputRef} class={'tool-terminal-out' + (live ? ' is-live' : '')}>
            <code>{terminalOut}</code>
          </pre>
          <button
            type="button"
            class="copy-button"
            onClick={handleCopy}
            title={copied ? t('copy.copied') : t('copy.copy')}
            aria-label={copied ? t('copy.copied') : t('copy.copy')}
          >
            {copied ? t('copy.copied') : t('copy.copy')}
          </button>
        </div>
      ) : live ? (
        <div class="tool-terminal-out is-empty is-live"></div>
      ) : null}
    </div>
  );
}

function ToolExpandedBody({
  tool,
  outputRef,
}: {
  tool: ToolRow;
  outputRef: { current: HTMLPreElement | null };
}) {
  const t = useT();
  const live = tool.status === 'pending';
  const category = toolCategory(tool.name);

  // 1. Bash / terminal tool: render a unified terminal console ($ command + output).
  //    A read-only `git diff` reuses the edit red/green panel for display only.
  if (category === 'terminal') {
    const shellDiff = isViewOnlyShellDiff(tool.name, tool.output, tool.args)
      ? resolveToolDiffPreview(tool.name, tool.output, tool.args)
      : null;
    if (shellDiff) {
      return (
        <div class="tool-terminal-diff">
          <ToolTerminalBody tool={tool} outputRef={outputRef} hideOutput />
          <DiffBody
            lines={shellDiff.lines}
            raw={shellDiff.raw}
            variant="applied"
            caption={t('tool.diffView')}
          />
        </div>
      );
    }
    return <ToolTerminalBody tool={tool} outputRef={outputRef} />;
  }

  const argsPretty = tool.args ? prettyToolText(tool.args) : null;
  const outputPretty = tool.output ? prettyToolText(tool.output) : null;
  const diffPreview = resolveToolDiffPreview(tool.name, tool.output, tool.args, tool.status);
  const isDone = tool.status === 'done';
  const diffIsPlanned = !isDone && diffPreview?.source === 'args';
  const isDiagnostic = !isDone && diffPreview?.source === 'diagnostic';
  const isFailed = tool.status === 'error';
  const diffCaption = isDiagnostic
    ? t('tool.diffDiagnostic')
    : isFailed
    ? t('tool.diffFailed')
    : diffIsPlanned
    ? t('tool.diffPlanned')
    : t('tool.diffApplied');

  return (
    <div class={'tool-cli' + (live ? ' is-live' : '')}>
      {argsPretty && argsPretty.text && (
        <div class="tool-cli-row">
          <div class="tool-cli-label">{t('tool.args')}</div>
          <CopyableCodeBlock text={argsPretty.text} lang={argsPretty.lang} />
        </div>
      )}
      {tool.output && (
        <div class="tool-cli-row">
          <div class="tool-cli-label">{t('tool.output')}</div>
          {diffPreview ? (
            <>
              {(diffIsPlanned || isDiagnostic || isFailed) && tool.output.trim() ? (
                <pre class="tool-edit-error">{tool.output.trim()}</pre>
              ) : null}
              <DiffBody
                lines={diffPreview.lines}
                raw={diffPreview.raw}
                variant={diffIsPlanned || isDiagnostic || isFailed ? 'planned' : 'applied'}
                caption={diffCaption}
              />
            </>
          ) : (
            <CopyableCodeBlock
              text={outputPretty?.text || tool.output}
              lang={outputPretty?.lang}
              live={live}
              outputRef={outputRef}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** Parallel sub-agent rows — TUI `SubtaskProgress` panel parity. */
function SubtaskPanel({ items }: { items: import('../lib/subtasks').SubtaskItem[] }) {
  const t = useT();
  const { completed, running, pending, failed, total } = subtaskCounts(items);
  // Prefer showing active/failed rows; completed ones stay visible so the
  // panel still reads as a full fan-out (unlike TUI footer which hides done).
  return (
    <div class="subtask-panel">
      <div class="subtask-panel-header">
        {t('subtask.summary', {
          done: String(completed),
          total: String(total),
          running: String(running),
          pending: String(pending),
          failed: String(failed),
        })}
      </div>
      <div class="subtask-list">
        {items.map((item) => (
          <div class={'subtask-row status-' + item.status} key={item.label}>
            <span class="subtask-status-dot" aria-hidden="true">
              {item.status === 'completed'
                ? '✓'
                : item.status === 'failed'
                  ? '✗'
                  : item.status === 'running'
                    ? '●'
                    : '○'}
            </span>
            <span class="subtask-label">{item.label}</span>
            {item.model && <span class="subtask-model">{item.model}</span>}
            <span class="subtask-desc" title={item.description || item.activity}>
              {item.activity || item.description || '—'}
            </span>
            {item.outputTokens > 0 && (
              <span class="subtask-tokens">↑ {item.outputTokens}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
