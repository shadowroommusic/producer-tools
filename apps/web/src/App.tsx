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
import { Composer } from "./components/Composer";
import { ApprovalCard, type PendingApproval } from "./components/ApprovalCard";
import { Conversation } from "./components/Conversation";
import { DockPanel } from "./components/DockPanel";
import { IconChat } from "./components/icons";
import { WorkbenchHome } from "./components/WorkbenchHome";
import { PluginPanelPage } from "./components/PluginPanelPage";
import { PluginsPage } from "./components/PluginsPage";
import { StudioPage } from "./components/StudioPage";
import { SettingsPage } from "./components/SettingsPage";
import { loadModelSettings, mainModelChoices, saveModelSettings, type ModelSettings } from "./lib/providers";
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
  type StudioProject,
} from "./lib/studio";
import {
  createBargeIn,
  createTurnDetector,
  saveRecording,
  speak,
  startCapture,
  startListening,
  stopSpeaking,
  voiceInputSupported,
  type BargeIn,
  type TurnDetector,
  type VoiceCapture,
  type VoiceSession,
} from "./lib/voice";
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
  { id: "splitter", server: "splitter", label: "人声分轨", repo: "stem-splitter" },
  { id: "grabber", server: "grabber", label: "音乐抓取转码", repo: "ShadowMusicGrabber" },
];

type Bridge = "connecting" | "online" | "offline";

