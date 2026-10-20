/**
 * 会话级 agent 设置：model / effort / access。
 *
 * 一个真相的分工：
 * - **sandbox/approval 的映射只在 bridge**（`tools/think-stream.mjs` 的 ACCESS_PRESETS）——生效点在那边；
 *   前端只发送 access 枚举，不重述元组。
 * - 前端这里负责的是「显示哪几档、默认是哪档、什么时候不能切」：effort 的可见性从
 *   ModelProfile.reasoning 的 requestProtocol 推导，不猜、不装饰。
 *
 * 存储：per-session（`Session.settings`）+ 一份全局默认快照（新会话继承）。只保存经过
 * `thread/settings/updated` 确认的值。
 */

export type AgentAccess = "read-only" | "workspace-write" | "danger-full-access";

export type AgentSettings = {
  /** 内置模型 id，或 `custom:<providerId>:<model>`（自定义供应商）。 */
  modelId?: string;
  /** 仅当模型的 effort 是真实可映射档位时才存在。 */
  effort?: string;
  access: AgentAccess;
};

export const DEFAULT_ACCESS: AgentAccess = "workspace-write";

export const ACCESS_LEVELS: ReadonlyArray<{ id: AgentAccess; label: string; hint: string }> = [
  { id: "read-only", label: "只读", hint: "只能读文件，不能写——最安全" },
  { id: "workspace-write", label: "工作区可写", hint: "工作区与临时目录里可写，其它要先问（默认）" },
  { id: "danger-full-access", label: "完全访问", hint: "可读写整盘、回合内不再询问——每次进入都要重新确认" },
];

export function accessLabel(access: AgentAccess): string {
  return ACCESS_LEVELS.find((level) => level.id === access)?.label ?? access;
}

export function isAgentAccess(value: unknown): value is AgentAccess {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access";
}

/** 收窄未知数据（localStorage 旧档、别的入口塞进来的）成合法设置；缺省回落工作区可写。 */
export function normalizeAgentSettings(value: unknown): AgentSettings {
  if (value === null || typeof value !== "object") return { access: DEFAULT_ACCESS };
  const raw = value as { modelId?: unknown; effort?: unknown; access?: unknown };
  return {
    ...(typeof raw.modelId === "string" && raw.modelId !== "" ? { modelId: raw.modelId } : {}),
    ...(typeof raw.effort === "string" && raw.effort !== "" ? { effort: raw.effort } : {}),
    access: isAgentAccess(raw.access) ? raw.access : DEFAULT_ACCESS,
  };
}

/* ── 全局默认快照 ──────────────────────────────────────────────────────────── */

const DEFAULTS_KEY = "shadowroom.agent-defaults.v1";

/**
 * 全局默认。老安装里模型是全局存的（`shadowroom.model`）——第一次读默认快照时把它吸收进来，
 * 一次性迁移，之后以新键为准。
 */
export function loadAgentDefaults(): AgentSettings {
  try {
    const raw = window.localStorage.getItem(DEFAULTS_KEY);
    if (raw !== null) return normalizeAgentSettings(JSON.parse(raw));
    const legacyModel = window.localStorage.getItem("shadowroom.model");
    if (legacyModel !== null && legacyModel !== "") {
      return { modelId: legacyModel, access: DEFAULT_ACCESS };
    }
  } catch {
    /* unreadable storage → defaults below */
  }
  return { access: DEFAULT_ACCESS };
}

export function saveAgentDefaults(settings: AgentSettings): void {
  try {
    window.localStorage.setItem(DEFAULTS_KEY, JSON.stringify(settings));
  } catch {
    /* storage blocked — the per-session copy still governs this session */
  }
}

/* ── effort 可见性 ─────────────────────────────────────────────────────────── */

/**
 * 一个模型的思考深度在该 UI 里的形态：
 * - `list`：多档、当前协议能真实映射（Codex 内核原生，或 provider 档案的 openai-responses）；
 * - `locked`：协议是 `none`——模型自己内置推理，锁定唯一档，不可切换；
 * - `hidden`：无声明、单档、或协议未知——不显示，也绝不在请求里带 effort。
 */
export type EffortChoice =
  | { kind: "hidden" }
  | { kind: "locked"; effort: string }
  | { kind: "list"; efforts: string[]; defaultEffort: string };

export type EffortSource = {
  supportedReasoningEfforts?: Array<{ effort: string }>;
  defaultReasoningEffort?: string;
  /** provider 档案声明的请求协议（内核模型视为 openai-responses）。 */
  reasoningProtocol?: string;
};

export function effortChoiceFor(model: EffortSource | undefined): EffortChoice {
  if (model === undefined) return { kind: "hidden" };
  const efforts = (model.supportedReasoningEfforts ?? []).map((entry) => entry.effort);
  const protocol = model.reasoningProtocol ?? "openai-responses";
  if (protocol === "none") {
    const only = model.defaultReasoningEffort ?? efforts[0];
    return only === undefined ? { kind: "hidden" } : { kind: "locked", effort: only };
  }
  // 只有能真实映射的协议才许显示多档；单档不算选择，隐藏。
  if (protocol !== "openai-responses" || efforts.length <= 1) return { kind: "hidden" };
  return { kind: "list", efforts, defaultEffort: model.defaultReasoningEffort ?? efforts[0] };
}

/**
 * 换模型后 effort 必须重置——A 模型的档位不能跟着到 B 模型上（Kimi #484 第 6 条）。
 * 只有 list 形态才落一个具体档，其余形态不带 effort。
 */
export function effortForModel(model: EffortSource | undefined): string | undefined {
  const choice = effortChoiceFor(model);
  return choice.kind === "list" ? choice.defaultEffort : undefined;
}

/** 发送这一轮用的 effort：档位不在模型的 list 里就干脆不带（防陈旧值）。 */
export function effortForSend(model: EffortSource | undefined, current: string | undefined): string | undefined {
  if (current === undefined) return undefined;
  const choice = effortChoiceFor(model);
  return choice.kind === "list" && choice.efforts.includes(current) ? current : undefined;
}

/** thread/settings/updated 回读的 sandboxPolicy.type → 三档枚举；认不出的形状不猜。 */
export function accessFromSandboxType(type: string | undefined): AgentAccess | undefined {
  if (type === "readOnly") return "read-only";
  if (type === "workspaceWrite") return "workspace-write";
  if (type === "dangerFullAccess") return "danger-full-access";
  return undefined;
}
