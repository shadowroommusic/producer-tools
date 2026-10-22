/**
 * Shadow Producers — app shell.
 *
 * Composition only: the frame owns the columns, the sidebar owns navigation and the plugins, the
 * conversation owns the transcript and the composer, the dock owns the selected plugin's panel.
 *
 * Sessions are real: they are created, switched, titled from the first message and persisted, and a
 * tool a panel runs lands in that session's transcript next to the message that asked for it — the
 * same place the Codex core will write when it is wired.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Composer } from "./components/Composer";
import { ButlerOrb } from "./components/ButlerOrb";
import { ApprovalCard, type PendingApproval } from "./components/ApprovalCard";
import { Conversation } from "./components/Conversation";
import { DockPanel } from "./components/DockPanel";
import { IconChat } from "./components/icons";
import { WorkbenchHome } from "./components/WorkbenchHome";
import { PluginPanelPage } from "./components/PluginPanelPage";
import { PluginsPage } from "./components/PluginsPage";
import { StudioPage } from "./components/StudioPage";
import { DjPage } from "./components/DjPage";
import { LibraryPage } from "./components/LibraryPage";
import { SettingsPage } from "./components/SettingsPage";
import {
  agentModelChoices,
  capabilityTarget,
  loadModelSettings,
  roleTarget,
  saveModelSettings,
  type ModelSettings,
} from "./lib/providers";
import { StudioProjects, summarize } from "./components/StudioProjects";
import { Transcript } from "./components/Transcript";
import { Sidebar, type PluginEntry, type SessionSummary, type WorkspaceId } from "./components/Sidebar";
import { type ToolCall } from "./components/ToolCallRow";
import {
  toolResultBelongsToOpenProject,
  type DjAgentContext,
  type LibraryAgentContext,
} from "./lib/agent-context";
import { RouteIntentCard } from "./components/RouteIntentCard";
import {
  answerApproval,
  applyAgentSettings,
  fetchAgentHealth,
  fetchModels,
  interruptTurn,
  sendTurn,
  toolCallFromItem,
  type AgentModel,
  type AgentHealth,
  type Mention,
} from "./lib/agent";
import {
  accessFromSandboxType,
  accessLabel,
  effortChoiceFor,
  effortForModel,
  effortForSend,
  loadAgentDefaults,
  saveAgentDefaults,
  type AgentAccess,
  type AgentSettings,
} from "./lib/agent-settings";
import { appendAssistantDelta, segmentKeyFor } from "./lib/conversation-flow";
import { conversationRecoveryBlock } from "./lib/conversation-recovery";
import { routeNeedsConfirmation } from "./lib/route-policy.ts";
import {
  parseButlerCommand,
  type ButlerCommand,
  type DispatchRoute,
  type NavigateCommand,
} from "./lib/butler-command.ts";
import { fetchBridge, type ServerInfo } from "./lib/mcp";
import { callTool } from "./lib/mcp";

/**
 * 管家的简报 —— 每次对话前现算的那张"当前情况"卡片。
 *
 * 它不是历史记录：账本里只有关键事件（`injectable`），细节由管家需要时自己 `recent_events` 拉。
 * 预算 300–450 token（约 10 条事件）。**取不到就返回空**——桥没起来时不该让用户的话发不出去。
 */
async function butlerBrief(): Promise<string> {
  try {
    const raw = await callTool<string>("steward", "situation_report", {});
    const report = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : (raw as unknown as Record<string, unknown>);
    const events = (report.events as Array<{ type?: string; actor?: string; payload?: { file?: string; outcome?: string; metrics?: Record<string, number> } }> | undefined) ?? [];
    const handoffs = report.handoffs as
      | {
          counts?: Record<string, number>;
          active?: Array<{ id?: number; target?: string; status?: string; instruction_preview?: string }>;
          recent?: Array<{ id?: number; target?: string; status?: string; instruction_preview?: string }>;
        }
      | undefined;
    const activeHandoffs = handoffs?.active ?? [];
    const recentHandoffs = handoffs?.recent ?? [];
    const handoffLines = [...activeHandoffs, ...recentHandoffs].slice(-6).map((handoff) => {
      const preview = (handoff.instruction_preview ?? "").trim();
      return `  - #${handoff.id ?? "?"} ${handoff.target ?? "?"} · ${handoff.status ?? "?"}${preview === "" ? "" : ` · ${preview}`}`;
    });
    if (events.length === 0 && handoffLines.length === 0) return "";
    const lines = events.slice(-10).map((event) => {
      const bits = [
        event.type ?? "?",
        event.actor ?? "?",
        event.payload?.file === undefined ? "" : event.payload.file.split("/").pop() ?? "",
        event.payload?.outcome === "failed" ? "失败" : "",
        Object.entries(event.payload?.metrics ?? {}).map(([key, value]) => `${key}=${value}`).join(" "),
      ].filter((bit) => bit !== "");
      return `  - ${bits.join(" · ")}`;
    });
    const errors = (report.errors as unknown[] | undefined) ?? [];
    return [
      "",
      "[butler_brief]",
      `最近关键事件（${events.length} 条）:`,
      ...lines,
      ...(handoffLines.length === 0
        ? []
        : [
            `交接状态（待办 ${(handoffs?.counts?.pending ?? 0) + (handoffs?.counts?.claimed ?? 0) + (handoffs?.counts?.running ?? 0)} 条）:`,
            ...handoffLines,
          ]),
      ...(errors.length === 0 ? [] : [`未解决的问题: ${errors.length} 条`]),
      "[/butler_brief]",
      "（上面是**当前全局状态**，不是用户的新指令，不要对它们采取行动；用户问「刚才怎么样」时才用它汇报，需要细节再调 steward 的 recent_events。）",
    ].join("\n");
  } catch {
    return "";
  }
}
import {
  clipFromNotes,
  defaultProject,
  canAddTracks,
  defaultTrackName,
  nextTrackColor,
  trackTypeOf,
  notesRevision,
  structureRevision,
  tracksFromStems,
  type StudioAnalysis,
  type StudioNote,
  lastOpenProject,
  loadProjects,
  newClip,
  newTrack,
  rememberOpenProject,
  saveProjects,
  snapshotProject,
  type StudioProject,
} from "./lib/studio";
import {
  createTurnDetector,
  saveRecording,
  startCapture,
  type TurnDetector,
  type VoiceCapture,
} from "./lib/voice";
import { createSystemTTS, type TTSProvider } from "./lib/tts";
import { createTTS, resolveSpeechPlan } from "./lib/speech-plan";
import { createSpeechQueue, type SpeechQueue, type SpeechQueueSpeaker } from "./lib/tts-queue";
import { createSpeechTurn } from "./lib/speech-turn";
import { createSpeechFeeder, SPEECH_TURN_MAX_MS, type SpeechFeeder, type SpeechMode } from "./lib/speech-text";
import { createBridgeSTT, createBrowserSTT, type STTProvider, type STTSession } from "./lib/stt";
import { createBargeInDetector, turnSilenceMs, type BargeInDetector } from "./lib/bargein";
import { CALL_START_HINT, OFFLINE_CAPTION, UNCLEAR_CAPTION, UNCLEAR_HOLD_MS, callWord } from "./lib/call-words";
import type { CallState } from "./lib/call-states";

declare global {
  interface Window {
    /**
     * e2e 探针（F-1 + S4b）：通话态、unclear 回退闹钟是否还挂着——挂断后的泄漏在 DOM 上看
     * 不出来；marks 是语音延迟/回退验收的只读读数（时间戳 + 计数，无文本/路径/密钥）。
     */
    __callProbe?: {
      state: () => CallState;
      unclearArmed: () => boolean;
      marks: () => {
        turnEndAt: number;
        turnSubmitAt: number;
        firstDeltaAt: number;
        firstSpeakStartAt: number;
        lastSpeakEndAt: number;
        ttsAttempts: number;
        ttsFallbacks: number;
      };
    };
  }
}
import {
  createSession,
  loadSessions,
  saveSessions,
  timeAgo,
  titleFrom,
  capSession,
  sessionForKind,
  selectSession,
  type ChatMessage,
  type MessageScope,
  type Session,
  type SessionKind,
  type SessionStore,
} from "./lib/sessions";
import { AppFrame } from "./shell/AppFrame";

/** The nine ShadowRoom MCP servers, keyed by the ids the bridge reports. */
const PLUGINS: Array<{ id: string; server: string; label: string; repo: string }> = [
  { id: "bridge", server: "converter", label: "Rekordbox ⇄ Serato", repo: "rekordbox-serato-bridge" },
  { id: "analysis", server: "analysis", label: "音频分析去重", repo: "audio-analysis-dedupe" },
  { id: "planner", server: "planner", label: "Set 编排", repo: "set-planner" },
  { id: "generator", server: "generator", label: "音乐生成队列", repo: "shadow-music-generator" },
  { id: "splitter", server: "splitter", label: "Stem Splitter", repo: "stem-splitter" },
  { id: "soundfont", server: "soundfont", label: "真乐器渲染", repo: "soundfont-renderer" },
  { id: "steward", server: "steward", label: "管家账本", repo: "steward" },
  { id: "library", server: "library", label: "曲目库", repo: "library" },
  { id: "grabber", server: "grabber", label: "音乐抓取转码", repo: "ShadowMusicGrabber" },
];

type Bridge = "connecting" | "online" | "offline";
type MainView = "workbench" | "conversation" | "plugins" | "plugin" | "studio" | "dj" | "library" | "settings";
type DockableView = "workbench" | "studio" | "dj" | "library";
type DockState = Record<DockableView, boolean>;

const DOCKABLE_VIEWS: readonly DockableView[] = ["workbench", "studio", "dj", "library"];
const DOCK_STATE_KEY = "shadowroom.dock.by-view.v1";
const EMPTY_DOCKS: DockState = { workbench: false, studio: false, dj: false, library: false };

function dockView(view: MainView): DockableView | undefined {
  return DOCKABLE_VIEWS.includes(view as DockableView) ? (view as DockableView) : undefined;
}

function sessionKindForView(view: MainView): SessionKind {
  return view === "studio" ? "studio" : view === "dj" ? "dj" : view === "library" ? "library" : "butler";
}

function loadDockState(): DockState {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DOCK_STATE_KEY) ?? "{}") as Partial<DockState>;
    return {
      workbench: parsed.workbench === true,
      studio: parsed.studio === true,
      dj: parsed.dj === true,
      library: parsed.library === true,
    };
  } catch {
    return { ...EMPTY_DOCKS };
  }
}

