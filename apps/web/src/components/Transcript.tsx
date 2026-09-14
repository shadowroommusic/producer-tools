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
import type { ChatMessage } from "../lib/sessions";

export function Transcript({
  messages,
  calls,
  running,
}: {
  messages: ChatMessage[];
  calls: ToolCall[];
  running: boolean;
}) {
  return (
    <>
      {messages.map((message) => {
        if (message.role === "user") {
          return (
            <div key={message.id} className="sr-msg-user">
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
          return <ReasoningRow key={message.id} text={message.text} running={message.streaming === true} />;
        }
        if (message.role === "usage") {
          return (
            <p key={message.id} className="sr-usage sr-mono">
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