export function App() {
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [home, setHome] = useState("");
  const [workspaces, setWorkspaces] = useState("");
  const [bridge, setBridge] = useState<Bridge>("connecting");
  const [workspace, setWorkspace] = useState<WorkspaceId>(
    () => (window.localStorage.getItem("shadowroom.workspace") as WorkspaceId | null) ?? "workbench",
  );
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
    "workbench" | "conversation" | "plugins" | "plugin" | "studio" | "settings"
  >(
    () =>
      (window.localStorage.getItem("shadowroom.view") as
        | "workbench"
        | "conversation"
        | "plugins"
        | "plugin"
        | "studio"
        | "settings"
        | null) ?? "workbench",
  );
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
  const voiceSession = useRef<VoiceSession | null>(null);
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
   * 主模型 configured in Settings that this build cannot run yet.
   *
   * The chat's switch may only ever offer main models (语音/生图 live in settings), so a configured
   * one belongs in that list — switched off, with a reason, until the harness can route to it.
   */
  const [modelSettings, setModelSettings] = useState<ModelSettings>(() => loadModelSettings());
  useEffect(() => {
    saveModelSettings(modelSettings);
  }, [modelSettings]);
  const configuredMainModels = useMemo<AgentModel[]>(
    () =>
      mainModelChoices(modelSettings).map(({ provider, slot }) => ({
        id: `custom:${slot.id}`,
        displayName: `${provider.label} · ${slot.model}`,
        description: "设置里配好的主模型（等 harness 接入后生效）",
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

  useEffect(() => {
    saveProjects(projects);
  }, [projects]);

  // Come back to the same page after a reload.
  useEffect(() => {
    window.localStorage.setItem("shadowroom.view", mainView);
    window.localStorage.setItem("shadowroom.workspace", workspace);
    window.localStorage.setItem("shadowroom.dock", dockOpen ? "open" : "closed");
  }, [dockOpen, mainView, workspace]);

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
    (override?: string, options: { mentions?: Mention[] } = {}) => {
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
    const arrangementContext =
      openProject === undefined || (openProject.sections?.length ?? 0) === 0
        ? []
        : [
            "",
            "[structure_context]",
            `revision: ${structureRevision(openProject)}`,
            `bars: ${openProject.bars}`,
            `sections: ${JSON.stringify((openProject.sections ?? []).map((section) => ({ id: section.id, name: section.name, start: section.start, bars: section.bars })))}`,
            `tracks: ${JSON.stringify(openProject.tracks.map((track) => ({ name: track.name, clips: track.clips.map((clip) => ({ id: clip.id, start: clip.start, length: clip.length })) })))}`,
            "[/structure_context]",
            "（要改结构就调 shadow-music-generator 的 arrange：把上面的 bars/sections/tracks 原样传进去、operations 写操作、revision 回传；它会把每个片段的新位置算好，前端落盘。不要自己算位置。）",
          ];
    const outgoing =
      noteContext === null
        ? [text, ...arrangementContext].join("\n")
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
        model: modelId,
        mentions,
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
    [agent, attachments, draft, modelId, noteContext, patchSession, running, store.activeId, store.sessions],
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
  const voiceSupported = voiceInputSupported();
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
  const bargeRef = useRef<BargeIn | null>(null);
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
    voiceSession.current = startListening({
      onPartial: (text) => {
        if (!current()) return;
        partialRef.current = text;
        setVoicePartial(text);
      },
      onFinal: (text) => {
        if (text === "" || !current()) return;
        // A finished phrase is *not* the end of the turn: pausing mid-sentence must not cut the user
        // off, so the text accumulates and the endpointer decides when the turn is over.
        heardRef.current = heardRef.current === "" ? text : `${heardRef.current} ${text}`;
        partialRef.current = "";
        setVoicePartial("");
        setVoiceNotice(null);
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
    stopListening();
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
    turnRef.current = createTurnDetector({ onTurnEnd: () => finishRef.current() });
    bargeRef.current = createBargeIn({
      onSpeak: () => {
        if (voiceStateRef.current !== "speaking") return;
        // The user talked over the answer: stop it and listen from here.
        answerToken.current += 1;
        stopSpeaking();
        capture.current?.takeWav(); // the answer's tail is not part of the next request
        moveVoice("listening");
        listenRef.current();
      },
    });
    setVoiceMode(true);
    moveVoice("listening");
    listenRef.current();
  }, []);

  const hangUp = useCallback(() => {
    stopListening();
    answerToken.current += 1;
    stopSpeaking();
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

  // When the turn is done, speak the answer and go back to listening — the call never stops.
  useEffect(() => {
    if (!voiceMode || voiceState !== "thinking" || running) return;
    const answer = lastAssistant?.role === "assistant" ? lastAssistant.text.trim() : "";
    if (answer === "") {
      moveVoice("listening");
      listenRef.current();
      return;
    }
    const token = answerToken.current + 1;
    answerToken.current = token;
    moveVoice("speaking");
    bargeRef.current?.start(performance.now());
    speak(speechText(answer), () => {
      if (!voiceModeRef.current || answerToken.current !== token) return;
      capture.current?.takeWav(); // drop the audio captured while the answer played
      moveVoice("listening");
      listenRef.current();
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
        onSubmit={submit}
        onStop={stop}
        busy={running}
        mode={mode}
        onModeChange={setMode}
        models={models}
        otherMainModels={configuredMainModels}
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
        const wrapper = JSON.parse(call.detail ?? "{}") as { result?: { content?: Array<{ text?: string }> } };
        const parsed = JSON.parse(String(wrapper.result?.content?.[0]?.text)) as {
          clip_id?: string;
          path?: string;
          spec?: Record<string, unknown>;
          bpm?: number;
          bars?: number;
          diff_summary?: string;
        };
        if (parsed.clip_id === undefined || parsed.path === undefined) {
          throw new Error("结果里没有片段或文件");
        }
        let applied = false;
        updateProjectRef.current((project) => {
          const track = project.tracks.find((entry) => entry.clips.some((clip) => clip.id === parsed.clip_id));
          if (track === undefined) return project;
          applied = true;
          return {
            ...project,
            tracks: project.tracks.map((entry) =>
              entry.id === track.id
                ? {
                    ...entry,
                    clips: entry.clips.map((clip) =>
                      clip.id === parsed.clip_id
                        ? {
                            ...clip,
                            source: parsed.path as string,
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
        const wrapper = JSON.parse(call.detail ?? "{}") as { result?: { content?: Array<{ text?: string }> } };
        const parsed = JSON.parse(String(wrapper.result?.content?.[0]?.text)) as {
          clip_id?: string;
          revision?: string;
          notes?: StudioNote[];
          diff_summary?: string;
          affected_count?: number;
        };
        if (parsed.clip_id === undefined || parsed.notes === undefined) throw new Error("结果里没有片段或音符");
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
        const openTrack = openProject?.tracks.find((track) => track.clips.some((clip) => clip.id === parsed.clip_id));
        const openClip = openTrack?.clips.find((clip) => clip.id === parsed.clip_id);
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
          const track = project.tracks.find((entry) => entry.clips.some((clip) => clip.id === parsed.clip_id));
          const clip = track?.clips.find((entry) => entry.id === parsed.clip_id);
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
                      item.id === parsed.clip_id ? { ...item, notes: translated } : item,
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
              // A song longer than the project's grid widens the grid: the clips are the truth.
              bars:
                typeof parsed.bars === "number" && parsed.bars > 0
                  ? Math.max(project.bars, Math.ceil(parsed.bars))
                  : project.bars,
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
  const chatInDock = dockOpen;
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
            setWorkspace(next);
            // The work pages keep the conversation beside them; the conversation page is the
            // conversation, so the dock folds away there.
            setMainView(next === "studio" ? "studio" : next === "settings" ? "settings" : "workbench");
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
              setWorkspace("studio");
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
              setWorkspace("studio");
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
          ) : mainView === "studio" ? (
          openProject === undefined ? (
            <StudioProjects
              projects={[...projects].sort((a, b) => b.updatedAt - a.updatedAt).map(summarize)}
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
              composer={chatInDock ? null : composerFor()}
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
        <div className="sr-dock-rail">
          <button
            type="button"
            className="sr-dock-rail-btn"
            title={running ? "对话 · 正在运行" : "展开对话"}
            aria-label="展开对话"
            data-busy={running || voiceMode || undefined}
            onClick={() => setDockOpen(true)}
          >
            <IconChat size={18} />
          </button>
        </div>
      }
      dock={
        <DockPanel
          chat={
            <>
              <div className="sr-transcript sr-scroll">
                <Transcript
                  messages={session?.messages ?? []}
                  calls={session?.calls ?? []}
                  running={running}
                  quiet={mode === "极简"}
                />
              </div>
              <div className="sr-dock-composer">{composerFor("和智能体说点什么…")}</div>
            </>
          }
          onClose={() => setDockOpen(false)}
        />
      }
    />
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
const PART_LABEL: Record<string, string> = {
  drums: "鼓",
  bass: "贝斯",
  chords: "和弦",
  lead: "主音",
  pad: "铺底",
};
