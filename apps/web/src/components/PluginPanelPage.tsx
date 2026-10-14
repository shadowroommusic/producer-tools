/**
 * A plugin's panel as a *page* in the centre column.
 *
 * It used to live in the right dock; moving it here keeps the dock a single-purpose chat column and
 * gives every panel the room its JSON editors and result tables want.
 */
import { useCallback, useEffect, useState } from "react";
import { AnalysisPanel } from "./AnalysisPanel";
import { ConverterPanel } from "./ConverterPanel";
import { GeneratorPanel } from "./GeneratorPanel";
import { GrabberPanel } from "./GrabberPanel";
import { SetPlannerPanel } from "./SetPlannerPanel";
import { callTool } from "../lib/mcp";
import type { PluginEntry } from "./Sidebar";
import type { ToolCall } from "./ToolCallRow";

/** Copy for the plugins that are published but have no panel yet. */
const PLACEHOLDER: Record<string, { body: string; bullets: string[] }> = {
  "rekordbox-serato-bridge": {
    body: "把 Rekordbox 的播放列表、cue / loop / 颜色转换到 Serato。",
    bullets: ["预览报告（dry-run）", "逐曲目对照", "颜色与 loop 映射"],
  },
};

type SplitInstall = {
  needed?: boolean;
  venv_ready?: boolean;
  model_ready?: boolean;
  estimate_mb?: number;
  note?: string;
};

/**
 * 分轨面板（#94-A.3）：除了「去 Studio 用」的引导，还承载首用组件的**预装**——
 * `stem_backends` 报出缺什么、多大，按钮把「约 XXX MB、仅一次」写在脸上再开装，
 * 进度走 job 的 install_step（与分轨同一套异步作业，可取消、可重试）。
 */
function SplitterPanel({
  connected,
  onBegin,
  onEnd,
}: {
  connected: boolean;
  onBegin: (call: ToolCall) => void;
  onEnd: (id: string, patch: Partial<ToolCall>) => void;
}) {
  const [install, setInstall] = useState<SplitInstall | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const described = JSON.parse(
        String(await callTool<string>("splitter", "stem_backends", {})),
      ) as { install?: SplitInstall };
      setInstall(described.install ?? null);
    } catch {
      setInstall(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function installBackend() {
    const id = `stem_install_backend-${Date.now()}`;
    setBusy(true);
    setError(null);
    setStep("检查分轨组件");
    onBegin({
      id,
      server: "stem-splitter",
      name: "stem_install_backend",
      status: "running",
      summary: "安装分轨组件（约 " + (install?.estimate_mb ?? 160) + " MB，仅一次）",
      detail: "{}",
    });
    try {
      const started = JSON.parse(
        String(await callTool<string>("splitter", "stem_install_backend", {})),
      ) as { job_id?: string };
      const jobId = started.job_id;
      if (jobId === undefined) throw new Error("没有拿到 job id");
      // 与 App 的分轨轮询同节奏；install_step 是安装器的中文进度句
      for (let attempt = 0; attempt < 3000; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const status = JSON.parse(
          String(await callTool<string>("splitter", "stem_job_status", { job_id: jobId })),
        ) as { status?: string; install_step?: string; error?: string };
        if (status.status === "running") {
          setStep(status.install_step ?? null);
          onEnd(id, { status: "running", summary: status.install_step ?? "安装中" });
          continue;
        }
        if (status.status === "ok") {
          setStep(null);
          onEnd(id, { status: "ok", summary: "分轨组件已就绪", detail: JSON.stringify(status, null, 2) });
          return;
        }
        throw new Error(status.error ?? `安装 ${status.status ?? "失败"}`);
      }
      throw new Error("安装超时：请查看插件轨迹后重试");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      onEnd(id, { status: "error", summary: message, detail: message });
    } finally {
      setBusy(false);
      void refresh();
    }
  }

  const demucsLine = install === null
    ? "本地 Demucs：状态未知（桥不可达或插件未连接）"
    : install.needed
      ? `本地 Demucs：未安装${install.model_ready === false ? "（模型也未下载）" : ""}`
      : "本地 Demucs：已就绪";

  return (
    <div className="sr-plugin-pane">
      <p className="sr-plugin-hint">
        分轨在 Studio 里用：右键任意音频片段 →「分轨（Vocal / Drums / Bass / Other）」，四条分轨会自动落到新轨道。
      </p>
      <ul className="sr-plugin-bullets">
        <li>{demucsLine}</li>
        <li>要分离一整首歌，也可以直接在对话里说「把这首歌分轨」</li>
        <li>作业是异步的：启动后返回 job id，中断不会丢</li>
      </ul>
      {install?.needed === true && (
        <div className="sr-plugin-install">
          <p className="sr-plugin-hint">
            {install.note ?? "首次分轨需下载模型（约 160 MB，仅一次）"}——现在就装好，第一次分轨不用等。
          </p>
          <button
            type="button"
            className="sr-page-action"
            disabled={!connected || busy}
            onClick={() => void installBackend()}
          >
            {busy ? "安装中…" : `安装分轨组件（约 ${install.estimate_mb ?? 160} MB，仅一次）`}
          </button>
          {busy && step !== null && <p className="sr-plugin-hint sr-mono">{step}</p>}
          {error !== null && (
            <p className="sr-plugin-hint" role="alert">
              安装失败：{error}。网络恢复后再点一次会续传；也可以设置 STEM_SPLIT_COMMAND 改用远端分离。
            </p>
          )}
        </div>
      )}
    </div>
  );
}

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
            <SplitterPanel connected={plugin.connected} onBegin={onCallBegin} onEnd={onCallEnd} />
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
