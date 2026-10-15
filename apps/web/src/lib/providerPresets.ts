/**
 * Provider presets —— 从用户自己的 Shadow 全量搬过来的目录。
 *
 * 出处：`~/Desktop/shadow/src/shared/model-provider-preset-catalog-{core,extended}.ts`（同一个作者的项目，
 * 见 DECISIONS ADR-015 补充）。每一行都带 `source`，将来某个端点了、模型换了，能顺着它回去核对。
 *
 * 与 Shadow 的两点差别，都写在数据里而不是藏着：
 * 1. **没有视频**：video 能力字段在生成时就丢掉了（用户要求）。
 * 2. `kind !== "http"` 的行（订阅 / CLI 委托那一类）标记 `needsVerification`，界面上会写明原因——
 *    我们的 bridge 现在只会说 HTTP。
 */

import type { ProviderProfile } from "./providers.ts";

export type ProviderPresetCapability = {
  /** Shadow 里这一项能力用的协议名。 */
  protocol: string;
  baseUrl: string;
  models: string[];
};

export type ProviderPreset = {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
  /** 这家预置的非对话能力（生图 / 语音识别 / 语音合成 / 音乐），端点与模型都来自 Shadow。 */
  capabilities?: Partial<Record<"image" | "speech" | "textToSpeech" | "music", ProviderPresetCapability>>;
  source: string;
  /** 端点或登录方式仍需核实 / 暂不支持时置 true，界面会说明。 */
  needsVerification?: boolean;
  /** 为什么需要核实（有就显示给用户）。 */
  note?: string;
};

