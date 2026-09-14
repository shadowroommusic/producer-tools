/**
 * Shadow Producers — app shell.
 *
 * Composition only: the frame owns the columns, the sidebar owns navigation and the plugins, the
 * conversation owns the transcript and the composer, the dock owns the selected plugin's panel.
 * Everything the agent core will drive lives behind one `session` shape so wiring Codex later does
 * not move the UI around.
 */
import { useCallback, useEffect, useState } from "react";
import { Composer } from "./components/Composer";
import { Conversation, type Message } from "./components/Conversation";
import { DockPanel } from "./components/DockPanel";
import { Sidebar, type PluginEntry, type SessionSummary, type WorkspaceId } from "./components/Sidebar";
import type { ToolCall } from "./components/ToolCallRow";
import { fetchServers, type ServerInfo } from "./lib/mcp";
import { AppFrame } from "./shell/AppFrame";

/** The four ShadowRoom MCP servers, keyed by the ids the bridge reports. */
const PLUGINS: Array<{ id: string; server: string; label: string; repo: string }> = [
  { id: "bridge", server: "converter", label: "Rekordbox ⇄ Serato", repo: "rekordbox-serato-bridge" },
  { id: "analysis", server: "analysis", label: "音频分析去重", repo: "audio-analysis-dedupe" },
  { id: "planner", server: "planner", label: "Set 编排", repo: "set-planner" },
  { id: "generator", server: "generator", label: "音乐生成队列", repo: "shadow-music-generator" },
];

const SEED_SESSIONS: SessionSummary[] = [
  { id: "s1", title: "Rooftop 909 串场", meta: "128 BPM · 昨天", state: "done" },
  { id: "s2", title: "周五 set 排 60 分钟", meta: "124 BPM · 2 天前", state: "done" },
];

type Bridge = "connecting" | "online" | "offline";

export function App() {
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [bridge, setBridge] = useState<Bridge>("connecting");
  const [workspace, setWorkspace] = useState<WorkspaceId>("workbench");
  const [activePlugin, setActivePlugin] = useState("set-planner");
  const [dockOpen, setDockOpen] = useState(true);
  const [view, setView] = useState<"chat" | "trajectory">("chat");
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState("标准");
  const [sessions, setSessions] = useState<SessionSummary[]>(SEED_SESSIONS);
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<Message[]>([]);
  const [calls] = useState<ToolCall[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchServers()
      .then((list) => {
        if (cancelled) return;
        setServers(list);
        setBridge("online");
      })
      .catch(() => {
        if (!cancelled) setBridge("offline");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const plugins: PluginEntry[] = PLUGINS.map((entry) => ({
    id: entry.id,
    label: entry.label,
    repo: entry.repo,
    connected: servers.some((server) => server.id === entry.server && server.connected),
  }));
  const selected = plugins.find((plugin) => plugin.repo === activePlugin) ?? plugins[2];
  const active = plugins.find((plugin) => plugin.repo === activePlugin);

  const submit = useCallback(() => {
    const text = draft.trim();
    if (text.length === 0) return;
    setMessages((current) => [
      ...current,
      { id: `u${current.length}`, role: "user", text },
      {
        id: `a${current.length}`,
        role: "assistant",
        text:
          "收到了。现在还没有接上智能体内核（下一步是 Codex app-server），所以这条需求先记在会话里。" +
          "内核接上之后，同一个输入框就会真的拆解任务、调用左侧的插件。",
      },
    ]);
    const title = text.length > 16 ? `${text.slice(0, 16)}…` : text;
    const id = `s${Date.now()}`;
    setSessions((current) => [{ id, title, meta: "刚刚", state: "draft" }, ...current]);
    setActiveSessionId(id);
    setDraft("");
  }, [draft]);

  const startSession = useCallback(() => {
    setMessages([]);
    setActiveSessionId(undefined);
    setView("chat");
  }, []);

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
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelectSession={(id) => {
            setActiveSessionId(id);
            setMessages((current) => (current.length === 0 ? current : current));
          }}
          onNewSession={startSession}
        />
      )}
      main={
        <Conversation
          crumb={workspaceLabel(workspace)}
          title={activeSessionId === undefined ? "新会话" : "会话"}
          view={view}
          onViewChange={setView}
          messages={messages}
          calls={calls}
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
              variant={messages.length === 0 ? "hero" : "docked"}
              value={draft}
              onChange={setDraft}
              onSubmit={submit}
              busy={false}
              mode={mode}
              onModeChange={setMode}
              plugin={active}
            />
          }
        />
      }
      dock={
        selected === undefined ? null : (
          <DockPanel plugin={selected} onClose={() => setDockOpen(false)} />
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
