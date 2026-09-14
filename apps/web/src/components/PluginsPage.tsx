/**
 * The plugins page — the centre column's other occupant, next to the conversation.
 *
 * Codex keeps its plugins on a page like this (installed grid + featured list) instead of pinning them
 * into the sidebar; selecting one opens its panel in the dock, which is where the work happens.
 */
import { useState } from "react";
import { BrandMark } from "./BrandMark";
import { IconPlugin } from "./icons";
import type { PluginEntry } from "./Sidebar";

export function PluginsPage({
  plugins,
  activePlugin,
  onOpenPlugin,
}: {
  plugins: PluginEntry[];
  activePlugin?: string;
  onOpenPlugin: (repo: string) => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const visible = plugins.filter(
    (plugin) =>
      needle === "" ||
      plugin.label.toLowerCase().includes(needle) ||
      plugin.repo.toLowerCase().includes(needle) ||
      plugin.tools.some((tool) => tool.name.toLowerCase().includes(needle)),
  );
  const installed = plugins.filter((plugin) => plugin.connected).length;

  return (
    <div className="sr-page">
      <header className="sr-page-header">
        <h1 className="sr-page-title">插件</h1>
        <p className="sr-page-sub">在你的工作台里使用 ShadowRoom 的工具</p>
        <input
          className="sr-input sr-page-search"
          value={query}
          placeholder="搜索插件"
          onChange={(event) => setQuery(event.target.value)}
        />
      </header>

      <div className="sr-page-body sr-scroll">
        <section className="sr-page-section">
          <div className="sr-page-section-head">
            <h2 className="sr-page-section-title">已安装</h2>
            <span className="sr-page-section-meta sr-mono">
              {installed}/{plugins.length} 已连接
            </span>
          </div>
          <div className="sr-plugin-grid">
            {visible.map((plugin) => (
              <button
                key={plugin.repo}
                type="button"
                className="sr-plugin-card"
                data-active={plugin.repo === activePlugin || undefined}
                onClick={() => onOpenPlugin(plugin.repo)}
              >
                <span className="sr-plugin-card-mark">
                  <BrandMark height={26} strokeWidth={5} />
                </span>
                <span className="sr-plugin-card-body">
                  <span className="sr-plugin-card-title">
                    {plugin.label}
                    <span className="sr-dot" data-state={plugin.connected ? "live" : "idle"} />
                  </span>
                  <span className="sr-plugin-card-repo sr-mono">{plugin.repo}</span>
                  <span className="sr-plugin-card-tools sr-mono">
                    {plugin.tools.length > 0
                      ? plugin.tools.map((tool) => tool.name).join(" · ")
                      : plugin.connected
                        ? "没有工具"
                        : "bridge 未连接"}
                  </span>
                </span>
                <span className="sr-plugin-card-action sr-mono">打开面板</span>
              </button>
            ))}
            {visible.length === 0 && <p className="sr-view-hint">没有匹配的插件。</p>}
          </div>
        </section>

        <section className="sr-page-section">
          <div className="sr-page-section-head">
            <h2 className="sr-page-section-title">面板</h2>
            <span className="sr-page-section-meta sr-mono">{plugins.length} 个工具</span>
          </div>
          <p className="sr-page-note">
            <IconPlugin size={14} />
            每个插件都是独立的 MCP 服务器：面板里可以手动跑，智能体在会话里也会调用同一批工具。
          </p>
        </section>
      </div>
    </div>
  );
}
