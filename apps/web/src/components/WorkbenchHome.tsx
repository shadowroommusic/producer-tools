/**
 * The main column when the chat dock is open on 工作台: the work you have, next to the conversation.
 *
 * Without it the page would be the transcript and the dock would be the same transcript — the app
 * drew the same chat twice. Here the left side answers "where was I?" instead: recent Studio
 * projects, recent conversations, and the state of the plugins.
 */
import { IconChat, IconPlugin, IconStudio } from "./icons";
import { timeAgo } from "../lib/sessions";
import type { PluginEntry, SessionSummary } from "./Sidebar";
import type { StudioProject } from "../lib/studio";

export function WorkbenchHome({
  projects,
  sessions,
  plugins,
  onOpenProject,
  onOpenSession,
  onOpenPlugins,
}: {
  projects: StudioProject[];
  sessions: SessionSummary[];
  plugins: PluginEntry[];
  onOpenProject: (id: string) => void;
  onOpenSession: (id: string) => void;
  onOpenPlugins: () => void;
}) {
  const connected = plugins.filter((plugin) => plugin.connected).length;

  return (
    <div className="sr-page sr-workbench">
      <header className="sr-page-header">
        <h1 className="sr-page-title">工作台</h1>
        <p className="sr-page-sub">最近做的工程和会话 —— 右边可以直接跟智能体说话</p>
      </header>

      <div className="sr-page-body sr-scroll">
        <section className="sr-page-section">
          <div className="sr-page-section-head">
            <h2 className="sr-page-section-title">最近的工程</h2>
            <span className="sr-page-section-meta sr-mono">{projects.length} 个</span>
          </div>
          <div className="sr-plugin-grid">
            {projects.slice(0, 4).map((project) => (
              <button
                key={project.id}
                type="button"
                className="sr-plugin-card"
                onClick={() => onOpenProject(project.id)}
              >
                <span className="sr-plugin-card-mark">
                  <IconStudio size={18} />
                </span>
                <span className="sr-plugin-card-body">
                  <span className="sr-plugin-card-title">{project.name}</span>
                  <span className="sr-plugin-card-repo sr-mono">
                    {project.bpm} BPM · {project.key} · {project.tracks.length} 轨 ·{" "}
                    {project.tracks.reduce((count, track) => count + track.clips.length, 0)} 片段
                  </span>
                  <span className="sr-plugin-card-tools sr-mono">更新于 {timeAgo(project.updatedAt)}</span>
                </span>
                <span className="sr-plugin-card-action sr-mono">打开</span>
              </button>
            ))}
            {projects.length === 0 && <p className="sr-view-hint">还没有工程 —— 侧栏点 Studio 新建一个。</p>}
          </div>
        </section>

        <section className="sr-page-section">
          <div className="sr-page-section-head">
            <h2 className="sr-page-section-title">最近的对话</h2>
            <span className="sr-page-section-meta sr-mono">{sessions.length} 条</span>
          </div>
          <div className="sr-project-list">
            {sessions.slice(0, 5).map((session) => (
              <div key={session.id} className="sr-project-row">
                <button type="button" className="sr-project-open" onClick={() => onOpenSession(session.id)}>
                  <span className="sr-project-row-title">{session.title}</span>
                  <span className="sr-project-row-meta sr-mono">{session.meta}</span>
                </button>
              </div>
            ))}
            {sessions.length === 0 && <p className="sr-view-hint">还没有对话。</p>}
          </div>
        </section>

        <section className="sr-page-section">
          <div className="sr-page-section-head">
            <h2 className="sr-page-section-title">插件</h2>
            <span className="sr-page-section-meta sr-mono">
              {connected}/{plugins.length} 已连接
            </span>
          </div>
          <button type="button" className="sr-project-new" onClick={onOpenPlugins}>
            <span className="sr-project-new-mark">
              <IconPlugin size={18} />
            </span>
            <span className="sr-project-new-body">
              <span className="sr-project-new-title">打开插件页</span>
              <span className="sr-project-new-hint">
                {plugins.map((plugin) => plugin.label).join(" · ")}
              </span>
            </span>
          </button>
        </section>

        <p className="sr-page-note">
          <IconChat size={14} />
          右边是对话栏：打字或说话都在那里，主区留给工程。
        </p>
      </div>
    </div>
  );
}
