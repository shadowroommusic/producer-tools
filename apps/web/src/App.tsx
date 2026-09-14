import { useCallback, useEffect, useState } from "react";
import { BrandMark } from "./components/BrandMark";
import { Composer } from "./components/Composer";
import { PlannerPanel } from "./components/PlannerPanel";
import { Sidebar } from "./components/Sidebar";
import { fetchServers, type ServerInfo } from "./lib/mcp";

/** Shown before the bridge answers, so the sidebar always lists the four ShadowRoom servers. */
const KNOWN_SERVERS: ServerInfo[] = [
  { id: "converter", label: "rekordbox-serato-bridge", description: "Rekordbox ⇄ Serato 转换", connected: false, tools: [] },
  { id: "analysis", label: "audio-analysis-dedupe", description: "音频分析与去重", connected: false, tools: [] },
  { id: "planner", label: "set-planner", description: "Set 编排", connected: false, tools: [] },
  { id: "generator", label: "shadow-music-generator", description: "生成任务队列", connected: false, tools: [] },
];

type Bridge = "connecting" | "online" | "offline";

type Request = { id: string; text: string; at: string };

const clock = () =>
  new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });

export function App() {
  const [servers, setServers] = useState<ServerInfo[]>(KNOWN_SERVERS);
  const [bridge, setBridge] = useState<Bridge>("connecting");
  const [draft, setDraft] = useState("");
  const [queue, setQueue] = useState<Request[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchServers()
      .then((list) => {
        if (cancelled) return;
        setServers(list.length ? list : KNOWN_SERVERS);
        setBridge("online");
      })
      .catch(() => {
        if (cancelled) return;
        setBridge("offline");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    setQueue((current) => [{ id: crypto.randomUUID(), text, at: clock() }, ...current]);
    setDraft("");
  }, [draft]);

  const planner = servers.find((server) => server.id === "planner");

  return (
    <div className="sr-app">
      <Sidebar servers={servers} />

      <main className="sr-main">
        <header className="sr-topbar">
          <div className="sr-crumbs">
            <span>工作台</span>
            <span aria-hidden="true">/</span>
            <b>新会话</b>
          </div>
          <div className="sr-top-right">
            <span className={`sr-status sr-status--${bridge}`}>
              <span className={`sr-dot sr-dot--${bridge === "online" ? "live" : "idle"}`} />
              <span className="sr-mono">
                {bridge === "online" ? "MCP 已连接" : bridge === "connecting" ? "连接中…" : "MCP 未连接"}
              </span>
            </span>
            <span className="sr-status sr-status--muted" title="下一步接入 Codex app-server">
              <span className="sr-mono">内核：未接入</span>
            </span>
          </div>
        </header>

        <div className="sr-home">
          <section className="sr-greet">
            <span className="sr-greet-mark">
              <BrandMark height={72} />
            </span>
            <h1>把灵感交给智能体</h1>
            <p>
              说清楚你要的东西 —— 智能体会拆解任务、调度 ShadowRoom 的 MCP 工具，并把每一步摊开给你看。
            </p>
          </section>

          <Composer value={draft} onChange={setDraft} onSubmit={submit} busy={false} />

          <div className="sr-row2">
            <section className="sr-panel">
              <header className="sr-panel-head">
                <span className="sr-panel-title">会话</span>
                <span className="sr-panel-hint sr-mono">{queue.length} 条待运行</span>
              </header>
              {queue.length ? (
                <ul className="sr-queue">
                  {queue.map((item) => (
                    <li key={item.id}>
                      <span className="sr-dot sr-dot--queued" />
                      <span className="sr-queue-body">
                        <span className="sr-queue-text">{item.text}</span>
                        <span className="sr-queue-meta sr-mono">{item.at} · 等待内核接入</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="sr-panel-hint">
                  还没有会话。上面写下第一条需求 —— 现在它会排在这里；等 Codex 内核接上后，同一条会话就会真的跑起来。
                </p>
              )}
            </section>

            <PlannerPanel connected={Boolean(planner?.connected)} />
          </div>
        </div>
      </main>
    </div>
  );
}
