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
import { useCallback, useEffect, useRef, useState } from "react";
import { Composer } from "./components/Composer";
import { ApprovalCard, type PendingApproval } from "./components/ApprovalCard";
import { Conversation } from "./components/Conversation";
import { DockPanel } from "./components/DockPanel";
import { IconChat } from "./components/icons";
import { WorkbenchHome } from "./components/WorkbenchHome";
import { PluginPanelPage } from "./components/PluginPanelPage";
import { PluginsPage } from "./components/PluginsPage";
import { StudioPage } from "./components/StudioPage";
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
    "workbench" | "conversation" | "plugins" | "plugin" | "studio"
  >(
    () =>
      (window.localStorage.getItem("shadowroom.view") as
        | "workbench"
        | "conversation"
        | "plugins"
        | "plugin"
        | "studio"
        | null) ?? "workbench",
  );
  const [projects, setProjects] = useState<StudioProject[]>(() => loadProjects());
  const [openProjectId, setOpenProjectId] = useState<string | undefined>(undefined);
  /** Undo/redo for the open Studio project (drag gestures push one snapshot, not one per frame). */
  const [history, setHistory] = useState<{ past: StudioProject[]; future: StudioProject[] }>({
    past: [],
    future: [],
  });
  const [voiceMode, setVoiceMode] = useState(false);
  const [voiceState, setVoiceState] = useState<"listening" | "thinking" | "speaking">("listening");
  const voiceSession = useRef<VoiceSession | null>(null);
  const capture = useRef<VoiceCapture | null>(null);
  const level = useRef(0);
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

    void sendTurn(
      sessionId,
      text,
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
    [agent, attachments, draft, modelId, patchSession, running, store.activeId, store.sessions],
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
  const absorbToolResult = useCallback(
    (call: ToolCall) => {
      if (call.status !== "ok" || openProjectId === undefined) return;
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
          parts?: Array<{ part?: string; path?: string; duration_ms?: number }>;
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
              return next;
            })();
            return { ...project, bpm, tracks, updatedAt: Date.now() };
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
  /** Remember the project as it is right now — the point a drag or an edit can return to. */
  const beginEdit = useCallback(() => {
    setProjects((current) => {
      const project = current.find((entry) => entry.id === openProjectId);
      if (project !== undefined) {
        setHistory((previous) => ({ past: [...previous.past.slice(-49), project], future: [] }));
      }
      return current;
    });
  }, [openProjectId]);

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

  const undo = useCallback(() => {
    setHistory((previous) => {
      const previousProject = previous.past.at(-1);
      if (previousProject === undefined) return previous;
      setProjects((current) =>
        current.map((project) =>
          project.id === previousProject.id
            ? { ...previousProject, updatedAt: Date.now() }
            : project,
        ),
      );
      const currentProject = projects.find((project) => project.id === previousProject.id);
      return {
        past: previous.past.slice(0, -1),
        future: currentProject === undefined ? previous.future : [currentProject, ...previous.future].slice(0, 50),
      };
    });
  }, [projects]);

  const redo = useCallback(() => {
    setHistory((previous) => {
      const nextProject = previous.future[0];
      if (nextProject === undefined) return previous;
      setProjects((current) =>
        current.map((project) => (project.id === nextProject.id ? { ...nextProject, updatedAt: Date.now() } : project)),
      );
      const currentProject = projects.find((project) => project.id === nextProject.id);
      return {
        past: currentProject === undefined ? previous.past : [...previous.past.slice(-49), currentProject],
        future: previous.future.slice(1),
      };
    });
  }, [projects]);

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
            setMainView(next === "studio" ? "studio" : "workbench");
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

/** Part names the synth uses, in the workbench's language. */
const PART_LABEL: Record<string, string> = {
  drums: "鼓",
  bass: "贝斯",
  chords: "和弦",
  lead: "主音",
  pad: "铺底",
};
