/**
 * Right dock: one plugin pane at a time, with a 38px header (label, repo, state, expand).
 * The plugins themselves live in the sidebar — this column only shows the selected one, the same
 * way DeepSeek Harness's right column hosts a single registered panel.
 */
import { useState } from "react";
import type { ReactNode } from "react";
import { AnalysisPanel } from "./AnalysisPanel";
import { ConverterPanel } from "./ConverterPanel";
import { GeneratorPanel } from "./GeneratorPanel";
import { IconCollapse, IconExpand } from "./icons";
import { SetPlannerPanel } from "./SetPlannerPanel";
import type { PluginEntry } from "./Sidebar";
import type { ToolCall } from "./ToolCallRow";

/** Copy for the plugins that are published but not wired into the UI yet. */
const PLACEHOLDER: Record<string, { body: string; bullets: string[] }> = {
};

export function DockPanel({
  plugin,
  home,
  tab,
  onTabChange,
  chat,
  onClose,
  onCallBegin,
  onCallEnd,
}: {
  plugin: PluginEntry;
  home: string;
  tab: "chat" | "plugin";
  onTabChange: (tab: "chat" | "plugin") => void;
  /** The conversation, shown in the dock's 对话 tab. */
  chat: ReactNode;
  onClose: () => void;
  onCallBegin: (call: ToolCall) => void;
  onCallEnd: (id: string, patch: Partial<ToolCall>) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const placeholder = PLACEHOLDER[plugin.repo];

  return (
    <section className="sr-dock" data-expanded={expanded || undefined} aria-label={plugin.label}>
      <header className="sr-dock-head">
        <div className="sr-dock-tabs" role="tablist" aria-label="侧边栏">
          <button
            type="button"
            role="tab"
            className="sr-dock-tab"
            aria-selected={tab === "chat"}
            data-on={tab === "chat" || undefined}
            onClick={() => onTabChange("chat")}
          >
            对话
          </button>
          <button
            type="button"
            role="tab"
            className="sr-dock-tab"
            aria-selected={tab === "plugin"}
            data-on={tab === "plugin" || undefined}
            onClick={() => onTabChange("plugin")}
          >
            {plugin.label}
          </button>
        </div>
        <div className="sr-dock-actions">
          {tab === "plugin" && <span className="sr-dot" data-state={plugin.connected ? "live" : "idle"} />}
          <button
            type="button"
            className="sr-icon-btn"
            aria-label={expanded ? "退出全屏" : "全屏显示面板"}
            title={expanded ? "退出全屏" : "全屏显示面板"}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? <IconCollapse size={16} /> : <IconExpand size={16} />}
          </button>
          <button
            type="button"
            className="sr-icon-btn"
            aria-label="收起面板"
            title="收起面板"
            onClick={onClose}
          >
            <IconDockClose />
          </button>
        </div>
      </header>

      <div className="sr-dock-body sr-scroll">
        {tab === "chat" ? (
          <div className="sr-dock-chat">{chat}</div>
        ) : plugin.repo === "rekordbox-serato-bridge" ? (
          <ConverterPanel
            connected={plugin.connected}
            tools={plugin.tools}
            home={home}
            onBegin={onCallBegin}
            onEnd={onCallEnd}
          />
        ) : plugin.repo === "set-planner" ? (
          <SetPlannerPanel
            connected={plugin.connected}
            tools={plugin.tools}
            onBegin={onCallBegin}
            onEnd={onCallEnd}
          />
        ) : plugin.repo === "audio-analysis-dedupe" ? (
          <AnalysisPanel
            connected={plugin.connected}
            tools={plugin.tools}
            onBegin={onCallBegin}
            onEnd={onCallEnd}
          />
        ) : plugin.repo === "shadow-music-generator" ? (
          <GeneratorPanel
            connected={plugin.connected}
            tools={plugin.tools}
            onBegin={onCallBegin}
            onEnd={onCallEnd}
          />
        ) : (
          <div className="sr-plugin-pane">
            <p className="sr-plugin-hint">{placeholder?.body ?? "这个插件还没有面板。"}</p>
            <ul className="sr-plugin-bullets">
              {(placeholder?.bullets ?? []).map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
            <p className="sr-plugin-hint sr-plugin-hint--dim">
              面板会在逐个接通后补上；插件本身已经作为独立 MCP 服务器发布。
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function IconDockClose() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