export const PROVIDER_PRESETS: ReadonlyArray<ProviderPreset> = [
  {
    id: "litellm",
    label: "LiteLLM",
    baseUrl: "http://localhost:4000",
    models: [],
    source: "shadow · model-provider-preset-catalog-core.ts / -extended.ts",
  },
  {
    id: "longcat",
    label: "LongCat",
    baseUrl: "https://api.longcat.chat/openai",
    models: ["LongCat-2.0-Preview"],
    source: "shadow · model-provider-preset-catalog-core.ts / -extended.ts",
  },
  {
    id: "claude-subscription",
    label: "Claude (Pro/Max 订阅)",
    baseUrl: "https://api.anthropic.com",
    models: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
    source: "shadow · model-provider-preset-catalog-core.ts / -extended.ts",
    needsVerification: true,
    note: "订阅 / CLI 登录方式（agent-sdk）暂不支持：bridge 现在只说 HTTP",
  },
  {
    id: "zhipu-coding-plan",
    label: "Zhipu Coding Plan",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
    models: [],
    source: "shadow · model-provider-preset-catalog-core.ts / -extended.ts",
  },
  {
    id: "zai-coding-plan",
    label: "Z.ai Coding Plan",
    baseUrl: "https://api.z.ai/api/coding/paas/v4/chat/completions",
    models: [],
    source: "shadow · model-provider-preset-catalog-core.ts / -extended.ts",
  },
  {
    id: "kimi-code",
    label: "Kimi Code",
    baseUrl: "https://api.kimi.com/coding/v1",
    models: ["k3", "kimi-for-coding", "kimi-for-coding-highspeed"],
    source: "shadow · model-provider-preset-catalog-core.ts / -extended.ts",
  },
  {
    id: "volcengine",
    label: "Volcano Ark API",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    models: [],
    capabilities: {
      image: { protocol: "volcengine-ark-image", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", models: [] },
    },
    source: "shadow · model-provider-preset-catalog-core.ts / -extended.ts",
    /** MiniMax preset-note-sweep #410 ④：有能力却零说明——note 是界面唯一的说明位。 */
    note: "ark.cn-beijing.volces.com/api/v3：目录给的端点，未实测；image 能力没带模型名，保存 Key 后先到「模型」页签拉取，再做生图。",
  },
  {
    id: "volcengine-agent-plan",
    label: "Volcano Ark Agent Plan",
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
    models: [],
    capabilities: {
      image: { protocol: "volcengine-ark-image", baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3", models: ["doubao-seedream-5.0-lite"] },
    },
    source: "shadow · model-provider-preset-catalog-core.ts / -extended.ts",
    note: "ark.cn-beijing.volces.com/api/plan/v3：目录给的端点，未实测；image 能力带 doubao-seedream-5.0-lite，配好后用一次生图验真。",
  },
  {
    id: "volcengine-coding-plan",
    label: "Volcano Ark Coding Plan",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    models: ["doubao-seed-1-6-250615", "doubao-seed-1-6-flash-250828"],
    source: "shadow · model-provider-preset-catalog-core.ts / -extended.ts",
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    models: ["grok-4.5", "glm-5.2", "glm-5.1", "glm-5", "kimi-k2.7", "kimi-k2.7-code", "kimi-k2.6", "deepseek-v4-pro", "deepseek-v4-flash", "mimo-v2.5", "mimo-v2.5-pro", "mimo-v2-pro", "mimo-v2-omni", "minimax-m3", "minimax-m2.7", "minimax-m2.5", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen3.5-plus"],
    source: "shadow · model-provider-preset-catalog-core.ts / -extended.ts",
  },
  {
    id: "zenmux",
    label: "ZenMux API",
    baseUrl: "https://zenmux.ai/api/v1",
    models: [],
    source: "shadow · model-provider-preset-catalog-core.ts / -extended.ts",
    needsVerification: true,
    /**
     * 这条 note 原来错挂在 ZenMux 上——内容是 MiniMax 的域名/协议实测（Codex 05:1x 复盘 #406 时发现：
     * minimax 预设自己没有 note，界面永远不显示那段说明；ZenMux 反而在讲别人的 key）。
     * 现在归位：MiniMax 的实测说明搬到 minimax 预设；ZenMux 留一句真话（端点尚未实测）。
     * 补充（MiniMax preset-note-sweep #410 ⑤）：原来那句「配好 Key 后点测试连接」和界面对不上——
     * 这家 models 为空，「测试连接」按钮是 disabled 的，用户照 note 做不了；改成先拉模型的路径。
     */
    note: "端点待核实：目录里给的是 zenmux.ai/api/v1，我们没实测过这家。这家没内置模型——先到「模型」页签拉取（或手动加一个），再回「连接」点「测试连接」验证。",
  },
  {
    id: "moonshot-cn",
    label: "Moonshot CN",
    baseUrl: "https://api.moonshot.cn/v1",
    models: [],
    source: "shadow · model-provider-preset-catalog-core.ts / -extended.ts",
  },
  {
    id: "moonshot-global",
    label: "Moonshot Global",
    baseUrl: "https://api.moonshot.ai/v1",
    models: [],
    source: "shadow · model-provider-preset-catalog-core.ts / -extended.ts",
  },
  {
    id: "xiaomi",
    label: "Xiaomi",
    baseUrl: "https://api.xiaomimimo.com/v1",
    models: ["mimo-v2.5-pro", "mimo-v2.5", "mimo-v2-pro", "mimo-v2-omni"],
    capabilities: {
      speech: { protocol: "mimo-asr", baseUrl: "https://api.xiaomimimo.com/v1", models: ["mimo-v2.5-asr"] },
      textToSpeech: { protocol: "mimo-tts", baseUrl: "https://api.xiaomimimo.com/v1", models: ["mimo-v2.5-tts", "mimo-v2.5-tts-voicedesign", "mimo-v2.5-tts-voiceclone"] },
    },
    source: "shadow · model-provider-preset-catalog-core.ts / -extended.ts",
    note: "api.xiaomimimo.com/v1：目录给的端点，未实测；这家自带语音能力（speech mimo-v2.5-asr / textToSpeech mimo-v2.5-*）——把「语音识别」角色指到它，通话就不必依赖 Chrome 的在线识别。",
  },
  {
    id: "minimax",
    label: "MiniMax",
    baseUrl: "https://api.minimaxi.com/v1",
    models: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5", "MiniMax-M2.5-highspeed", "MiniMax-M2.1", "MiniMax-M2.1-highspeed", "MiniMax-M2"],
    capabilities: {
      image: { protocol: "minimax-image", baseUrl: "https://api.minimaxi.com", models: ["image-01", "image-01-live"] },
      textToSpeech: { protocol: "minimax-t2a", baseUrl: "https://api.minimaxi.com", models: ["speech-2.8-hd", "speech-2.8-turbo"] },
      // 语音识别：形状 2026-10-16 用用户 key 实测（/v1/speech_to_text，multipart，asr-1.0）。
      // 之前 MiniMax 这家没有 speech 一条 —— 所以「语音识别」在设置里根本选不到它，
      // 通话只能退回 Chrome 自带的识别（要连 Google，国内不通）= 用户说的「根本用不了」。
      speech: { protocol: "minimax-asr", baseUrl: "https://api.minimaxi.com", models: ["asr-1.0"] },
      music: { protocol: "minimax-music", baseUrl: "https://api.minimaxi.com", models: ["music-2.6", "music-cover", "music-2.6-free", "music-cover-free"] },
    },
    source: "shadow · model-provider-preset-catalog-core.ts / -extended.ts",
    /**
     * 实测口径（原来错挂在 zenmux 上）：国内 key 认 api.minimaxi.com，国际版换 api.minimax.io；
     * 音乐 API 已对新用户关闭。MiniMax preset-note-sweep #410 ③ 补：语音识别也是这家，
     * 而且它直接决定通话能不能用（没配 speech 时通话只能退回 Chrome 在线识别=国内不通）。
     */
    note: "国内 key（sk-cp-…）走 api.minimaxi.com：实测 OpenAI 兼容端点是 https://api.minimaxi.com/v1（857ms 回复），同一把 key 在 api.minimax.io 会报 invalid api key；shadow 预设里的 /anthropic 是 Anthropic 协议，我们的适配器不会说，所以这里改成了 /v1。国际版把 Base URL 与各能力端点换成 api.minimax.io。另外 MiniMax 的 music API 已对新用户关闭（HTTP 410 / 2153），音乐请用本地合成器。语音识别（speech, asr-1.0）同样走这一家：把它选成「语音识别」角色，通话就用桥式 STT，不再依赖 Chrome 的在线识别。",
  },
  {
    id: "aliyun",
    label: "Aliyun",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-max", "qwen-plus", "qwen-flash", "qwen3-coder-plus", "qwq-plus", "qwen-vl-max", "qwen3-vl-plus"],
    source: "shadow · model-provider-preset-catalog-core.ts / -extended.ts",
  },
  {
    id: "tencentcloud",
    label: "Tencent Cloud",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    models: ["hunyuan-turbos-latest", "hunyuan-t1-latest", "hunyuan-lite"],
    source: "shadow · model-provider-preset-catalog-core.ts / -extended.ts",
  },
  {
    id: "vercel-ai-gateway",
    label: "Vercel AI Gateway",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    models: [],
    source: "shadow · model-provider-preset-catalog-core.ts / -extended.ts",
  },
];

/** 预设按 id 取；自定义端点返回 undefined。 */
export function presetById(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

/** 一行摘要：端点是事实，模型与能力数量是承诺，待核实的直说。 */
export function describePreset(preset: ProviderPreset): string {
  const parts = [preset.baseUrl];
  if (preset.models.length > 0) parts.push(`${preset.models.length} 个模型`);
  if (preset.capabilities !== undefined) parts.push(`${Object.keys(preset.capabilities).length} 项能力`);
  if (preset.needsVerification === true) parts.push(preset.note ?? "端点待核实");
  return parts.join(" · ");
}


/** Shadow 的协议名 → 我们的线格式。 */
export function presetProtocol(protocol: string): "chat_completions" | "responses" | "messages" | "custom_endpoint" {
  if (protocol.includes("anthropic") || protocol === "messages") return "messages";
  if (protocol.includes("responses")) return "responses";
  if (protocol.includes("openai") || protocol.includes("chat")) return "chat_completions";
  return "custom_endpoint";
}

/** 预设里那四项能力对应我们的哪个角色（speech 是语音识别）。 */
export const PRESET_CAPABILITY_KIND = {
  image: "image",
  speech: "stt",
  textToSpeech: "tts",
  music: "music",
} as const;

/**
 * 选一家预设时填进供应商表单的默认值 —— SettingsPage 的 choosePreset 用它，
 * 单测在这里把每家的默认值钉住（F-8：折叠层的默认值写错就是静默错配）。
 * 端点/协议的进一步兜底（f57b571「按端点认家」）在 bridge 的 resolveMediaProtocol，这里不动。
 */
export function providerDefaultsFromPreset(
  preset: ProviderPreset,
): Pick<ProviderProfile, "name" | "baseUrl" | "presetSource" | "models" | "capabilities"> {
  /**
   * 能力也一起预填：Shadow 的目录里 MiniMax / Xiaomi / Volcengine 这些家写了各自的 TTS、生图、
   * 音乐端点与模型，选它们的时候不该让用户再填一遍。协议名从 Shadow 的说法翻成我们的线格式。
   */
  const capabilities: ProviderProfile["capabilities"] = {};
  for (const [key, config] of Object.entries(preset.capabilities ?? {})) {
    const kind = PRESET_CAPABILITY_KIND[key as keyof typeof PRESET_CAPABILITY_KIND];
    if (kind === undefined) continue;
    capabilities[kind] = {
      protocol: presetProtocol(config.protocol),
      baseUrl: config.baseUrl === "" ? preset.baseUrl : config.baseUrl,
      models: config.models,
    };
  }
  return { name: preset.label, baseUrl: preset.baseUrl, presetSource: preset.id, models: preset.models, capabilities };
}
