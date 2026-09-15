/**
 * Which model does what.
 *
 * One 服务商 (provider) is an endpoint plus a credential name; a 能力槽 (slot) is one of that
 * provider's models doing one job. Roles point at slots. The point of the split is the rule the user
 * asked for: **the chat can only switch the main model** — everything else (voice out, voice clone,
 * speech in, images) is chosen in settings and never appears next to the send button.
 *
 * Credentials are *names* here — never values. The bridge owns the values (see `tools/agent-bridge.mjs`,
 * `~/.shadowroom/credentials.json`, 0600, environment variables win), so a project file or a browser
 * profile can be copied around without leaking a key.
 */

/** What a model can be asked to do. These are also the roles the settings page offers. */
export type CapabilityKind = "agent" | "tts" | "voice_clone" | "stt" | "image";

/** The roles in the order the settings page shows them, with the label a beginner reads. */
export const CAPABILITIES: ReadonlyArray<{ kind: CapabilityKind; label: string; hint: string }> = [
  { kind: "agent", label: "主模型", hint: "对话、写歌、调用工具——只有它出现在对话页的模型开关里" },
  { kind: "tts", label: "语音合成", hint: "把文字念出来（朗读回复、语音通话里的声音）" },
  { kind: "voice_clone", label: "音色克隆", hint: "用一段样本做自己的音色，给语音合成用" },
  { kind: "stt", label: "语音识别", hint: "把你说的话转成文字（默认用浏览器自带的）" },
  { kind: "image", label: "生图", hint: "封面、配图这类图像生成" },
];

/** How a provider's HTTP requests are shaped. `openai` is the common one; `custom` trusts the path. */
export type ProviderProtocol = "openai" | "elevenlabs" | "custom";

export type ProviderProfile = {
  id: string;
  label: string;
  baseUrl: string;
  /** Name of the credential in the bridge's store; `null` when the endpoint needs no key. */
  credentialRef: string | null;
  protocol: ProviderProtocol;
  enabled: boolean;
};

/** One model, doing one job. */
export type CapabilitySlot = {
  id: string;
  providerId: string;
  capability: CapabilityKind;
  model: string;
  /** Overrides the protocol's default path, e.g. `/audio/speech` vs `/chat/completions`. */
  endpointPath?: string;
  enabled: boolean;
  /** Capability-specific extras: TTS's `voice`, image's `size`… */
  metadata?: Record<string, string>;
};

/** Role → slot id, or `null` when the role is deliberately not configured. */
export type RoleMap = Record<CapabilityKind, string | null>;

export type ModelSettings = {
  version: 1;
  providers: ProviderProfile[];
  slots: CapabilitySlot[];
  roles: RoleMap;
};

/** Everything unconfigured: the built-in agent (Codex) is the default main model. */
export function emptySettings(): ModelSettings {
  return {
    version: 1,
    providers: [],
    slots: [],
    roles: { agent: null, tts: null, voice_clone: null, stt: null, image: null },
  };
}

/** Where the settings live in the browser (no secrets: those are in the bridge). */
export const SETTINGS_KEY = "shadowroom.models.v1";

export function loadModelSettings(): ModelSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (raw === null) return emptySettings();
    const parsed = JSON.parse(raw) as Partial<ModelSettings>;
    const base = emptySettings();
    return {
      version: 1,
      providers: Array.isArray(parsed.providers) ? parsed.providers : base.providers,
      slots: Array.isArray(parsed.slots) ? parsed.slots : base.slots,
      roles: { ...base.roles, ...(parsed.roles ?? {}) },
    };
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

/**
 * The slots that may serve one role: same capability, enabled, a real model name, and a provider
 * that is switched on. A slot whose model is still blank is a half-typed row, not an answer — the
 * chat must never offer "OpenAI · " as if it were a model.
 */
export function slotsForRole(settings: ModelSettings, role: CapabilityKind): CapabilitySlot[] {
  const live = new Set(settings.providers.filter((provider) => provider.enabled).map((provider) => provider.id));
  return settings.slots.filter(
    (slot) => slot.capability === role && slot.enabled && slot.model.trim() !== "" && live.has(slot.providerId),
  );
}

