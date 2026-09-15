/**
 * 供应商与角色：形状照搬用户自己的 Shadow（`src/shared/app-settings-types-provider.ts`）。
 *
 * 一个供应商 = 一个端点 + 一把 Key，`models` 是它的**对话模型列表**（可以多个，主模型从这里选），
 * `modelProfiles` 是每个模型的档案（上下文、模态、工具调用、推理档），`capabilities` 是它的其它能力
 * （语音合成 / 音色克隆 / 语音识别 / 生图 / 音乐生成，各有自己的协议、端点与模型列表）。
 *
 * 与 Shadow 的唯一差别：**没有 video**——类型、能力枚举、预设里都不留它的位置，
 * 免得以后有人以为支持（用户明确要求，见 DECISIONS ADR-015 补充）。
 *
 * 第一原则照旧：能推导的不存。所以没有 `slots`、没有「默认模型」这种第二份真相——
 * 角色的绑定是 `{providerId, capability, model}`，模型从供应商自己的列表里来。
 */
import { copyModelProfiles, type EndpointFormat, type ModelProfile } from "./providerModel.ts";

/** 角色种类。`agent` 用供应商的 `models`，其它用 `capabilities[kind].models`。 */
export type CapabilityKind = "agent" | "tts" | "voice_clone" | "stt" | "image" | "music";

/** 角色表（设置页按这个顺序显示）。非 agent 的几项就是「能力」页签里的卡片。 */
export const CAPABILITIES: ReadonlyArray<{ kind: CapabilityKind; label: string; hint: string }> = [
  { kind: "agent", label: "主模型 · Main", hint: "对话、写歌、调用工具——只有它出现在对话页的模型开关里" },
  { kind: "tts", label: "语音合成 · TTS", hint: "把文字念出来（朗读回复、语音通话里的声音）" },
  { kind: "voice_clone", label: "音色克隆 · Voice Clone", hint: "用一段样本做自己的音色，给语音合成用" },
  { kind: "stt", label: "语音识别 · STT", hint: "把你说的话转成文字（默认用浏览器自带的）" },
  { kind: "image", label: "生图 · Image", hint: "封面、配图这类图像生成" },
  { kind: "music", label: "音乐生成 · Music", hint: "让模型按描述写一段音乐（本地合成器之外的第二条路）" },
];

/** 能力页签里的卡片：除主模型以外的全部（Shadow 的能力页就是生图/语音/音乐那几张，没有视频）。 */
export const PROVIDER_CAPABILITIES = CAPABILITIES.filter((entry) => entry.kind !== "agent");

/** 一项能力的配置：协议 + 端点 + 模型列表（照抄 Shadow 的 `ModelProvider*CapabilityV1`）。 */
export type CapabilityConfig = {
  protocol: EndpointFormat;
  baseUrl: string;
  models: string[];
};

export type ProviderProfile = {
  id: string;
  name: string;
  baseUrl: string;
  /** 凭证名（值在 bridge，0600）。`null` = 这家不需要 Key（本地服务）。 */
  credentialRef: string | null;
  endpointFormat: EndpointFormat;
  enabled: boolean;
  /** 来自哪个预设（`providerPresets.ts` 的 id），自定义端点为空。 */
  presetSource?: string;
  /** 对话模型。主模型从这里选——**可以多个**。 */
  models: string[];
  /** 每个模型的档案；没有档案的模型按「未知」处理，而不是编一个。 */
  modelProfiles: Record<string, ModelProfile>;
  /** 其它能力，没有这一项 = 这家不提供它。 */
  capabilities: Partial<Record<CapabilityKind, CapabilityConfig>>;
};

/** 角色 → 哪个供应商的哪项能力、用哪个模型。没有绑定就是 `null`。 */
export type RoleBinding = { providerId: string; capability: CapabilityKind; model: string } | null;

export type ModelSettings = {
  /** 3：供应商持有 `models` + `modelProfiles`，能力是 `{protocol, baseUrl, models}`，角色带 model。 */
  version: 3;
  providers: ProviderProfile[];
  roles: Record<CapabilityKind, RoleBinding>;
};

