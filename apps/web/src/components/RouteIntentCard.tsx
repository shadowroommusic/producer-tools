import { IconChevronRight } from "./icons";

export type RouteTarget = "studio" | "dj" | "library" | "butler_direct" | "ask_user";

export type RouteIntent = {
  target: RouteTarget;
  actionSummary: string;
  confidence: number;
  contextSatisfied: boolean;
  missingContext: string[];
  routeId: string;
  /**
   * The request that produced this route. Persisted with the tool row so confirmation still works
   * after a reload and voice recordings are not lost between classification and execution.
   */
  sourceText?: string;
  sourceMentions?: Array<{ name: string; path: string; label: string }>;
  sourceSessionId?: string;
  /** Durable steward handoff created when the user confirms this route. */
  handoffId?: number;
};

const TARGET_LABEL: Record<RouteTarget, string> = {
  studio: "Studio",
  dj: "DJ",
  library: "曲目库",
  butler_direct: "管家直接处理",
  ask_user: "需要补充信息",
};

export function RouteIntentCard({
  route,
  onOpen,
  onDismiss,
}: {
  route: RouteIntent;
  onOpen: (route: RouteIntent) => void;
  onDismiss: () => void;
}) {
  const navigable = route.target === "studio" || route.target === "dj" || route.target === "library";
  const ready = navigable && route.contextSatisfied && route.confidence >= 0.7;
  return (
    <section className="sr-route-card" data-ready={ready || undefined}>
      <span className="sr-route-kicker sr-mono">ROUTE · {Math.round(route.confidence * 100)}%</span>
      <div className="sr-route-main">
        <p className="sr-route-title">
          这看起来是 <strong>{TARGET_LABEL[route.target]}</strong> 的请求
        </p>
        <p className="sr-route-summary">{route.actionSummary}</p>
        {route.missingContext.length > 0 && (
          <p className="sr-route-missing sr-mono">缺少：{route.missingContext.join(" · ")}</p>
        )}
      </div>
      <div className="sr-route-actions">
        <button type="button" className="sr-btn" onClick={onDismiss}>
          稍后
        </button>
        {ready && (
          <button type="button" className="sr-btn sr-btn--accent" onClick={() => onOpen(route)}>
            打开并继续
            <IconChevronRight size={14} />
          </button>
        )}
      </div>
    </section>
  );
}
