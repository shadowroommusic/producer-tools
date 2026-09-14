/**
 * Conversation column: 56px header (crumbs + view tabs + utilities), the scroll body, and the
 * composer seat pinned to the bottom. Empty sessions centre the composer as the hero instead —
 * the same phase switch DeepSeek Harness's ConversationRoot performs.
 */
import type { ReactNode } from "react";
import { BrandMark } from "./BrandMark";
import { IconDock } from "./icons";
import { ToolCallRow, type ToolCall } from "./ToolCallRow";

export type Message = { id: string; role: "user" | "assistant"; text: string };

export function Conversation({
  crumb,
  title,
  status,
  view,
  onViewChange,
  messages,
  calls,
  composer,
  suggestions,
  onSuggestion,
  dockCollapsed,
  onToggleDock,
}: {
  crumb: string;
  title: string;
  status: ReactNode;
  view: "chat" | "trajectory";
  onViewChange: (view: "chat" | "trajectory") => void;
  messages: Message[];
  calls: ToolCall[];
  composer: ReactNode;
  suggestions: string[];
  onSuggestion: (text: string) => void;
  dockCollapsed: boolean;
  onToggleDock: () => void;
}) {
  /** Empty session: the composer rides the column as the hero. */
  const heroPhase = messages.length === 0;
  /** …but only the chat view shows the hero block; the trajectory tab shows its own content. */
  const heroChat = heroPhase && view === "chat";

  return (
    <div
      className="sr-conversation"
      data-phase={heroPhase ? "hero" : "active"}
      data-hero={heroChat || undefined}
    >
      <header className="sr-conversation-header">
        <div className="sr-conversation-titlerow">
          <div className="sr-crumbs">
            <span className="sr-crumb">{crumb}</span>
            <span className="sr-crumb-sep">/</span>
            <span className="sr-crumb sr-crumb--current">{title}</span>
          </div>
          <div className="sr-conversation-actions">
            {status}
            <button
              type="button"
              className="sr-icon-btn"
              aria-label={dockCollapsed ? "显示插件面板" : "隐藏插件面板"}
              title={dockCollapsed ? "显示插件面板" : "隐藏插件面板"}
              aria-pressed={!dockCollapsed}
              onClick={onToggleDock}
            >
              <IconDock size={16} />
            </button>
          </div>
        </div>
        <div className="sr-tabs" role="tablist" aria-label="会话视图">
          <button
            type="button"
            role="tab"
            className="sr-tab"
            aria-selected={view === "chat"}
            data-active={view === "chat" || undefined}
            onClick={() => onViewChange("chat")}
          >
            会话
          </button>
          <button
            type="button"
            role="tab"
            className="sr-tab"
            aria-selected={view === "trajectory"}
            data-active={view === "trajectory" || undefined}
            onClick={() => onViewChange("trajectory")}
          >
            轨迹<span className="sr-tab-count sr-mono">{calls.length || ""}</span>
          </button>
        </div>
      </header>

      <div className="sr-conversation-body">
        <div className="sr-conversation-scroll sr-scroll">
          <div className="sr-conversation-column">
            {view === "trajectory" ? (
              calls.length > 0 ? (
                calls.map((call) => <ToolCallRow key={call.id} call={call} />)
              ) : (
                <p className="sr-view-hint">
                  还没有工具调用。左侧插件面板里点一次"运行"，这里就会按顺序列出调用、参数和返回。
                </p>
              )
            ) : heroChat ? (
              <>
                <section className="sr-hero">
                  <span className="sr-hero-mark">
                    <BrandMark height={46} strokeWidth={4} />
                  </span>
                  <h1 className="sr-hero-title">把灵感交给智能体</h1>
                </section>
                <div className="sr-hero-suggestions">
                  {suggestions.map((text) => (
                    <button
                      key={text}
                      type="button"
                      className="sr-suggestion"
                      onClick={() => onSuggestion(text)}
                    >
                      {text}
                    </button>
                  ))}
                </div>
                {composer}
              </>
            ) : (
              messages.map((message) =>
                message.role === "user" ? (
                  <div key={message.id} className="sr-msg-user">
                    <div className="sr-bubble">{message.text}</div>
                  </div>
                ) : (
                  <div key={message.id} className="sr-msg-assistant">
                    {message.text}
                  </div>
                ),
              )
            )}
          </div>
        </div>
        {!heroChat && <div className="sr-composer-seat">{composer}</div>}
      </div>
    </div>
  );
}
