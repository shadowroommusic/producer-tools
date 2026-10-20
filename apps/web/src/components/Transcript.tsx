/**
 * The message flow on its own: user bubbles, streamed answers, 思考 rows, tool rows in the order they
 * happened, notices and the per-turn usage line.
 *
 * It is shared by the conversation column and the dock's 对话 tab, so the same session can be watched
 * from either place.
 */
import { NoticeRow } from "./NoticeRow";
import { ReasoningRow } from "./ReasoningRow";
import { ToolCallRow, type ToolCall } from "./ToolCallRow";
import { reasoningSeconds } from "../lib/reasoning-title";
import type { ChatMessage } from "../lib/sessions";

export function Transcript({
  messages,
  calls,
  running,
  quiet = false,
}: {
  messages: ChatMessage[];
  calls: ToolCall[];
  running: boolean;
  /** 极简 mode: the model's thinking stays out of the way. */
  quiet?: boolean;
}) {
  return (
    <>
      {messages.map((message, index) => {
        if (message.role === "user") {
          return (
            <div key={message.id} className="sr-msg-user">
              {message.scope !== undefined && message.scope.workspaceId !== "butler" && (
                <span className="sr-bubble-scope sr-mono">
                  {message.scope.label ?? message.scope.workspaceId}
                </span>
              )}
              <div className="sr-bubble">{message.text}</div>
            </div>
          );
        }
        if (message.role === "assistant") {
          if (message.text === "" && message.streaming === true) {
            return (
              <p key={message.id} className="sr-turn-status">
                正在运行
              </p>
            );
          }
          // 迁移把纯 think 消息剥成空正文时，气泡不渲染（reasoning 行已经承载了内容）。
          if (message.text === "") return null;
          return (
            <div key={message.id} className="sr-msg-assistant">
              {message.text}
              {message.streaming === true && <span className="sr-caret" aria-hidden="true" />}
            </div>
          );
        }
        if (message.role === "notice") {
          return <NoticeRow key={message.id} title={message.title} text={message.text} />;
        }
        if (message.role === "reasoning") {
          if (quiet) return null;
          // 思考块只记开始（at），「想了多久」从下一条消息何时到推导，不另存状态。
          const next = messages[index + 1];
          const seconds =
            message.streaming === true || next === undefined ? undefined : reasoningSeconds(message.at, next.at);
          return (
            <ReasoningRow
              key={message.id}
              text={message.text}
              running={message.streaming === true}
              seconds={seconds}
            />
          );
        }
        if (message.role === "usage") {
          // 回合尾的真实摘要（N 个工具 · M 个 MCP · X 秒）必须可见；tokens 是开发者读数，
          // 挂 title。旧数据没有 title 字段——整行读数照旧只挂 title，行为不变。
          const legacy = message.title === undefined;
          return legacy ? (
            <p key={message.id} className="sr-usage sr-mono" title={message.text} />
          ) : (
            <p key={message.id} className="sr-usage sr-mono" title={message.title}>
              {message.text}
            </p>
          );
        }
        const call = calls.find((entry) => entry.id === message.callId);
        return call === undefined ? null : <ToolCallRow key={message.id} call={call} />;
      })}
      {running && <p className="sr-turn-status">正在运行</p>}
    </>
  );
}
