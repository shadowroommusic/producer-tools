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
import { useCallback, useEffect, useState } from "react";
import { Composer } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { DockPanel } from "./components/DockPanel";
import { Sidebar, type PluginEntry, type SessionSummary, type WorkspaceId } from "./components/Sidebar";
import type { ToolCall } from "./components/ToolCallRow";
import { fetchBridge, type ServerInfo } from "./lib/mcp";
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

const NOTICE: { title: string; text: string } = {
  title: "内核未接入",
  text: "这条需求先记在会话里；接上 Codex app-server 之后，同一个输入框就会真的拆解任务、调用左侧的插件。",
};

type Bridge = "connecting" | "online" | "offline";

export function App() {
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [home, setHome] = useState("");
  const [bridge, setBridge] = useState<Bridge>("connecting");
  const [workspace, setWorkspace] = useState<WorkspaceId>("workbench");
  const [activePlugin, setActivePlugin] = useState("set-planner");
  const [dockOpen, setDockOpen] = useState(true);
  const [view, setView] = useState<"chat" | "trajectory">("chat");
  const [store, setStore] = useState<SessionStore>(() => loadSessions());
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState("标准");

  const session = store.sessions.find((entry) => entry.id === store.activeId);

  useEffect(() => {
    saveSessions(store);
  }, [store]);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchBridge()
        .then((info) => {
          if (cancelled) return;
          setServers(info.servers);
          setHome(info.home);
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
    setView("chat");
  }, []);

  const submit = useCallback(() => {
    const text = draft.trim();
    if (text === "") return;
    setDraft("");
    const at = Date.now();
    withActiveSession((current) => {
      const message: ChatMessage = { id: `u-${at}`, role: "user", text, at };
      const notice: ChatMessage = { id: `n-${at}`, role: "notice", ...NOTICE, at };
      return {
        ...current,
        title: current.messages.length === 0 ? titleFrom(text) : current.title,
        messages: [...current.messages, message, notice],
      };
    });
  }, [draft, withActiveSession]);

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

  return (
    <AppFrame
      dockCollapsed={!dockOpen}
      sidebar={({ collapsed, toggleSidebar }) => (
        <Sidebar
          collapsed={collapsed}
          toggleSidebar={toggleSidebar}
          plugins={plugins}
          activeWorkspace={workspace}
          activePlugin={active?.repo}
          onSelectWorkspace={setWorkspace}
          onSelectPlugin={(repo) => {
            setActivePlugin(repo);
            setDockOpen(true);
          }}
          sessions={summaries}
          activeSessionId={store.activeId}
          onSelectSession={(id) => {
            setStore((current) => ({ ...current, activeId: id }));
            setView("chat");
          }}
          onNewSession={startSession}
        />
      )}
      main={
        <Conversation
          crumb={workspaceLabel(workspace)}
          title={session === undefined || session.messages.length === 0 ? "新会话" : session.title}
          view={view}
          onViewChange={setView}
          messages={session?.messages ?? []}
          calls={session?.calls ?? []}
          suggestions={SUGGESTIONS}
          onSuggestion={(text) => {
            setDraft(text);
            setView("chat");
          }}
          dockCollapsed={!dockOpen}
          onToggleDock={() => setDockOpen((open) => !open)}
          status={
            <span className="sr-chip sr-chip--status" data-state={bridge}>
              <span className="sr-dot" data-state={bridge === "online" ? "live" : "idle"} />
              <span className="sr-chip-label">
                {bridge === "online" ? "插件已连接" : bridge === "connecting" ? "连接中" : "内核未接入"}
              </span>
            </span>
          }
          composer={
            <Composer
              variant={session === undefined || session.messages.length === 0 ? "hero" : "docked"}
              value={draft}
              onChange={setDraft}
              onSubmit={submit}
              busy={false}
              mode={mode}
              onModeChange={setMode}
              plugin={active}
              onPluginClick={() => setDockOpen(true)}
            />
          }
        />
      }
      dock={
        selected === undefined ? null : (
          <DockPanel
            plugin={selected}
            home={home}
            onClose={() => setDockOpen(false)}
            onCallBegin={beginCall}
            onCallEnd={endCall}
          />
        )
      }
    />
  );
}

function workspaceLabel(workspace: WorkspaceId): string {
  switch (workspace) {
    case "library":
      return "曲目库";
    case "studio":
      return "Studio";
    case "dj":
      return "DJ";
    case "settings":
      return "设置";
    default:
      return "工作台";
  }
}

/** Quick starts for the empty session — they only fill the composer, nothing runs yet. */
const SUGGESTIONS = [
  "给这 12 首 tech house 排一套 60 分钟的 set",
  "把 Rekordbox 的 cue 和颜色转到 Serato",
  "找出资料库里重复的曲目",
];
