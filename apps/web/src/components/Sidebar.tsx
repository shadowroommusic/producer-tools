/**
 * Sidebar column: brand row, New Session, the workspace list, the plugin list, the session browser
 * and the foot. Geometry follows DeepSeek Harness's ui-sidebar (60px logo row, 38px/r12 New Session
 * bar, 36px rows, 56px rail) with our own marks and copy; the plugins are the ShadowRoom MCP servers.
 */
import { useEffect, useRef, useState } from "react";
import { BrandMark } from "./BrandMark";
import {
  IconDj,
  IconLibrary,
  IconNewSession,
  IconPanelLeft,
  IconPlugin,
  IconSettings,
  IconStudio,
  IconWorkbench,
} from "./icons";

export type WorkspaceId = "workbench" | "library" | "studio" | "dj" | "settings";

export type PluginEntry = {
  id: string;
  label: string;
  repo: string;
  connected: boolean;
  tools: { name: string; description?: string }[];
};

export type SessionSummary = {
  id: string;
  title: string;
  meta: string;
  state: "running" | "done" | "draft";
};

const WORKSPACES: Array<{ id: WorkspaceId; label: string; icon: typeof IconWorkbench; ready: boolean }> = [
  { id: "workbench", label: "工作台", icon: IconWorkbench, ready: true },
  { id: "library", label: "曲目库", icon: IconLibrary, ready: false },
  { id: "studio", label: "Studio", icon: IconStudio, ready: false },
  { id: "dj", label: "DJ", icon: IconDj, ready: false },
  { id: "settings", label: "设置", icon: IconSettings, ready: false },
];

/** Scrollbars are a pointer affordance: a column nobody points at carries none. */
function usePointerLinger(ref: React.RefObject<HTMLElement | null>) {
  const [inside, setInside] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!inside) return;
    const onMove = (event: PointerEvent): void => {
      const rect = ref.current?.getBoundingClientRect();
      if (rect === undefined) return;
      const within =
        event.clientX >= rect.left &&
        event.clientX < rect.right &&
        event.clientY >= rect.top &&
        event.clientY < rect.bottom;
      window.clearTimeout(timer.current);
      if (!within) timer.current = window.setTimeout(() => setInside(false), 1200);
    };
    document.addEventListener("pointermove", onMove);
    return () => {
      document.removeEventListener("pointermove", onMove);
      window.clearTimeout(timer.current);
    };
  }, [inside, ref]);
  return [inside, setInside] as const;
}

export function Sidebar({
  collapsed,
  toggleSidebar,
  plugins,
  activeWorkspace,
  showPlugins,
  onSelectWorkspace,
  onShowPlugins,
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
}: {
  collapsed: boolean;
  toggleSidebar: () => void;
  plugins: PluginEntry[];
  activeWorkspace: WorkspaceId;
  showPlugins: boolean;
  onSelectWorkspace: (workspace: WorkspaceId) => void;
  onShowPlugins: () => void;
  sessions: SessionSummary[];
  activeSessionId?: string;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [pointerInside, setPointerInside] = usePointerLinger(root);

  return (
    <div
      ref={root}
      className="sr-sidebar"
      data-collapsed={collapsed || undefined}
      data-quiet={!pointerInside || undefined}
      onPointerEnter={() => setPointerInside(true)}
      onPointerLeave={() => setPointerInside(false)}
    >
      <div className="sr-sidebar-logorow">
        {!collapsed && (
          <button type="button" className="sr-brand" onClick={onNewSession} title="新建会话">
            <span className="sr-brand-mark">
              <BrandMark height={26} strokeWidth={5} />
            </span>
            <span className="sr-brand-name">
              Shadow<span className="sr-brand-accent">Room</span> Producers
            </span>
          </button>
        )}
        <button
          type="button"
          className="sr-icon-btn sr-sidebar-toggle"
          aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
          title={collapsed ? "展开侧栏" : "收起侧栏"}
          onClick={toggleSidebar}
        >
          {collapsed ? (
            <span className="sr-sidebar-railmark">
              <BrandMark height={22} strokeWidth={5} />
            </span>
          ) : null}
          <IconPanelLeft className="sr-sidebar-toggle-icon" size={collapsed ? 18 : 16} />
        </button>
      </div>

      <button type="button" className="sr-new-session" onClick={onNewSession} aria-label="新建会话">
        <IconNewSession size={collapsed ? 18 : 14} />
        {!collapsed && <span className="sr-new-session-label">新建会话</span>}
      </button>

      <nav className="sr-panel-list" aria-label="工作区">
        {WORKSPACES.map((entry) => {
          const Icon = entry.icon;
          const active = entry.id === activeWorkspace;
          return (
            <button
              key={entry.id}
              type="button"
              className="sr-panel-row"
              data-active={active || undefined}
              aria-current={active ? "page" : undefined}
              aria-disabled={entry.ready ? undefined : true}
              title={collapsed ? entry.label : entry.ready ? undefined : "即将开放"}
              onClick={() => onSelectWorkspace(entry.id)}
            >
              <span className="sr-panel-glyph">
                <Icon size={collapsed ? 18 : 16} />
              </span>
              {!collapsed && (
                <>
                  <span className="sr-panel-title">{entry.label}</span>
                  {!entry.ready && <span className="sr-panel-soon sr-mono">即将</span>}
                </>
              )}
            </button>
          );
        })}
      </nav>

      {/* Plugins are a page, not a permanent list: one entry, the way Codex's sidebar has it. */}
      <nav className="sr-panel-list" aria-label="插件">
        <button
          type="button"
          className="sr-panel-row"
          data-active={showPlugins || undefined}
          aria-current={showPlugins ? "page" : undefined}
          title={collapsed ? "插件" : undefined}
          onClick={onShowPlugins}
        >
          <span className="sr-panel-glyph">
            <IconPlugin size={collapsed ? 18 : 16} />
          </span>
          {!collapsed && (
            <>
              <span className="sr-panel-title">插件</span>
              <span className="sr-panel-soon sr-mono">
                {plugins.filter((plugin) => plugin.connected).length}/{plugins.length}
              </span>
            </>
          )}
        </button>
      </nav>

      <div className="sr-sidebar-region">
        {!collapsed && <p className="sr-region-title sr-mono">对话</p>}
        <div className="sr-region-scroll sr-scroll">
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className="sr-session-row"
              data-active={session.id === activeSessionId || undefined}
              title={session.title}
              onClick={() => onSelectSession(session.id)}
            >
              <span className="sr-session-dot" data-state={session.state} />
              {!collapsed && (
                <span className="sr-session-body">
                  <span className="sr-session-title">{session.title}</span>
                  <span className="sr-session-meta sr-mono">{session.meta}</span>
                </span>
              )}
            </button>
          ))}
          {!collapsed && sessions.length === 0 && <p className="sr-region-empty">还没有会话</p>}
        </div>
      </div>

      <div className="sr-sidebar-foot">
        <div className="sr-foot-row" title="ShadowRoom Music">
          <span className="sr-brand-mark sr-foot-mark">
            <BrandMark height={18} strokeWidth={6} />
          </span>
          {!collapsed && <span className="sr-foot-label">ShadowRoom Music</span>}
        </div>
        {!collapsed && <div className="sr-foot-version sr-mono">AGPL-3.0 · v0.0.0</div>}
      </div>
    </div>
  );
}