/** The slot a role points at, or undefined when it is unconfigured or points at a dead slot. */
export function slotForRole(settings: ModelSettings, role: CapabilityKind): CapabilitySlot | undefined {
  const id = settings.roles[role];
  if (id === null || id === undefined) return undefined;
  return slotsForRole(settings, role).find((slot) => slot.id === id);
}

/**
 * The slot a role points at even when it is not usable yet — a provider just switched off, or a model
 * name the user has not typed in. The settings page needs this: without it, choosing a provider would
 * immediately lose the choice (the strict lookup answers "nothing") and the model field would vanish
 * before anyone could fill it in.
 */
export function assignedSlot(settings: ModelSettings, role: CapabilityKind): CapabilitySlot | undefined {
  const id = settings.roles[role];
  if (id === null || id === undefined) return undefined;
  return settings.slots.find((slot) => slot.id === id);
}

/**
 * What the chat's model switch may offer.
 *
 * Only the main model. This is the rule the user asked for, expressed once so no future screen has to
 * remember it.
 */
export function mainModelChoices(settings: ModelSettings): Array<{ provider: ProviderProfile; slot: CapabilitySlot }> {
  return slotsForRole(settings, "agent").map((slot) => ({
    provider: settings.providers.find((provider) => provider.id === slot.providerId) as ProviderProfile,
    slot,
  }));
}

/** A one-line description of a role for the settings page: who serves it, or that nobody does. */
export function roleSummary(settings: ModelSettings, role: CapabilityKind): string {
  const slot = slotForRole(settings, role);
  if (slot === undefined) return "未配置";
  const provider = settings.providers.find((entry) => entry.id === slot.providerId);
  return `${provider?.label ?? "?"} · ${slot.model}`;
}

/** Add or replace one provider, and keep slots pointing at providers that still exist. */
export function upsertProvider(settings: ModelSettings, profile: ProviderProfile): ModelSettings {
  const exists = settings.providers.some((entry) => entry.id === profile.id);
  return {
    ...settings,
    providers: exists
      ? settings.providers.map((entry) => (entry.id === profile.id ? profile : entry))
      : [...settings.providers, profile],
  };
}

/**
 * Remove a provider and everything that pointed at it — including roles, which fall back to
 * "unconfigured" rather than silently keeping a slot that can never work.
 */
export function removeProvider(settings: ModelSettings, providerId: string): ModelSettings {
  const gone = settings.slots.filter((slot) => slot.providerId === providerId).map((slot) => slot.id);
  const roles = { ...settings.roles };
  for (const role of Object.keys(roles) as CapabilityKind[]) {
    if (roles[role] !== null && gone.includes(roles[role] as string)) roles[role] = null;
  }
  return {
    ...settings,
    providers: settings.providers.filter((entry) => entry.id !== providerId),
    slots: settings.slots.filter((slot) => slot.providerId !== providerId),
    roles,
  };
}

/** Point a role at a slot (or at nothing). */
export function setRole(settings: ModelSettings, role: CapabilityKind, slotId: string | null): ModelSettings {
  return { ...settings, roles: { ...settings.roles, [role]: slotId } };
}

/** Give a role a slot for a provider+model, creating the slot when it does not exist yet. */
export function assignRole(
  settings: ModelSettings,
  role: CapabilityKind,
  providerId: string,
  model: string,
  metadata?: Record<string, string>,
): ModelSettings {
  const trimmed = model.trim();
  const existing = settings.slots.find(
    (slot) => slot.capability === role && slot.providerId === providerId && slot.model === trimmed,
  );
  const slot: CapabilitySlot =
    existing ??
    {
      id: `slot-${role}-${providerId}-${trimmed.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "model"}`,
      providerId,
      capability: role,
      model: trimmed,
      enabled: true,
    };
  const withSlot: ModelSettings = existing === undefined ? { ...settings, slots: [...settings.slots, slot] } : settings;
  const slots = withSlot.slots.map((entry) =>
    entry.id === slot.id ? { ...entry, enabled: true, ...(metadata === undefined ? {} : { metadata }) } : entry,
  );
  return setRole({ ...withSlot, slots }, role, slot.id);
}

/** Turn a role off without deleting the slot underneath it. */
export function clearRole(settings: ModelSettings, role: CapabilityKind): ModelSettings {
  return setRole(settings, role, null);
}
