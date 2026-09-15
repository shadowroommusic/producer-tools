/**
 * Provider presets: pick a service instead of typing its endpoint.
 *
 * Adding a provider used to ask for five fields (name, Base URL, protocol, credential name, key) and then
 * for an endpoint per capability. That is the app asking the user to do its job — 一家就是「一个网址 +
 * 一把 Key」，模型和能力都可以随后自动拉。
 *
 * Where the data comes from: the rows below are taken from the user's own Shadow app
 * (`~/Desktop/shadow/src/shared/model-provider-preset-catalog-{core,extended}.ts`) — same author, so
 * copying the values is sanctioned (DECISIONS ADR-015 addendum). Two rules still apply:
 *
 * 1. `baseUrl` and model ids are **facts about public APIs**, and they go stale — each row says where it
 *    came from so the next reader can re-check it instead of trusting it.
 * 2. Anything not verified here is marked `needsVerification: true` and the UI says so, rather than
 *    presenting a guess as a preset (`AGENTS.md`: 不猜).
 */

export type ProviderPreset = {
  id: string;
  label: string;
  /** The chat endpoint. Capabilities inherit it unless they override it. */
  baseUrl: string;
  /** Models worth offering as a starting point; 「拉取模型」 replaces them with the real list. */
  models: string[];
  /** Where the row came from, so a stale value can be traced. */
  source: string;
  /** True when the endpoint still has to be confirmed against the provider's docs. */
  needsVerification?: boolean;
};

export const PROVIDER_PRESETS: ReadonlyArray<ProviderPreset> = [
  {
    id: "minimax",
    label: "MiniMax",
    // Shadow ships MiniMax on its Anthropic-compatible route; the OpenAI-compatible one has to be
    // confirmed before we offer it (the reported hosts differ: api.minimax.cn / api.minimaxi.com).
    baseUrl: "https://api.minimaxi.com/anthropic",
    models: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5", "MiniMax-M2.5-highspeed", "MiniMax-M2.1"],
    source: "shadow · model-provider-preset-catalog-extended.ts (id: minimax)",
    needsVerification: true,
  },
  {
    id: "moonshot-cn",
    label: "Moonshot （国内）",
    baseUrl: "https://api.moonshot.cn/v1",
    models: [],
    source: "shadow · model-provider-preset-catalog-core.ts (id: moonshot-cn)",
  },
  {
    id: "moonshot-global",
    label: "Moonshot （国际）",
    baseUrl: "https://api.moonshot.ai/v1",
    models: [],
    source: "shadow · model-provider-preset-catalog-core.ts (id: moonshot-global)",
  },
  {
    id: "aliyun",
    label: "Aliyun DashScope",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-max", "qwen-plus", "qwen-flash", "qwen3-coder-plus", "qwq-plus", "qwen-vl-max"],
    source: "shadow · model-provider-preset-catalog-extended.ts (id: aliyun)",
  },
  {
    id: "volcengine",
    label: "Volcano Ark（火山方舟）",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    models: [],
    source: "shadow · model-provider-preset-catalog-core.ts (id: volcengine)",
  },
  {
    id: "zhipu-coding-plan",
    label: "Zhipu（智谱）",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
    models: [],
    source: "shadow · model-provider-preset-catalog-core.ts (id: zhipu-coding-plan)",
    needsVerification: true,
  },
  {
    id: "kimi-code",
    label: "Kimi Code",
    baseUrl: "https://api.kimi.com/coding/v1",
    models: ["k3", "kimi-for-coding", "kimi-for-coding-highspeed"],
    source: "shadow · model-provider-preset-catalog-core.ts (id: kimi-code)",
  },
  {
    id: "xiaomi",
    label: "Xiaomi MiMo",
    baseUrl: "https://api.xiaomimimo.com/v1",
    models: ["mimo-v2.5-pro", "mimo-v2.5", "mimo-v2-pro", "mimo-v2-omni"],
    source: "shadow · model-provider-preset-catalog-extended.ts (id: xiaomi)",
  },
  {
    id: "tencentcloud",
    label: "Tencent Hunyuan",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    models: ["hunyuan-turbos-latest", "hunyuan-t1-latest", "hunyuan-lite"],
    source: "shadow · model-provider-preset-catalog-extended.ts (id: tencentcloud)",
  },
  {
    id: "litellm",
    label: "LiteLLM（本地网关）",
    baseUrl: "http://localhost:4000",
    models: [],
    source: "shadow · model-provider-preset-catalog-core.ts (id: litellm)",
  },
];

/** The preset a user picked, or undefined for a custom (hand-typed) endpoint. */
export function presetById(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

/**
 * What the add form shows once a preset is chosen: the endpoint (read-only, as a fact) and the default
 * models, so the user can see what they are about to get without opening anything.
 */
export function describePreset(preset: ProviderPreset): string {
  const parts = [preset.baseUrl];
  if (preset.models.length > 0) parts.push(`${preset.models.length} 个模型`);
  if (preset.needsVerification === true) parts.push("端点待核实");
  return parts.join(" · ");
}
