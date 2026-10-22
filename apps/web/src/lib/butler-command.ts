/**
 * The butler's typed app commands.
 *
 * `navigate` is ephemeral UI state; `dispatch` is durable domain work. Keeping them as separate
 * variants prevents page changes from accidentally creating a worker handoff (and vice versa).
 */

export const WORKER_TARGETS = ["studio", "dj", "library"] as const;
export type WorkerTarget = (typeof WORKER_TARGETS)[number];

export const WORKSPACE_IDS = ["workbench", "library", "studio", "dj", "settings"] as const;
export type WorkspaceId = (typeof WORKSPACE_IDS)[number];

export const APP_VIEWS = [
  ...WORKSPACE_IDS,
  "conversation",
  "plugins",
] as const;
export type AppView = (typeof APP_VIEWS)[number];

const WORKER_TARGET_SET = new Set<string>(WORKER_TARGETS);
const APP_VIEW_SET = new Set<string>(APP_VIEWS);

export function isWorkerTarget(value: unknown): value is WorkerTarget {
  return typeof value === "string" && WORKER_TARGET_SET.has(value);
}

export function isAppView(value: unknown): value is AppView {
  return typeof value === "string" && APP_VIEW_SET.has(value);
}

export type RoutedAction = {
  target: WorkerTarget;
  actionSummary: string;
  confidence: number;
  requiredContext: string[];
  contextSatisfied: boolean;
  missingContext: string[];
};

export type RouteSourceMention = { name: string; path: string; label: string };

export type DispatchRoute = RoutedAction & {
  commandId: string;
  sourceText?: string;
  sourceMentions?: RouteSourceMention[];
  sourceSessionId?: string;
  handoffId?: number;
};

export type NavigateCommand = {
  op: "navigate";
  view: AppView;
  reason: string;
  commandId: string;
  sourceText?: string;
  sourceSessionId?: string;
};

export type DispatchCommand = {
  op: "dispatch";
  route: DispatchRoute;
  reason: string;
  commandId: string;
};

export type ButlerCommand = NavigateCommand | DispatchCommand;

type ButlerCall = {
  id: string;
  name: string;
  detail?: string;
  routeSource?: {
    text: string;
    mentions: RouteSourceMention[];
    sessionId: string;
  };
};

function resultObject(detail: string | undefined): Record<string, unknown> | null {
  try {
    const envelope = JSON.parse(detail ?? "{}") as Record<string, unknown>;
    let result = envelope.result;
    if (result !== null && typeof result === "object" && Array.isArray((result as { content?: unknown[] }).content)) {
      const text = (result as { content: Array<{ text?: unknown }> }).content
        .map((entry) => (typeof entry.text === "string" ? entry.text : ""))
        .join("");
      if (text !== "") result = JSON.parse(text);
    }
    if (typeof result === "string") result = JSON.parse(result);
    if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
    return result as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry)).filter((entry) => entry.trim() !== "")
    : [];
}

function hasOnlyKeys(row: Record<string, unknown>, allowed: readonly string[]): boolean {
  const permit = new Set(allowed);
  return Object.keys(row).every((key) => permit.has(key));
}

function parseDispatchRoute(
  row: Record<string, unknown>,
  commandId: string,
  source?: ButlerCall["routeSource"],
): DispatchRoute | null {
  if (
    !hasOnlyKeys(row, [
      "accept",
      "target",
      "action_summary",
      "required_context",
      "confidence",
      "context_satisfied",
      "missing_context",
    ])
  ) {
    return null;
  }
  const target = row.target;
  const actionSummary = String(row.action_summary ?? "").trim();
  const confidence = typeof row.confidence === "number" ? row.confidence : Number.NaN;
  if (!isWorkerTarget(target) || actionSummary === "" || !Number.isFinite(confidence)) return null;
  return {
    target,
    actionSummary,
    confidence,
    requiredContext: stringList(row.required_context),
    contextSatisfied: row.context_satisfied === true,
    missingContext: stringList(row.missing_context),
    commandId,
    ...(source === undefined
      ? {}
      : {
          sourceText: source.text,
          sourceMentions: source.mentions,
          sourceSessionId: source.sessionId,
        }),
  };
}

/**
 * Parse only a steward echo, never the model's arguments. `route_intent` remains read-compatible
 * for command rows persisted before `app_command` existed; new turns use `app_command` only.
 */
export function parseButlerCommand(call: ButlerCall): ButlerCommand | null {
  const row = resultObject(call.detail);
  if (row === null || row.accept !== true) return null;

  if (call.name === "route_intent") {
    const route = parseDispatchRoute(row, call.id, call.routeSource);
    return route === null
      ? null
      : {
          op: "dispatch",
          route,
          reason: route.actionSummary,
          commandId: call.id,
        };
  }

  if (call.name !== "app_command") return null;
  const op = row.op;
  const reason = String(row.reason ?? "").trim();
  if (op === "navigate") {
    const view = row.view;
    if (!isAppView(view) || !hasOnlyKeys(row, ["accept", "op", "view", "reason"])) return null;
    return {
      op: "navigate",
      view,
      reason: reason === "" ? `打开 ${view}` : reason,
      commandId: call.id,
      ...(call.routeSource === undefined
        ? {}
        : {
            sourceText: call.routeSource.text,
            sourceSessionId: call.routeSource.sessionId,
          }),
    };
  }
  if (op === "dispatch") {
    const routeRow = row.route;
    if (
      !hasOnlyKeys(row, ["accept", "op", "route", "reason"]) ||
      routeRow === null ||
      typeof routeRow !== "object" ||
      Array.isArray(routeRow)
    ) {
      return null;
    }
    const route = parseDispatchRoute(routeRow as Record<string, unknown>, call.id, call.routeSource);
    return route === null
      ? null
      : {
          op: "dispatch",
          route,
          reason: reason === "" ? route.actionSummary : reason,
          commandId: call.id,
        };
  }
  return null;
}
