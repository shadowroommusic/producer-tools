/**
 * 模型档（per-model profile）—— 从用户自己的 Shadow 里搬过来的数据层。
 *
 * 出处：`~/Desktop/shadow/src/shared/app-settings-types-provider.ts`（`ModelProviderModelProfileV1` 等类型）
 * 与 `src/shared/model-provider-preset-profile-builders.ts`（`textChatProfile` / `visionChatProfile` /
 * `copyModelProfiles`）以及 `src/shared/model-provider-preset-types.ts` 里的推理常量。
 * 同一个作者的项目，所以按原样移植（DECISIONS ADR-015 补充）；只去掉视频相关的部分。
 *
 * 这一层回答的是「这个模型能干什么」：上下文多大、能不能看图、会不会调工具、推理档位有哪些。
 * 供应商级控件不该碰这些——推理档是按模型的能力，供应商设成某个值会让一部分模型直接报错
 * （Shadow 的注释里就是这么写的，照抄这个判断）。
 */

/** 输入/输出模态。 */
export type InputModality = "text" | "image" | "audio";

/** 一条消息里允许出现的片段类型（按 provider 的消息格式）。 */
export type MessagePart = "text" | "image_url" | "input_audio";

/** 打这个模型用哪种线格式；缺省表示继承供应商。 */
export type EndpointFormat = "chat_completions" | "responses" | "messages" | "custom_endpoint";

/** 推理档位的形状（effort 名 + 默认 + 请求协议）。 */
export type ReasoningCapability = {
  supportedEfforts: string[];
  defaultEffort: string;
  /** 用哪个协议把 effort 送到服务端，例如 openai-responses / anthropic-thinking / none。 */
  requestProtocol: string;
};

/** 参考价（美元 / 百万 token），只用于估算成本。 */
export type ModelPricing = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

/**
 * 一个模型的档案。除 `inputModalities` / `outputModalities` / `supportsToolCalling` / `messageParts`
 * 外都可选——「不知道」就留空，而不是编一个数字（AGENTS.md：不猜）。
 */
export type ModelProfile = {
  aliases?: string[];
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  inputModalities: InputModality[];
  outputModalities: InputModality[];
  supportsToolCalling: boolean;
  messageParts: MessagePart[];
  reasoning?: ReasoningCapability;
  pricing?: ModelPricing;
  serviceTiers?: string[];
  /** 这个模型单独的线格式；缺省继承供应商的 `endpointFormat`。 */
  endpointFormat?: EndpointFormat;
};

/* ── 推理常量：逐个从 Shadow 的 model-provider-preset-types.ts 抄来（去掉视频/订阅相关） ── */

export const XIAOMI_REASONING: ReasoningCapability = {
  supportedEfforts: ["off", "low", "medium", "high"],
  defaultEffort: "high",
  requestProtocol: "mimo-chat-completions",
};

export const MINIMAX_M3_REASONING: ReasoningCapability = {
  supportedEfforts: ["auto", "off"],
  defaultEffort: "auto",
  requestProtocol: "anthropic-thinking",
};

export const MINIMAX_BUILT_IN_REASONING: ReasoningCapability = {
  supportedEfforts: ["auto"],
  defaultEffort: "auto",
  requestProtocol: "none",
};

export const GLM_REASONING: ReasoningCapability = {
  supportedEfforts: ["off", "high", "max"],
  defaultEffort: "max",
  requestProtocol: "glm-chat-completions",
};

export const CODEX_RESPONSES_REASONING: ReasoningCapability = {
  supportedEfforts: ["low", "medium", "high", "max"],
  defaultEffort: "high",
  requestProtocol: "openai-responses",
};

/* ── 档案构造器（逐字来自 Shadow 的 builders，视频那几个函数未移植） ── */

export function textChatProfile(
  contextWindowTokens?: number,
  reasoning?: ReasoningCapability,
  endpointFormat?: EndpointFormat,
): ModelProfile {
  return {
    ...(contextWindowTokens ? { contextWindowTokens } : {}),
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsToolCalling: true,
    messageParts: ["text"],
    ...(reasoning ? { reasoning } : {}),
    ...(endpointFormat ? { endpointFormat } : {}),
  };
}

export function visionChatProfile(
  contextWindowTokens?: number,
  reasoning?: ReasoningCapability,
  endpointFormat?: EndpointFormat,
): ModelProfile {
  return {
    ...(contextWindowTokens ? { contextWindowTokens } : {}),
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    supportsToolCalling: true,
    messageParts: ["text", "image_url"],
    ...(reasoning ? { reasoning } : {}),
    ...(endpointFormat ? { endpointFormat } : {}),
  };
}

export function xiaomiTextChatProfile(contextWindowTokens: number): ModelProfile {
  return textChatProfile(contextWindowTokens, XIAOMI_REASONING);
}

export function xiaomiVisionChatProfile(contextWindowTokens: number): ModelProfile {
  return visionChatProfile(contextWindowTokens, XIAOMI_REASONING);
}

export function minimaxM3ChatProfile(): ModelProfile {
  return visionChatProfile(1_000_000, MINIMAX_M3_REASONING);
}

export function minimaxM2ChatProfile(): ModelProfile {
  return textChatProfile(204_800, MINIMAX_BUILT_IN_REASONING);
}

export function withPriorityServiceTier(profile: ModelProfile): ModelProfile {
  return { ...profile, serviceTiers: ["priority"] };
}

/** 深拷贝——改一个模型的档案时不能顺手改到常量本身（Shadow 同名函数的作用）。 */
export function copyModelProfiles(profiles: Record<string, ModelProfile> | undefined): Record<string, ModelProfile> {
  if (profiles === undefined) return {};
  return Object.fromEntries(
    Object.entries(profiles).map(([modelId, profile]) => [
      modelId,
      {
        ...profile,
        ...(profile.aliases ? { aliases: [...profile.aliases] } : {}),
        inputModalities: [...profile.inputModalities],
        outputModalities: [...profile.outputModalities],
        messageParts: [...profile.messageParts],
        ...(profile.serviceTiers ? { serviceTiers: [...profile.serviceTiers] } : {}),
        ...(profile.reasoning
          ? {
              reasoning: {
                supportedEfforts: [...profile.reasoning.supportedEfforts],
                defaultEffort: profile.reasoning.defaultEffort,
                requestProtocol: profile.reasoning.requestProtocol,
              },
            }
          : {}),
      },
    ]),
  );
}

/** 一个只说文本、不会调工具的模型（本地小模型常见的形状）。 */
export function plainTextProfile(contextWindowTokens?: number): ModelProfile {
  return {
    ...(contextWindowTokens ? { contextWindowTokens } : {}),
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsToolCalling: false,
    messageParts: ["text"],
  };
}

/** 人类可读的一行摘要，用在模型 chips 的 tooltip 上。 */
export function describeProfile(profile: ModelProfile | undefined): string {
  if (profile === undefined) return "未填写模型档案";
  const parts: string[] = [];
  if (profile.contextWindowTokens !== undefined) {
    parts.push(`上下文 ${Math.round(profile.contextWindowTokens / 1000)}K`);
  }
  if (profile.maxOutputTokens !== undefined) parts.push(`输出 ${Math.round(profile.maxOutputTokens / 1000)}K`);
  if (profile.inputModalities.includes("image")) parts.push("可看图");
  if (profile.inputModalities.includes("audio")) parts.push("可听音");
  parts.push(profile.supportsToolCalling ? "会调工具" : "不调工具");
  if (profile.reasoning !== undefined) parts.push(`推理 ${profile.reasoning.supportedEfforts.join("/")}`);
  return parts.join(" · ");
}