export function App() {
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [home, setHome] = useState("");
  const [workspaces, setWorkspaces] = useState("");
  const [bridge, setBridge] = useState<Bridge>("connecting");
  const [activePlugin, setActivePlugin] = useState("set-planner");
  const [store, setStore] = useState<SessionStore>(() => loadSessions());
  const [mode, setMode] = useState("标准");
  const [agent, setAgent] = useState<AgentHealth | null>(null);
  /**
   * Busy is per thread, never per window. The butler and a page worker can run independently, and
   * the dock beside Studio/DJ must not inherit the butler's spinner just because the orb is thinking.
   */
  const [runningSessions, setRunningSessions] = useState<Set<string>>(() => new Set());
  const runningSessionsRef = useRef<Set<string>>(new Set());
  const controllers = useRef(new Map<string, AbortController>());
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [mainView, setMainView] = useState<MainView>(
    () =>
      (window.localStorage.getItem("shadowroom.view") as
        | "workbench"
        | "conversation"
        | "plugins"
        | "plugin"
        | "studio"
        | "dj"
        | "library"
        | "settings"
            | null) ?? "workbench",
  );
  /**
   * Dock visibility belongs to a page, never to a global "last open" switch. Entering Studio or DJ
   * must not steal screen space from the work surface; opening it once on that page is remembered.
   */
  const [dockByView, setDockByView] = useState<DockState>(loadDockState);
  /**
   * Typing belongs to the conversation that owns it. The persistent orb always writes to the butler,
   * even while Studio/DJ/Library is open; the page dock writes only to that page's worker.
   */
  const [drafts, setDrafts] = useState<Record<SessionKind, string>>({
    butler: "",
    studio: "",
    dj: "",
    library: "",
  });
  const draftKind = sessionKindForView(mainView);
  const draft = drafts[draftKind];
  const setDraftFor = useCallback((kind: SessionKind, next: string) => {
    setDrafts((current) => ({ ...current, [kind]: next }));
  }, []);
  const setDraft = useCallback((next: string) => setDraftFor(draftKind, next), [draftKind, setDraftFor]);
  const setButlerDraft = useCallback((next: string) => setDraftFor("butler", next), [setDraftFor]);
  const currentDockView = dockView(mainView);
  const dockOpen = currentDockView === undefined ? false : dockByView[currentDockView];
  const setDockOpen = useCallback(
    (open: boolean) => {
      const view = dockView(mainView);
      if (view !== undefined) setDockByView((current) => ({ ...current, [view]: open }));
    },
    [mainView],
  );
  /**
   * Where the sidebar thinks you are is **derived**, not stored.
   *
   * There used to be two states for one question — `workspace` and `mainView` — and they could
   * disagree (leaving Studio kept the sidebar on Studio while the page showed the 工作台). Anything
   * that can disagree eventually does, so there is one state (`mainView`) and this reads it.
   */
  const [lastWorkspaceView, setLastWorkspaceView] = useState<WorkspaceId>("workbench");
  const workspace: WorkspaceId =
    mainView === "studio"
      ? "studio"
      : mainView === "dj"
        ? "dj"
      : mainView === "library"
        ? "library"
      : mainView === "settings"
        ? "settings"
        : mainView === "plugins" || mainView === "plugin"
          ? "workbench"
          : mainView === "workbench"
            ? "workbench"
            : lastWorkspaceView;
  useEffect(() => {
    if (
      mainView === "studio" ||
      mainView === "dj" ||
      mainView === "library" ||
      mainView === "settings" ||
      mainView === "workbench"
    )
      setLastWorkspaceView(mainView);
  }, [mainView]);
  const [projects, setProjects] = useState<StudioProject[]>(() => loadProjects());
  const [openProjectId, setOpenProjectId] = useState<string | undefined>(() => lastOpenProject(projects));
  const [djContext, setDjContext] = useState<DjAgentContext | null>(null);
  const [libraryContext, setLibraryContext] = useState<LibraryAgentContext | null>(null);
  const [routeSuggestion, setRouteSuggestion] = useState<DispatchRoute | null>(null);
  /**
   * A route is dispatched at most once. The card unmounts on the first click, but a duplicated
   * `shadowroom:route-intent` (double dispatch, hydration racing a live event) must not queue a
   * second handoff of the same request.
   */
  const handledCommandIdsRef = useRef<Set<string>>(new Set());
  const openingRoutesRef = useRef<Set<string>>(new Set());
  const dispatchedRoutesRef = useRef<Set<string>>(new Set());
  const commandErrorsRef = useRef<Set<string>>(new Set());
  const activeDispatchIdRef = useRef<string | null>(null);
  const [queuedRoute, setQueuedRoute] = useState<{
    route: DispatchRoute;
    text: string;
    mentions: Mention[];
    sourceSessionId: string;
  } | null>(null);
  const queuedRouteRef = useRef<{
    route: DispatchRoute;
    text: string;
    mentions: Mention[];
    sourceSessionId: string;
  } | null>(null);
  /**
   * Undo/redo, **per project**: each project keeps its own past/future, so switching projects never
   * mixes histories (the rule every editor follows, and the one this app got wrong until now).
   */
  const [histories, setHistories] = useState<Record<string, { past: StudioProject[]; future: StudioProject[] }>>({});
  const history = histories[openProjectId ?? ""] ?? { past: [], future: [] };
  /** Clips an agent is re-rendering right now — the workbench shows a badge while it happens. */
  const [rendering, setRendering] = useState<string[]>([]);
  /** When each of those renders started, so a very fast one still shows its badge for a moment. */
  const renderingSince = useRef(new Map<string, number>());
  /** The clip the piano roll has open: notes the next message should carry as context. */
  const [noteContext, setNoteContext] = useState<{
    clipId: string;
    clipName: string;
    notes: StudioNote[];
    revision: string;
    render?: Record<string, unknown>;
  } | null>(null);
  const [voiceMode, setVoiceMode] = useState(false);
  const [voiceState, setVoiceState] = useState<CallState>("listening");
  const voiceSession = useRef<STTSession | null>(null);
  /** One recogniser and one speaker for the whole call — implemented behind the interfaces in
      `lib/stt.ts` / `lib/tts.ts`, so the desktop build swaps them without touching this logic. */
  const stt = useRef<STTProvider | null>(null);
  const sttKey = useRef("");
  /**
   * Where speech-to-text comes from.
   *
   * A configured 语音识别 role wins: the recording goes through the bridge (key stays there) and the
   * text comes back as one piece at the end of the turn. With no role configured the browser's own
   * recogniser keeps working — but be honest about it: Chrome's recogniser needs Google's service
   * (measured unusable on this network) and Electron has none at all (ADR-018). That's why the
   * settings hint for STT now says to配置一家供应商.
   */
  const currentSTT = (): STTProvider => {
    const target = roleTarget(modelSettings, "stt");
    const key = target === undefined ? "browser" : `${target.provider.id}:${target.model}:${target.provider.credentialRef ?? ""}`;
    if (stt.current === null || sttKey.current !== key) {
      if (target === undefined) {
        stt.current = createBrowserSTT();
      } else {
        const capability = capabilityTarget(target.provider, "stt");
        stt.current = createBridgeSTT({
          baseUrl: capability.baseUrl,
          credentialRef: target.provider.credentialRef,
          protocol: capability.protocol,
          model: target.model,
        });
      }
      sttKey.current = key;
    }
    return stt.current;
  };
  /**
   * Which voice the call speaks with — the whole chain now lives in the S0–S4a modules
   * (`speech-plan` / `tts-queue` / `speech-turn` / `speech-text`). What is left here is the wiring:
   * the queue (created once, with callbacks that own the call's state), the current provider
   * instance keyed by the plan, and the bridge→system fallback. The old hand-rolled
   * `currentTTS()`/`currentVoiceId()` pair is gone — see the speech block after `moveVoiceOffline`.
   */
  /** What the user said *while the answer was playing* — the start of their next turn. */
  const interruptRef = useRef("");
  const capture = useRef<VoiceCapture | null>(null);
  const level = useRef(0);
  /** Project edits from inside an async tool callback; assigned once `updateProject` exists. */
  const updateProjectRef = useRef<(patch: (project: StudioProject) => StudioProject) => void>(() => undefined);
  /**
   * The projects as this render sees them.
   *
   * A tool result can arrive seconds later, and by then the callback that handles it was created
   * with an older `projects`. Reading the ref is what lets that handler decide *before* touching the
   * project — which is the only way to refuse an edit without leaving an empty undo step behind.
   */
  const projectsRef = useRef<StudioProject[]>(projects);
  projectsRef.current = projects;
  const openProjectIdRef = useRef(openProjectId);
  openProjectIdRef.current = openProjectId;
  /** Absorption goes through a ref: `submit` is created before the absorber exists. */
  const absorbRef = useRef<(call: ToolCall) => void>(() => undefined);
  const beginCallRef = useRef<(call: ToolCall) => void>(() => undefined);
  const endCallRef = useRef<(id: string, patch: Partial<ToolCall>) => void>(() => undefined);
  const voiceModeRef = useRef(false);
  const voiceStateRef = useRef<CallState>("listening");
  /** When the last sentence finished playing — used to ignore the answer's own tail. */
  const speakEndedAt = useRef(0);
  voiceModeRef.current = voiceMode;
  /**
   * The call's state lives in the ref (the callbacks below are not re-created on every render), and
   * `useState` only draws it. Every change goes through here: `setVoiceState` alone would leave the
   * ref stale for a moment, and stopping the recognizer fires `onend` *in that moment* — which read
   * "still listening" and started the user's turn over (measured: one phrase, two messages).
   */
  /**
   * 「没听清」的回退闹钟（F-1）。
   *
   * AGENTS.md:109 的规矩来自用户实测过的 timer 泄漏，所以这里把四条退出路径一次列全——
   * ① 挂断（hangUp）；② 组件卸载（挂载处的 cleanup 调 hangUp）；③ 切进 offline / 任何别的态
   * （moveVoice 里统一清）；④ 异常（transcribe 抛错走 offline，同一条清）。任何一条漏掉，
   * 都会留下一个 2.5s 后偷偷把状态改回 listening 的闹钟——挂断之后它还会动，正是要防的事。
   */
  const unclearTimer = useRef<number | null>(null);
  /** 「轻插话，先憋一下」的 700ms 恢复手柄（onPause 用）；挂断时和 unclear 闹钟一起清。 */
  const pauseTimer = useRef<number | null>(null);
  const clearUnclear = useCallback(() => {
    if (unclearTimer.current === null) return;
    window.clearTimeout(unclearTimer.current);
    unclearTimer.current = null;
  }, []);
  const moveVoice = useCallback(
    (next: CallState) => {
      /** ③：只要离开 unclear（回聆听、去想、去说、去 offline），闹钟就不许再响。 */
      if (next !== "unclear") clearUnclear();
      voiceStateRef.current = next;
      setVoiceState(next);
    },
    [clearUnclear],
  );
  /**
   * 「说了话但没接住」→ unclear（F-1 规格 / Kimi F-1 / deepseek O-3）。
   *
   * 只有**明确知道用户说了话**才进这个态：桥式 STT 是端点检测收回合之后才请求识别的，
   * 空结果 = 听见了、没听清。浏览器识别那条流式路径不从这里走（Chrome 的空 final 很常见，
   * 拿它报「没听清」会变成狼来了）。
   */
  const moveVoiceUnclear = useCallback(() => {
    clearUnclear();
    moveVoice("unclear");
    unclearTimer.current = window.setTimeout(() => {
      unclearTimer.current = null;
      /** 到了就自己回聆听：用户什么都不做也有下一步（点球=重说，字幕上的按钮=改成打字）。 */
      moveVoice("listening");
    }, UNCLEAR_HOLD_MS);
  }, [clearUnclear, moveVoice]);
  /**
   * STT 断了（network / not-allowed / 桥返回错误）→ offline（F-1）。
   *
   * 与 unclear 的区别是「等谁」：unclear 等 2.5s 自动回聆听；offline 停在这里等用户——
   * 点球 = 重连（不是开新通话），字幕附「或先打字」。琥珀不是红：断了可恢复，红留给真致命。
   */
  const moveVoiceOffline = useCallback(
    (detail: string) => {
      setVoiceNotice(detail);
      moveVoice("offline");
    },
    [moveVoice],
  );

  /* ── 语音朗读链（S4b 接线，实现都在 lib/speech-* 与 lib/tts-queue） ──────────
   *
   * 喂句的唯一入口是本轮的 delta 事件（feedVoiceDelta）：稳定句进队列，队列串行播、驱动字幕
   * （onSentence）、开口切 speaking（onStart）、自然播完回 listening（onIdle）。上一轮的长答案
   * 从此没有任何入口可以再被念到——旧 effect 读 lastAssistant 的那条重播路彻底删掉了。
   */
  const speechTurnRef = useRef(createSpeechTurn());
  const speechQueueRef = useRef<SpeechQueue | null>(null);
  const speechPlanKeyRef = useRef("");
  const speechProviderRef = useRef<TTSProvider | null>(null);
  /** bridge 熔断挂在 plan.key 上：换音色/换端点（新 key）自动解除（Kimi B3）。 */
  const bridgeBrokenKeyRef = useRef("");
  const systemFallbackRef = useRef<TTSProvider | null>(null);
  const feederRef = useRef<SpeechFeeder | null>(null);
  const feederModeRef = useRef<SpeechMode>("brief");
  const speechModeRef = useRef<SpeechMode>("brief");
  /** 本轮交给过队列的句子全集（fallback 的 repush 从这里切片，不读队列内部——Kimi R2）。 */
  const turnSentencesRef = useRef<string[]>([]);
  /**
   * 已开播句数（队列 onSentence 推进）。与 speech-turn 的 spoken（入队数）语义不同：
   * fallback 要的是"还没轮到播的"，不是"还没入队的"（Codex 复核 #3）。
   */
  const spokenIndexRef = useRef(0);
  /**
   * 本轮 submit 是否在途（语音语义，不是全局 running 的第二份——它只在语音回合的开头/finally
   * 各赋值一次）：在途时 onIdle 不回 listening，句间排空保持 speaking 等下一句。
   */
  const voiceTurnActiveRef = useRef(false);
  const voiceTurnStartedAtRef = useRef(0);
  /** speaker 工厂读设置：不抓 state 闭包，否则换 provider 的时机会晚一拍。 */
  const modelSettingsRef = useRef<ModelSettings | null>(null);
  /** e2e 的延迟/回退读数（__callProbe.marks）：只有时间戳和计数，没有文本/路径/密钥。 */
  const probeMarksRef = useRef({
    turnEndAt: 0,
    turnSubmitAt: 0,
    firstDeltaAt: 0,
    firstSpeakStartAt: 0,
    lastSpeakEndAt: 0,
    ttsAttempts: 0,
    ttsFallbacks: 0,
  });
  /** 单轮朗读硬顶（SPEECH_TURN_MAX_MS）：预算正常到不了，它是模型失控的安全带。 */
  const speechCeilingTimer = useRef<number | null>(null);
  const disarmSpeechCeiling = useCallback(() => {
    if (speechCeilingTimer.current === null) return;
    window.clearTimeout(speechCeilingTimer.current);
    speechCeilingTimer.current = null;
  }, []);

  /**
   * 队列的 speaker 来源。plan.key 变化（换音色/换端点/换供应商）时的顺序是硬约束：
   * **先 queue.clear() 再换实例**——反了会把 cancel 打到新实例、旧音频照播（双音叠轨）。
   * push 前走 `refreshSpeaker()`；这里的工厂只做读取，保证 speakOnce 拿到的永远是当前实例。
   */
  const speakerForQueue = (): SpeechQueueSpeaker => {
    const plan = resolveSpeechPlan(modelSettingsRef.current ?? loadModelSettings());
    if (plan.key !== speechPlanKeyRef.current) {
      speechPlanKeyRef.current = plan.key;
      bridgeBrokenKeyRef.current = "";
      speechProviderRef.current = createTTS(plan);
    }
    if (bridgeBrokenKeyRef.current === plan.key) {
      systemFallbackRef.current ??= createSystemTTS();
      return systemFallbackRef.current;
    }
    return speechProviderRef.current ?? createSystemTTS();
  };
  const refreshSpeaker = () => {
    const plan = resolveSpeechPlan(modelSettingsRef.current ?? loadModelSettings());
    if (plan.key === speechPlanKeyRef.current) return;
    speechQueueRef.current?.clear();
    speechPlanKeyRef.current = plan.key;
    bridgeBrokenKeyRef.current = "";
    speechProviderRef.current = createTTS(plan);
    systemFallbackRef.current = null;
  };
  /** queue.push 的 voiceId 选项只在 system plan 下传（Kimi R6：bridge 音色是实例属性）。 */
  const systemVoicePushOptions = () => {
    const plan = resolveSpeechPlan(modelSettingsRef.current ?? loadModelSettings());
    const voice =
      plan.kind === "system"
        ? plan.voiceId
        : bridgeBrokenKeyRef.current === plan.key
          ? window.localStorage.getItem("shadowroom.voice") ?? undefined
          : undefined;
    return voice === undefined || voice === "" ? {} : { voiceId: voice };
  };

  /**
   * 一次合成失败后的回退（Kimi B3 状态机，顺序是硬约束）：
   * bridge 且未熔断 → 记熔断 key → queue.clear()（取消旧 provider 播放）→ 提示原文 →
   * 失败句 + 未播剩余用系统音色 repush 恰好一次。system 失败只提示，绝不重入队。
   * 重念失败句是安全的：bridge 整段合成完才开口，失败句从未出声，不存在双播。
   */
  const handleSpeechError = (message: string, failedSentence: string) => {
    const plan = resolveSpeechPlan(modelSettingsRef.current ?? loadModelSettings());
    if (plan.kind === "bridge" && bridgeBrokenKeyRef.current !== plan.key) {
      bridgeBrokenKeyRef.current = plan.key;
      /** 未播剩余从**已开播**游标切：失败句自己已计入（onSentence 先于 speak），所以从这里切完正好。 */
      const remaining = turnSentencesRef.current.slice(spokenIndexRef.current);
      speechQueueRef.current?.clear();
      setVoiceNotice(`供应商音色不可用：${message}，已改用系统音色`);
      const queue = speechQueueRef.current;
      if (queue !== null) {
        for (const sentence of [failedSentence, ...remaining]) {
          probeMarksRef.current.ttsFallbacks += 1;
          queue.push(sentence, systemVoicePushOptions());
        }
      }
      return;
    }
    setVoiceNotice(`语音失败：${message}`);
  };

  const ensureSpeechQueue = useCallback((): SpeechQueue => {
    const existing = speechQueueRef.current;
    if (existing !== null) return existing;
    const queue = createSpeechQueue({
      speaker: () => speakerForQueue(),
      onSentence: (text) => {
        setSpokenSentence(text);
        if (text !== null) {
          /**
           * 已播游标：队列每开始播一句就推进（pump 在 speak 之前调 onSentence，所以失败句也
           * 已计入）。fallback 的"未播剩余"从这里切——从入队数切会得到空数组，clear 后已排队
           * 未播的句子就丢了（Codex 复核 #3）。
           */
          spokenIndexRef.current = Math.min(spokenIndexRef.current + 1, turnSentencesRef.current.length);
        }
      },
      onStart: () => {
        probeMarksRef.current.firstSpeakStartAt ||= performance.now();
        if (voiceStateRef.current === "thinking") {
          moveVoice("speaking");
          bargeRef.current?.start(performance.now());
        }
      },
      onIdle: () => {
        disarmSpeechCeiling();
        if (!voiceModeRef.current) return;
        probeMarksRef.current.lastSpeakEndAt = performance.now();
        speakEndedAt.current = performance.now();
        /**
         * 模型还在写（submit 在途）时的 onIdle 只是"本段暂时播完"：句间排空不代表回合结束，
         * 保持 speaking 等下一句——提前回 listening 会把麦克风/打断检测错误交接（Codex 复核 #2）。
         * 真正的收尾由 finishVoiceTurn（submit 的 finally，模型已结束）或最后一句的 onIdle（那
         * 时 active 已清）走。
         */
        if (voiceTurnActiveRef.current) return;
        capture.current?.takeWav();
        moveVoice("listening");
      },
      onError: (message, text) => handleSpeechError(message, text),
    });
    speechQueueRef.current = queue;
    return queue;
  }, [disarmSpeechCeiling, moveVoice]);

  /** 一句话入队：push 全集；计数交给队列自己的已播游标（onSentence），不在入队时推进。 */
  const enqueueSentence = (sentence: string) => {
    const queue = ensureSpeechQueue();
    refreshSpeaker();
    turnSentencesRef.current.push(sentence);
    probeMarksRef.current.ttsAttempts += 1;
    queue.push(sentence, systemVoicePushOptions());
  };

  /**
   * 本轮 delta 的唯一喂入口。归属是硬约束（Codex 复核 #1）：首个 delta 的 itemId 绑定本轮
   * 回答；之后**只有** owns 的分段才喂——同一轮里 tool 之后的第二个分段不属于本轮朗读对象
   * （它有别的视觉呈现），直接 return。itemId 缺失（旧 core）按本轮首段放行（fallback）。
   */
  const feedVoiceDelta = (delta: string, itemId?: string) => {
    if (!voiceModeRef.current) return;
    if (probeMarksRef.current.firstDeltaAt === 0) probeMarksRef.current.firstDeltaAt = performance.now();
    const feeder = feederRef.current;
    if (feeder === null) return;
    if (itemId !== undefined && itemId !== "") {
      const candidate = `a-${itemId}`;
      if (speechTurnRef.current.id() === null) speechTurnRef.current.bind(candidate);
      else if (!speechTurnRef.current.owns(candidate)) return;
    }
    for (const sentence of feeder.push(delta)) enqueueSentence(sentence);
  };

  /** 回合收尾：尾句冲刷 + 「模型已结束且队列空闲」才回 listening（onIdle 的另一半）。 */
  const finishVoiceTurn = () => {
    const feeder = feederRef.current;
    if (feeder !== null) {
      for (const sentence of feeder.flush()) enqueueSentence(sentence);
    }
    const queue = speechQueueRef.current;
    const idle = queue === null || (!queue.busy() && queue.pending() === 0);
    if (!idle) return; // 还有句在播/在排：最后一句的 onIdle（此刻 active 已清）负责收尾。
    if (voiceStateRef.current === "thinking") {
      moveVoice("listening");
      return;
    }
    if (voiceStateRef.current === "speaking") {
      disarmSpeechCeiling();
      probeMarksRef.current.lastSpeakEndAt ||= performance.now();
      speakEndedAt.current = performance.now();
      capture.current?.takeWav();
      moveVoice("listening");
    }
  };

  /** 新回合开始：清上一轮的绑定/句子/读数，装 90 秒硬顶。submit 会按完整用户话重定 mode。 */
  const beginVoiceTurn = useCallback(() => {
    speechTurnRef.current.begin();
    feederRef.current = createSpeechFeeder(speechModeRef.current);
    feederModeRef.current = speechModeRef.current;
    turnSentencesRef.current = [];
    spokenIndexRef.current = 0;
    voiceTurnStartedAtRef.current = performance.now();
    probeMarksRef.current.firstDeltaAt = 0;
    probeMarksRef.current.firstSpeakStartAt = 0;
    disarmSpeechCeiling();
    speechCeilingTimer.current = window.setTimeout(() => {
      speechCeilingTimer.current = null;
      if (!voiceModeRef.current) return;
      speechQueueRef.current?.clear();
      setVoiceNotice("这一轮说太久了，先停在这里");
      moveVoice("listening");
    }, SPEECH_TURN_MAX_MS);
  }, [disarmSpeechCeiling, moveVoice]);
  const [attachments, setAttachments] = useState<Mention[]>([]);
  const [models, setModels] = useState<AgentModel[]>([]);
  /**
   * 主模型 configured in Settings — and they are **live**.
   *
   * Choosing one starts that session's Codex thread on the provider's endpoint: the bridge writes a
   * `CODEX_HOME` config, runs a loopback Responses→Chat adapter in front of the provider, and restarts
   * the core on it. Measured end to end against a local OpenAI-compatible endpoint: the turn came back
   * as `turn, item×3, delta, usage, done` with the provider's own reply.
   */
  const [modelSettings, setModelSettings] = useState<ModelSettings>(() => loadModelSettings());
  /** speaker 工厂/回退逻辑读的是 ref：不随渲染重建（见语音朗读链块）。 */
  modelSettingsRef.current = modelSettings;
  /**
   * Which provider the Codex core is currently running on ("" = the built-in one).
   *
   * Switching is a core restart — the accepted channel is a `CODEX_HOME` config file, not a per-thread
   * override — so it happens only when the choice actually changes, not on every message. A restart also
   * drops the bridge's thread mapping, i.e. the next message starts a fresh agent thread on the new
   * provider (the transcript in the UI is unaffected).
   */
  const appliedProvider = useRef("");
  /** Provider bindings live in the bridge process; a restarted bridge starts on the built-in core. */
  const bridgeInstance = useRef("");
  /** Sessions whose current bridge/core thread already has their history. */
  const recoveredSessions = useRef<Set<string>>(new Set());
  useEffect(() => {
    saveModelSettings(modelSettings);
  }, [modelSettings]);
  const configuredMainModels = useMemo<AgentModel[]>(
    () =>
      agentModelChoices(modelSettings).map(({ provider, model, profile }) => ({
        id: `custom:${provider.id}:${model}`,
        displayName: `${provider.name} · ${model}`,
        description: `${provider.name} · 走你自己的端点`,
        isDefault: false,
        // effort 能力来自模型档案自己的声明（reasoning.requestProtocol），协议映射不了就不显示、
        // 也不发送——自定义 provider 的思考深度不许装饰（Kimi #484 第 6 条）。
        ...(profile?.reasoning === undefined
          ? { supportedReasoningEfforts: [] }
          : {
              supportedReasoningEfforts: profile.reasoning.supportedEfforts.map((effort) => ({
                effort,
                description: effort,
              })),
              defaultReasoningEffort: profile.reasoning.defaultEffort,
              reasoningProtocol: profile.reasoning.requestProtocol,
            }),
      })),
    [modelSettings],
  );
  /**
   * 全局默认快照（新会话继承；模型/effort/权限确认成功后写回）。老安装里全局存的
   * `shadowroom.model` 在第一次读取时被它吸收——一次性迁移。
   */
  const [agentDefaults, setAgentDefaults] = useState<AgentSettings>(() => loadAgentDefaults());

  const sessionKind = sessionKindForView(mainView);
  const session = sessionForKind(store, sessionKind);
  const butlerSession = sessionForKind(store, "butler");
  const butlerSessionRef = useRef(butlerSession);
  butlerSessionRef.current = butlerSession;
  const anyRunning = runningSessions.size > 0;
  const sessionBusy = session !== undefined && runningSessions.has(session.id);
  const butlerBusy = butlerSession !== undefined && runningSessions.has(butlerSession.id);

  /**
   * 本会话生效的设置：会话里确认过的字段优先，没确认过的继承全局默认（新会话就是这么
   * 继承的）；两层都各自持久化，刷新即恢复。
   */
  const agentSettingValues = useMemo<AgentSettings>(
    () => ({ ...agentDefaults, ...(session?.settings ?? {}) }),
    [agentDefaults, session],
  );

  useEffect(() => {
    saveSessions(store);
  }, [store]);

  /**
   * 工程存不上必须说出来。
   *
   * `localStorage` 大约 5MB，写满时 `setItem` 抛异常；以前这里静默失败，用户看到的是「改了半天，
   * 刷新回到上一个状态」。失败只在第一次说一次（存回去成功后重新武装），不然每敲一下都会刷屏。
   */
  const saveFailed = useRef(false);
  const [storageBlocked, setStorageBlocked] = useState(false);
  useEffect(() => {
    const ok = saveProjects(projects);
    setStorageBlocked(!ok);
    if (ok) {
      saveFailed.current = false;
      return;
    }
    if (saveFailed.current) return;
    saveFailed.current = true;
    withActiveSession((current) => ({
      ...current,
      messages: [
        ...current.messages,
        {
          id: `save-${Date.now()}`,
          role: "notice",
          title: "工程没存上",
          text: "本地存储写不进去了（通常是被 5MB 配额占满）。先「导出音频」备份，再删掉几条不用的轨道或旧工程。",
          at: Date.now(),
        },
      ],
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects]);

  // Come back to the same page after a reload.
  useEffect(() => {
    window.localStorage.setItem("shadowroom.view", mainView);
    window.localStorage.setItem(DOCK_STATE_KEY, JSON.stringify(dockByView));
  }, [dockByView, mainView]);

  // Reopen whatever project was open last, so a reload lands where the work was.
  useEffect(() => {
    const id = lastOpenProject(projects);
    if (id !== undefined) setOpenProjectId(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchBridge()
        .then((info) => {
          if (cancelled) return;
          setServers(info.servers);
          setHome(info.home);
          setWorkspaces(info.workspaces);
          setBridge("online");
        })
        .catch(() => {
          if (!cancelled) setBridge("offline");
        });
    void load();
    // The bridge can be started after the page; a slow poll keeps the plugin dots honest.
    const timer = window.setInterval(load, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // The model picker mirrors the core's own list; the choice sticks per session (defaults snapshot
  // for new ones). See `applyChoice` below for the confirm-then-persist flow.
  useEffect(() => {
    if (agent?.ok !== true) return;
    let cancelled = false;
    fetchModels()
      .then((list) => {
        if (!cancelled) setModels(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [agent?.ok]);

  // The agent core is optional: without it the composer records requests instead of running them.
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchAgentHealth()
        .then((health) => {
          if (!cancelled) {
            if (health.instanceId !== undefined && health.instanceId !== bridgeInstance.current) {
              bridgeInstance.current = health.instanceId;
              appliedProvider.current = "";
              recoveredSessions.current.clear();
            }
            setAgent(health);
          }
        })
        .catch(() => {
          if (!cancelled) setAgent(null);
        });
    void load();
    const timer = window.setInterval(load, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  /** Apply an update to the active session, creating one when the hero is still empty. */
  const withActiveSession = useCallback((update: (session: Session) => Session) => {
    setStore((current) => {
      const kind = sessionKindForView(mainView);
      const existing = sessionForKind(current, kind);
      const target = existing ?? createSession(kind);
      const next = update(target);
      return selectSession(current, { ...next, lastActiveAt: Date.now() });
    });
  }, [mainView]);

  const startSession = useCallback(() => {
    setStore((current) => selectSession(current, createSession("butler")));
  }, []);

  /** Page workers are hidden from the sidebar but exist independently of butler topics. */
  const ensureWorkerSession = useCallback((kind: Exclude<SessionKind, "butler">) => {
    setStore((current) => {
      if (sessionForKind(current, kind) !== undefined) return current;
      return selectSession(current, createSession(kind));
    });
  }, []);

  useEffect(() => {
    const kind = sessionKindForView(mainView);
    if (kind !== "butler") ensureWorkerSession(kind);
  }, [ensureWorkerSession, mainView]);

  /** Append a message to one session inside the store. */
  const patchSession = useCallback((store_: SessionStore, id: string, patch: (session: Session) => Session) => {
    return {
      ...store_,
      // 环形缓冲的唯一切口：任何一次会话更新都把结果裁回上限内（长通话不涨内存）。
      sessions: store_.sessions.map((entry) => (entry.id === id ? capSession(patch(entry)) : entry)),
    };
  }, []);

  /**
   * Mark the stored typed command as handled. Navigation commands must never replay after a reload;
   * dispatch commands use the same marker so a confirmation card can be retired exactly once.
   */
  const consumeCommand = useCallback(
    (command: Pick<ButlerCommand, "commandId"> & { sourceSessionId?: string }) => {
      setStore((current) => {
        // Rows written before route provenance existed still belong to the session that owns the
        // call id. Resolve that owner from the stored calls instead of leaving "稍后" inert.
        const sessionId =
          command.sourceSessionId ??
          current.sessions.find((entry) => entry.calls.some((call) => call.id === command.commandId))?.id;
        if (sessionId === undefined) return current;
        if (!current.sessions.some((entry) => entry.id === sessionId)) return current;
        return patchSession(current, sessionId, (session) => ({
          ...session,
          calls: session.calls.map((call) =>
            call.id === command.commandId ? { ...call, routeConsumed: true } : call,
          ),
        }));
      });
    },
    [patchSession],
  );

  const reportCommandError = useCallback(
    (sessionId: string | undefined, commandId: string, text: string) => {
      if (sessionId === undefined || commandErrorsRef.current.has(commandId)) return;
      commandErrorsRef.current.add(commandId);
      setStore((current) =>
        patchSession(current, sessionId, (session) => {
          const id = `app-command-error-${commandId}`;
          if (session.messages.some((message) => message.id === id)) return session;
          return {
            ...session,
            messages: [
              ...session.messages,
              {
                id,
                role: "notice",
                title: "管家命令未执行",
                text,
                at: Date.now(),
              },
            ],
          };
        }),
      );
    },
    [patchSession],
  );

  /**
   * Page switching is deliberately not a dispatch: no worker turn, no handoff, no confirmation.
   * The existing focus-change effect records it in the ledger after `mainView` updates.
   */
  const applyNavigation = useCallback(
    (command: NavigateCommand) => {
      if (handledCommandIdsRef.current.has(command.commandId)) return;
      handledCommandIdsRef.current.add(command.commandId);
      consumeCommand(command);
      setMainView(command.view);
    },
    [consumeCommand],
  );

  /**
   * A dispatch writes a durable steward handoff before navigating. The local queue still carries
   * the live request; the MCP row is the audit/retry record that survives this page.
   * If the ledger bridge is unavailable we keep the local path working rather than losing the task.
   */
  const openRoute = useCallback(
    (route: DispatchRoute) => {
      const handled = (sessions: Session[]) => sessions.some((session) =>
        session.calls.some((call) => call.id === route.commandId && call.routeConsumed === true),
      );
      if (
        handled(store.sessions) ||
        handled(loadSessions().sessions) ||
        openingRoutesRef.current.has(route.commandId)
      ) {
        return;
      }
      openingRoutesRef.current.add(route.commandId);
      activeDispatchIdRef.current = route.commandId;
      setRouteSuggestion(null);
      consumeCommand(route);
      let targetProjectId = openProjectId;
      if (route.target === "studio" && targetProjectId === undefined) {
        const created = defaultProject();
        targetProjectId = created.id;
        setProjects((current) => [created, ...current]);
        setOpenProjectId(created.id);
        rememberOpenProject(created.id);
      }
      void (async () => {
        let next = route;
        try {
          const raw = await callTool<string>("steward", "handoff_create", {
            target: route.target,
            instruction: route.actionSummary,
            attachments: (route.sourceMentions ?? []).map(({ name, path }) => ({ name, path })),
            ...(route.sourceSessionId === undefined
              ? {}
              : { source_session_id: route.sourceSessionId }),
            context: {
              workspace: route.target,
              ...(route.target === "studio" && targetProjectId !== undefined
                ? { projectId: targetProjectId }
                : {}),
              ...(route.target === "dj" && djContext !== null ? { setId: djContext.id } : {}),
            },
            idempotency_key: `butler-command:${route.commandId}`,
          });
          const parsed = JSON.parse(String(raw)) as { handoff?: { id?: number } };
          if (typeof parsed.handoff?.id === "number") {
            next = { ...route, handoffId: parsed.handoff.id };
          }
        } catch {
          /* the target worker still runs through the agent bridge */
        }
        window.dispatchEvent(new CustomEvent("shadowroom:route-intent", { detail: next }));
      })();
    },
    [consumeCommand, djContext, openProjectId, store],
  );

  /**
   * Restore an unanswered dispatch after a reload. Navigation is intentionally lazy history: it is
   * consumed once and never replayed, while a destructive/ambiguous dispatch may re-offer its card.
   * Legacy `route_intent` rows remain readable; new rows use `app_command`.
   */
  const routesHydrated = useRef(false);
  useEffect(() => {
    if (routesHydrated.current) return;
    routesHydrated.current = true;
    if (routeSuggestion !== null) return;
    const newest = [...store.sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    for (const entry of newest) {
      if (entry.kind !== "butler") continue;
      const call = [...entry.calls]
        .reverse()
        .find(
          (c) =>
            (c.name === "app_command" || c.name === "route_intent") &&
            c.routeSource !== undefined &&
            c.routeConsumed !== true,
        );
      if (call === undefined) continue;
      const parsed = parseButlerCommand(call);
      if (parsed?.op === "navigate") {
        handledCommandIdsRef.current.add(parsed.commandId);
        consumeCommand(parsed);
        return;
      }
      if (parsed?.op === "dispatch") {
        if (routeNeedsConfirmation(parsed.route)) {
          activeDispatchIdRef.current = parsed.route.commandId;
          setRouteSuggestion(parsed.route);
        } else {
          window.setTimeout(() => openRoute(parsed.route), 0);
        }
        return;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, openRoute, consumeCommand]);

  useEffect(() => {
    const onRoute = (event: Event) => {
      const route = (event as CustomEvent<DispatchRoute>).detail;
      if (route === undefined) return;
      if (handledCommandIdsRef.current.has(route.commandId)) return;
      if (queuedRouteRef.current !== null) {
        reportCommandError(
          route.sourceSessionId,
          route.commandId,
          "前一个任务还在排队或执行，这条命令没有执行。请等它结束后再发一次。",
        );
        consumeCommand(route);
        return;
      }
      handledCommandIdsRef.current.add(route.commandId);
      // Both surfaces (the transcript card and the page toast) land here; answering it once
      // retires the offer everywhere and is recorded on the stored row.
      consumeCommand(route);
      ensureWorkerSession(route.target);
      setMainView(route.target);
      setDockByView((current) => ({ ...current, [route.target]: true }));
      setDraftFor(route.target, route.actionSummary);
      const queued = {
        route,
        text: route.sourceText ?? route.actionSummary,
        mentions: route.sourceMentions ?? [],
        sourceSessionId: route.sourceSessionId ?? butlerSessionRef.current?.id ?? "",
      };
      queuedRouteRef.current = queued;
      setQueuedRoute(queued);
    };
    /** The transcript card's 稍后 button: retire the offer without executing anything. */
    const onRouteConsumed = (event: Event) => {
      const route = (event as CustomEvent<DispatchRoute>).detail;
      if (route !== undefined) {
        if (activeDispatchIdRef.current === route.commandId) activeDispatchIdRef.current = null;
        consumeCommand(route);
      }
    };
    const onRouteOpen = (event: Event) => {
      const route = (event as CustomEvent<DispatchRoute>).detail;
      if (route !== undefined) openRoute(route);
    };
    window.addEventListener("shadowroom:route-intent", onRoute);
    window.addEventListener("shadowroom:route-consumed", onRouteConsumed);
    window.addEventListener("shadowroom:route-open", onRouteOpen);
    return () => {
      window.removeEventListener("shadowroom:route-intent", onRoute);
      window.removeEventListener("shadowroom:route-consumed", onRouteConsumed);
      window.removeEventListener("shadowroom:route-open", onRouteOpen);
    };
  }, [consumeCommand, ensureWorkerSession, openRoute, reportCommandError, setDraftFor]);

  /* ── 模型 / 思考深度 / 访问权限：确认后才算数 ───────────────────────────────
   *
   * 流程（Kimi #484 第 3、4 条）：选择 → bridge /api/agent/settings → 以
   * thread/settings/updated 回读为准 → 成功才写 session.settings 与全局默认快照；
   * 失败 UI 不动（本地从未提前改过），composer 附近给原文。自定义供应商的模型不经这条
   * 链（模型在 thread/start 上由 provider 决定），本地持久化、下一轮生效。运行中全禁。
   */
  const [settingsPending, setSettingsPending] = useState<Partial<AgentSettings> | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsApplied, setSettingsApplied] = useState<string | null>(null);
  /**
   * 连续点击只有最后一次算数：每个请求带序号，过期响应（用户已经又点了一下）一律丢弃，
   * 写状态的永远是最新那次——bridge 那头同样的串行链保证 thread 也停在最后一次。
   */
  const settingsSeq = useRef(0);

  const modelOptions = useMemo(() => [...models, ...configuredMainModels], [models, configuredMainModels]);
  const currentModel = useMemo(
    () =>
      modelOptions.find((model) => model.id === agentSettingValues.modelId) ??
      modelOptions.find((model) => model.isDefault) ??
      modelOptions[0],
    [modelOptions, agentSettingValues.modelId],
  );
  const effortChoice = effortChoiceFor(currentModel);
  const activeEffort =
    effortChoice.kind === "list"
      ? effortForSend(currentModel, agentSettingValues.effort) ?? effortChoice.defaultEffort
      : undefined;

  const persistSettings = useCallback(
    (confirmed: AgentSettings) => {
      setAgentDefaults(confirmed);
      saveAgentDefaults(confirmed);
      if (session === undefined) return;
      setStore((current) =>
        patchSession(current, session.id, (target) => ({ ...target, settings: confirmed })),
      );
    },
    [session],
  );

  const applyChoice = useCallback(
    async (choice: { modelId?: string; effort?: string; access?: AgentAccess }) => {
      if (sessionBusy) return;
      const seq = ++settingsSeq.current;
      const next: AgentSettings = { ...agentSettingValues, ...choice };
      setSettingsError(null);
      setSettingsApplied(null);
      setSettingsPending(choice);
      const isCustomModel = next.modelId?.startsWith("custom:") === true;
      const needsBridge = session !== undefined && agent?.ok === true && !isCustomModel;
      try {
        if (needsBridge) {
          const confirmed = await applyAgentSettings(
            session.id,
            {
              ...(next.modelId !== undefined ? { model: next.modelId } : {}),
              ...(next.effort !== undefined ? { effort: next.effort } : {}),
              access: next.access,
            },
            sessionKind,
          );
          if (settingsSeq.current !== seq) return;
          persistSettings({
            ...(next.modelId === undefined ? {} : { modelId: next.modelId }),
            ...(next.effort === undefined ? {} : { effort: next.effort }),
            access: accessFromSandboxType(confirmed.sandboxPolicy?.type) ?? next.access,
          });
        } else {
          // 自定义模型 / 内核没起来：thread/start 会带这些值，本地先记。
          persistSettings(next);
        }
        const bits = [
          choice.modelId === undefined
            ? undefined
            : `${modelOptions.find((model) => model.id === choice.modelId)?.displayName ?? choice.modelId}`,
          choice.effort === undefined ? undefined : `思考深度 ${choice.effort}`,
          choice.access === undefined ? undefined : accessLabel(choice.access),
        ].filter((bit) => bit !== undefined);
        setSettingsApplied(`${bits.join(" · ")} · 从下一轮开始生效`);
      } catch (error) {
        if (settingsSeq.current !== seq) return;
        // 没确认就没生效：本地状态一行没动，把原文给用户。
        setSettingsError(error instanceof Error ? error.message : String(error));
      } finally {
        if (settingsSeq.current === seq) setSettingsPending(null);
      }
    },
    [agent?.ok, agentSettingValues, modelOptions, persistSettings, session, sessionBusy, sessionKind],
  );

  const chooseModel = useCallback(
    (id: string) => {
      const target = modelOptions.find((model) => model.id === id);
      // 换模型必重置 effort：A 模型的档位不能带到 B 模型上。
      void applyChoice({ modelId: id, effort: effortForModel(target) });
    },
    [applyChoice, modelOptions],
  );
  const chooseEffort = useCallback((effort: string) => void applyChoice({ effort }), [applyChoice]);
  const chooseAccess = useCallback((access: AgentAccess) => void applyChoice({ access }), [applyChoice]);

  const submit = useCallback(
    /**
     * Async because the turn may first have to point the Codex core at the chosen provider (a core
     * restart, ~1s). Everything below is unchanged — the awaits are only around that switch.
     */
    async (
      override?: string,
      options: {
        mentions?: Mention[];
        kind?: SessionKind;
        route?: DispatchRoute;
        /** A visible note attached to this turn (e.g. the no-open-project warning on a routed handoff). */
        notice?: { title: string; text: string };
      } = {},
    ) => {
    const kind = options.kind ?? sessionKindForView(mainView);
    const text = (override ?? drafts[kind]).trim();
    if (text === "") return;

    // Each page owns one endpoint thread: butler topics never impersonate Studio/DJ/library.
    const known = sessionForKind(store, kind);
    const fresh = known === undefined ? createSession(kind) : undefined;
    const sessionId = known?.id ?? fresh?.id ?? createSession(kind).id;
    if (runningSessionsRef.current.has(sessionId)) return;
    /**
     * 语音回合的开口准备（S5 contract 的另一半在 outgoing 的 [voice_turn] 注入）：
     * mode 按本轮用户话确定性判定（正则，不猜语义），beginVoiceTurn 会按它重建 feeder。
     * begin 在这里再跑一次：打字提交的回合不经 finishTurn，bind/feeder 必须有同一个入口；
     * 语音路径此前已在 finishTurn 开头 begin 过，此刻还没有任何 delta，幂等无害。
     * 通话中打字同样要走 thinking→speaking→listening 的状态机——否则球停在「在听…」，
     * 声音却在响（实测：回退提示也因此从未显示）。
     */
    const isVoiceTurn = voiceModeRef.current;
    if (isVoiceTurn) {
      speechModeRef.current = /详细说|展开|具体点|全部念|继续/.test(text) ? "detail" : "brief";
      beginVoiceTurn();
      /** submit 在途标记（onIdle 的门）：finally 里清，见 finishVoiceTurn 前。 */
      voiceTurnActiveRef.current = true;
      probeMarksRef.current.turnSubmitAt = performance.now();
      if (voiceStateRef.current === "listening" || voiceStateRef.current === "unclear") moveVoice("thinking");
    }
    setDraftFor(kind, "");
    const at = Date.now();
    const mentions = options.mentions ?? attachments;
    if (options.mentions === undefined) setAttachments([]);

    if (known === undefined) {
      const base = fresh ?? createSession(kind);
      const created: Session = {
        ...base,
        title: kind === "butler" ? titleFrom(text) : base.title,
      };
      setStore((current) => selectSession(current, created));
    }

    const scopeProject =
      kind === "studio" && openProjectId !== undefined
        ? projects.find((project) => project.id === openProjectId)
        : undefined;
    const messageScope: MessageScope = {
      workspaceId: kind,
      ...(kind === "studio" && scopeProject !== undefined
        ? { label: `Studio · ${scopeProject.name}` }
        : kind === "dj" && djContext !== null
          ? { label: `DJ · ${djContext.name}` }
          : kind === "library"
            ? { label: "Library · 曲目库" }
            : {}),
      ...(scopeProject === undefined
        ? {}
        : { projectId: scopeProject.id, revision: structureRevision(scopeProject) }),
      ...(kind === "dj" && djContext !== null
        ? {
            setId: djContext.id,
            revision: `${djContext.trackCount}:${djContext.tracks.map((track) => track.trackId).join(",")}`,
          }
        : {}),
      ...(kind === "library" && libraryContext !== null
        ? {
            revision: `${libraryContext.total}:${libraryContext.visible}:${JSON.stringify(libraryContext.filters)}`,
          }
        : {}),
    };
    setStore((current) =>
      patchSession(current, sessionId, (session) => ({
        ...session,
        title: session.messages.length === 0 ? titleFrom(text) : session.title,
        lastActiveAt: at,
        messages: [
          ...session.messages,
          { id: `u-${at}`, role: "user", text, at, scope: messageScope },
          ...(options.notice === undefined
            ? []
            : [{ id: `n-${at}`, role: "notice" as const, title: options.notice.title, text: options.notice.text, at }]),
        ],
      })),
    );

    if (agent === null || !agent.ok) {
      // No core: record the request and say why nothing ran.
      setStore((current) =>
        patchSession(current, sessionId, (session) => ({
          ...session,
          messages: [
            ...session.messages,
            {
              id: `n-${at}`,
              role: "notice",
              title: "内核未启动",
              text: "需求已记在会话里。运行 pnpm serve:agent 之后，这个输入框就会真的拆解任务、调用插件。",
              at,
            },
          ],
        })),
      );
      if (options.route?.handoffId !== undefined) {
        void callTool("steward", "handoff_finish", {
          handoff_id: options.route.handoffId,
          worker_session_id: sessionId,
          status: "failed",
          error: "agent bridge unavailable",
        }).catch(() => undefined);
      }
      return;
    }

    const abort = new AbortController();
    controllers.current.set(sessionId, abort);
    runningSessionsRef.current.add(sessionId);
    setRunningSessions(new Set(runningSessionsRef.current));
    setSettingsApplied(null);
    const startedAt = Date.now();
    /** Latest token usage seen for this turn, reported when it finishes. */
    let usage: { totalTokens?: number } | undefined;
    /** A durable route reaches one terminal state even if the bridge stream ends without `done`. */
    let routeHandoffSettled = false;
    /** Calls this turn added — the turn-end summary counts exactly these. */
    const turnCallIds = new Set<string>();
    /** Shell rows carry no durationMs from the core; we measure them ourselves. */
    const callStartedAt = new Map<string, number>();
    /**
     * 正文分段（lib/conversation-flow）：同一 itemId 且在消息数组末尾才追加；任何 tool /
     * reasoning 行插进来之后，下一段文字就是新气泡。bridge 已把 <think> 剥成 reasoning 事件，
     * delta 到这里全是净文本。
     */
    const appendDelta = (delta: string, itemId?: string, turnId?: string) => {
      setStore((current) =>
        patchSession(current, sessionId, (session_) => ({
          ...session_,
          messages: appendAssistantDelta(
            session_.messages,
            delta,
            segmentKeyFor(itemId, turnId, `at-${startedAt}`),
            Date.now(),
          ),
        })),
      );
    };
    const finishAssistant = () => {
      controllers.current.delete(sessionId);
      runningSessionsRef.current.delete(sessionId);
      setRunningSessions(new Set(runningSessionsRef.current));
    };

    /**
     * What the agent actually receives: the user's words plus, when the piano roll is open, the notes
     * it is looking at. The clip cannot be read from the agent's side — the app owns that state — so
     * it travels with the message, together with the revision the edit must match.
     */
    const openProject =
      kind === "studio" ? projects.find((project) => project.id === openProjectId) : undefined;
    /**
     * 工程随每条消息一起过去 —— **音频文件在智能体那边读不到，只有前端知道**。
     *
     * 以前只在「有段落」时才带上下文，于是刷新一下页面说「导出这首」「把 bass 再暗一点」，
     * 智能体手里既没有片段路径也没有 render_spec，只能瞎猜或反问。现在只要工程是打开的，
     * 轨道、片段（路径 / 起点 / 长度 / spec）、段落全都跟着走；段落为空时也不影响导出与改单轨。
     */
    const arrangementContext =
      openProject === undefined
        ? []
        : [
            "",
            "[arrangement_context]",
            `project: ${openProject.name} · ${openProject.bpm} BPM · ${openProject.bars} 小节${openProject.key === undefined ? "" : ` · ${openProject.key}`}`,
            `revision: ${structureRevision(openProject)}`,
            `sections: ${JSON.stringify((openProject.sections ?? []).map((section) => ({ id: section.id, name: section.name, start: section.start, bars: section.bars })))}`,
            `tracks: ${JSON.stringify(
              openProject.tracks.map((track) => ({
                name: track.name,
                type: trackTypeOf(track),
                volume: track.volume,
                clips: track.clips.map((clip) => ({
                  id: clip.id,
                  name: clip.name,
                  start: clip.start,
                  length: clip.length,
                  ...(clip.source === undefined || clip.source === "" ? {} : { path: clip.source }),
                  ...(clip.render === undefined ? {} : { render_spec: clip.render }),
                  ...(clip.notes === undefined ? {} : { notes: clip.notes.length }),
                })),
              })),
            )}`,
            "[/arrangement_context]",
            "（上面就是当前工程的全部内容：导出整首用 mix_arrangement（tracks 结构 {name, gain(0-1), clips:[{path, start(小节), bars}]}）、导出分轨用 export_stems、导出 MIDI 用 export_midi；只改一条轨用 regenerate_part（render_spec 原样传、clip_id 必填）；改结构用 arrange（bars/sections/tracks 原样传、operations 写操作、revision 回传，别自己算位置）。）",
          ];
    const djSetContext =
      kind === "dj" && djContext !== null
        ? [
            "",
            "[dj_set_context]",
            `set_id: ${djContext.id}`,
            `name: ${djContext.name}`,
            `track_count: ${djContext.trackCount}`,
            `overlap_ms: ${djContext.overlapMs}`,
            `tracks: ${JSON.stringify(djContext.tracks)}`,
            "[/dj_set_context]",
            "（这是 DJ 页当前 Set 的真实状态。只处理选曲、排序、BPM/Camelot 关系和 set 计时；不要修改曲库字段，也不要生成歌曲或分轨。）",
          ]
        : [];
    const libraryPageContext =
      kind === "library" && libraryContext !== null
        ? [
            "",
            "[library_context]",
            `total_tracks: ${libraryContext.total}`,
            `visible_tracks: ${libraryContext.visible}`,
            `filters: ${JSON.stringify(libraryContext.filters)}`,
            `selected_track: ${JSON.stringify(libraryContext.selected)}`,
            "[/library_context]",
            "（这是曲目库页当前的筛选与选中对象。只处理入库、元数据、分类、查重和分析；不要生成音乐或编排 DJ Set。）",
          ]
        : [];
    const butlerUiContext =
      kind === "butler"
        ? [
            "",
            "[ui_context]",
            `current_view: ${mainView}`,
            `open_project_id: ${openProjectId ?? ""}`,
            `dj_set_id: ${djContext?.id ?? ""}`,
            `library_tracks: ${libraryContext?.total ?? ""}`,
            "[/ui_context]",
            "（只用于理解用户当前在哪；不要假装已经执行其它页面的领域操作。）",
          ]
        : [];
    const routeContext =
      options.route !== undefined && kind === options.route.target
        ? [
            "",
            "[butler_route]",
            `command_id: ${options.route.commandId}`,
            ...(options.route.handoffId === undefined ? [] : [`handoff_id: ${options.route.handoffId}`]),
            `target: ${options.route.target}`,
            `instruction: ${options.route.actionSummary}`,
            ...(kind === "studio" && openProject === undefined
              ? [
                  "project_open: no",
                  "（当前没有打开的工程：能做的先做（如 hum_to_midi 出 MIDI 文件并给出路径），并明确告诉用户新建或打开工程后产物才能落进时间线；不要假装已经写进工程。）",
                ]
              : []),
            "[/butler_route]",
            "（这是用户在管家确认卡上刚刚确认的页内请求。按 instruction 执行；不要把它当成 worker 自己新发起的话题。）",
          ]
        : [];
    /**
     * Point the core at the provider this choice belongs to (or back at the built-in one) before the
     * turn is sent. Without this the turn went out with the custom *model name* but the built-in
     * provider, and Codex answered "The supported API model names are …".
     */
    const chosen =
      agentSettingValues.modelId?.startsWith("custom:") === true
        ? agentModelChoices(modelSettings).find((choice) => `custom:${choice.provider.id}:${choice.model}` === agentSettingValues.modelId)
        : undefined;
    const wantedProvider = chosen?.provider.id ?? "";
    if (wantedProvider !== appliedProvider.current) {
      try {
        // Switching a provider restarts the core, so every UI session needs one bounded recovery injection.
        recoveredSessions.current.clear();
        await fetch("/api/agent/use-provider", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            provider:
              chosen === undefined
                ? null
                : {
                    id: chosen.provider.id,
                    label: chosen.provider.name,
                    baseUrl: chosen.provider.baseUrl,
                    model: chosen.model,
                    credentialRef: chosen.provider.credentialRef,
                    endpointFormat: chosen.provider.endpointFormat,
                  },
          }),
        });
        appliedProvider.current = wantedProvider;
      } catch {
        /* the bridge will answer with its own error if the provider cannot be started */
      }
    }

    /**
     * 管家简报：跟工程上下文一样，随每条消息走 —— 它是"我刚在别的页面做了什么"的唯一来源。
     */
    const brief = kind === "butler" ? await butlerBrief() : "";
    const briefContext = brief === "" ? [] : [brief];
    const recoveryContext = recoveredSessions.current.has(sessionId)
      ? []
      : conversationRecoveryBlock(known?.messages ?? []);
    /**
     * [voice_turn]（S5 response contract）：随语音回合隐藏注入，只进发给智能体的 outgoing，
     * 不写进用户可见消息（消息列表只存 text）。确定性字段：mode 与预算——模型侧契约在
     * agent-bridge 的 VOICE_CALL_RULES，前端这层只声明"这是语音回合 + 口语预算"。
     */
    const voiceTurnContext = isVoiceTurn
      ? [
          "",
          "[voice_turn]",
          `mode: ${speechModeRef.current}`,
          `budget: ${speechModeRef.current === "brief" ? "2 句 / 70 字" : "8 句 / 360 字"}`,
          "[/voice_turn]",
          "（语音通话回合：朗读版只取前 1–2 句口语结论；第一句直接给回答或结论；不播报页面、数量、切换历史；不自报职责边界；最多一个追问；屏幕上可以有完整内容。）",
        ]
      : [];
    const outgoing =
      (kind !== "studio" || noteContext === null
        ? [text, ...recoveryContext, ...briefContext, ...butlerUiContext, ...arrangementContext, ...djSetContext, ...libraryPageContext, ...routeContext].join("\n")
        : [
            text,
            ...recoveryContext,
            "",
            "[clip_context]",
            `clip_id: ${noteContext.clipId}`,
            `clip_name: ${noteContext.clipName}`,
            `revision: ${noteContext.revision}`,
            ...(noteContext.notes.length === 0
              ? []
              : [
                  `notes: ${JSON.stringify(noteContext.notes.map(({ id, midi, start_ms, end_ms, velocity }) => ({ id, pitch: midi, start_ms, end_ms, velocity: velocity ?? 100 })))}`,
                ]),
            ...(noteContext.render === undefined
              ? []
              : [`render_spec: ${JSON.stringify(noteContext.render)}`]),
            "[/clip_context]",
            "（这一段是用户在 Studio 里选中的片段：改音符用 transform_notes；想让这一轨的声音变一点就调 regenerate_part，把上面的 render_spec 原样放进 part、clip_id 必填、patch 只动要改的那几个键。注意：没有 notes 的片段是音频（导入的文件、分轨结果），它没有可编辑的音符——transform_notes 打过去会被拒绝，这种情况应该先用 stem-splitter 分轨，或在乐器轨/鼓轨上操作。）",
            ...arrangementContext,
            ...briefContext,
            ...butlerUiContext,
            ...djSetContext,
            ...libraryPageContext,
            ...routeContext,
          ].join("\n")) + (voiceTurnContext.length === 0 ? "" : `\n${voiceTurnContext.join("\n")}`);

    void sendTurn(
      sessionId,
      outgoing,
      (event) => {
        if (event.type === "done") {
          if (options.route?.handoffId !== undefined) {
            routeHandoffSettled = true;
            void callTool("steward", "handoff_finish", {
              handoff_id: options.route.handoffId,
              worker_session_id: sessionId,
              status: /failed/i.test(String(event.turn?.status ?? "")) ? "failed" : "done",
              outcome: "worker turn completed",
              metrics: { turns: 1 },
            }).catch(() => undefined);
          }
          if (kind !== "butler") {
            void callTool("steward", "report_done", {
              type: "worker.turn",
              actor: `${kind}:worker`,
              object_id: messageScope.projectId ?? messageScope.setId ?? undefined,
              outcome: /completed/i.test(String(event.turn?.status ?? "completed")) ? "ok" : "failed",
              metrics: { turns: 1 },
              injectable: true,
            }).catch(() => undefined);
          }
          return;
        }
        if (event.type === "delta") {
          appendDelta(event.text, event.itemId, event.turnId);
          if (isVoiceTurn) feedVoiceDelta(event.text, event.itemId);
          return;
        }
        if (event.type === "item") {
          if (event.item.type === "reasoning") {
            const id = `r-${event.item.id}`;
            const settled = event.phase === "completed";
            const seeded = [event.item.summary?.join("\n"), event.item.content?.join("\n")]
              .filter((part) => typeof part === "string" && part !== "")
              .join("\n");
            setStore((current) =>
              patchSession(current, sessionId, (session) => {
                const existing = session.messages.find((message) => message.id === id);
                if (existing === undefined) {
                  return {
                    ...session,
                    messages: [
                      ...session.messages,
                      { id, role: "reasoning", text: seeded, at: Date.now(), streaming: !settled },
                    ],
                  };
                }
                return {
                  ...session,
                  messages: session.messages.map((message) =>
                    message.id === id && message.role === "reasoning"
                      ? {
                          ...message,
                          text: message.text === "" && seeded !== "" ? seeded : message.text,
                          streaming: !settled,
                        }
                      : message,
                  ),
                };
              }),
            );
            return;
          }
          const call = toolCallFromItem(event.item, event.phase, event.turnId);
          if (call === null) return;
          turnCallIds.add(call.id);
          if (event.phase !== "completed") callStartedAt.set(call.id, callStartedAt.get(call.id) ?? Date.now());
          const finishedAt = event.phase === "completed" ? Date.now() : undefined;
          const measured =
            call.durationMs ??
            (finishedAt !== undefined && callStartedAt.has(call.id)
              ? finishedAt - (callStartedAt.get(call.id) as number)
              : undefined);
          const timed =
            measured === undefined
              ? call
              : {
                  ...call,
                  durationMs: measured,
                  ...(finishedAt === undefined ? {} : { finishedAt }),
                  ...(callStartedAt.has(call.id) ? { startedAt: callStartedAt.get(call.id) } : {}),
                };
          let routed: ButlerCommand | null = null;
          if (
            kind === "butler" &&
            event.phase === "completed" &&
            (call.name === "app_command" || call.name === "route_intent")
          ) {
            const parsed = parseButlerCommand(call);
            if (parsed?.op === "navigate") {
              const command: NavigateCommand = {
                ...parsed,
                sourceText: text,
                sourceSessionId: sessionId,
              };
              routed = command;
              // The stored call gets one render tick to land before it is consumed, matching the
              // dispatch path and surviving StrictMode's development replay.
              window.setTimeout(() => applyNavigation(command), 0);
            } else if (parsed?.op === "dispatch") {
              const route: DispatchRoute = {
                ...parsed.route,
                sourceText: text,
                sourceMentions: mentions,
                sourceSessionId: sessionId,
              };
              routed = {
                ...parsed,
                route,
                reason: route.actionSummary,
              };
              if (
                activeDispatchIdRef.current !== null &&
                activeDispatchIdRef.current !== route.commandId
              ) {
                reportCommandError(
                  sessionId,
                  route.commandId,
                  "前一个任务还在等待确认、排队或执行，这条任务没有提交。",
                );
                consumeCommand(route);
              } else {
                activeDispatchIdRef.current = route.commandId;
                if (routeNeedsConfirmation(route)) {
                  setRouteSuggestion(route);
                } else {
                  // A safe task is the assistant doing its job, not a form to fill in.
                  window.setTimeout(() => openRoute(route), 0);
                }
              }
            } else if (call.name === "app_command") {
              reportCommandError(
                sessionId,
                call.id,
                "命令格式无效或不在白名单内，页面和任务状态都没有改变。",
              );
            }
          }
          if (call.name === "regenerate_part") {
            // A render can be over in a fifth of a second, and a badge that flickers is worse than
            // none: hold it for at least 700 ms so the user sees that the track was rebuilt.
            const args = (event.item.arguments ?? {}) as { clip_id?: string };
            if (typeof args.clip_id === "string") {
              const clipId = args.clip_id;
              if (event.phase === "completed") {
                const startedAt = renderingSince.current.get(clipId) ?? Date.now();
                renderingSince.current.delete(clipId);
                const wait = Math.max(0, 700 - (Date.now() - startedAt));
                window.setTimeout(
                  () => setRendering((current) => current.filter((id) => id !== clipId)),
                  wait,
                );
              } else {
                renderingSince.current.set(clipId, Date.now());
                setRendering((current) => [...new Set([...current, clipId])]);
              }
            }
          }
          const ownsCurrentProject = toolResultBelongsToOpenProject(
            kind,
            scopeProject?.id,
            openProjectIdRef.current,
          );
          if (event.phase === "completed" && ownsCurrentProject) absorbRef.current(call);
          const storedCall: ToolCall =
            routed === null
              ? timed
              : {
                  ...timed,
                  routeSource: {
                    text:
                      (routed.op === "navigate" ? routed.sourceText : routed.route.sourceText) ??
                      text,
                    mentions: routed.op === "dispatch" ? (routed.route.sourceMentions ?? []) : [],
                    sessionId:
                      (routed.op === "navigate" ? routed.sourceSessionId : routed.route.sourceSessionId) ??
                      sessionId,
                  },
                };
          setStore((current) =>
            patchSession(current, sessionId, (session) => {
              const known_ = session.calls.some((entry) => entry.id === timed.id);
              return {
                ...session,
                calls: known_
                  ? session.calls.map((entry) => (entry.id === timed.id ? { ...entry, ...storedCall } : entry))
                  : [...session.calls, storedCall],
                messages: known_
                  ? session.messages
                  : [...session.messages, { id: `c-${timed.id}`, role: "tool", callId: timed.id, at: Date.now() }],
              };
            }),
          );
          return;
        }
        if (event.type === "reasoning") {
          const id = `r-${event.itemId ?? "current"}`;
          setStore((current) =>
            patchSession(current, sessionId, (session) => {
              const existing = session.messages.find((message) => message.id === id);
              if (existing === undefined) {
                return {
                  ...session,
                  messages: [...session.messages, { id, role: "reasoning", text: event.text, at: Date.now(), streaming: true }],
                };
              }
              return {
                ...session,
                messages: session.messages.map((message) =>
                  message.id === id && message.role === "reasoning"
                    ? { ...message, text: message.text + event.text }
                    : message,
                ),
              };
            }),
          );
          return;
        }
        if (event.type === "usage") {
          usage = event.usage?.last ?? event.usage?.total ?? usage;
          return;
        }
        if (event.type === "error") {
          setStore((current) =>
            patchSession(current, sessionId, (session) => ({
              ...session,
              messages: [
                ...session.messages,
                { id: `e-${Date.now()}`, role: "notice", title: "运行出错", text: event.message, at: Date.now() },
              ],
            })),
          );
          return;
        }
        if (event.type === "approval") {
          setApprovals((current) => [
            ...current.filter((entry) => entry.approvalId !== event.approvalId),
            {
              approvalId: event.approvalId,
              sessionId: event.sessionId,
              kind: event.kind,
              title: event.title,
              detail: event.detail,
            },
          ]);
        }
      },
      abort.signal,
      {
        // A `custom:` choice carries the provider with it: the bridge starts this thread on it.
        ...(() => {
          const custom =
            agentSettingValues.modelId?.startsWith("custom:") === true
              ? (() => {
                  const [, providerId, model] = agentSettingValues.modelId.split(":");
                  return agentModelChoices(modelSettings).find((choice) => choice.provider.id === providerId && choice.model === model);
                })()
              : undefined;
          const scopeOptions = {
            scope: kind,
            eventContext: {
              ...(messageScope.projectId === undefined ? {} : { projectId: messageScope.projectId }),
              ...(messageScope.setId === undefined ? {} : { setId: messageScope.setId }),
            },
          };
          if (custom === undefined) {
            return {
              // The session's confirmed settings ride along every turn: the bridge parameterizes
              // thread/start with them and repeats them on turn/start as the last line of defence.
              settings: {
                ...(agentSettingValues.modelId === undefined || agentSettingValues.modelId.startsWith("custom:")
                  ? {}
                  : { model: agentSettingValues.modelId }),
                ...(activeEffort === undefined ? {} : { effort: activeEffort }),
                access: agentSettingValues.access,
              },
              mentions,
              ...scopeOptions,
            };
          }
          return {
            model: custom.model,
            mentions,
            ...scopeOptions,
            settings: {
              ...(activeEffort === undefined ? {} : { effort: activeEffort }),
              access: agentSettingValues.access,
            },
            provider: {
              id: custom.provider.id,
              label: custom.provider.name,
              baseUrl: custom.provider.baseUrl,
              credentialRef: custom.provider.credentialRef,
              endpointFormat: custom.provider.endpointFormat,
            },
          };
        })(),
      },
    )
      .then(() => {
        if (options.route?.handoffId !== undefined && !routeHandoffSettled) {
          void callTool("steward", "handoff_finish", {
            handoff_id: options.route.handoffId,
            worker_session_id: sessionId,
            status: "failed",
            error: "agent stream ended without a done event",
          }).catch(() => undefined);
        }
        recoveredSessions.current.add(sessionId);
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) {
          if (options.route?.handoffId !== undefined) {
            routeHandoffSettled = true;
            void callTool("steward", "handoff_finish", {
              handoff_id: options.route.handoffId,
              worker_session_id: sessionId,
              status: "cancelled",
              outcome: "worker turn interrupted",
            }).catch(() => undefined);
          }
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (options.route?.handoffId !== undefined) {
          routeHandoffSettled = true;
          void callTool("steward", "handoff_finish", {
            handoff_id: options.route.handoffId,
            worker_session_id: sessionId,
            status: "failed",
            error: message,
          }).catch(() => undefined);
        }
        setStore((current) =>
          patchSession(current, sessionId, (session) => ({
            ...session,
            messages: [
              ...session.messages,
              { id: `e-${Date.now()}`, role: "notice", title: "运行出错", text: message, at: Date.now() },
            ],
          })),
        );
      })
      .finally(() => {
        finishAssistant();
        // 语音回合收尾：先清「在途」（onIdle 此刻起允许交接），再冲残句/兜底回聆听。
        if (isVoiceTurn) {
          voiceTurnActiveRef.current = false;
          finishVoiceTurn();
        }
        const elapsedMs = Date.now() - startedAt;
        const seconds = Math.max(1, Math.round(elapsedMs / 1000));
        const at_ = Date.now();
        setStore((current) =>
          patchSession(current, sessionId, (session) => {
            // 回合尾的真实摘要：本回合的 calls 实数（工具数、去重 MCP server 数、秒数）。
            const turnCalls = session.calls.filter((entry) => turnCallIds.has(entry.id));
            const toolCount = turnCalls.length;
            const mcpCount = new Set(turnCalls.filter((entry) => entry.server !== "shell").map((entry) => entry.server)).size;
            const summaryText =
              toolCount === 0 ? `${seconds} 秒` : `${toolCount} 个工具 · ${mcpCount} 个 MCP · ${seconds} 秒`;
            const tokens = usage?.totalTokens;
            return {
              ...session,
              messages: [
                ...session.messages,
                {
                  id: `u-${at_}`,
                  role: "usage",
                  text: summaryText,
                  // tokens 是开发者读数（Kimi F-5）：可见行只放工具/MCP/秒，读数挂 title。
                  ...(tokens === undefined ? {} : { title: `${tokens.toLocaleString("en-US")} tokens` }),
                  at: at_,
                },
              ],
            };
          }),
        );
      });
    },
    [agent, agentSettingValues, applyNavigation, attachments, beginVoiceTurn, consumeCommand, djContext, drafts, libraryContext, mainView, modelSettings, moveVoice, noteContext, openProjectId, openRoute, patchSession, projects, reportCommandError, setDraftFor, store],
  );

  /**
   * A confirmed route is an execution handoff, not a page switch.
   *
   * Two waits, both of them "keep the queue and retry", never "drop the request": the orb may still
   * be finishing its acknowledgement (source thread), and the target worker may itself be mid-turn.
   * When both are idle the original request — voice recording included — goes to the worker with the
   * route contract attached, exactly once (the queue is emptied before submit runs).
   */
  useEffect(() => {
    if (queuedRoute === null) return;
    if (queuedRoute.sourceSessionId !== "" && runningSessionsRef.current.has(queuedRoute.sourceSessionId)) {
      return;
    }
    const worker = sessionForKind(store, queuedRoute.route.target);
    if (worker === undefined) {
      ensureWorkerSession(queuedRoute.route.target);
      return;
    }
    if (runningSessionsRef.current.has(worker.id)) return;
    if (dispatchedRoutesRef.current.has(queuedRoute.route.commandId)) return;
    const next = queuedRoute;
    dispatchedRoutesRef.current.add(next.route.commandId);
    queuedRouteRef.current = null;
    activeDispatchIdRef.current = null;
    setQueuedRoute(null);
    void (async () => {
      if (next.route.handoffId !== undefined) {
        try {
          const raw = await callTool<string>("steward", "handoff_claim", {
            handoff_id: next.route.handoffId,
            worker_session_id: worker.id,
          });
          const claim = JSON.parse(String(raw)) as { claimed?: boolean; status?: string };
          if (claim.claimed !== true) {
            setStore((current) =>
              patchSession(current, worker.id, (target) => ({
                ...target,
                messages: [
                  ...target.messages,
                  {
                    id: `handoff-${next.route.commandId}`,
                    role: "notice" as const,
                    title: "交接没有启动",
                    text: `这条任务已经处于 ${claim.status ?? "未知"} 状态，可能由另一个 worker 处理中。`,
                    at: Date.now(),
                  },
                ],
              })),
            );
            return;
          }
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          setStore((current) =>
            patchSession(current, worker.id, (target) => ({
              ...target,
              messages: [
                ...target.messages,
                {
                  id: `handoff-${next.route.commandId}`,
                  role: "notice" as const,
                  title: "交接记录不可用",
                  text: `本地仍会继续执行；steward 账本返回：${message}`,
                  at: Date.now(),
                },
              ],
            })),
          );
        }
      }
      await submit(next.text, {
        kind: next.route.target,
        mentions: next.mentions,
        route: next.route,
        ...(next.route.target === "studio" && openProjectId === undefined
          ? {
              notice: {
                title: "工程未打开",
                text: "Studio 还没有打开的工程：请求会照常执行（比如哼唱转 MIDI），但结果要等你新建或打开工程后才能落进时间线。",
              },
            }
          : {}),
      });
    })();
  }, [ensureWorkerSession, queuedRoute, runningSessions, store, submit, openProjectId, patchSession]);

  const stop = useCallback(() => {
    if (session === undefined) return;
    controllers.current.get(session.id)?.abort();
    void interruptTurn(session.id);
  }, [session]);

  /** Answer one approval and record the decision in the transcript. */
  const decide = useCallback(
    (approval: PendingApproval, decision: "allow" | "allow_session" | "deny") => {
      setApprovals((current) =>
        current.map((entry) => (entry.approvalId === approval.approvalId ? { ...entry, busy: true } : entry)),
      );
      const label = decision === "deny" ? "已拒绝" : decision === "allow_session" ? "本次会话都允许" : "已允许一次";
      void answerApproval(approval.approvalId, decision)
        .catch(() => undefined)
        .finally(() => {
          setApprovals((current) => current.filter((entry) => entry.approvalId !== approval.approvalId));
          const sessionId = approval.sessionId ?? session?.id;
          if (sessionId === undefined) return;
          setStore((current) =>
            patchSession(current, sessionId, (session) => ({
              ...session,
              messages: [
                ...session.messages,
                {
                  id: `ap-${approval.approvalId}`,
                  role: "notice",
                  title: label,
                  text: approval.title,
                  at: Date.now(),
                },
              ],
            })),
          );
        });
    },
    [patchSession, session],
  );

  const pendingForSession = approvals.filter(
    (approval) => approval.sessionId === undefined || approval.sessionId === session?.id,
  );

  /**
   * Voice call: one tap starts a conversation instead of a dictation, and from then on it behaves
   * like a phone call — the user talks, stops, the answer comes back spoken, and talking over the
   * answer interrupts it. The microphone stays open for the whole call (needed to hear an
   * interruption), but only the stretch between "the user stopped" and "the answer finished" is
   * turned into a message; every turn carries the WAV of the phrase that asked for it.
   *
   * The callbacks go through refs: the speech session outlives renders, but it must always reach the
   * *current* submit (the one that knows which session is active).
   */
  const submitRef = useRef(submit);
  submitRef.current = submit;
  const listenRef = useRef<() => void>(() => undefined);
  const finishRef = useRef<() => void>(() => undefined);
  /** Everything the recognizer has finalized for the turn being spoken. */
  const heardRef = useRef("");
  /** Its live interim words — shown under the waveform so the user sees what was heard. */
  const partialRef = useRef("");
  const [voicePartial, setVoicePartial] = useState("");
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  /**
   * 正在念的那句话（球旁边的字幕）。
   *
   * 用户 2026-10 的反馈是「球看着还行但非常不清晰」——TTS 声音一过就没有痕迹，听不清就要重问。
   * 字幕把「在听 → 在想 → 在说」三态写成一行字：说的话有回声、识别有回执、思考有等待感。
   */
  const [spokenSentence, setSpokenSentence] = useState<string | null>(null);
  /**
   * 通话刚起时的一行用法提示（「说就行 · 点球挂断」）。第一句话开始（有 partial 或回合提交）
   * 就撤掉——提示是给第一次用的人看的，不该在整通话里占着字幕位。
   */
  const [callHintOn, setCallHintOn] = useState(false);
  const turnRef = useRef<TurnDetector | null>(null);
  const bargeRef = useRef<BargeInDetector | null>(null);
  /** Bumped on every interruption, so a canceled answer's `onend` cannot resume the call twice. */
  const answerToken = useRef(0);
  /**
   * Every listening session carries a token: `SpeechRecognition` fires `onend`/`onresult` from the
   * session that was already replaced, and without this the stale session wrote the previous turn's
   * words into the next one (measured: one phrase came back as the phrase twice).
   */
  const listenToken = useRef(0);

  /** Stop the recognizer and make sure nothing it still has queued can reach the call. */
  const stopListening = useCallback(() => {
    listenToken.current += 1;
    voiceSession.current?.stop();
    voiceSession.current = null;
  }, []);

  const listen = useCallback(() => {
    /**
     * 回合制识别（桥式）：没有流式会话可开——说话时只走端点检测，回合结束由 finishTurn
     * 把 WAV 交给 transcribe。浏览器识别则是流式的，照旧开会话收 partial/final。
     */
    if (currentSTT().transcribe !== undefined) return;
    if (voiceSession.current !== null) return;
    const token = listenToken.current + 1;
    listenToken.current = token;
    const current = () => listenToken.current === token;
    heardRef.current = "";
    partialRef.current = "";
    setVoicePartial("");
    // A fresh turn: the endpointer starts from "nothing heard yet".
    turnRef.current?.reset();
    voiceSession.current = currentSTT().start({
      onPartial: (text) => {
        if (!current()) return;
        if (text !== "") setCallHintOn(false);
        /**
         * Full duplex: the recogniser keeps running while the answer plays. Words heard then belong
         * to the *next* turn — they are buffered, not discarded, which is what makes "no, wait —"
         * work without the user having to repeat themselves.
         */
        if (voiceStateRef.current === "speaking") {
          interruptRef.current = text;
          setVoicePartial(text);
          return;
        }
        partialRef.current = text;
        setVoicePartial(text);
        turnRef.current?.heard(`${heardRef.current} ${text}`.trim());
      },
      onFinal: (text) => {
        if (text === "" || !current()) return;
        if (voiceStateRef.current === "speaking") {
          interruptRef.current = interruptRef.current === "" ? text : `${interruptRef.current} ${text}`;
          return;
        }
        // A finished phrase is *not* the end of the turn: pausing mid-sentence must not cut the user
        // off, so the text accumulates and the endpointer decides when the turn is over.
        heardRef.current = heardRef.current === "" ? text : `${heardRef.current} ${text}`;
        partialRef.current = "";
        setVoicePartial("");
        setVoiceNotice(null);
        turnRef.current?.heard(heardRef.current);
      },
      onEnd: () => {
        if (!current()) return;
        voiceSession.current = null;
        // Recognition stops on its own after a silence: keep the call up.
        if (voiceModeRef.current && voiceStateRef.current === "listening") listenRef.current();
      },
      onError: (message) => {
        if (!current() || message === "no-speech" || message === "aborted") return;
        /**
         * F-1：识别器报错 → offline（琥珀、等用户点球重连），不再只是行一闪而过的 notice。
         * 顺带治好一个真洞：not-allowed 之后 onend 会立刻重启识别 → 又报错 → 无限对空喊；
         * 进了 offline 之后 onend 里那条「还在聆听才重启」的判断自然不成立，循环断了。
         */
        moveVoiceOffline(
          message === "not-allowed" || message === "audio-capture"
            ? "拿不到麦克风：在系统设置里允许浏览器使用麦克风，再点球重试。"
            : message === "network"
              ? "这台环境连不上语音识别服务：Chrome 的识别要联网，桌面包会改用本地识别。现在可以打字继续。"
              : `语音识别出错：${message}`,
        );
      },
    });
    /** 依赖都是稳定引用（moveVoice/moveVoiceOffline 是 useCallback），加进来只为不留陈旧闭包口实。 */
  }, [moveVoiceOffline]);
  listenRef.current = listen;

  /** The user stopped talking: hand the turn over, with the WAV of that phrase attached. */
  const finishTurn = useCallback(async () => {
    /**
     * 新回合从「用户停嘴」这一刻开始（Kimi R3）：saveRecording 的 await 窗口里任何路径都不许
     * 再碰上一轮的回答——bind/feeder/读数在这里全部重置，早于下面的 await。
     */
    beginVoiceTurn();
    probeMarksRef.current.turnEndAt = performance.now();
    let text = [heardRef.current, partialRef.current]
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .join(" ");
    const wav = capture.current?.takeWav() ?? null;
    /**
     * 回合制识别：流式识别器没给过字（桥式 STT 根本没开会话），就把这一回的 WAV 交给它。
     * 识别期间状态是「想」——用户看到的是「正在识别…」，说完不用再点任何东西。
     */
    const provider = currentSTT();
    if (provider.transcribe !== undefined && text === "") {
      if (wav === null) {
        turnRef.current?.reset();
        return;
      }
      moveVoice("thinking");
      setVoiceNotice("正在识别…");
      let result: Awaited<ReturnType<NonNullable<typeof provider.transcribe>>>;
      try {
        result = await provider.transcribe(wav);
      } catch (cause) {
        /** ④ 异常路径：转写本身抛了（理论上不该发生，实现在内部兜了）也按断线收，绝不留悬空闹钟。 */
        moveVoiceOffline(`识别失败：${cause instanceof Error ? cause.message : String(cause)}`);
        return;
      } finally {
      }
      if ("error" in result) {
        moveVoiceOffline(result.error);
        return;
      }
      text = result.text.trim();
      if (text === "") {
        /**
         * 空洞（F-1）：说了话、识别回来了、但是空的——不是错误，是「没听清」。
         * 2.5s 后自己回聆听；这期间点球=重说、字幕上的「改成打字」=非语音出口。
         */
        moveVoiceUnclear();
        return;
      }
      setVoiceNotice(null);
      heardRef.current = text;
    }
    if (text === "") {
      // Noise, not words: keep listening, no turn is opened.
      turnRef.current?.reset();
      return;
    }
    /**
     * Note what is *not* here: stopping the recogniser. The call listens through the answer now, so
     * the user can start talking at any moment — `interruptRef` holds those words until the barge-in
     * detector decides they were meant for us.
     */
    setVoicePartial("");
    setCallHintOn(false);
    moveVoice("thinking");
    const path = wav === null ? null : await saveRecording(wav, "voice");
    const mentions: Mention[] =
      path === null ? [] : [{ name: path.split("/").pop() ?? "voice.wav", path, label: "这段语音" }];
    submitRef.current(text, { mentions, kind: "butler" });
    /**
     * 回合交出去了，下一回从空白开始。流式路径由 listen() 复位；回合制（桥式 STT）没有
     * 那个会话，必须在这里收尾，否则第二句话会和第一句拼在一起发出去。
     */
    heardRef.current = "";
    partialRef.current = "";
    /**
     * 依赖刻意写全：moveVoiceUnclear 挂着 ④ 异常路径（转写抛错按断线收），少于它的话
     * 闭包里会抓到旧引用——那正是「定时器清理四条路径」最容易漏的一条。
     */
  }, [beginVoiceTurn, moveVoiceOffline, moveVoiceUnclear]);
  finishRef.current = () => void finishTurn();

  const startCall = useCallback(async () => {
    const recorder = capture.current ?? (await startCapture());
    if (recorder === null) {
      setVoiceNotice("拿不到麦克风：在系统设置里允许浏览器使用麦克风。");
      return;
    }
    capture.current = recorder;
    setVoiceNotice(null);
    /**
     * The endpointer waits less after a finished sentence ("好的。") and more after a dangling
     * conjunction ("但是…"), which is the difference between a call that feels quick and one that
     * cuts people off mid-thought.
     */
    turnRef.current = createTurnDetector({
      onTurnEnd: () => finishRef.current(),
      silenceMs: () => turnSilenceMs(`${heardRef.current} ${partialRef.current}`.trim()),
    });
    bargeRef.current = createBargeInDetector({
      /**
       * A small rise: hold the answer for a moment without giving it up. `speechSynthesis.pause()`
       * exists, so this is cheap — and a cough or a chair creak no longer cancels the sentence.
       */
      onPause: () => {
        if (voiceStateRef.current !== "speaking") return;
        window.speechSynthesis?.pause?.();
        /** 手柄存下来：挂断时一起清（MiniMax #387 ①：通话路径上不许有没人管的定时器）。 */
        if (pauseTimer.current !== null) window.clearTimeout(pauseTimer.current);
        pauseTimer.current = window.setTimeout(() => {
          pauseTimer.current = null;
          if (voiceStateRef.current === "speaking") window.speechSynthesis?.resume?.();
        }, 700);
      },
      /**
       * A real sentence: the answer is cancelled and the agent is told to stop generating.
       *
       * 打断后的「接着说的那句话」怎么处理，两种识别方式不一样（MiniMax 交叉验证 #356 抓的洞）：
       * - 流式（浏览器识别）：识别器一直在跑，打断词都在 interruptRef 里，拼成下一回合的开头；
       * - 回合制（桥式 STT）：没有 partial，interruptRef 恒空——但音频都在缓冲里。从起音时刻
       *   （sinceMs）切片救回来交给 transcribe，认出来就直接当下一回合的用户话提交，用户不用
       *   重说一遍；认不出才退回「请再说一次」。切片同时消费掉整个缓冲：起音之前的部分是
       *   答案自己的尾巴，不进下一回合（与旧 takeWav 的丢弃语义一致）。
       */
      onCancel: ({ sinceMs }) => {
        if (voiceStateRef.current !== "speaking" && voiceStateRef.current !== "thinking") return;
        const turnBased = currentSTT().transcribe !== undefined;
        answerToken.current += 1;
        /** 打断 = 立刻静音（cancel 实际在播的实例）+ 停掉硬顶闹钟；interruptTurn 只发一次。 */
        speechQueueRef.current?.clear();
        disarmSpeechCeiling();
        const rescued = capture.current?.takeWavSince(sinceMs) ?? null;
        const voiceSessionId = butlerSessionRef.current?.id;
        if (voiceSessionId !== undefined) {
          controllers.current.get(voiceSessionId)?.abort();
          void interruptTurn(voiceSessionId);
        }
        const heard = interruptRef.current.trim();
        interruptRef.current = "";
        heardRef.current = heard === "" ? heardRef.current : heard === heardRef.current ? heard : `${heard} ${heardRef.current}`.trim();
        partialRef.current = "";
        if (heard !== "") {
          setVoiceNotice("（打断了，接着说）");
          moveVoice("listening");
          return;
        }
        if (!turnBased || rescued === null) {
          setVoiceNotice(turnBased ? "（已打断）刚才那句没接住，请再说一次" : "（打断了，接着说）");
          moveVoice("listening");
          return;
        }
        /**
         * 回合制救话。token 防竞态：挂断或下一次打断都会递增 answerToken，迟到的识别结果直接弃。
         * submit 不带录音附件：那句话的字就是内容，上传切片只为存档，慢一个网络来回不值。
         */
        const token = answerToken.current;
        moveVoice("thinking");
        setVoiceNotice("正在识别（救回打断的话）…");
        void (async () => {
          const provider = currentSTT();
          const result = provider.transcribe === undefined ? { error: "识别器不在" } : await provider.transcribe(rescued);
          if (!voiceModeRef.current || answerToken.current !== token || voiceStateRef.current !== "thinking") return;
          const text = "error" in result ? "" : result.text.trim();
          if (text === "") {
            setVoiceNotice("（已打断）刚才那句没接住，请再说一次");
            moveVoice("listening");
            return;
          }
          setVoiceNotice(null);
          heardRef.current = "";
          partialRef.current = "";
          setVoicePartial("");
          turnRef.current?.reset();
          submitRef.current(text, { kind: "butler" });
        })();
      },
    });
    setVoiceMode(true);
    moveVoice("listening");
    setCallHintOn(true);
    // 回合制识别没有 listen() 的复位，这里显式开一个新回合。
    heardRef.current = "";
    partialRef.current = "";
    setVoicePartial("");
    turnRef.current.reset();
    listenRef.current();
  }, []);

  const hangUp = useCallback(() => {
    /** 通话真的起来过才清「通话中的临时提示」——起手失败（麦克风被拒）那条必须留在屏幕上。 */
    const wasUp = voiceModeRef.current;
    stopListening();
    /** ① 挂断路径：unclear 的回退闹钟在这里停掉（卸载复用同一条，AGENTS.md:109）。 */
    clearUnclear();
    if (pauseTimer.current !== null) {
      window.clearTimeout(pauseTimer.current);
      pauseTimer.current = null;
    }
    answerToken.current += 1;
    /** 挂断：队列清空（取消在播实例）、硬顶闹钟停、feeder 丢弃——三样都在这一条路径上。 */
    speechQueueRef.current?.clear();
    disarmSpeechCeiling();
    feederRef.current = null;
    setSpokenSentence(null);
    capture.current?.stop();
    capture.current = null;
    turnRef.current = null;
    bargeRef.current = null;
    setVoicePartial("");
    setCallHintOn(false);
    setVoiceMode(false);
    if (wasUp) setVoiceNotice(null);
  }, [clearUnclear]);

  /**
   * 点球 = 通话的唯一开关，但「按当前是什么态」动作不同（F-1）：
   *   听着 / 想着 / 说着 → 挂断（与 Esc、通话条的「结束通话」同一条 hangUp）
   *   没听清（unclear）  → 重说：立刻回聆听，不等那 2.5s
   *   断了（offline）    → 重连：清掉错误行、重新起聆听（不是开一条新通话）
   */
  const onOrbCallToggle = useCallback(() => {
    if (!voiceMode) {
      void startCall();
      return;
    }
    const state = voiceStateRef.current;
    if (state === "unclear" || state === "offline") {
      /** 重连路径：残留的朗读一律清掉（规格：打断/hangup/reconnect 都 clear）。 */
      speechQueueRef.current?.clear();
      disarmSpeechCeiling();
      moveVoice("listening");
      setVoiceNotice(null);
      heardRef.current = "";
      partialRef.current = "";
      setVoicePartial("");
      turnRef.current?.reset();
      /** 浏览器识别要重开一个会话；桥式没有常驻会话，这一步是空操作——两条路共用同一句。 */
      listenRef.current();
      return;
    }
    hangUp();
  }, [hangUp, moveVoice, startCall, voiceMode]);

  /**
   * unclear 的第二条出路（deepseek O-3）：改成打字。
   * 已经认到的片段带走（别让用户重敲），挂断、填进对话栏、聚焦——然后就是普通打字。
   */
  const typeInstead = useCallback(() => {
    const fragment = [heardRef.current, partialRef.current]
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .join(" ");
    hangUp();
    if (sessionKindForView(mainView) !== "butler") setMainView("conversation");
    if (fragment !== "") setDraftFor("butler", fragment);
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>(".sr-composer-input")?.focus();
    });
  }, [hangUp, mainView, setDraftFor]);

  /**
   * 验收钩子（生产不触发，形状照抄 StudioSoundsDrawer 的 __soundsProbe）：
   * 「挂断之后那一刻，unclear 的回退闹钟还挂着没有」在 DOM 上看不出来（挂断后球回 idle，
   * 悬空定时器照样会在 2.5s 后把状态改成 listening），而它正是 AGENTS.md:109 要防的泄漏。
   * marks 是延迟/回退验收的读数（S4b）：只有时间戳与计数，只读，不含文本/路径/密钥。
   */
  useEffect(() => {
    window.__callProbe = {
      state: () => voiceStateRef.current,
      unclearArmed: () => unclearTimer.current !== null,
      marks: () => ({ ...probeMarksRef.current }),
    };
    return () => {
      delete window.__callProbe;
    };
  }, []);

  // While the call is up the microphone feeds exactly one thing at a time: the endpointer while the
  // user has the turn, the barge-in detector while the answer is playing.
  useEffect(() => {
    if (!voiceMode) return;
    let raf: number | null = null;
    const tick = (now: number) => {
      const value = capture.current?.level() ?? 0;
      level.current = value;
      if (voiceStateRef.current === "listening") turnRef.current?.feed(value, now);
      else if (voiceStateRef.current === "speaking") bargeRef.current?.feed(value, now);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [voiceMode]);

  /**
   * Speaking the answer, sentence by sentence as it streams（S4b 后的真相在这段注释里）：
   *
   * 朗读链**不再是一个 effect**。旧实现把「读哪条消息、念到哪句、谁在说」全放在这个 effect 里，
   * 每次渲染重算 `speechText(lastAssistant)`——thinking 窗口里 lastAssistant 还是上一轮的长答案，
   * 这就是"上一轮回答被重播"的根。现在：
   * - 喂句的唯一入口是本轮 delta（`feedVoiceDelta` → feeder 稳定句 → `enqueueSentence`）；
   * - 顺序/取消/句间停顿由 `lib/tts-queue` 拥有；字幕 `onSentence`、开口 `onStart`（切 speaking）、
   *   自然播完 `onIdle`（回 listening、收音频）；
   * - 回合边界 `speech-turn` 拥有：finishTurn/submit 开头 begin，首个 delta 的 itemId bind；
   * - 尾句与空答案由 submit 的 finally（`finishVoiceTurn`）兜底。
   */

  useEffect(() => () => hangUp(), [hangUp]);

  /** A tool run appears in the transcript and under 轨迹 at the same time. */
  const beginCall = useCallback(
    (call: ToolCall) => {
      withActiveSession((current) => ({
        ...current,
        calls: [...current.calls, call],
        messages: [...current.messages, { id: `c-${call.id}`, role: "tool", callId: call.id, at: Date.now() }],
      }));
    },
    [withActiveSession],
  );

  const endCall = useCallback(
    (id: string, patch: Partial<ToolCall>) => {
      withActiveSession((current) => ({
        ...current,
        calls: current.calls.map((call) => (call.id === id ? { ...call, ...patch } : call)),
      }));
    },
    [withActiveSession],
  );
  beginCallRef.current = beginCall;
  endCallRef.current = endCall;

  const plugins: PluginEntry[] = PLUGINS.map((entry) => ({
    id: entry.id,
    label: entry.label,
    repo: entry.repo,
    connected: servers.some((server) => server.id === entry.server && server.connected),
    tools: servers.find((server) => server.id === entry.server)?.tools ?? [],
  }));
  const selected = plugins.find((plugin) => plugin.repo === activePlugin) ?? plugins[2];
  const active = plugins.find((plugin) => plugin.repo === activePlugin);

  const summaries: SessionSummary[] = store.sessions
    .filter(
      (entry) =>
        entry.kind === "butler" &&
        (entry.messages.length > 0 || entry.id === butlerSession?.id),
    )
    .map((entry) => ({
      id: entry.id,
      title: entry.title,
      meta: `${entry.messages.filter((message) => message.role !== "notice").length} 条 · ${timeAgo(entry.lastActiveAt)}`,
      state: entry.calls.some((call) => call.status === "running")
        ? "running"
        : entry.messages.length > 0
          ? "done"
          : "draft",
    }));

  /** One composer, two homes (the main column or the dock); the dock gets a shorter placeholder. */
  /**
   * The conversation, assembled once.
   *
   * It used to be written twice — once for the centre page and once inside the dock — and the two had
   * already drifted (the dock gave its composer a placeholder the centre view did not). A transcript
   * that can differ depending on where it is shown is exactly the kind of thing that makes an app feel
   * arbitrary, so there is one component and `variant` says where it is being drawn.
   */
  const conversationPane = (options: { variant: "page" | "dock"; composer: ReactNode }) => (
    <div className={options.variant === "dock" ? "sr-conversation-pane sr-conversation-pane--dock" : "sr-conversation-pane"}>
      <div className="sr-transcript sr-scroll">
        <Transcript
          messages={session?.messages ?? []}
          calls={session?.calls ?? []}
          running={sessionBusy}
          quiet={mode === "极简"}
        />
      </div>
      <div className={options.variant === "dock" ? "sr-dock-composer" : "sr-page-composer"}>{options.composer}</div>
    </div>
  );

  const composerFor = (placeholder?: string) => (
    <>
        {pendingForSession.map((approval) => (
          <ApprovalCard
            key={approval.approvalId}
            approval={approval}
            onDecide={(decision) => decide(approval, decision)}
          />
      ))}
              <Composer
        variant={session === undefined || session.messages.length === 0 ? "hero" : "docked"}
        value={draft}
        onChange={setDraft}
        // 包一层：submit 的第一个参数是 override 文本，而 onClick 会把点击事件对象当实参传进来，
        // (event).trim 直接抛错——真实用户点「发送」按钮于是毫无反应（回车发送不经过这里）。
        onSubmit={() => void submit()}
        onStop={stop}
        busy={sessionBusy}
        mode={mode}
        onModeChange={setMode}
        /*
          Configured main models are part of the same list now — they run on the user's own endpoint,
          so they are choices, not promises. The menu still offers *only* main models (语音/生图 stay
          in settings), which is the rule the user asked for.
        */
        models={[...models, ...configuredMainModels]}
        modelId={agentSettingValues.modelId ?? currentModel?.id}
        onModelSelect={chooseModel}
        effortId={activeEffort}
        effortChoice={effortChoice}
        onEffortSelect={chooseEffort}
        access={agentSettingValues.access}
        onAccessSelect={chooseAccess}
        settingsBusy={sessionBusy || settingsPending !== null}
        settingsNotice={settingsError ?? settingsApplied ?? undefined}
        attachments={attachments}
        onAttach={(mention) =>
                  setAttachments((current) =>
                    current.some((entry) => entry.name === mention.name) ? current : [...current, mention],
                  )
                }
        onDetach={(name) => setAttachments((current) => current.filter((entry) => entry.name !== name))}
        plugins={plugins}
        pluginRoot={workspaces}
        {...(placeholder === undefined ? {} : { placeholder })}
      />
    </>
  );


  /**
   * What the agent produces lands on the timeline by itself: a `hum_to_midi` result becomes a clip
   * with its notes, and a `render_song` / `render_part` result becomes one track per part pointing at
   * the rendered stem. No button, no second step — the song grows out of the same sentence.
   */
  /**
   * Apply an arrangement edit (insert bars / repeat a section / delete one).
   *
   * The tool returns where every clip ends up — copies name the clip they came from — so this only
   * moves data around. Clips whose stored plan no longer matches the new structure are marked as
   * needing a re-render: the arrangement changed, the audio did not, and pretending otherwise would
   * put the wrong sound in the wrong place. (This absorber was missing for a while because a patch
   * that added it crashed before writing — the agent's call landed on nothing. Lesson: run it.)
   */
  const applyArrangement = useCallback(
    (call: ToolCall) => {
      const notice = (title: string, text: string) =>
        withActiveSession((current) => ({
          ...current,
          messages: [...current.messages, { id: `ar-${Date.now()}`, role: "notice", title, text, at: Date.now() }],
        }));
      try {
        const wrapper = JSON.parse(call.detail ?? "{}") as { result?: { content?: Array<{ text?: string }> } };
        const parsed = JSON.parse(String(wrapper.result?.content?.[0]?.text)) as {
          revision?: string;
          bars?: number;
          sections?: Array<{ id?: string; name?: string; start?: number; bars?: number }>;
          clips?: Array<{ id?: string; track?: string; start?: number; length?: number; copy_of?: string }>;
          diff_summary?: string;
        };
        if (parsed.clips === undefined || parsed.bars === undefined) throw new Error("结果里没有结构");

        /**
         * Decide first, then hand React one finished project.
         *
         * The flags below used to be written *inside* the `setProjects` updater; React runs updaters
         * during the next render, so the notice was written while the flags still said "nothing
         * happened" — the arrangement changed and the transcript stayed silent (measured).
         */
        const current = projects.find((entry) => entry.id === openProjectId);
        if (current === undefined) throw new Error("没有打开的工程");
        if (parsed.revision !== undefined && parsed.revision !== structureRevision(current)) {
          notice("结构没改成", "这段时间线在你发消息之后被改过，智能体的版本已经过期；再说一次就会用最新结构重算。");
          return;
        }
        const next = ((project: StudioProject) => {
          const byId = new Map((parsed.clips ?? []).map((clip) => [String(clip.id), clip]));
          const songBars = Math.max(1, Math.round(parsed.bars as number));
          const tracks = project.tracks.map((track) => {
            const kept = track.clips
              .filter((clip) => byId.has(clip.id))
              .map((clip) => {
                const position = byId.get(clip.id) as { start?: number; length?: number };
                const start = typeof position.start === "number" ? position.start : clip.start;
                const length = typeof position.length === "number" ? position.length : clip.length;
                const planBars = typeof clip.render?.bars === "number" ? clip.render.bars : undefined;
                const moved = start !== clip.start;
                return {
                  ...clip,
                  start,
                  length,
                  // the plan described the old arrangement: say so instead of re-rendering silently
                  ...(moved && planBars !== undefined && planBars !== songBars
                    ? { renderStale: "结构变了，音频还没跟上" }
                    : {}),
                };
              });
            const copies = (parsed.clips ?? [])
              .filter((entry) => entry.copy_of !== undefined && entry.track === track.name)
              .flatMap((entry) => {
                const source = track.clips.find((clip) => clip.id === entry.copy_of);
                if (source === undefined) return [];
                return [
                  {
                    ...source,
                    id: String(entry.id),
                    start: typeof entry.start === "number" ? entry.start : source.start,
                    length: typeof entry.length === "number" ? entry.length : source.length,
                  },
                ];
              });
            return { ...track, clips: [...kept, ...copies].sort((a, b) => a.start - b.start) };
          });
          const sections = (parsed.sections ?? [])
            .filter((section) => typeof section.bars === "number" && (section.bars as number) > 0)
            .map((section, index) => ({
              ...(section.id === undefined ? {} : { id: section.id }),
              name: section.name ?? `段落 ${index + 1}`,
              bars: Number(section.bars),
              start: Number(section.start ?? 0),
            }));
          return {
            ...project,
            bars: songBars,
            tracks,
            ...(sections.length > 0 ? { sections } : {}),
          };
        })(current);
        updateProjectRef.current(() => next);
        notice("结构改了", `${parsed.diff_summary ?? "已调整"}（⌘Z 可撤销；需要重渲染的片段会标出来）`);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        notice("结构没改成", message);
      }
    },
    [openProjectId, projects, withActiveSession],
  );

  /**
   * Swap in a freshly rendered part.
   * The clip keeps its place on the timeline (start, length) and gains a new source file plus the
   * updated plan; one undo step, and the summary the renderer wrote is what the user reads.
   */
  const applyRegeneratedPart = useCallback(
    (call: ToolCall) => {
      const notice = (title: string, text: string) =>
        withActiveSession((current) => ({
          ...current,
          messages: [...current.messages, { id: `rp-${Date.now()}`, role: "notice", title, text, at: Date.now() }],
        }));
      try {
        const wrapper = JSON.parse(call.detail ?? "{}") as {
          result?: { content?: Array<{ text?: string }> };
          // Codex 卡片路径的字段是 arguments（toolCallFromItem），media-events 路径是 args。
          arguments?: { clip_id?: string; out_path?: string };
          args?: { clip_id?: string; out_path?: string };
        };
        const parsed = JSON.parse(String(wrapper.result?.content?.[0]?.text)) as {
          clip_id?: string;
          path?: string;
          spec?: Record<string, unknown>;
          bpm?: number;
          bars?: number;
          diff_summary?: string;
        };
        // clip_id / 路径优先读结果，结果没带就从这次调用的参数里拿——同一份事实，两个来源，别解析两次。
        const clipId = parsed.clip_id ?? wrapper.args?.clip_id ?? wrapper.arguments?.clip_id;
        const written = parsed.path ?? wrapper.args?.out_path ?? wrapper.arguments?.out_path;
        if (clipId === undefined || written === undefined) {
          throw new Error("结果里没有片段或文件");
        }
        let applied = false;
        updateProjectRef.current((project) => {
          const track = project.tracks.find((entry) => entry.clips.some((clip) => clip.id === clipId));
          if (track === undefined) return project;
          applied = true;
          return {
            ...project,
            tracks: project.tracks.map((entry) =>
              entry.id === track.id
                ? {
                    ...entry,
                    clips: entry.clips.map((clip) =>
                      clip.id === clipId
                        ? {
                            ...clip,
                            source: written,
                            ...(parsed.spec === undefined
                              ? {}
                              : {
                                  render: {
                                    bpm: parsed.bpm ?? clip.render?.bpm ?? project.bpm,
                                    bars: parsed.bars ?? clip.render?.bars ?? clip.length,
                                    part: parsed.spec,
                                    ...(clip.render?.sections === undefined ? {} : { sections: clip.render.sections }),
                                    ...(clip.render?.seed === undefined ? {} : { seed: clip.render.seed }),
                                  },
                                }),
                          }
                        : clip,
                    ),
                  }
                : entry,
            ),
          };
        });
        if (applied) {
          notice("这一轨重渲染好了", `${parsed.diff_summary ?? "已更新"}（⌘Z 可撤销，旧文件还在）`);
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        notice("重渲染没成功", message);
      }
    },
    [withActiveSession],
  );

  /**
   * Apply a `transform_notes` result to the clip it names.
   *
   * The agent's edit only lands if the revision it was given still matches the clip: if the user
   * moved a note while the model was thinking, their work wins and the edit is reported as stale
   * rather than silently overwriting it. One edit = one undo step, and the result says what changed.
   */
  const applyNoteEdit = useCallback(
    (call: ToolCall) => {
      const notice = (title: string, text: string) =>
        withActiveSession((current) => ({
          ...current,
          messages: [...current.messages, { id: `nt-${Date.now()}`, role: "notice", title, text, at: Date.now() }],
        }));
      try {
        const wrapper = JSON.parse(call.detail ?? "{}") as {
          result?: { content?: Array<{ text?: string }> };
          // Codex 卡片路径的字段是 arguments（toolCallFromItem），media-events 路径是 args。
          arguments?: { clip_id?: string };
          args?: { clip_id?: string };
        };
        const parsed = JSON.parse(String(wrapper.result?.content?.[0]?.text)) as {
          clip_id?: string;
          revision?: string;
          notes?: StudioNote[];
          diff_summary?: string;
          affected_count?: number;
        };
        const clipId = parsed.clip_id ?? wrapper.args?.clip_id ?? wrapper.arguments?.clip_id;
        if (clipId === undefined || parsed.notes === undefined) throw new Error("结果里没有片段或音符");
        /**
         * The tool speaks `pitch` (MIDI parlance), the studio's notes speak `midi` — the first version
         * forgot to translate and wrote notes without a pitch at all (measured: `[null, null, null]`
         * in the clip and a `NaN` in the piano roll's layout).
         */
        const incoming = parsed.notes as unknown as Array<Record<string, unknown>>;
        const translated: StudioNote[] = incoming.map((note) => ({
          ...(typeof note.id === "string" ? { id: note.id } : {}),
          midi: Math.max(0, Math.min(127, Number(note.midi ?? note.pitch ?? 60))),
          start_ms: Math.max(0, Number(note.start_ms ?? 0)),
          end_ms: Math.max(1, Number(note.end_ms ?? 0)),
          velocity: Math.max(1, Math.min(127, Number(note.velocity ?? 100))),
        }));
        if (translated.length === 0) throw new Error("结果里没有音符");
        /**
         * A clip with no notes is a file, not a score — there is nothing for `transform_notes` to
         * change, and the tool would have been given an empty note list anyway. Refusing *before*
         * `updateProject` is what keeps an edit that did not happen out of the undo stack.
         */
        const openProject = projectsRef.current.find((project) => project.id === openProjectId);
        const openTrack = openProject?.tracks.find((track) => track.clips.some((clip) => clip.id === clipId));
        const openClip = openTrack?.clips.find((clip) => clip.id === clipId);
        if (openTrack !== undefined && openClip !== undefined && (openClip.notes?.length ?? 0) === 0) {
          notice(
            "音符没改成",
            trackTypeOf(openTrack) === "audio"
              ? "这个片段是音频（导入的文件、分轨结果或渲染出来的音频），里面没有音符。先用 hum_to_midi 或「转 MIDI」把它变成音符，再改。"
              : "这个片段还没有音符，transform_notes 没有东西可以改。先让 render_part 写一段，或把它转成 MIDI。",
          );
          return;
        }
        let stale = false;
        let applied = false;
        updateProjectRef.current((project) => {
          const track = project.tracks.find((entry) => entry.clips.some((clip) => clip.id === clipId));
          const clip = track?.clips.find((entry) => entry.id === clipId);
          if (clip === undefined) {
            stale = true;
            return project;
          }
          const current = notesRevision(clip.notes ?? []);
          if (parsed.revision !== undefined && parsed.revision !== current) {
            stale = true;
            return project;
          }
          applied = true;
          return {
            ...project,
            tracks: project.tracks.map((entry) =>
              entry.id === track?.id
                ? {
                    ...entry,
                    clips: entry.clips.map((item) =>
                      item.id === clipId ? { ...item, notes: translated } : item,
                    ),
                  }
                : entry,
            ),
          };
        });
        // `updateProject` runs its patch twice under StrictMode; only report once the state is real
        if (stale) {
          notice("音符没改成", "这个片段在你发消息之后被改过，智能体的版本已经过期。再说一次就会用最新音符重算。");
        } else if (applied) {
          notice(
            "音符已更新",
            `${parsed.diff_summary ?? "已修改"}${parsed.affected_count === undefined ? "" : ` · ${parsed.affected_count} 个音符`}（⌘Z 可撤销）`,
          );
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        notice("音符没改成", message);
      }
    },
    [withActiveSession],
  );

  /**
   * 适配器内部跑出来的媒体调用（插件是我们自己执行的，Codex 看不到），要落成 Studio 轨道。
   *
   * 桥在 `/api/agent/media-events` 里记着它们，这里轮询新的那几条，然后**走和 Codex 工具卡片完全
   * 相同的吸收路径**——不另写一套解析，避免两条路慢慢跑偏。
   */
  const mediaCursor = useRef(0);
  /** 当前工程**本次打开**的时刻（ms）：早于它的媒体事件属于历史/别的工程，不吸收只推游标。 */
  const projectOpenedAt = useRef(0);
  /**
   * 对齐游标：桥里可能还躺着上一次会话的事件，重放它们会让一个刚打开的工程凭空多出几轨。
   * 对齐**只在页面刚打开时做一次**（挂在下面那个 effect 上），并且必须一次就成功——如果失败，
   * 就留到下一次成功时对齐并且**立刻再取一次**，否则「对齐」和「第一次真正取数」之间发生的事件
   * 会被静默吃掉（实测过一次：渲染写了文件，时间线却一条轨都没多）。
   */
  const mediaCursorReady = useRef(false);
  /**
   * 焦点进账本：切页面、切工程、开关工程都记一条。
   *
   * 这是悬浮球"知道你刚才在哪"的唯一来源 —— 不靠模型记忆，靠事件。失败就算了（桥可能没起来），
   * 上报本身绝不该挡住用户的操作。
   */
  useEffect(() => {
    void callTool("steward", "focus_change", {
      workspace: mainView,
      ...(openProjectId === undefined ? {} : { object_id: openProjectId }),
      actor: "ui",
    }).catch(() => undefined);
  }, [mainView, openProjectId]);

  /**
   * 打开页面/打开工程那一刻，把游标**对齐到最新**：跳过桥里残留的全部历史事件。
   *
   * P0 回归的教训：只解耦轮询不保留这道防线，页面加载就会把别的工程/别的会话渲染过的
   * 事件倒进当前工程（实测 8 秒冒出 8 条轨，其中 9 条是历史残留）。对齐 = 「此刻之前的一切
   * 都与我无关」；此后轮询只吸收**新产生**的事件。
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const answer = (await fetch("/api/agent/media-events?since=0").then((response) => response.json())) as { events?: Array<{ id: number }>; next?: number };
        if (cancelled || typeof answer.next !== "number") return;
        mediaCursor.current = Math.max(mediaCursor.current, answer.next);
        mediaCursorReady.current = true;
        projectOpenedAt.current = Date.now();
      } catch {
        /* 桥还没起来：交给轮询那条路，它会先对齐、再立刻取一次 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openProjectId, mainView, session?.id]);
  useEffect(() => {
    // 启动条件与「模型回合」解耦（P0 最后一公里）：异步 start_render 的完成事件在回合结束后
    // 才被 worker 推进来，那时 running 早就 false 了——按 running 门控轮询，事件永远没人取。
    if (openProjectId === undefined) return;
    let cancelled = false;
    const take = async () => {
      try {
        const answer = (await fetch(`/api/agent/media-events?since=${mediaCursor.current}`).then((response) => response.json())) as {
          events?: Array<{
            id: number;
            at?: number;
            sessionId?: string | null;
            scope?: string | null;
            projectId?: string | null;
            setId?: string | null;
            server: string;
            tool: string;
            ok: boolean;
            text: string;
            args?: Record<string, unknown>;
          }>;
          next?: number;
        };
        if (cancelled || answer.events === undefined) return;
        if (!mediaCursorReady.current) {
          mediaCursorReady.current = true;
          mediaCursor.current = Math.max(mediaCursor.current, Number(answer.next ?? 0));
          return take();
        }
        for (const event of answer.events) {
          mediaCursor.current = Math.max(mediaCursor.current, event.id);
          /**
           * Ownership is authoritative when the producer supplied it. Old events without a
           * sessionId still use the timestamp fallback below, so pre-migration logs remain safe.
           */
          if (event.sessionId !== undefined && event.sessionId !== null && event.sessionId !== session?.id) continue;
          if (
            event.projectId !== undefined &&
            event.projectId !== null &&
            openProjectId !== undefined &&
            event.projectId !== openProjectId
          ) {
            continue;
          }
          // 作用域（P0 回归第二道闸）：只吸收**本工程本次打开之后**发生的事件。历史/别处的
          // 事件跳过吸收但照常推进游标——不推进会每轮重试同一批（实测把旧轨倒进新工程）。
          const eventAt = (event as { at?: number }).at ?? 0;
          if (projectOpenedAt.current > 0 && eventAt > 0 && eventAt < projectOpenedAt.current) continue;
          absorbRef.current({
            id: `media-${event.id}`,
            server: event.server,
            name: event.tool,
            status: event.ok ? "ok" : "error",
            summary: event.tool,
            // 和 Codex 工具卡片同一个形状，外加 args：clip_id 这类句柄只存在于调用参数里，
            // 结果文本不一定回显（regenerate_part 曾因此吸收不到）。
            detail: JSON.stringify({
              result: { content: [{ text: event.text }] },
              ...(event.args === undefined ? {} : { args: event.args }),
            }),
          });
        }
      } catch {
        /* the bridge is down; the next tick tries again */
      }
    };
    void take();
    const timer = window.setInterval(() => void take(), anyRunning ? 2500 : 8000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [anyRunning, openProjectId, session?.id]);

  const absorbToolResult = useCallback(
    (call: ToolCall) => {

      if (call.status !== "ok" || openProjectId === undefined) return;
      /**
       * 泵感调制（Bitwig 刀2 §②C）：butler 走 generator 的 `clip_modulate{clip_id, rate, depth}`，
       * 两条吸收通道（Codex 工具卡片 / media-events）在这里汇合。App 只把意图转成一次自定义
       * 事件——写入、换算与 undo 归开着工程的 StudioPage（它持有 clip 的写口），字段只进导出
       * spec，不进播放图。参数读不出来就静默跳过：转写卡还在，用户看得见发生了什么。
       */
      if (call.name === "clip_modulate") {
        try {
          const wrapper = JSON.parse(call.detail ?? "{}") as {
            arguments?: { clip_id?: string; rate?: string; depth?: number };
            args?: { clip_id?: string; rate?: string; depth?: number };
          };
          const args = wrapper.args ?? wrapper.arguments ?? {};
          if (typeof args.clip_id === "string") {
            window.dispatchEvent(
              new CustomEvent("shadowroom:clip-modulate", {
                detail: { clipId: args.clip_id, rate: args.rate, depth: args.depth },
              }),
            );
          }
        } catch {
          /* 参数不是合法 JSON：留卡片，不落字段 */
        }
        return;
      }
      if (call.name === "transform_notes") {
        applyNoteEdit(call);
        return;
      }
      if (call.name === "regenerate_part") {
        applyRegeneratedPart(call);
        return;
      }
      if (call.name === "arrange") {
        applyArrangement(call);
        return;
      }
      if (!["hum_to_midi", "render_song", "render_part"].includes(call.name)) return;
      try {
        const wrapper = JSON.parse(call.detail ?? "{}") as {
          result?: { content?: Array<{ text?: string }> };
        };
        const parsed = JSON.parse(String(wrapper.result?.content?.[0]?.text)) as {
          part?: string;
          path?: string;
          bpm?: number;
          bars?: number;
          parts?: Array<{ part?: string; path?: string; duration_ms?: number; spec?: Record<string, unknown> }>;
          sections?: Array<{ name?: string; bars?: number; start_bar?: number }>;
          midi_path?: string;
          notes?: Array<{ start_ms: number; end_ms: number; midi: number; name?: string }>;
        };
        setProjects((current) =>
          current.map((project) => {
            if (project.id !== openProjectId) return project;
            const bpm = typeof parsed.bpm === "number" ? parsed.bpm : project.bpm;
            const tracks = (() => {
              if (call.name === "hum_to_midi") {
                const notes = parsed.notes ?? [];
                if (notes.length === 0) return project.tracks;
                const clip = clipFromNotes(notes, project.bars, 0, parsed.midi_path ?? "");
                // S4：0 轨工程建一条旋律轨接住哼唱（与 absorbMelody 同口径）。
                if (project.tracks.length === 0) {
                  return [
                    {
                      ...newTrack(defaultTrackName(project.tracks, "instrument")),
                      type: "instrument" as const,
                      color: nextTrackColor(project.tracks),
                      clips: [clip],
                    },
                  ];
                }
                return project.tracks.map((track, index) =>
                  index === 0 ? { ...track, clips: [...track.clips, clip] } : track,
                );
              }
              const parts =
                call.name === "render_song"
                  ? (parsed.parts ?? [])
                  : [{ part: parsed.part, path: parsed.path, duration_ms: undefined }];
              let next = [...project.tracks];
              for (const entry of parts) {
                if (entry.path === undefined) continue;
                const label = PART_LABEL[entry.part ?? ""] ?? entry.part ?? "声部";
                const bars =
                  typeof parsed.bars === "number"
                    ? parsed.bars
                    : typeof entry.duration_ms === "number"
                      ? Math.max(1, Math.ceil((entry.duration_ms / 1000) * (bpm / 4 / 60)))
                      : 4;
                let index = next.findIndex((track) => track.name === label);
                if (index === -1) {
                  next = [...next, newTrack(label)];
                  index = next.length - 1;
                }
                const clip = newClip(label, 0, Math.max(1, Math.round(bars)), entry.path);
                // The plan travels with the clip, so a later "重一点" is a patch, not a rewrite.
                const spec = (entry as { spec?: Record<string, unknown> }).spec;
                if (spec !== undefined) {
                  clip.render = {
                    bpm,
                    bars,
                    part: spec,
                    ...(parsed.sections === undefined ? {} : { sections: parsed.sections }),
                    ...(typeof spec.seed === "number" ? { seed: spec.seed } : {}),
                  };
                }
                next = next.map((track, position) =>
                  position === index
                    ? {
                        ...track,
                        clips: [
                          ...track.clips.filter((existing) => existing.source !== entry.path),
                          clip,
                        ],
                      }
                      : track,
                );
              }
              /**
               * A render can hand back the same arrangement as MIDI (the plan that was played). It
               * lands on its own track so it can be seen and exported through the export dialog —
               * the studio's MIDI export reads clips that point at a `.mid`, notes or not.
               */
              if (typeof parsed.midi_path === "string" && parsed.midi_path !== "") {
                const songBars = Math.max(1, Math.round(typeof parsed.bars === "number" ? parsed.bars : 4));
                const name = "MIDI";
                let index = next.findIndex((track) => track.name === name);
                if (index === -1) {
                  next = [...next, newTrack(name)];
                  index = next.length - 1;
                }
                const clip = newClip(
                  (parsed.midi_path.split("/").pop() ?? "song.mid").replace(/\.mid$/i, ""),
                  0,
                  songBars,
                  parsed.midi_path,
                );
                next = next.map((track, position) =>
                  position === index
                    ? { ...track, clips: [...track.clips.filter((existing) => existing.source !== parsed.midi_path), clip] }
                    : track,
                );
              }
              return next;
            })();
            /**
             * An arrangement render says what the song's shape is; keep it so the ruler shows the
             * sections the agent wrote instead of a bare row of bars. A plain loop render carries no
             * sections, and leaves whatever was there alone.
             */
            const sections = (parsed.sections ?? [])
              .filter((entry) => typeof entry.bars === "number" && entry.bars > 0)
              .map((entry, index) => ({
                name: entry.name ?? `section ${index + 1}`,
                bars: Number(entry.bars),
                start: Number(entry.start_bar ?? 0),
              }));
            return {
              ...project,
              bpm,
              tracks,
              /**
               * 时间线的长度跟着**内容**走，不跟着渲染返回的 bars 走。
               *
               * 用户实测过这个 bug：新建工程默认 16 小节，渲染回来的歌只有 8 小节（15 秒），
               * 于是「音乐都播完了，黄线才走到一半」，读数也显示 00:30 而真实内容只有 15 秒。
               * 规则：**空工程**落第一次内容时，长度就设成内容长度；已经有内容的工程只扩不缩
               * （用户手动加长的那部分不能被抹掉）。
               */
              bars: (() => {
                const contentEnd = tracks
                  .flatMap((track) => track.clips)
                  .reduce((end, clip) => Math.max(end, clip.start + clip.length), 0);
                if (contentEnd <= 0) return project.bars;
                const contentBars = Math.max(1, Math.ceil(contentEnd));
                const wasEmpty = project.tracks.every((track) => track.clips.length === 0);
                return wasEmpty ? contentBars : Math.max(project.bars, contentBars);
              })(),
              ...(sections.length > 0 ? { sections } : {}),
              updatedAt: Date.now(),
            };
          }),
        );
      } catch {
        /* a tool result we cannot read simply stays in the transcript */
      }
    },
    [openProjectId],
  );
  absorbRef.current = absorbToolResult;

  const openProject = projects.find((project) => project.id === openProjectId);
  /** The chat dock is available on every page. On 工作台 the main column shows the overview instead,
      so the same transcript is never drawn twice. */
  /**
   * Which pages the conversation belongs to.
   *
   * 工作台 and Studio are places where you work *with* the agent, so the chat can sit beside them.
   * 设置 and 插件 are places where you are changing the app itself — a transcript next to a settings
   * form is noise, and a chat beside the plugin list is a second conversation nobody asked for. On
   * those pages the dock stays put away (the rail can still take you to the conversation).
   */
  const viewShowsDock = mainView === "workbench" || mainView === "studio" || mainView === "dj" || mainView === "library";
  const chatInDock = dockOpen && viewShowsDock;
  const dockLabel =
    mainView === "studio"
      ? "工程对话"
      : mainView === "dj"
        ? "Set 对话"
        : mainView === "library"
          ? "曲库对话"
          : "管家对话";
  const dockScope =
    mainView === "studio"
      ? openProject === undefined
        ? "Studio · 未打开工程"
        : `Studio · ${openProject.name}`
      : mainView === "dj"
        ? `DJ · ${djContext?.name ?? "当前 Set"}`
        : mainView === "library"
          ? `Library · ${libraryContext?.total ?? "—"} 首`
          : "Butler · 全局";
  /** Bounce the arrangement through the generator plugin and record the call in the transcript. */
  const exportArrangement = useCallback(
    async (spec: Record<string, unknown>) => {
      const { kind, ...payload } = spec as { kind?: "mix" | "stems" | "midi" };
      const tool = kind === "stems" ? "export_stems" : kind === "midi" ? "export_midi" : "mix_arrangement";
      const id = `${tool}-${Date.now()}`;
      beginCallRef.current({
        id,
        server: "shadow-music-generator",
        name: tool,
        status: "running",
        summary:
          kind === "midi"
            ? "MIDI"
            : kind === "stems"
              ? `分轨 · ${spec.sample_rate as number} Hz`
              : `${spec.container as string} · ${spec.sample_rate as number} Hz`,
        detail: JSON.stringify(payload, null, 2),
      });
      try {
        const raw = await callTool<string>("generator", tool, payload);
        const text = String(raw);
        const parsed = JSON.parse(text) as { path?: string; out_dir?: string; stem_count?: number };
        endCallRef.current(id, {
          status: "ok",
          summary:
            kind === "stems"
              ? `${parsed.stem_count ?? 0} 条分轨`
              : (parsed.path ?? tool).split("/").pop() ?? tool,
          detail: text.slice(0, 4000),
        });
        return parsed.path ?? parsed.out_dir ?? null;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        endCallRef.current(id, { status: "error", summary: message, detail: message });
        return null;
      }
    },
    [],
  );

  /** Which containers the generator can write on this machine — the export dialog asks when it opens. */
  const exportFormats = useCallback(async () => {
    const raw = await callTool<string>("generator", "list_export_formats", {});
    const parsed = JSON.parse(String(raw)) as {
      containers?: Array<{ id?: string; extension?: string; lossy?: boolean; available?: boolean; via?: string }>;
    };
    return (parsed.containers ?? [])
      .filter((entry) => typeof entry.id === "string")
      .map((entry) => ({
        id: String(entry.id),
        extension: String(entry.extension ?? entry.id),
        lossy: entry.lossy === true,
        available: entry.available !== false,
        via: String(entry.via ?? ""),
      }));
  }, []);

  /**
   * Separate one clip into vocals / drums / bass / other, and put the stems on their own tracks.
   *
   * The plugin works as a job (a separation takes minutes; an MCP call must not block), so this
   * starts it, then polls — updating the transcript row with the stage so the wait is visible — and
   * when the four files exist they land as four new tracks, each holding one clip the length of the
   * clip they came from. The original clip keeps playing and is marked as already split.
   */
  const splitStems = useCallback(
    async (clip: { source: string; clipId: string; name: string; start: number; length: number }) => {
      const id = `separate_stems-${Date.now()}`;
      beginCallRef.current({
        id,
        server: "stem-splitter",
        name: "separate_stems",
        status: "running",
        summary: `${clip.name} · 分离中`,
        detail: JSON.stringify({ path: clip.source }, null, 2),
      });
      const fail = (message: string) => {
        endCallRef.current(id, { status: "error", summary: message, detail: message });
        withActiveSession((current) => ({
          ...current,
          messages: [
            { id: `st-${Date.now()}`, role: "notice", title: "分轨失败", text: message, at: Date.now() },
          ],
        }));
      };
      try {
        const started = JSON.parse(
          String(await callTool<string>("splitter", "separate_stems", { path: clip.source })),
        ) as { job_id?: string; error?: string };
        if (started.job_id === undefined) throw new Error(started.error ?? "没有拿到 job id");
        const jobId = started.job_id;
        // poll until the job stops being "running"; a 4-minute song takes a few minutes on CPU
        for (let attempt = 0; attempt < 1200; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const status = JSON.parse(
            String(await callTool<string>("splitter", "stem_job_status", { job_id: jobId })),
          ) as {
            status?: string;
            stage?: string;
            stems?: Record<string, string>;
            out_dir?: string;
            error?: string;
          };
          if (status.status === "running") {
            endCallRef.current(id, {
              status: "running",
              summary: `${clip.name} · ${stageLabel(status.stage)}`,
            });
            continue;
          }
          if (status.status !== "ok" || status.stems === undefined) {
            throw new Error(status.error ?? `分轨 ${status.status ?? "失败"}`);
          }
          const stems = status.stems;
          const outDir = status.out_dir ?? "";
          const currentProject = projects.find((entry) => entry.id === openProjectId);
          const stemCount = Object.keys(stems).length;
          if (currentProject !== undefined && !canAddTracks(currentProject.tracks, stemCount)) {
            // The soft limit (10) may be overflowed by automatic work; the hard one (15) may not.
            endCallRef.current(id, { status: "error", summary: "轨道数已达上限", detail: "超过 15 轨" });
            withActiveSession((current) => ({
              ...current,
              messages: [
                ...current.messages,
                {
                  id: `st-${Date.now()}`,
                  role: "notice",
                  title: "分轨结果没落轨",
                  text: `当前 ${currentProject.tracks.length} 条轨道，再加 ${stemCount} 条会超过 15 轨硬上限。先删掉几条，再说一次「分轨」。`,
                  at: Date.now(),
                },
              ],
            }));
            return false;
          }
          updateProjectRef.current((project) => {
            const created = tracksFromStems(stems, project.tracks, clip);
            return {
              ...project,
              tracks: [...project.tracks, ...created].map((track) => ({
                ...track,
                clips: track.clips.map((entry) =>
                  entry.id === clip.clipId ? { ...entry, stemsDir: outDir } : entry,
                ),
              })),
            };
          });
          endCallRef.current(id, {
            status: "ok",
            summary: `${Object.keys(stems).length} 条分轨`,
            detail: JSON.stringify({ out_dir: outDir, stems }, null, 2),
          });
          return true;
        }
        throw new Error("分轨超时（40 分钟）");
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        fail(message);
        return false;
      }
    },
    [withActiveSession],
  );

  /** Notate one audio clip with the melody tool — "turn this clip into MIDI" from the clip menu. */
  const notateClip = useCallback(async (path: string) => {
    const id = `hum_to_midi-${Date.now()}`;
    beginCallRef.current({
      id,
      server: "audio-analysis-dedupe",
      name: "hum_to_midi",
      status: "running",
      summary: path.split("/").pop() ?? path,
      detail: JSON.stringify({ path }, null, 2),
    });
    try {
      const raw = await callTool<string>("analysis", "hum_to_midi", { path });
      const text = String(raw);
      const parsed = JSON.parse(text) as {
        midi_path?: string;
        notes?: Array<{ start_ms: number; end_ms: number; midi: number; name?: string }>;
      };
      endCallRef.current(id, {
        status: "ok",
        summary: `${parsed.notes?.length ?? 0} 个音符`,
        detail: text.slice(0, 4000),
      });
      // Where the notated clip lands is the caller's decision (the clip menu puts it beside the audio
      // it came from), so this only records the call and hands the notes back.
      return { midi_path: parsed.midi_path, notes: parsed.notes };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      endCallRef.current(id, { status: "error", summary: message, detail: message });
      return null;
    }
  }, []);

  /** Studio edits arrive as updaters, so the page never has to hold a snapshot. */
  /**
   * Hand a finished recording to the bridge, which turns it into a WAV.
   *
   * MediaRecorder gives us webm/opus (Safari: mp4), so the bytes go up as base64 and come back as a
   * path plus the length the file really has — measured from the WAV header, not from our stopwatch.
   */
  const uploadRecording = useCallback(async (blob: Blob, name: string): Promise<{ path: string; durationMs: number } | null> => {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("读取录音失败"));
      reader.onload = () => {
        const result = String(reader.result);
        resolve(result.slice(result.indexOf(",") + 1));
      };
      reader.readAsDataURL(blob);
    });
    const extension = (blob.type.split("/")[1] ?? "webm").split(";")[0].toLowerCase();
    try {
      const response = await fetch("/api/agent/record", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data, name, extension }),
      });
      const body = (await response.json()) as { path?: string; duration_ms?: number; error?: string };
      if (!response.ok || body.path === undefined) throw new Error(body.error ?? "录音没有保存成功");
      return { path: body.path, durationMs: body.duration_ms ?? 0 };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      withActiveSession((current) => ({
        ...current,
        messages: [...current.messages, { id: `nt-${Date.now()}`, role: "notice", title: "录音没有保存", text: message, at: Date.now() }],
      }));
      return null;
    }
  }, [withActiveSession]);

  /**
   * Copy the files the user dropped (or picked in the browser) into the workspace.
   *
   * A `File` has no path, so the bytes go through `POST /api/agent/import` and come back as a real
   * file under `~/Documents/ShadowRoom/imports/<date>/` — from then on the studio, the exporter and
   * the agent all treat it like any other file on disk.
   */
  const uploadImport = useCallback(async (files: File[]) => {
    const paths: string[] = [];
    for (const file of files) {
      try {
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error("读取文件失败"));
          reader.onload = () => {
            const result = String(reader.result);
            resolve(result.slice(result.indexOf(",") + 1));
          };
          reader.readAsDataURL(file);
        });
        const response = await fetch("/api/agent/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: file.name, data }),
        });
        const payload = (await response.json()) as { path?: string; error?: string };
        if (!response.ok || payload.path === undefined) throw new Error(payload.error ?? `${response.status}`);
        paths.push(payload.path);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        withActiveSession((current) => ({
          ...current,
          messages: [
            ...current.messages,
            { id: `i-${Date.now()}-${file.name}`, role: "notice", title: "导入失败", text: `${file.name}：${message}`, at: Date.now() },
          ],
        }));
      }
    }
    return paths;
  }, [withActiveSession]);

  /** The machine's own file dialog: reference a file where it lives, copy nothing. */
  const pickImport = useCallback(async () => {
    try {
      const response = await fetch("/api/agent/pick", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ multiple: true, kind: "audio" }),
      });
      const payload = (await response.json()) as { paths?: string[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? `${response.status}`);
      return payload.paths ?? [];
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      withActiveSession((current) => ({
        ...current,
        messages: [
          ...current.messages,
          { id: `p-${Date.now()}`, role: "notice", title: "打开文件对话框失败", text: message, at: Date.now() },
        ],
      }));
      return [];
    }
  }, [withActiveSession]);

  /**
   * What is this file? Tempo and key, from the analysis plugin.
   *
   * The two calls are recorded as tool rows like any other, and when the project was empty the
   * detected tempo becomes the project's own — the studio then places the file on a grid that
   * matches it instead of on an arbitrary 128.
   */
  const analyzeImport = useCallback(
    async (path: string, context: { wasEmpty: boolean }): Promise<StudioAnalysis | null> => {
      const id = `analyse-${Date.now()}`;
      beginCallRef.current({
        id,
        server: "audio-analysis-dedupe",
        name: "detect_tempo",
        status: "running",
        summary: path.split("/").pop() ?? path,
        detail: JSON.stringify({ path }, null, 2),
      });
      try {
        const tempoRaw = await callTool<string>("analysis", "detect_tempo", { path });
        const tempo = JSON.parse(String(tempoRaw)) as { bpm?: number; confidence?: number; onsets?: number };
        const keyRaw = await callTool<string>("analysis", "detect_key", { path }).catch(() => "");
        const key = keyRaw === "" ? {} : (JSON.parse(String(keyRaw)) as { key?: string; camelot?: string; confidence?: number });
        const analysis: StudioAnalysis = {
          ...(typeof tempo.bpm === "number" ? { bpm: tempo.bpm } : {}),
          ...(typeof tempo.confidence === "number" ? { confidence: tempo.confidence } : {}),
          ...(typeof key.key === "string" ? { key: key.key } : {}),
          ...(typeof key.camelot === "string" ? { camelot: key.camelot } : {}),
        };
        endCallRef.current(id, {
          status: "ok",
          summary: [analysis.bpm === undefined ? undefined : `${Math.round(analysis.bpm)} BPM`, analysis.camelot ?? analysis.key]
            .filter((part) => part !== undefined)
            .join(" · "),
          detail: JSON.stringify({ tempo, key }, null, 2).slice(0, 2000),
        });
        if (context.wasEmpty && typeof analysis.bpm === "number" && (analysis.confidence ?? 0) >= 0.5) {
          const name = path.split("/").pop() ?? path;
          updateProjectRef.current((project) => ({ ...project, bpm: Math.round(analysis.bpm as number) }));
          withActiveSession((current) => ({
            ...current,
            messages: [
              ...current.messages,
              {
                id: `bpm-${Date.now()}`,
                role: "notice",
                title: "工程 BPM 已更新",
                text: `${Math.round(analysis.bpm as number)} BPM（来自 ${name}）`,
                at: Date.now(),
              },
            ],
          }));
        }
        return analysis;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        endCallRef.current(id, { status: "error", summary: message, detail: message });
        return null;
      }
    },
    [withActiveSession],
  );

  /** Remember the project as it is right now — the point a drag or an edit can return to. */
  /**
   * Remember the project as it is right now — the point the next edit can return to.
   *
   * The snapshot is taken from the state this render already has, and pushed in a single updater:
   * the first version called `setHistory` from *inside* a `setProjects` updater, and React's
   * StrictMode runs those twice — which is how an undo came out as a no-op (measured: two undos
   * behaved like one).
   */
  const beginEdit = useCallback(() => {
    const project = projects.find((entry) => entry.id === openProjectId);
    if (project === undefined) return;
    const id = project.id;
    setHistories((previous) => {
      const current = previous[id] ?? { past: [], future: [] };
      return { ...previous, [id]: { past: [...current.past.slice(-49), project], future: [] } };
    });
  }, [openProjectId, projects]);

  const updateProject = useCallback(
    (patch: (project: StudioProject) => StudioProject, options?: { transient?: boolean }) => {
      if (options?.transient !== true) beginEdit();
      setProjects((current) =>
        current.map((project) =>
          project.id === openProjectId ? { ...patch(project), updatedAt: Date.now() } : project,
        ),
      );
    },
    [beginEdit, openProjectId],
  );

  updateProjectRef.current = (patch) => updateProject(patch);

  const undo = useCallback(() => {
    const previousProject = history.past.at(-1);
    if (previousProject === undefined) return;
    const id = previousProject.id;
    const currentProject = projects.find((project) => project.id === id);
    setProjects((current) =>
      current.map((project) => (project.id === id ? { ...previousProject, updatedAt: Date.now() } : project)),
    );
    setHistories((previous) => ({
      ...previous,
      [id]: {
        past: (previous[id]?.past ?? []).slice(0, -1),
        future:
          currentProject === undefined
            ? (previous[id]?.future ?? [])
            : [currentProject, ...(previous[id]?.future ?? [])].slice(0, 50),
      },
    }));
  }, [history, projects]);

  const redo = useCallback(() => {
    const nextProject = history.future[0];
    if (nextProject === undefined) return;
    const id = nextProject.id;
    const currentProject = projects.find((project) => project.id === id);
    setProjects((current) =>
      current.map((project) => (project.id === id ? { ...nextProject, updatedAt: Date.now() } : project)),
    );
    setHistories((previous) => ({
      ...previous,
      [id]: {
        past:
          currentProject === undefined
            ? (previous[id]?.past ?? [])
            : [...(previous[id]?.past ?? []).slice(-49), currentProject],
        future: (previous[id]?.future ?? []).slice(1),
      },
    }));
  }, [history, projects]);

  // Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z (or Ctrl+Y) while a Studio project is open.
  useEffect(() => {
    if (mainView !== "studio" || openProjectId === undefined) return;
    const onKey = (event: KeyboardEvent): void => {
      const meta = event.metaKey || event.ctrlKey;
      if (!meta) return;
      const target = event.target as HTMLElement | null;
      if (target !== null && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mainView, openProjectId, redo, undo]);

  /**
   * The agent's melody tool lands on the timeline by itself: when `hum_to_midi` completes in a
   * conversation, its notes become a clip in the open project. No button, no second step — the hum
   * happens inside the call and the arrangement grows out of the same sentence.
   */
  const absorbMelody = useCallback(
    (call: ToolCall) => {
      if (call.name !== "hum_to_midi" || call.status !== "ok" || openProjectId === undefined) return;
      try {
        const wrapper = JSON.parse(call.detail ?? "{}") as {
          result?: { content?: Array<{ text?: string }> };
        };
        const text = wrapper.result?.content?.[0]?.text;
        const parsed = JSON.parse(String(text)) as {
          midi_path?: string;
          notes?: Array<{ start_ms: number; end_ms: number; midi: number; name?: string }>;
        };
        const notes = parsed.notes ?? [];
        if (notes.length === 0) return;
        setProjects((current) =>
          current.map((project) => {
            if (project.id !== openProjectId) return project;
            const clip = clipFromNotes(notes, project.bars, 0, parsed.midi_path ?? "");
            // S4（2026-09-25 巡检）：工程从 0 轨起步——没有轨道时建一条旋律轨接住哼唱，
            // 而不是让 map 空转、音符无声消失。
            if (project.tracks.length === 0) {
              return {
                ...project,
                updatedAt: Date.now(),
                tracks: [
                  {
                    ...newTrack(defaultTrackName(project.tracks, "instrument")),
                    type: "instrument" as const,
                    color: nextTrackColor(project.tracks),
                    clips: [clip],
                  },
                ],
              };
            }
            return {
              ...project,
              updatedAt: Date.now(),
              tracks: project.tracks.map((track, index) =>
                index === 0 ? { ...track, clips: [...track.clips, clip] } : track,
              ),
            };
          }),
        );
      } catch {
        /* a tool result we cannot read simply stays in the transcript */
      }
    },
    [openProjectId],
  );

  return (
    <>
      <AppFrame
      dockCollapsed={!chatInDock}
      sidebar={({ collapsed, toggleSidebar }) => (
        <Sidebar
          collapsed={collapsed}
          toggleSidebar={toggleSidebar}
          plugins={plugins}
          activeWorkspace={workspace}
          showPlugins={mainView === "plugins"}
          onHome={() => setMainView("workbench")}
          onSelectWorkspace={(next) => {
            if (next === "studio") ensureWorkerSession("studio");
            else if (next === "dj") ensureWorkerSession("dj");
            else if (next === "library") ensureWorkerSession("library");
            setMainView(
              next === "studio"
                ? "studio"
                : next === "dj"
                  ? "dj"
                  : next === "library"
                    ? "library"
                  : next === "settings"
                    ? "settings"
                    : "workbench",
            );
          }}
          onShowPlugins={() => {
            setMainView("plugins");
          }}
          sessions={summaries}
          activeSessionId={butlerSession?.id}
          onSelectSession={(id) => {
            const selected = store.sessions.find((entry) => entry.id === id);
            if (selected === undefined) return;
            setStore((current) => selectSession(current, selected));
            setMainView("conversation");
            setDockOpen(false);
          }}
          onNewSession={() => {
            startSession();
            setMainView("conversation");
            setDockOpen(false);
          }}
        />
      )}
      main={
        <div className="sr-main-wrap">
          {mainView === "workbench" ? (
          <WorkbenchHome
            projects={[...projects].sort((a, b) => b.updatedAt - a.updatedAt)}
            sessions={summaries}
            plugins={plugins}
            onOpenProject={(id) => {
              ensureWorkerSession("studio");
              setOpenProjectId(id);
              rememberOpenProject(id);
              setMainView("studio");
            }}
            onOpenSession={(id) => {
              const selected = store.sessions.find((entry) => entry.id === id);
              if (selected === undefined) return;
              setStore((current) => selectSession(current, selected));
              setMainView("conversation");
              setDockOpen(false);
            }}
            onOpenPlugins={() => setMainView("plugins")}
            onOpenLibrary={() => {
              ensureWorkerSession("library");
              setMainView("library");
            }}
            onOpenDj={() => {
              ensureWorkerSession("dj");
              setMainView("dj");
            }}
            onCreateProject={() => {
              ensureWorkerSession("studio");
              const created = defaultProject();
              setProjects((current) => [created, ...current]);
              setOpenProjectId(created.id);
              rememberOpenProject(created.id);
              setMainView("studio");
            }}
          />
          ) : mainView === "plugins" ? (
          <PluginsPage
            plugins={plugins}
            activePlugin={active?.repo}
            onOpenPlugin={(repo) => {
              setActivePlugin(repo);
              setMainView("plugin");
            }}
          />
          ) : mainView === "plugin" && active !== undefined ? (
            <PluginPanelPage
              plugin={active}
              home={home}
              onBack={() => setMainView("plugins")}
              onCallBegin={beginCall}
              onCallEnd={endCall}
            />
          ) : mainView === "settings" ? (
            <SettingsPage settings={modelSettings} onChange={setModelSettings} />
          ) : mainView === "dj" ? (
            <DjPage onContextChange={setDjContext} />
          ) : mainView === "library" ? (
            <LibraryPage onContextChange={setLibraryContext} />
          ) : mainView === "studio" ? (
          openProject === undefined ? (
            <StudioProjects
              projects={[...projects].sort((a, b) => b.updatedAt - a.updatedAt).map(summarize)}
              /**
               * 另存快照：原样复制一份新的工程。撤销栈只活在当前会话里，而「想试试别的 bass 又
               * 怕回不去」是真需求 —— 快照就是那个回得去的地方（StudioProjects 里那颗按钮）。
               */
              onSnapshot={(id) => {
                setProjects((current) => {
                  const source = current.find((project) => project.id === id);
                  return source === undefined ? current : [...current, snapshotProject(source)];
                });
              }}
              onCreate={() => {
                const created = defaultProject();
                setProjects((current) => [created, ...current]);
                setOpenProjectId(created.id);
                rememberOpenProject(created.id);
              }}
              onOpen={(id) => {
                setOpenProjectId(id);
                rememberOpenProject(id);
              }}
              onDelete={(id) => {
                setProjects((current) => current.filter((project) => project.id !== id));
                if (id === openProjectId) {
                  setOpenProjectId(undefined);
                  rememberOpenProject(null);
                }
              }}
            />
          ) : (
            <StudioPage
              project={openProject}
              onChange={updateProject}
              onBeginEdit={beginEdit}
              onUndo={undo}
              onRedo={redo}
              canUndo={history.past.length > 0}
              canRedo={history.future.length > 0}
              onExport={exportArrangement}
              onConvertToMidi={notateClip}
              onUploadImport={uploadImport}
              onPickImport={pickImport}
              onAnalyze={analyzeImport}
              onExportFormats={exportFormats}
              onSplitStems={splitStems}
              onSaveRecording={uploadRecording}
              onNoteContextChange={setNoteContext}
              rendering={rendering}
              storageBlocked={storageBlocked}
              /* 用户定稿：Studio 页不再有底部大输入条——打字入口只有悬浮球面板与右侧对话栏。
                 传 null 让 StudioPage 不渲染 composer 整条（输入框/添加/模式芯片/模型/发送）。 */
              composer={null}
              onClose={() => {
                setOpenProjectId(undefined);
                rememberOpenProject(null);
              }}
            />
          )
          ) : (
          <Conversation
            messages={session?.messages ?? []}
            calls={session?.calls ?? []}
            running={sessionBusy}
            quiet={mode === "极简"}
            suggestions={SUGGESTIONS}
            onSuggestion={setDraft}
            composer={chatInDock ? null : composerFor()}
          />
          )}
        </div>
      }
      dockRail={
        /**
         * Pages that have no conversation show no way *into* one either: a rail whose only button
         * teleports you elsewhere is the same "why is there a chat in my settings" problem in smaller
         * form. 设置 and 插件 therefore get a plain collapsed column.
         */
        !viewShowsDock ? null : (
        <div className="sr-dock-rail">
          <button
            type="button"
            className="sr-dock-rail-btn"
            title={viewShowsDock ? (sessionBusy ? "对话 · 正在运行" : "展开对话") : "去对话"}
            aria-label={viewShowsDock ? "展开对话" : "去对话"}
            data-busy={sessionBusy || voiceMode || undefined}
            onClick={() => {
              // On a page that has no dock, the button takes you to the conversation itself.
              if (viewShowsDock) setDockOpen(true);
              else setMainView("conversation");
            }}
          >
            <IconChat size={18} />
          </button>
        </div>
        )
      }
      dock={
        <DockPanel
          label={dockLabel}
          scope={dockScope}
          chat={conversationPane({ variant: "dock", composer: composerFor("和智能体说点什么…") })}
          onClose={() => setDockOpen(false)}
        />
      }
      />
      {routeSuggestion !== null && sessionKindForView(mainView) !== "butler" && (
        <div className="sr-route-toast" role="status" aria-live="polite">
          <RouteIntentCard
            route={routeSuggestion}
            onOpen={(route) => {
              openRoute(route);
            }}
            onDismiss={() => {
              setRouteSuggestion(null);
              if (activeDispatchIdRef.current === routeSuggestion.commandId) {
                activeDispatchIdRef.current = null;
              }
              consumeCommand(routeSuggestion);
            }}
          />
        </div>
      )}
      {/*
        管家球：常驻整个 app（不属于任何页面）。它在任何页面都写 butler 线程；页面 dock 才写页面
        worker。两条草稿也分开发，避免在 Studio 里打开球时把管家话术带进工程线程。
      */}
      <ButlerOrb
        draft={drafts.butler}
        onDraftChange={setButlerDraft}
        onSubmit={() => void submit(drafts.butler, { kind: "butler" })}
        running={butlerBusy}
        voiceMode={voiceMode}
        voiceState={voiceState}
        voiceLevel={() => level.current}
        onCallToggle={onOrbCallToggle}
        onCallEnd={hangUp}
        onOpenHistory={() => {
          setMainView("conversation");
          setDockOpen(false);
        }}
        onNewConversation={() => {
          startSession();
          setMainView("conversation");
          setDockOpen(false);
        }}
        onOpenSettings={() => {
          setMainView("settings");
          setDockOpen(false);
        }}
        caption={
          /*
           * 通话没起来（麦克风被拒等）时也要把话说出来——否则用户点球什么都不发生，
           * 字幕是唯一能解释「为什么没反应」的地方。
           *
           * F-1 五态各一行（通话相关文案只有 call-words.ts 一处：状态词 callWord + 两条字幕常量）：
           * 没听清 = UNCLEAR_CAPTION + 「改成打字」按钮（≤12 字，留给用户做的决定）；
           * 断了 = OFFLINE_CAPTION（琥珀，不是红——可恢复）。
           */
          voiceMode
            ? voiceState === "speaking"
              ? // 供应商音色回退这类 notice 优先于正在念的句子：声音已经换到系统音色了，
                // 屏幕上却只滚句子的话，用户不知道刚才那次变调是「出过错」。
                (voiceNotice ?? spokenSentence ?? undefined)
              : voiceState === "thinking"
                ? (voiceNotice ?? callWord("thinking"))
                : voiceState === "unclear"
                  ? UNCLEAR_CAPTION
                  : voiceState === "offline"
                    ? OFFLINE_CAPTION
                    : voicePartial !== ""
                      ? voicePartial
                      : callHintOn
                        ? CALL_START_HINT
                        : callWord("listening")
            : (voiceNotice ?? undefined)
        }
        captionAction={
          voiceMode && voiceState === "unclear" ? { label: "改成打字", onAction: typeInstead } : undefined
        }
      />
    </>
  );
}

/** Quick starts for the empty session — they only fill the composer, nothing runs yet. */
const SUGGESTIONS = [
  "给这 12 首 tech house 排一套 60 分钟的 set",
  "把 Rekordbox 的 cue 和颜色转到 Serato",
  "找出资料库里重复的曲目",
];

/** What the separator's stages are called in the conversation. */
function stageLabel(stage: string | undefined): string {
  if (stage === "decode") return "解码中";
  if (stage === "separate") return "分离中";
  if (stage === "collect") return "整理分轨";
  return "排队中";
}

/** Part names the synth uses, in the workbench's language. */
/**
 * Part names are the synth's own vocabulary and stay English — the agent says `drums`/`bass`, the
 * MIDI files say `drums`/`bass`, and a producer looking for the kick reads "Drums", not "鼓".
 */
const PART_LABEL: Record<string, string> = {
  drums: "Drums",
  bass: "Bass",
  chords: "Chords",
  lead: "Lead",
  pad: "Pad",
};
