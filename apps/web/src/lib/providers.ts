/**
 * Which model does what.
 *
 * One 服务商 (provider) is an endpoint plus a credential *name*; the provider declares which
 * **capabilities** it offers (主模型 / 语音合成 / 音色克隆 / 语音识别 / 生图), each with its own
 * protocol, endpoint and default model. Roles then point at `providerId:capability`.
 *
 * Two rules from the project's first principle live here:
 *
 * 1. **The capability is the only truth.** There used to be a persisted `slots` array *and* the roles
 *    pointing into it — two things describing the same assignment. Slots are now derived
 *    ({@link deriveSlots}), so they cannot drift.
 * 2. **Nothing is copied that can be inherited.** A capability's `baseUrl`/`protocol` are empty
 *    unless the user deliberately overrides them; {@link capabilityTarget} resolves the inheritance.
 *    Storing a copy would mean editing the chat endpoint silently leaves an old TTS endpoint behind.
 */

/** What a model can be asked to do. These are also the roles the settings page offers. */
export type CapabilityKind = "agent" | "tts" | "voice_clone" | "stt" | "image";

/** The roles in the order the settings page shows them, with the label a beginner reads. */
export const CAPABILITIES: ReadonlyArray<{ kind: CapabilityKind; label: string; hint: string }> = [
  /* 中文说清楚是什么，后面跟上行业里真正叫的名字（AGENTS.md：行业词不翻译）。 */
  { kind: "agent", label: "主模型 · Main", hint: "对话、写歌、调用工具——只有它出现在对话页的模型开关里" },
  { kind: "tts", label: "语音合成 · TTS", hint: "把文字念出来（朗读回复、语音通话里的声音）" },
  { kind: "voice_clone", label: "音色克隆 · Voice Clone", hint: "用一段样本做自己的音色，给语音合成用" },
  { kind: "stt", label: "语音识别 · STT", hint: "把你说的话转成文字（默认用浏览器自带的）" },
  { kind: "image", label: "生图 · Image", hint: "封面、配图这类图像生成" },
];

/** How a provider's HTTP requests are shaped. `openai` is the common one; `custom` trusts the path. */
export type ProviderProtocol = "openai" | "elevenlabs" | "custom";

/**
 * What one capability needs on top of the provider.
 *
 * Every optional field means **inherit**: an empty `baseUrl` is the provider's chat endpoint, an empty
 * `protocol` is the provider's protocol. That is why they are optional rather than pre-filled — a copy
 * would be a second truth that goes stale the moment the chat endpoint changes.
 */
export type CapabilityOverride = {
  enabled: boolean;
  protocol?: ProviderProtocol;
  baseUrl?: string;
  /** Path override, e.g. `/audio/speech`; the protocol's default path is used when absent. */
  endpointPath?: string;
  /** The model this capability uses. Required once the capability is enabled. */
  defaultModel?: string;
  /** Other models worth offering in the role dropdown; collapsed in the UI. */
  extraModels?: string[];
  /** Capability-specific extras: TTS `voice`, STT `language`, image `size`… */
  options?: Record<string, string>;
};

export type ProviderProfile = {
  id: string;
  label: string;
  /** The chat endpoint. Capabilities inherit it unless they override it. */
  baseUrl: string;
  /** Name of the credential in the bridge's store; `null` when the endpoint needs no key. */
  credentialRef: string | null;
  protocol: ProviderProtocol;
  enabled: boolean;
  capabilities: Partial<Record<CapabilityKind, CapabilityOverride>>;
};

/** A capability, resolved: what to call, where, and with which model. */
export type CapabilityTarget = {
  providerId: string;
  capability: CapabilityKind;
  protocol: ProviderProtocol;
  baseUrl: string;
  endpointPath: string | undefined;
  model: string;
  models: string[];
  options: Record<string, string>;
};

/** Derived, never stored: one slot per enabled capability that names a model. */
export type CapabilitySlot = { id: string; providerId: string; capability: CapabilityKind; model: string };

/** Role → slot id (`providerId:capability`), or `null` when the role is deliberately not configured. */
export type RoleMap = Record<CapabilityKind, string | null>;

export type ModelSettings = {
  /** 2 since capabilities became the truth and slots became derived. */
  version: 2;
  providers: ProviderProfile[];
  roles: RoleMap;
};

