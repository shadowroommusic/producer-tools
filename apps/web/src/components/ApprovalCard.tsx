/**
 * One pending approval, as the composer takeover DeepSeek Harness uses: a warn strip, the reason the
 * core gave, the command or file list, and the decision buttons.
 */
export type PendingApproval = {
  approvalId: string;
  sessionId?: string;
  kind: string;
  title: string;
  detail?: string;
  busy?: boolean;
};

export function ApprovalCard({
  approval,
  onDecide,
}: {
  approval: PendingApproval;
  onDecide: (decision: "allow" | "allow_session" | "deny") => void;
}) {
  return (
    <section className="sr-approval" aria-label="等待确认">
      <header className="sr-approval-strip">
        <span className="sr-approval-dot" />
        等待确认
        <span className="sr-approval-kind sr-mono">
          {approval.kind === "patch" ? "文件修改" : "命令执行"}
        </span>
      </header>
      <div className="sr-approval-body">
        <p className="sr-approval-headline">{approval.title}</p>
        {approval.detail && <pre className="sr-approval-detail sr-scroll">{approval.detail}</pre>}
      </div>
      <div className="sr-approval-actions">
        <button
          type="button"
          className="sr-btn sr-btn--reject"
          disabled={approval.busy}
          onClick={() => onDecide("deny")}
        >
          拒绝
        </button>
        <button
          type="button"
          className="sr-btn"
          disabled={approval.busy}
          onClick={() => onDecide("allow_session")}
        >
          本次会话都允许
        </button>
        <button
          type="button"
          className="sr-btn sr-btn--accent"
          disabled={approval.busy}
          onClick={() => onDecide("allow")}
        >
          允许一次
        </button>
      </div>
    </section>
  );
}
