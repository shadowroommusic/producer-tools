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
import type { ToolCall } from "./components/ToolCallRow";
import {
  answerApproval,
  fetchAgentHealth,
  fetchModels,
  interruptTurn,
  sendTurn,
  toolCallFromItem,
  type AgentModel,
  type AgentHealth,
  type Mention,
} from "./lib/agent";
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
    if (events.length === 0) return "";
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
  microphoneSupported,
  type TurnDetector,
  type VoiceCapture,
} from "./lib/voice";
import { createBridgeTTS, createSystemTTS, splitSentences, type TTSProvider } from "./lib/tts";
import { createBrowserSTT, type STTSession } from "./lib/stt";
import { createBargeInDetector, turnSilenceMs, type BargeInDetector } from "./lib/bargein";
import {
  createSession,
  loadSessions,
  saveSessions,
  timeAgo,
  titleFrom,
  type ChatMessage,
  type Session,
  type SessionStore,
} from "./lib/sessions";
import { AppFrame } from "./shell/AppFrame";

/** The four ShadowRoom MCP servers, keyed by the ids the bridge reports. */
const PLUGINS: Array<{ id: string; server: string; label: string; repo: string }> = [
  { id: "bridge", server: "converter", label: "Rekordbox ⇄ Serato", repo: "rekordbox-serato-bridge" },
  { id: "analysis", server: "analysis", label: "音频分析去重", repo: "audio-analysis-dedupe" },
  { id: "planner", server: "planner", label: "Set 编排", repo: "set-planner" },
  { id: "generator", server: "generator", label: "音乐生成队列", repo: "shadow-music-generator" },
  { id: "splitter", server: "splitter", label: "Stem Splitter", repo: "stem-splitter" },
  { id: "grabber", server: "grabber", label: "音乐抓取转码", repo: "ShadowMusicGrabber" },
];

type Bridge = "connecting" | "online" | "offline";