/** The default path each capability hits, per protocol — used when a capability overrides nothing. */
export const DEFAULT_PATHS: Record<CapabilityKind, string> = {
  agent: "/chat/completions",
  tts: "/audio/speech",
  voice_clone: "/voices/add",
  stt: "/audio/transcriptions",
  image: "/images/generations",
};

/**
 * What turning a capability on should pre-fill.
 *
 * Not empty boxes: a beginner who switches on 语音合成 should find the model and voice that almost
 * every OpenAI-compatible endpoint uses, and change them only if their provider differs.
 */
export const CAPABILITY_DEFAULTS: Record<CapabilityKind, { model: string; options?: Record<string, string> }> = {
  agent: { model: "" },
  tts: { model: "tts-1", options: { voice: "alloy", format: "mp3" } },
  voice_clone: { model: "eleven_multilingual_v2", options: { samples: "5" } },
  stt: { model: "whisper-1", options: { language: "auto", format: "wav" } },
  image: { model: "", options: { size: "1024x1024", format: "png" } },
};

/** Everything unconfigured: the built-in agent (Codex) is the default main model. */
export function emptySettings(): ModelSettings {
  return {
    version: 2,
    providers: [],
    roles: { agent: null, tts: null, voice_clone: null, stt: null, image: null },
  };
}

/** Where the settings live in the browser (no secrets: those are in the bridge). */
export const SETTINGS_KEY = "shadowroom.models.v1";

/** Read settings, upgrading anything written by the first version. */
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

/**
 * Bring any stored shape up to version 2.
 *
 * Version 1 kept a `slots` array and pointed roles at slot ids. Those slots are folded into the
 * provider's capabilities (inheriting its endpoint, since that is what the old UI meant) and the role
 * ids are rewritten to `providerId:capability`. The `slots` key is dropped, so a reader can never
 * find two answers again.
 */
export function normalizeSettings(parsed: unknown): ModelSettings {
  const base = emptySettings();
  if (parsed === null || typeof parsed !== "object") return base;
  const raw = parsed as {
    version?: number;
    providers?: Array<Partial<ProviderProfile> & { capabilities?: ProviderProfile["capabilities"] }>;
    slots?: Array<{ id: string; providerId: string; capability: CapabilityKind; model: string }>;
    roles?: Partial<RoleMap>;
  };
  if (!Array.isArray(raw.providers)) return base;
  const legacySlots = Array.isArray(raw.slots) ? raw.slots : [];

  const providers: ProviderProfile[] = raw.providers.map((entry) => {
    const id = String(entry.id ?? `p-${Math.random().toString(36).slice(2, 8)}`);
    const capabilities: ProviderProfile["capabilities"] = { ...(entry.capabilities ?? {}) };
    for (const slot of legacySlots.filter((candidate) => candidate.providerId === id)) {
      const existing = capabilities[slot.capability];
      capabilities[slot.capability] = {
        enabled: true,
        ...(existing ?? {}),
        defaultModel: existing?.defaultModel ?? slot.model,
      };
    }
    return {
      id,
      label: String(entry.label ?? id),
      baseUrl: String(entry.baseUrl ?? ""),
      credentialRef: entry.credentialRef === null || entry.credentialRef === undefined ? null : String(entry.credentialRef),
      protocol: (entry.protocol ?? "openai") as ProviderProtocol,
      enabled: entry.enabled !== false,
      capabilities,
    };
  });

  const roles: RoleMap = { ...base.roles };
  for (const kind of Object.keys(roles) as CapabilityKind[]) {
    const stored = raw.roles?.[kind];
    if (stored === null || stored === undefined) {
      roles[kind] = null;
      continue;
    }
    if (stored.includes(":")) {
      roles[kind] = stored;
      continue;
    }
    // A version-1 slot id: translate it into the provider+capability it named.
    const slot = legacySlots.find((candidate) => candidate.id === stored);
    roles[kind] = slot === undefined ? null : `${slot.providerId}:${slot.capability}`;
  }
  return { version: 2, providers, roles };
}

