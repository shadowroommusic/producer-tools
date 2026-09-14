/**
 * Right dock: one plugin pane at a time, with a 38px header (label, repo, state, expand).
 * The plugins themselves live in the sidebar — this column only shows the selected one, the same
 * way DeepSeek Harness's right column hosts a single registered panel.
 */
import { useState } from "react";
import { IconCollapse, IconExpand } from "./icons";
import { SetPlannerPanel } from "./SetPlannerPanel";
import type { PluginEntry } from "./Sidebar";
import type { ToolCall } from "./ToolCallRow";

/** Copy for the plugins that are published but not wired into the UI yet. */
const PLACEHOLDER: Record<string, { body: string; bullets: string[] }> = {
  "rekordbox-serato-bridge": {
    body: "把 Rekordbox 的播放列表、cue / loop / 颜色转换到 Serato。",
    bullets: ["预览报告（dry-run）", "逐曲目对照", "颜色与 loop 映射"],
  },
  "audio-analysis-dedupe": {
    body: "扫描资料库，分析音频并找出重复曲目。",
    bullets: ["BPM / 调性 / 响度", "重复分组", "保留 / 复查标记"],
  },
  "shadow-music-generator": {
    body: "生成任务队列：提示词、歌词、参数和许可证备注。",
    bullets: ["任务队列与阶段", "产物与版本", "许可证记录"],
  },
};

export function DockPanel({
  plugin,
  onClose,
  onCallBegin,
  onCallEnd,
}: {
  plugin: PluginEntry;
  onClose: () => void;
  onCallBegin: (call: ToolCall) => void;
  onCallEnd: (id: string, patch: Partial<ToolCall>) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const placeholder = PLACEHOLDER[plugin.repo];

  return (
    <section className="sr-dock" data-expanded={expanded || undefined} aria-label={plugin.label}>
      <header className="sr-dock-head">
        <div className="sr-dock-title">
          <span className="sr-dock-label">{plugin.label}</span>
          <span className="sr-dock-repo sr-mono">{plugin.repo}</span>
        </div>
        <div className="sr-dock-actions">
          <span className="sr-dot" data-state={plugin.connected ? "live" : "idle"} />
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
        {plugin.repo === "set-planner" ? (
          <SetPlannerPanel
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