/** 能力开启时的预填（照抄 Shadow 的 `defaultXCapability(baseUrl)` 思路：协议默认、端点沿用、模型空）。 */
export const CAPABILITY_DEFAULT_PROTOCOL: Record<Exclude<CapabilityKind, "agent">, EndpointFormat> = {
  tts: "chat_completions",
  voice_clone: "custom_endpoint",
  stt: "chat_completions",
  image: "chat_completions",
  music: "chat_completions",
};

export function emptySettings(): ModelSettings {
  return {
    version: 3,
    providers: [],
    roles: { agent: null, tts: null, voice_clone: null, stt: null, image: null, music: null },
  };
}

export const SETTINGS_KEY = "shadowroom.models.v1";

export function loadModelSettings(): ModelSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (raw === null) return emptySettings();
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return emptySettings();
  }
}

export function saveModelSettings(settings: ModelSettings): void {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage blocked: the in-memory settings still work for this session */
  }
}

/** v1（只有 slots）/ v2（能力里塞一个 defaultModel）→ v3（供应商持有模型列表）。 */
export function normalizeSettings(parsed: unknown): ModelSettings {
  const base = emptySettings();
  if (parsed === null || typeof parsed !== "object") return base;
  const raw = parsed as {
    version?: number;
    providers?: Array<Record<string, unknown>>;
    slots?: Array<{ id: string; providerId: string; capability: CapabilityKind; model: string }>;
    roles?: Record<string, unknown>;
  };
  if (!Array.isArray(raw.providers)) return base;
  const legacySlots = Array.isArray(raw.slots) ? raw.slots : [];
  /**
   * Already version 3? Then the providers are authoritative and must be taken as they are. The first
   * version of this function only knew the v1/v2 shape, so a round trip through it **dropped every
   * capability** (v3 capabilities have no `enabled` flag to look at) — measured by seeding a v3 store
   * and watching the TTS role come back 未配置.
   */
  if (raw.version === 3) {
    const providers = raw.providers.map((entry) => ({
      id: String(entry.id ?? ""),
      name: String(entry.name ?? entry.label ?? entry.id ?? ""),
      baseUrl: String(entry.baseUrl ?? "").trim().replace(/\/+$/, ""),
      credentialRef: entry.credentialRef === null || entry.credentialRef === undefined ? null : String(entry.credentialRef),
      endpointFormat: (entry.endpointFormat ?? "chat_completions") as EndpointFormat,
      enabled: entry.enabled !== false,
      ...(typeof entry.presetSource === "string" ? { presetSource: entry.presetSource } : {}),
      models: Array.isArray(entry.models) ? (entry.models as string[]).map(String) : [],
      modelProfiles: copyModelProfiles((entry.modelProfiles ?? {}) as Record<string, ModelProfile>),
      capabilities: (entry.capabilities ?? {}) as ProviderProfile["capabilities"],
    }));
    const roles: ModelSettings["roles"] = { ...base.roles };
    for (const kind of Object.keys(roles) as CapabilityKind[]) {
      const stored = raw.roles?.[kind] as RoleBinding | null | undefined;
      roles[kind] =
        stored !== null && stored !== undefined && typeof stored === "object" && typeof stored.providerId === "string" && typeof stored.model === "string"
          ? { providerId: stored.providerId, capability: (stored.capability ?? kind) as CapabilityKind, model: stored.model }
          : null;
    }
    return { version: 3, providers, roles };
  }

  const providers: ProviderProfile[] = raw.providers.map((entry) => {
    const id = String(entry.id ?? `p-${Math.random().toString(36).slice(2, 8)}`);
    const label = String(entry.name ?? entry.label ?? id);
    const baseUrl = String(entry.baseUrl ?? "").trim().replace(/\/+$/, "");
    const endpointFormat = (entry.endpointFormat ?? legacyFormat(entry.protocol)) as EndpointFormat;
    const models = new Set<string>(Array.isArray(entry.models) ? (entry.models as string[]).map(String) : []);
    const capabilities: ProviderProfile["capabilities"] = {};

    /** v2：`capabilities[kind] = {enabled, protocol?, baseUrl?, defaultModel?, extraModels?}`。 */
    const legacyCapabilities = (entry.capabilities ?? {}) as Record<
      string,
      { enabled?: boolean; protocol?: string; baseUrl?: string; defaultModel?: string; extraModels?: string[] }
    >;
    for (const [kind, config] of Object.entries(legacyCapabilities)) {
      if (config?.enabled !== true) continue;
      const kindModels = [config.defaultModel, ...(config.extraModels ?? [])]
        .map((model) => String(model ?? "").trim())
        .filter((model) => model !== "");
      if (kind === "agent") {
        for (const model of kindModels) models.add(model);
        continue;
      }
      capabilities[kind as CapabilityKind] = {
        protocol: (config.protocol ?? endpointFormat) as EndpointFormat,
        baseUrl: (config.baseUrl ?? baseUrl).trim().replace(/\/+$/, ""),
        models: kindModels,
      };
    }
    /** v1：老 `slots` 里每一项折进它属于的那个地方。 */
    for (const slot of legacySlots.filter((candidate) => candidate.providerId === id)) {
      const model = String(slot.model ?? "").trim();
      if (model === "") continue;
      if (slot.capability === "agent") {
        models.add(model);
        continue;
      }
      const existing = capabilities[slot.capability] ?? { protocol: endpointFormat, baseUrl, models: [] };
      capabilities[slot.capability] = { ...existing, models: [...new Set([...existing.models, model])] };
    }

    return {
      id,
      name: label,
      baseUrl,
      credentialRef: entry.credentialRef === null || entry.credentialRef === undefined ? null : String(entry.credentialRef),
      endpointFormat,
      enabled: entry.enabled !== false,
      ...(typeof entry.presetSource === "string" ? { presetSource: entry.presetSource } : {}),
      models: [...models],
      modelProfiles: copyModelProfiles(
        (entry.modelProfiles ?? {}) as Record<string, ModelProfile>,
      ),
      capabilities,
    };
  });

  const roles: ModelSettings["roles"] = { ...base.roles };
  for (const kind of Object.keys(roles) as CapabilityKind[]) {
    const stored = raw.roles?.[kind];
    if (stored === null || stored === undefined) {
      roles[kind] = null;
      continue;
    }
    if (typeof stored === "object") {
      const binding = stored as { providerId?: unknown; capability?: unknown; model?: unknown };
      if (typeof binding.providerId === "string" && typeof binding.model === "string") {
        roles[kind] = {
          providerId: binding.providerId,
          capability: (typeof binding.capability === "string" ? binding.capability : kind) as CapabilityKind,
          model: binding.model,
        };
      }
      continue;
    }
    /** v1/v2：字符串形式的 `providerId:capability` 或老 slot id。 */
    const id = String(stored);
    const fromLegacySlot = legacySlots.find((candidate) => candidate.id === id);
    const [providerId, capability] = (fromLegacySlot === undefined ? id : `${fromLegacySlot.providerId}:${fromLegacySlot.capability}`).split(":");
    const provider = providers.find((candidate) => candidate.id === providerId);
    if (provider === undefined) {
      roles[kind] = null;
      continue;
    }
    const wanted = (capability ?? kind) as CapabilityKind;
    const model = fromLegacySlot?.model ?? (wanted === "agent" ? provider.models[0] : provider.capabilities[wanted]?.models[0]);
    roles[kind] = model === undefined ? null : { providerId, capability: wanted, model };
  }
  return { version: 3, providers, roles };
}