export function App() {
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [home, setHome] = useState("");
  const [workspaces, setWorkspaces] = useState("");
  const [bridge, setBridge] = useState<Bridge>("connecting");
  const [activePlugin, setActivePlugin] = useState("set-planner");
  /**
   * The dock is the conversation next to the work. It stays open on the work pages (工作台, Studio,
   * the plugin pages) and folds away on the conversation page, where the transcript already owns the
   * main column — the one place the same chat would otherwise be drawn twice. The choice sticks.
   */
  const [dockOpen, setDockOpen] = useState(
    () => window.localStorage.getItem("shadowroom.dock") !== "closed",
  );
  const [store, setStore] = useState<SessionStore>(() => loadSessions());
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState("标准");
  const [agent, setAgent] = useState<AgentHealth | null>(null);
  const [running, setRunning] = useState(false);
  const [controller, setController] = useState<AbortController | null>(null);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [mainView, setMainView] = useState<
    "workbench" | "conversation" | "plugins" | "plugin" | "studio" | "dj" | "settings"
  >(
    () =>
      (window.localStorage.getItem("shadowroom.view") as
        | "workbench"
        | "conversation"
        | "plugins"
        | "plugin"
        | "studio"
        | "dj"
        | "settings"
        | null) ?? "workbench",
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
      mainView === "settings" ||
      mainView === "workbench"
    )
      setLastWorkspaceView(mainView);
  }, [mainView]);
  const [projects, setProjects] = useState<StudioProject[]>(() => loadProjects());
  const [openProjectId, setOpenProjectId] = useState<string | undefined>(undefined);
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
  const [voiceState, setVoiceState] = useState<"listening" | "thinking" | "speaking">("listening");
  const voiceSession = useRef<STTSession | null>(null);
  /** One recogniser and one speaker for the whole call — implemented behind the interfaces in
      `lib/stt.ts` / `lib/tts.ts`, so the desktop build swaps them without touching this logic. */
  const stt = useRef(createBrowserSTT());
  /**
   * Which voice the call speaks with.
   *
   * A configured 语音合成 role wins: its audio comes back through the bridge and we play it ourselves,
   * which is also what gives the desktop build a reference signal for barge-in. With no role configured
   * the system voice keeps working, so a call is never blocked on settings.
   */
  const tts = useRef<TTSProvider | null>(null);
  const ttsKey = useRef("");
  const currentTTS = (): TTSProvider => {
    const target = roleTarget(modelSettings, "tts");
    const key = target === undefined ? "system" : `${target.provider.id}:${target.model}:${target.provider.credentialRef ?? ""}`;
    if (tts.current === null || ttsKey.current !== key) {
      if (target === undefined) {
        tts.current = createSystemTTS();
      } else {
        const capability = capabilityTarget(target.provider, "tts");
        /**
         * 音色暂时由供应商默认决定：能力配置里只存协议/端点/模型（和 Shadow 的能力形状一致），
         * 音色选择会跟着「通话与声音」页一起做——那页要列出这家自己的音色。
         */
        const voice = window.localStorage.getItem("shadowroom.tts.voice") ?? "";
        tts.current = createBridgeTTS({
          baseUrl: capability.baseUrl,
          credentialRef: target.provider.credentialRef,
          protocol: capability.protocol,
          model: target.model,
          ...(voice === "" ? {} : { voice }),
        });
      }
      ttsKey.current = key;
    }
    return tts.current;
  };
  /**
   * The voice is read at speak time, not held in state: it is chosen in 设置 (another view), and a
   * call that is already up should pick the new voice for its next sentence instead of needing a
   * reload. `localStorage` is the single place both views agree on.
   */
  const currentVoiceId = () => window.localStorage.getItem("shadowroom.voice") ?? undefined;
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
  /** Absorption goes through a ref: `submit` is created before the absorber exists. */
  const absorbRef = useRef<(call: ToolCall) => void>(() => undefined);
  const beginCallRef = useRef<(call: ToolCall) => void>(() => undefined);
  const endCallRef = useRef<(id: string, patch: Partial<ToolCall>) => void>(() => undefined);
  const voiceModeRef = useRef(false);
  const voiceStateRef = useRef<"listening" | "thinking" | "speaking">("listening");
  /** The turn's own `running` flag, read from callbacks that were created before it changed. */
  const runningRef = useRef(false);
  /** When the last sentence finished playing — used to ignore the answer's own tail. */
  const speakEndedAt = useRef(0);
  runningRef.current = running;
  /** How much of the current answer has already been handed to the synthesizer. */
  const spokenUpTo = useRef(0);
  /** Bumped whenever a new answer starts being spoken, so old callbacks cannot do anything. */
  const speakingToken = useRef(0);
  voiceModeRef.current = voiceMode;
  /**
   * The call's state lives in the ref (the callbacks below are not re-created on every render), and
   * `useState` only draws it. Every change goes through here: `setVoiceState` alone would leave the
   * ref stale for a moment, and stopping the recognizer fires `onend` *in that moment* — which read
   * "still listening" and started the user's turn over (measured: one phrase, two messages).
   */
  const moveVoice = useCallback((next: "listening" | "thinking" | "speaking") => {
    voiceStateRef.current = next;
    setVoiceState(next);
  }, []);
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
  /**
   * Which provider the Codex core is currently running on ("" = the built-in one).
   *
   * Switching is a core restart — the accepted channel is a `CODEX_HOME` config file, not a per-thread
   * override — so it happens only when the choice actually changes, not on every message. A restart also
   * drops the bridge's thread mapping, i.e. the next message starts a fresh agent thread on the new
   * provider (the transcript in the UI is unaffected).
   */
  const appliedProvider = useRef("");
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
        supportedReasoningEfforts: [],
      })),
    [modelSettings],
  );
  const [modelId, setModelId] = useState<string | undefined>(
    () => window.localStorage.getItem("shadowroom.model") ?? undefined,
  );

  const session = store.sessions.find((entry) => entry.id === store.activeId);

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
    window.localStorage.setItem("shadowroom.dock", dockOpen ? "open" : "closed");
  }, [dockOpen, mainView]);

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

  // The model picker mirrors the core's own list; the choice sticks per browser.
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

  const chooseModel = useCallback((id: string) => {
    setModelId(id);
    window.localStorage.setItem("shadowroom.model", id);
  }, []);

  // The agent core is optional: without it the composer records requests instead of running them.
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchAgentHealth()
        .then((health) => {
          if (!cancelled) setAgent(health);
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
      const existing = current.sessions.find((entry) => entry.id === current.activeId);
      const target = existing ?? createSession();
      const next = update(target);
      const known = existing !== undefined;
      return {
        sessions: known
          ? current.sessions.map((entry) => (entry.id === next.id ? next : entry))
          : [next, ...current.sessions],
        activeId: next.id,
      };
    });
  }, []);

  const startSession = useCallback(() => {
    const fresh = createSession();
    setStore((current) => ({ sessions: [fresh, ...current.sessions], activeId: fresh.id }));
  }, []);

  /** Append a message to one session inside the store. */
  const patchSession = useCallback((store_: SessionStore, id: string, patch: (session: Session) => Session) => {
    return {
      ...store_,
      sessions: store_.sessions.map((entry) => (entry.id === id ? patch(entry) : entry)),
    };
  }, []);

  const submit = useCallback(
    /**
     * Async because the turn may first have to point the Codex core at the chosen provider (a core
     * restart, ~1s). Everything below is unchanged — the awaits are only around that switch.
     */
    async (override?: string, options: { mentions?: Mention[] } = {}) => {
    const text = (override ?? draft).trim();
    if (text === "" || running) return;
    setDraft("");
    const at = Date.now();
    const assistantId = `a-${at}`;
    const mentions = options.mentions ?? attachments;
    if (options.mentions === undefined) setAttachments([]);

    // The session id has to be known synchronously, so a hero submit creates the session first.
    const known = store.sessions.find((entry) => entry.id === store.activeId);
    const sessionId = known?.id ?? createSession().id;
    if (known === undefined) {
      const fresh: Session = { id: sessionId, title: titleFrom(text), createdAt: at, messages: [], calls: [] };
      setStore((current) => ({ sessions: [fresh, ...current.sessions], activeId: fresh.id }));
    }

    setStore((current) =>
      patchSession(current, sessionId, (session) => ({
        ...session,
        title: session.messages.length === 0 ? titleFrom(text) : session.title,
        messages: [...session.messages, { id: `u-${at}`, role: "user", text, at }],
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
      return;
    }

    const abort = new AbortController();
    setController(abort);
    setRunning(true);
    const startedAt = Date.now();
    /** Latest token usage seen for this turn, reported when it finishes. */
    let usage: { totalTokens?: number } | undefined;
    /** The answer is created lazily: its position in the flow must follow the tool rows. */
    const appendDelta = (delta: string) => {
      setStore((current) =>
        patchSession(current, sessionId, (session) => {
          const existing = session.messages.find((message) => message.id === assistantId);
          if (existing === undefined) {
            return {
              ...session,
              messages: [...session.messages, { id: assistantId, role: "assistant", text: delta, at: Date.now() }],
            };
          }
          return {
            ...session,
            messages: session.messages.map((message) =>
              message.id === assistantId && message.role === "assistant"
                ? { ...message, text: message.text + delta }
                : message,
            ),
          };
        }),
      );
    };
    const finishAssistant = () => {
      setController(null);
      setRunning(false);
    };

    /**
     * What the agent actually receives: the user's words plus, when the piano roll is open, the notes
     * it is looking at. The clip cannot be read from the agent's side — the app owns that state — so
     * it travels with the message, together with the revision the edit must match.
     */
    const openProject = projects.find((project) => project.id === openProjectId);
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
    /**
     * Point the core at the provider this choice belongs to (or back at the built-in one) before the
     * turn is sent. Without this the turn went out with the custom *model name* but the built-in
     * provider, and Codex answered "The supported API model names are …".
     */
    const chosen =
      modelId?.startsWith("custom:") === true
        ? agentModelChoices(modelSettings).find((choice) => `custom:${choice.provider.id}:${choice.model}` === modelId)
        : undefined;
    const wantedProvider = chosen?.provider.id ?? "";
    if (wantedProvider !== appliedProvider.current) {
      try {
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
    const brief = await butlerBrief();
    const briefContext = brief === "" ? [] : [brief];
    const outgoing =
      noteContext === null
        ? [text, ...briefContext, ...arrangementContext].join("\n")
        : [
            text,
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
          ].join("\n");

    void sendTurn(
      sessionId,
      outgoing,
      (event) => {
        if (event.type === "delta") {
          appendDelta(event.text);
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
          const call = toolCallFromItem(event.item, event.phase);
          if (call === null) return;
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
          if (event.phase === "completed") absorbRef.current(call);
          setStore((current) =>
            patchSession(current, sessionId, (session) => {
              const known_ = session.calls.some((entry) => entry.id === call.id);
              return {
                ...session,
                calls: known_
                  ? session.calls.map((entry) => (entry.id === call.id ? { ...entry, ...call } : entry))
                  : [...session.calls, call],
                messages: known_
                  ? session.messages
                  : [...session.messages, { id: `c-${call.id}`, role: "tool", callId: call.id, at: Date.now() }],
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
            modelId?.startsWith("custom:") === true
              ? (() => {
                  const [, providerId, model] = modelId.split(":");
                  return agentModelChoices(modelSettings).find((choice) => choice.provider.id === providerId && choice.model === model);
                })()
              : undefined;
          if (custom === undefined) return { model: modelId, mentions };
          return {
            model: custom.model,
            mentions,
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
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
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
        const elapsedMs = Date.now() - startedAt;
        const tokens = usage?.totalTokens;
        if (tokens !== undefined) {
          const at_ = Date.now();
          setStore((current) =>
            patchSession(current, sessionId, (session) => ({
              ...session,
              messages: [
                ...session.messages,
                {
                  id: `u-${at_}`,
                  role: "usage",
                  text: `${tokens.toLocaleString("en-US")} tokens · ${Math.round(elapsedMs / 1000)}s`,
                  at: at_,
                },
              ],
            })),
          );
        }
      });
    },
    [agent, attachments, draft, modelId, modelSettings, noteContext, patchSession, running, store.activeId, store.sessions],
  );

  const stop = useCallback(() => {
    if (store.activeId === undefined) return;
    controller?.abort();
    void interruptTurn(store.activeId);
  }, [controller, store.activeId]);

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
          const sessionId = approval.sessionId ?? store.activeId;
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
    [patchSession, store.activeId],
  );

  const pendingForSession = approvals.filter(
    (approval) => approval.sessionId === undefined || approval.sessionId === store.activeId,
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
  const voiceSupported = microphoneSupported();
  const lastAssistant = [...(session?.messages ?? [])].reverse().find((message) => message.role === "assistant");
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
    if (voiceSession.current !== null) return;
    const token = listenToken.current + 1;
    listenToken.current = token;
    const current = () => listenToken.current === token;
    heardRef.current = "";
    partialRef.current = "";
    setVoicePartial("");
    // A fresh turn: the endpointer starts from "nothing heard yet".
    turnRef.current?.reset();
    voiceSession.current = stt.current.start({
      onPartial: (text) => {
        if (!current()) return;
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
        setVoiceNotice(
          message === "not-allowed" || message === "audio-capture"
            ? "拿不到麦克风：在系统设置里允许浏览器使用麦克风。"
            : message === "network"
              ? "这台环境连不上语音识别服务：Chrome 的识别要联网，桌面包会改用本地识别。现在可以打字继续。"
              : `语音识别出错：${message}`,
        );
      },
    });
  }, []);
  listenRef.current = listen;

  /** The user stopped talking: hand the turn over, with the WAV of that phrase attached. */
  const finishTurn = useCallback(async () => {
    const text = [heardRef.current, partialRef.current]
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .join(" ");
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
    moveVoice("thinking");
    const wav = capture.current?.takeWav() ?? null;
    const path = wav === null ? null : await saveRecording(wav, "voice");
    const mentions: Mention[] =
      path === null ? [] : [{ name: path.split("/").pop() ?? "voice.wav", path, label: "这段语音" }];
    submitRef.current(text, { mentions });
  }, []);
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
        window.setTimeout(() => {
          if (voiceStateRef.current === "speaking") window.speechSynthesis?.resume?.();
        }, 700);
      },
      /**
       * A real sentence: the answer is cancelled, the agent is told to stop generating, and whatever
       * the user already said becomes the start of their turn instead of being thrown away.
       */
      onCancel: () => {
        if (voiceStateRef.current !== "speaking" && voiceStateRef.current !== "thinking") return;
        answerToken.current += 1;
        currentTTS().cancel();
        capture.current?.takeWav(); // the answer's tail is not part of the next request
        controller?.abort();
        if (store.activeId !== undefined) void interruptTurn(store.activeId);
        const heard = interruptRef.current.trim();
        interruptRef.current = "";
        heardRef.current = heard === "" ? heardRef.current : heard === heardRef.current ? heard : `${heard} ${heardRef.current}`.trim();
        partialRef.current = "";
        setVoiceNotice("（打断了，接着说）");
        moveVoice("listening");
      },
    });
    setVoiceMode(true);
    moveVoice("listening");
    listenRef.current();
  }, []);

  const hangUp = useCallback(() => {
    stopListening();
    answerToken.current += 1;
    speakingToken.current += 1;
    currentTTS().cancel();
    capture.current?.stop();
    capture.current = null;
    turnRef.current = null;
    bargeRef.current = null;
    setVoicePartial("");
    setVoiceMode(false);
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
   * Speaking the answer, sentence by sentence as it streams.
   *
   * Waiting for the whole answer is the single biggest latency in a call — the model keeps writing
   * while the first sentence is already in the user's ear. Each sentence is spoken in order; when the
   * turn ends, whatever is left (an answer that never ended with punctuation) is spoken too, and then
   * the call goes back to plain listening.
   */
  useEffect(() => {
    if (!voiceMode) return;
    if (voiceState === "thinking" && running) return;
    const answer = lastAssistant?.role === "assistant" ? speechText(lastAssistant.text.trim()) : "";
    if (answer === "" && voiceState === "thinking") {
      moveVoice("listening");
      return;
    }
    if (answer === "") return;

    if (voiceState === "thinking") {
      spokenUpTo.current = 0;
      speakingToken.current += 1;
      moveVoice("speaking");
      bargeRef.current?.start(performance.now());
    }
    if (voiceStateRef.current !== "speaking") return;

    const token = speakingToken.current;
    const sentences = splitSentences(answer);
    const finished = !running;
    /** While the model is still writing, the last piece is a half sentence — do not speak it yet. */
    const speakable = finished ? sentences : sentences.slice(0, Math.max(0, sentences.length - 1));
    const next = speakable.slice(spokenUpTo.current);
    if (next.length === 0) {
      if (!finished) return;
      // Nothing left to say: the turn is over, hand the microphone back explicitly.
      capture.current?.takeWav();
      moveVoice("listening");
      speakEndedAt.current = performance.now();
      return;
    }
    spokenUpTo.current = speakable.length;
    const text = next.join(" ");
    currentTTS().speak(text, {
      voiceId: currentVoiceId(),
      onEnd: () => {
        if (!voiceModeRef.current || speakingToken.current !== token) return;
        /** If that was the last piece of a finished answer, the turn is over. */
        if (!runningRef.current && spokenUpTo.current >= splitSentences(answer).length) {
          capture.current?.takeWav();
          moveVoice("listening");
          speakEndedAt.current = performance.now();
        }
      },
    });
  }, [lastAssistant, running, voiceMode, voiceState]);

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

  const summaries: SessionSummary[] = store.sessions.map((entry) => ({
    id: entry.id,
    title: entry.title,
    meta: `${entry.messages.filter((message) => message.role !== "notice").length} 条 · ${timeAgo(entry.createdAt)}`,
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
          running={running}
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
        busy={running}
        mode={mode}
        onModeChange={setMode}
        /*
          Configured main models are part of the same list now — they run on the user's own endpoint,
          so they are choices, not promises. The menu still offers *only* main models (语音/生图 stay
          in settings), which is the rule the user asked for.
        */
        models={[...models, ...configuredMainModels]}
        modelId={modelId}
        onModelSelect={chooseModel}
        attachments={attachments}
        onAttach={(mention) =>
                  setAttachments((current) =>
                    current.some((entry) => entry.name === mention.name) ? current : [...current, mention],
                  )
                }
        onDetach={(name) => setAttachments((current) => current.filter((entry) => entry.name !== name))}
        plugins={plugins}
        pluginRoot={workspaces}
        listening={voiceMode}
        voiceSupported={voiceSupported}
        onToggleVoice={() => (voiceMode ? hangUp() : void startCall())}
        voiceMode={voiceMode}
        voiceState={voiceState}
        voiceLevel={() => level.current}
        voicePartial={voicePartial}
        voiceNotice={voiceNotice}
        onEndVoice={hangUp}
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
  }, [openProjectId, mainView]);
  useEffect(() => {
    // 启动条件与「模型回合」解耦（P0 最后一公里）：异步 start_render 的完成事件在回合结束后
    // 才被 worker 推进来，那时 running 早就 false 了——按 running 门控轮询，事件永远没人取。
    if (openProjectId === undefined) return;
    let cancelled = false;
    const take = async () => {
      try {
        const answer = (await fetch(`/api/agent/media-events?since=${mediaCursor.current}`).then((response) => response.json())) as {
          events?: Array<{ id: number; at?: number; server: string; tool: string; ok: boolean; text: string; args?: Record<string, unknown> }>;
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
    const timer = window.setInterval(() => void take(), running ? 2500 : 8000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [running, openProjectId]);

  const absorbToolResult = useCallback(
    (call: ToolCall) => {

      if (call.status !== "ok" || openProjectId === undefined) return;
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
                return project.tracks.map((track, index) =>
                  index === 0
                    ? { ...track, clips: [...track.clips, clipFromNotes(notes, project.bars, 0, parsed.midi_path ?? "")] }
                    : track,
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
  const viewShowsDock = mainView === "workbench" || mainView === "studio" || mainView === "dj";
  const chatInDock = dockOpen && viewShowsDock;
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
          current.map((project) =>
            project.id !== openProjectId
              ? project
              : {
                  ...project,
                  updatedAt: Date.now(),
                  tracks: project.tracks.map((track, index) =>
                    index === 0
                      ? { ...track, clips: [...track.clips, clipFromNotes(notes, project.bars, 0, parsed.midi_path ?? "")] }
                      : track,
                  ),
                },
          ),
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
          onSelectWorkspace={(next) => {
            // The work pages keep the conversation beside them; the conversation page is the
            // conversation, so the dock folds away there.
            setMainView(
              next === "studio"
                ? "studio"
                : next === "dj"
                  ? "dj"
                  : next === "settings"
                    ? "settings"
                    : "workbench",
            );
            setDockOpen(true);
          }}
          onShowPlugins={() => {
            setMainView("plugins");
            setDockOpen(true);
          }}
          sessions={summaries}
          activeSessionId={store.activeId}
          onSelectSession={(id) => {
            setStore((current) => ({ ...current, activeId: id }));
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
              setOpenProjectId(id);
              rememberOpenProject(id);
              setMainView("studio");
            }}
            onOpenSession={(id) => {
              setStore((current) => ({ ...current, activeId: id }));
              setMainView("conversation");
              setDockOpen(false);
            }}
            onOpenPlugins={() => setMainView("plugins")}
            onCreateProject={() => {
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
            <DjPage />
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
            running={running}
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
            title={viewShowsDock ? (running ? "对话 · 正在运行" : "展开对话") : "去对话"}
            aria-label={viewShowsDock ? "展开对话" : "去对话"}
            data-busy={running || voiceMode || undefined}
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
          chat={conversationPane({ variant: "dock", composer: composerFor("和智能体说点什么…") })}
          onClose={() => setDockOpen(false)}
        />
      }
      />
      {/*
        管家球：常驻整个 app（不属于任何页面）。给它 draft/onDraftChange/onSubmit 这三个 prop，
        球里那行输入就和右侧对话栏走的是**同一条会话**；running 让它在智能体干活时显示进度刻度。
      */}
      <ButlerOrb
        draft={draft}
        onDraftChange={setDraft}
        onSubmit={() => void submit()}
        running={running}
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

/**
 * What the call reads out loud: the answer without the parts that only make sense on screen —
 * fenced code, backticks, markdown emphasis, links and list bullets. Spelling "star star four bars
 * star star" out loud is worse than saying nothing.
 * @param text - the assistant's answer as it appears in the transcript.
 * @returns the same answer, spoken-shaped.
 */
function speechText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "（代码略）")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "链接")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|\s)[*_]([^*_]+)[*_]/g, "$1$2")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

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
