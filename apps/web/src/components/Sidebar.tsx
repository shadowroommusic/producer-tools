import { BrandMark } from "./BrandMark";
import type { ServerInfo } from "../lib/mcp";

const NAV = [
  { id: "home", label: "工作台", ready: true },
  { id: "library", label: "曲目库", ready: false },
  { id: "convert", label: "转换", ready: false },
  { id: "sets", label: "Set 编排", ready: false },
  { id: "settings", label: "设置", ready: false },
];

export function Sidebar({ servers, active = "home" }: { servers: ServerInfo[]; active?: string }) {
  const connected = servers.filter((server) => server.connected).length;

  return (
    <aside className="sr-sidebar">
      <div className="sr-brand">
        <span className="sr-brand-mark">
          <BrandMark height={30} />
        </span>
        <span className="sr-brand-text">
          <span className="sr-brand-name">
            Shadow<span className="sr-brand-accent">Room</span> Producers
          </span>
          <span className="sr-brand-sub sr-mono">SHADOWROOM MUSIC · 工作台</span>
        </span>
      </div>

      <nav className="sr-nav" aria-label="工作区">
        <p className="sr-sidebar-title sr-mono">工作区</p>
        {NAV.map((item) => {
          const isActive = item.id === active;
          return (
            <button
              key={item.id}
              className={`sr-nav-item${isActive ? " is-active" : ""}`}
              aria-current={isActive ? "page" : undefined}
              aria-disabled={item.ready ? undefined : true}
              title={item.ready ? undefined : "即将开放"}
            >
              <span>{item.label}</span>
              {item.ready ? null : <span className="sr-nav-soon sr-mono">即将</span>}
            </button>
          );
        })}
      </nav>

      <div className="sr-sidebar-section">
        <div className="sr-sidebar-title sr-mono">
          MCP 服务 <span className="sr-count">{connected}/{servers.length}</span>
        </div>
        {servers.map((server) => (
          <div key={server.id} className="sr-server" title={server.error ?? server.description}>
            <span className={`sr-dot sr-dot--${server.connected ? "live" : "idle"}`} />
            <span className="sr-server-body">
              <span className="sr-server-name sr-mono">{server.label}</span>
              <span className="sr-server-meta">
                {server.connected
                  ? `${server.tools.length} 个工具`
                  : server.error
                    ? "连接失败"
                    : "未连接"}
              </span>
            </span>
          </div>
        ))}
      </div>

      <div className="sr-side-foot sr-mono">
        <span>AGPL-3.0</span>
        <span>·</span>
        <span>v0.0.0</span>
      </div>
    </aside>
  );
}