function legacyFormat(protocol: unknown): EndpointFormat {
  if (protocol === "openai") return "chat_completions";
  if (protocol === "elevenlabs") return "custom_endpoint";
  if (protocol === "custom") return "custom_endpoint";
  return "chat_completions";
}

/** 凭证名从供应商名字派生（Shadow 的 `<ROUTE>_API_KEY` 思路）；同名时加序号。 */
export function credentialNameFor(name: string, taken: string[] = []): string {
  const stem = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "provider";
  if (!taken.includes(stem)) return stem;
  for (let index = 2; index < 100; index += 1) {
    if (!taken.includes(`${stem}-${index}`)) return `${stem}-${index}`;
  }
  return `${stem}-${taken.length + 1}`;
}

/** 界面只显示掩码与后四位，从不回显 Key。 */
export function maskKey(value: string | undefined): string {
  if (value === undefined || value === "") return "";
  return `••••••••${value.length > 4 ? value.slice(-4) : ""}`;
}

/** 供应商至少要有名字和 http(s) 端点。 */
export function providerProblems(profile: Pick<ProviderProfile, "name" | "baseUrl">): string[] {
  const problems: string[] = [];
  if (profile.name.trim() === "") problems.push("给它起个名字");
  const url = profile.baseUrl.trim();
  if (url === "") problems.push("填 Base URL");
  else if (!/^https?:\/\//i.test(url)) problems.push("Base URL 要以 http:// 或 https:// 开头");
  return problems;
}

/** 这家提供了哪项能力（没开就是 undefined）。 */
export function capabilityOf(provider: ProviderProfile, kind: CapabilityKind): CapabilityConfig | undefined {
  if (kind === "agent") {
    return provider.models.length === 0
      ? undefined
      : { protocol: provider.endpointFormat, baseUrl: provider.baseUrl, models: provider.models };
  }
  return provider.capabilities[kind];
}

/** 一项能力实际会调用的地方（协议、端点、模型列表）。 */
export function capabilityTarget(provider: ProviderProfile, kind: CapabilityKind): CapabilityConfig {
  const config = capabilityOf(provider, kind);
  return (
    config ?? {
      protocol: provider.endpointFormat,
      baseUrl: provider.baseUrl,
      models: [],
    }
  );
}

/** 角色实际绑定到的供应商 + 能力 + 模型，任何一环缺失就返回 undefined。 */
export function roleTarget(
  settings: ModelSettings,
  role: CapabilityKind,
): { provider: ProviderProfile; capability: CapabilityKind; model: string } | undefined {
  const binding = settings.roles[role];
  if (binding === null) return undefined;
  const provider = settings.providers.find((entry) => entry.id === binding.providerId);
  if (provider === undefined || provider.enabled === false) return undefined;
  const config = capabilityOf(provider, binding.capability);
  if (config === undefined || !config.models.includes(binding.model)) return undefined;
  return { provider, capability: binding.capability, model: binding.model };
}

export function roleSummary(settings: ModelSettings, role: CapabilityKind): string {
  const target = roleTarget(settings, role);
  return target === undefined ? "未配置" : `${target.provider.name} · ${target.model}`;
}

/**
 * 对话页模型开关能列出的东西：**所有供应商的所有对话模型**。
 * 规则（用户要求）依旧只在这里表达一次——语音、生图之类的模型永远不会出现在这里。
 */
export function agentModelChoices(settings: ModelSettings): Array<{ provider: ProviderProfile; model: string; profile?: ModelProfile }> {
  const choices: Array<{ provider: ProviderProfile; model: string; profile?: ModelProfile }> = [];
  for (const provider of settings.providers) {
    if (!provider.enabled) continue;
    for (const model of provider.models) {
      const profile = provider.modelProfiles[model];
      choices.push({ provider, model, ...(profile === undefined ? {} : { profile }) });
    }
  }
  return choices;
}

export function upsertProvider(settings: ModelSettings, profile: ProviderProfile): ModelSettings {
  const exists = settings.providers.some((entry) => entry.id === profile.id);
  return {
    ...settings,
    providers: exists ? settings.providers.map((entry) => (entry.id === profile.id ? profile : entry)) : [...settings.providers, profile],
  };
}

/** 删除供应商，并解掉指向它的角色（同一处更新里做完，界面不会瞥见悬空绑定）。 */
export function removeProvider(settings: ModelSettings, providerId: string): ModelSettings {
  const roles = { ...settings.roles };
  for (const role of Object.keys(roles) as CapabilityKind[]) {
    if (roles[role]?.providerId === providerId) roles[role] = null;
  }
  return { ...settings, providers: settings.providers.filter((entry) => entry.id !== providerId), roles };
}

/** 批量加入模型（「拉取模型 → 勾选 → 加入所选」走这里）。 */
export function addModels(settings: ModelSettings, providerId: string, models: string[], kind: CapabilityKind = "agent"): ModelSettings {
  const clean = models.map((model) => model.trim()).filter((model) => model !== "");
  return {
    ...settings,
    providers: settings.providers.map((provider) => {
      if (provider.id !== providerId) return provider;
      if (kind === "agent") return { ...provider, models: [...new Set([...provider.models, ...clean])] };
      const existing = provider.capabilities[kind] ?? { protocol: provider.endpointFormat, baseUrl: provider.baseUrl, models: [] };
      return {
        ...provider,
        capabilities: { ...provider.capabilities, [kind]: { ...existing, models: [...new Set([...existing.models, ...clean])] } },
      };
    }),
  };
}

/** 移除一个模型；如果角色正绑着它，一并解掉。 */
export function removeModel(settings: ModelSettings, providerId: string, model: string, kind: CapabilityKind = "agent"): ModelSettings {
  const providers = settings.providers.map((provider) => {
    if (provider.id !== providerId) return provider;
    if (kind === "agent") {
      const modelProfiles = { ...provider.modelProfiles };
      delete modelProfiles[model];
      return { ...provider, models: provider.models.filter((entry) => entry !== model), modelProfiles };
    }
    const existing = provider.capabilities[kind];
    if (existing === undefined) return provider;
    return { ...provider, capabilities: { ...provider.capabilities, [kind]: { ...existing, models: existing.models.filter((entry) => entry !== model) } } };
  });
  const roles = { ...settings.roles };
  for (const role of Object.keys(roles) as CapabilityKind[]) {
    const binding = roles[role];
    if (binding !== null && binding.providerId === providerId && binding.model === model && binding.capability === kind) roles[role] = null;
  }
  return { ...settings, providers, roles };
}

/** 编辑一个模型的档案（上下文、模态、工具调用、推理档……）。 */
export function setModelProfile(settings: ModelSettings, providerId: string, model: string, profile: ModelProfile | null): ModelSettings {
  return {
    ...settings,
    providers: settings.providers.map((provider) => {
      if (provider.id !== providerId) return provider;
      const modelProfiles = { ...provider.modelProfiles };
      if (profile === null) delete modelProfiles[model];
      else modelProfiles[model] = profile;
      return { ...provider, modelProfiles };
    }),
  };
}

/** 打开/关闭一项能力：打开时按 Shadow 的思路预填（协议默认、端点沿用、模型空）。 */
export function setCapability(settings: ModelSettings, providerId: string, kind: CapabilityKind, config: CapabilityConfig | null): ModelSettings {
  const providers = settings.providers.map((provider) => {
    if (provider.id !== providerId) return provider;
    const capabilities = { ...provider.capabilities };
    if (config === null) delete capabilities[kind];
    else capabilities[kind] = config;
    return { ...provider, capabilities };
  });
  const roles = { ...settings.roles };
  if (config === null) {
    for (const role of Object.keys(roles) as CapabilityKind[]) {
      const binding = roles[role];
      if (binding !== null && binding.providerId === providerId && binding.capability === kind) roles[role] = null;
    }
  }
  return { ...settings, providers, roles };
}

export function defaultCapabilityConfig(provider: ProviderProfile, kind: Exclude<CapabilityKind, "agent">): CapabilityConfig {
  return {
    protocol: kind === "voice_clone" ? "custom_endpoint" : CAPABILITY_DEFAULT_PROTOCOL[kind],
    baseUrl: provider.baseUrl,
    models: [],
  };
}

/** 把角色指到某个供应商的某项能力（模型用那项能力列表里的第一个）。 */
export function assignRole(settings: ModelSettings, role: CapabilityKind, providerId: string, model?: string): ModelSettings {
  const provider = settings.providers.find((entry) => entry.id === providerId);
  const config = provider === undefined ? undefined : capabilityOf(provider, role);
  const chosen = model ?? config?.models[0];
  if (chosen === undefined) return settings;
  return { ...settings, roles: { ...settings.roles, [role]: { providerId, capability: role, model: chosen } } };
}

export function setRoleModel(settings: ModelSettings, role: CapabilityKind, model: string): ModelSettings {
  const binding = settings.roles[role];
  if (binding === null) return settings;
  return { ...settings, roles: { ...settings.roles, [role]: { ...binding, model } } };
}

export function clearRole(settings: ModelSettings, role: CapabilityKind): ModelSettings {
  return { ...settings, roles: { ...settings.roles, [role]: null } };
}
