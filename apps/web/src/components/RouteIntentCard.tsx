import { IconChevronRight } from "./icons";
import { routeNeedsConfirmation } from "../lib/route-policy.ts";
import type { DispatchRoute, WorkerTarget } from "../lib/butler-command.ts";

export type RouteIntent = DispatchRoute;

const TARGET_LABEL: Record<WorkerTarget, string> = {
  studio: "Studio",
  dj: "DJ",
  library: "曲目库",
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
  const ready = routeNeedsConfirmation(route);
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
            确认执行
            <IconChevronRight size={14} />
          </button>
        )}
      </div>
    </section>
  );
}
