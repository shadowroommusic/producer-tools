/**
 * One system notice in the transcript: a dot, a short title and the reason.
 *
 * Geometry follows DeepSeek Harness's turn-status rows (10px dot column, 13/20 copy, 8px gap) —
 * notices are boundaries in the flow, not conversation content.
 */
export function NoticeRow({ title, text }: { title: string; text: string }) {
  return (
    <div className="sr-notice" role="status">
      <span className="sr-notice-dot" />
      <p className="sr-notice-copy">
        <span className="sr-notice-title">{title}</span>
        {text}
      </p>
    </div>
  );
}
