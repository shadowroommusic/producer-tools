/**
 * A plugin's panel as a *page* in the centre column.
 *
 * It used to live in the right dock; moving it here keeps the dock a single-purpose chat column and
 * gives every panel the room its JSON editors and result tables want.
 */
import { AnalysisPanel } from "./AnalysisPanel";
import { ConverterPanel } from "./ConverterPanel";
import { GeneratorPanel } from "./GeneratorPanel";
import { GrabberPanel } from "./GrabberPanel";
import { SetPlannerPanel } from "./SetPlannerPanel";
import type { PluginEntry } from "./Sidebar";
import type { ToolCall } from "./ToolCallRow";

/** Copy for the plugins that are published but have no panel yet. */
const PLACEHOLDER: Record<string, { body: string; bullets: string[] }> = {
  "rekordbox-serato-bridge": {
    body: "把 Rekordbox 的播放列表、cue / loop / 颜色转换到 Serato。",
    bullets: ["预览报告（dry-run）", "逐曲目对照", "颜色与 loop 映射"],
  },
};

export function PluginPanelPage({
  plugin,
  home,
  onBack,
  onCallBegin,
  onCallEnd,
}: {
  plugin: PluginEntry;
  home: string;
  onBack: () => void;
  onCallBegin: (call: ToolCall) => void;
  onCallEnd: (id: string, patch: Partial<ToolCall>) => void;
}) {
  const placeholder = PLACEHOLDER[plugin.repo];

  return (
    <div className="sr-page sr-plugin-page">
      <header className="sr-page-header">
        <button type="button" className="sr-page-back" onClick={onBack}>
          ‹ 插件
        </button>
        <h1 className="sr-page-title">{plugin.label}</h1>
        <p className="sr-page-sub sr-mono">
          {plugin.repo} · {plugin.connected ? "已连接" : "未连接"}
        </p>
      </header>
      <div className="sr-page-body sr-scroll">
        <div className="sr-plugin-page-body">
          {plugin.repo === "rekordbox-serato-bridge" ? (
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
          ) : plugin.repo === "ShadowMusicGrabber" ? (
            <GrabberPanel
              connected={plugin.connected}
              tools={plugin.tools}
              onBegin={onCallBegin}
              onEnd={onCallEnd}
            />
          ) : plugin.repo === "stem-splitter" ? (
            <div className="sr-plugin-pane">
              <p className="sr-plugin-hint">
                分轨在 Studio 里用：右键任意音频片段 →「分轨（Vocal / Drums / Bass / Other）」，四条分轨会自动落到新轨道。
              </p>
              <ul className="sr-plugin-bullets">
                <li>本地 Demucs：{plugin.connected ? "已连接" : "未连接"}</li>
                <li>要分离一整首歌，也可以直接在对话里说「把这首歌分轨」</li>
                <li>作业是异步的：启动后返回 job id，中断不会丢</li>
              </ul>
            </div>
          ) : (
            <div className="sr-plugin-pane">
              <p className="sr-plugin-hint">{placeholder?.body ?? "这个插件还没有面板。"}</p>
              <ul className="sr-plugin-bullets">
                {(placeholder?.bullets ?? []).map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