/** The credential name a new provider defaults to, e.g. `openai` from its label. */
export function credentialNameFor(label: string, taken: string[] = []): string {
  const stem =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "provider";
  if (!taken.includes(stem)) return stem;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${stem}-${index}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${stem}-${taken.length + 1}`;
}

/** What the UI shows for a stored key: never the value, only enough to recognise it. */
export function maskKey(value: string | undefined): string {
  if (value === undefined || value === "") return "";
  const tail = value.length > 4 ? value.slice(-4) : "";
  return `••••••••${tail}`;
}

/** A provider needs a name and an http(s) endpoint to be worth saving. */
export function providerProblems(profile: Pick<ProviderProfile, "label" | "baseUrl">): string[] {
  const problems: string[] = [];
  if (profile.label.trim() === "") problems.push("给它起个名字");
  const url = profile.baseUrl.trim();
  if (url === "") problems.push("填 Base URL");
  else if (!/^https?:\/\//i.test(url)) problems.push("Base URL 要以 http:// 或 https:// 开头");
  return problems;
}

/** One capability's configuration, or `{enabled:false}` when the provider does not offer it. */
export function capabilityOf(provider: ProviderProfile, kind: CapabilityKind): CapabilityOverride {
  return provider.capabilities[kind] ?? { enabled: false };
}

/** Resolve inheritance: what this capability would actually call, and with which model. */
export function capabilityTarget(provider: ProviderProfile, kind: CapabilityKind): CapabilityTarget {
  const config = capabilityOf(provider, kind);
  const model = (config.defaultModel ?? "").trim();
  return {
    providerId: provider.id,
    capability: kind,
    protocol: config.protocol ?? provider.protocol,
    baseUrl: (config.baseUrl ?? "").trim() === "" ? provider.baseUrl.trim() : (config.baseUrl as string).trim(),
    endpointPath: config.endpointPath,
    model,
    models: model === "" ? [...(config.extraModels ?? [])] : [model, ...(config.extraModels ?? [])],
    options: config.options ?? {},
  };
}

/** What a status badge should say about one capability. */
export type CapabilityStatus = "off" | "ready" | "needs-model" | "needs-credential" | "needs-endpoint" | "needs-path";

/**
 * Why a capability is not usable, in the order a user would fix it.
 *
 * "凭证未配置" is its own state because it needs a different sentence from "模型没填" — and because a
 * credential lives outside the settings document entirely (the bridge holds the value).
 */
export function capabilityStatus(
  provider: ProviderProfile,
  kind: CapabilityKind,
  credential: { source: "file" | "env" | "missing" } | undefined,
): CapabilityStatus {
  const config = capabilityOf(provider, kind);
  if (!config.enabled) return "off";
  if (provider.credentialRef !== null && (credential === undefined || credential.source === "missing")) {
    return "needs-credential";
  }
  if ((config.defaultModel ?? "").trim() === "") return "needs-model";
  const target = capabilityTarget(provider, kind);
  if (target.baseUrl !== "" && !/^https?:\/\//i.test(target.baseUrl)) return "needs-endpoint";
  if (target.protocol === "custom" && (config.endpointPath ?? "") === "") return "needs-path";
  if (target.baseUrl === "") return "needs-endpoint";
  return "ready";
}

/** The sentence a badge shows. */
export function capabilityStatusLabel(status: CapabilityStatus): string {
  switch (status) {
    case "ready":
      return "已启用";
    case "needs-model":
      return "需配置模型";
    case "needs-credential":
      return "凭证未配置";
    case "needs-endpoint":
      return "需配置 Endpoint";
    case "needs-path":
      return "需配置路径";
    default:
      return "未启用";
  }
}

/** The derived slots: one per enabled capability that names a model. */
export function deriveSlots(settings: ModelSettings): CapabilitySlot[] {
  const slots: CapabilitySlot[] = [];
  for (const provider of settings.providers) {
    for (const kind of Object.keys(CAPABILITY_DEFAULTS) as CapabilityKind[]) {
      const config = capabilityOf(provider, kind);
      if (!config.enabled) continue;
      const model = (config.defaultModel ?? "").trim();
      if (model === "") continue;
      slots.push({ id: `${provider.id}:${kind}`, providerId: provider.id, capability: kind, model });
    }
  }
  return slots;
}

/** Every model a role could pick: the capability's default first, then its extras. */
export function capabilityModels(provider: ProviderProfile, kind: CapabilityKind): string[] {
  return capabilityTarget(provider, kind).models;
}

/** The provider+capability a role points at, or undefined when it points at nothing usable. */
export function roleTarget(
  settings: ModelSettings,
  role: CapabilityKind,
): { provider: ProviderProfile; capability: CapabilityKind; model: string } | undefined {
  const id = settings.roles[role];
  if (id === null || id === undefined) return undefined;
  const [providerId, capability] = id.split(":");
  const provider = settings.providers.find((entry) => entry.id === providerId);
  if (provider === undefined || provider.enabled === false) return undefined;
  const config = capabilityOf(provider, capability as CapabilityKind);
  if (!config.enabled) return undefined;
  const model = (config.defaultModel ?? "").trim();
  if (model === "") return undefined;
  return { provider, capability: capability as CapabilityKind, model };
}

/**
 * What the chat's model switch may offer.
 *
 * Only the main model. This is the rule the user asked for, expressed once so no future screen has to
 * remember it.
 */
export function mainModelChoices(settings: ModelSettings): Array<{ provider: ProviderProfile; slot: CapabilitySlot }> {
  return deriveSlots(settings)
    .filter((slot) => slot.capability === "agent")
    .map((slot) => ({
      provider: settings.providers.find((provider) => provider.id === slot.providerId) as ProviderProfile,
      slot,
    }))
    .filter((choice) => choice.provider !== undefined);
}

/** A one-line description of a role for the settings page: who serves it, or that nobody does. */
export function roleSummary(settings: ModelSettings, role: CapabilityKind): string {
  const target = roleTarget(settings, role);
  return target === undefined ? "未配置" : `${target.provider.label} · ${target.model}`;
}

/** Add or replace one provider. */
export function upsertProvider(settings: ModelSettings, profile: ProviderProfile): ModelSettings {
  const exists = settings.providers.some((entry) => entry.id === profile.id);
  return {
    ...settings,
    providers: exists
      ? settings.providers.map((entry) => (entry.id === profile.id ? profile : entry))
      : [...settings.providers, profile],
  };
}

/** Remove a provider and unplug every role that pointed at it. */
export function removeProvider(settings: ModelSettings, providerId: string): ModelSettings {
  const roles = { ...settings.roles };
  for (const role of Object.keys(roles) as CapabilityKind[]) {
    if (roles[role]?.startsWith(`${providerId}:`)) roles[role] = null;
  }
  return { ...settings, providers: settings.providers.filter((entry) => entry.id !== providerId), roles };
}

/** Point a role at a capability (or at nothing). */
export function setRole(settings: ModelSettings, role: CapabilityKind, capabilityId: string | null): ModelSettings {
  return { ...settings, roles: { ...settings.roles, [role]: capabilityId } };
}

/** Turn one capability on or off, pre-filling the defaults when it is switched on. */
export function setCapability(
  settings: ModelSettings,
  providerId: string,
  kind: CapabilityKind,
  patch: Partial<CapabilityOverride> | null,
): ModelSettings {
  const providers = settings.providers.map((provider) => {
    if (provider.id !== providerId) return provider;
    if (patch === null) {
      const capabilities = { ...provider.capabilities };
      delete capabilities[kind];
      return { ...provider, capabilities };
    }
    const current = provider.capabilities[kind];
    const turningOn = patch.enabled === true && current?.enabled !== true;
    const defaults = CAPABILITY_DEFAULTS[kind];
    return {
      ...provider,
      capabilities: {
        ...provider.capabilities,
        [kind]: {
          ...(current ?? {}),
          ...(turningOn
            ? { defaultModel: current?.defaultModel ?? defaults.model, options: current?.options ?? defaults.options }
            : {}),
          ...patch,
        },
      },
    };
  });
  /**
   * Switching a capability off unplugs the roles that pointed at it — in the same update, so no render
   * ever sees a role pointing at a capability that just disappeared.
   */
  const roles = { ...settings.roles };
  if (patch === null) {
    for (const role of Object.keys(roles) as CapabilityKind[]) {
      if (roles[role] === `${providerId}:${kind}`) roles[role] = null;
    }
  }
  return { ...settings, providers, roles };
}

/** Point a role at a provider's capability. */
export function assignRole(settings: ModelSettings, role: CapabilityKind, providerId: string): ModelSettings {
  return setRole(settings, role, `${providerId}:${role}`);
}

/** Switch a role off without touching the provider underneath it. */
export function clearRole(settings: ModelSettings, role: CapabilityKind): ModelSettings {
  return setRole(settings, role, null);
}
