/**
 * Studio's front door: the project list.
 *
 * Same shape as any DAW's start screen — a list of projects with the last-edited time, one primary
 * action to create a new one, and an explicit way back into the last project. Opening a project is
 * what puts you in the multi-track studio.
 */
import { IconPlay, IconPlus } from "./icons";
import { timeAgo } from "../lib/sessions";
import type { StudioProject } from "../lib/studio";

export type ProjectSummary = {
  id: string;
  name: string;
  updatedAt: number;
  bpm: number;
  key: string;
  trackCount: number;
  clipCount: number;
};

export function summarize(project: StudioProject): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    updatedAt: project.updatedAt,
    bpm: project.bpm,
    key: project.key,
    trackCount: project.tracks.length,
    clipCount: project.tracks.reduce((count, track) => count + track.clips.length, 0),
  };
}

export function StudioProjects({
  projects,
  onOpen,
  onCreate,
  onDelete,
  onSnapshot,
}: {
  projects: ProjectSummary[];
  onOpen: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  /** 另存快照：把当前工程原样复制成一个新工程（换 id、名字带时间戳）。 */
  onSnapshot?: (id: string) => void;
}) {
  const [latest] = projects;

  return (
    <div className="sr-page">
      <header className="sr-page-header">
        <span className="sr-eyebrow">
          <span className="sr-eyebrow-dot" />
          MULTITRACK STUDIO
        </span>
        <h1 className="sr-page-title">Studio</h1>
        <p className="sr-page-sub">多轨工程：说一句想做什么，智能体把片段排进来</p>
      </header>

      <div className="sr-page-body sr-scroll">
        <section className="sr-page-section">
          <div className="sr-page-section-head">
            <h2 className="sr-page-section-title">新建</h2>
            <span className="sr-page-section-meta sr-mono">128 BPM · 8A</span>
          </div>
          <button type="button" className="sr-project-new" onClick={onCreate}>
            <span className="sr-project-new-mark">
              <IconPlus size={18} />
            </span>
            <span className="sr-project-new-body">
              <span className="sr-project-new-title">新建工程</span>
              <span className="sr-project-new-hint">空的多轨工程，之后再导入或让智能体生成</span>
            </span>
          </button>
        </section>

        {latest && (
          <section className="sr-page-section">
            <div className="sr-page-section-head">
              <h2 className="sr-page-section-title">继续</h2>
              <span className="sr-page-section-meta sr-mono">最近打开的工程</span>
            </div>
            <button type="button" className="sr-project-card sr-project-card--hero" onClick={() => onOpen(latest.id)}>
              <span className="sr-project-card-mark">
                <IconPlay size={16} />
              </span>
              <span className="sr-project-card-body">
                <span className="sr-project-card-title">{latest.name}</span>
                <span className="sr-project-card-meta sr-mono">
                  {latest.bpm} BPM · {latest.key} · {latest.trackCount} 轨 · {latest.clipCount} 片段 ·{" "}
                  {timeAgo(latest.updatedAt)}
                </span>
              </span>
              <span className="sr-project-card-action sr-mono">打开</span>
            </button>
          </section>
        )}

        <section className="sr-page-section">
          <div className="sr-page-section-head">
            <h2 className="sr-page-section-title">全部工程</h2>
            <span className="sr-page-section-meta sr-mono">{projects.length} 个</span>
          </div>
          <div className="sr-project-list">
            {/* 全部工程也列出最新的那个：它是用户最想「先存一份再改」的工程，不能只在这里看到
                其它的。上面的大卡片是「继续」，这里是完整的清单。 */}
            {projects.map((project) => (
              <div key={project.id} className="sr-project-row">
                <button type="button" className="sr-project-open" onClick={() => onOpen(project.id)}>
                  <span className="sr-project-row-title">{project.name}</span>
                  <span className="sr-project-row-meta sr-mono">
                    {project.bpm} BPM · {project.trackCount} 轨 · {project.clipCount} 片段 ·{" "}
                    {timeAgo(project.updatedAt)}
                  </span>
                </button>
                <button
                  type="button"
                  className="sr-project-snapshot sr-mono"
                  disabled={onSnapshot === undefined}
                  title={onSnapshot === undefined ? "另存快照" : "原样复制成一个新工程，改坏了随时回来"}
                  aria-label={`另存快照 ${project.name}`}
                  onClick={() => onSnapshot?.(project.id)}
                >
                  另存快照
                </button>
                <button
                  type="button"
                  className="sr-project-delete sr-mono"
                  aria-label={`删除 ${project.name}`}
                  onClick={() => onDelete(project.id)}
                >
                  删除
                </button>
              </div>
            ))}
            {projects.length === 0 && <p className="sr-view-hint">还没有工程 —— 上面新建一个。</p>}
          </div>
        </section>
      </div>
    </div>
  );
}
