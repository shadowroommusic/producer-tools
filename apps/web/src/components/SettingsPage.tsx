/**
 * 设置：供应商 / 模型 / 能力 / 角色 —— 形状照用户自己的 Shadow。
 *
 * 三层，和 Shadow 一一对应：
 * 1. **供应商**：列表 → 编辑页（页签 `连接 / 模型 / 能力`）。新增时先选一家预设 + 粘 Key，
 *    其余（Base URL、协议、凭证名）是应用的事，只有「自定义」才让人填。
 * 2. **模型**：`[拉取模型]` 自动从端点拉 → 搜索 + 多选 + 全选/取消 + 加入所选 → 模型 chips；
 *    点一个 chip 编辑它的**模型档**（上下文 / 最大输出 / 模态 / 会不会调工具 / 推理档 / 别名 / 单价）。
 * 3. **能力**（语音合成 / 音色克隆 / 语音识别 / 生图 / 音乐生成）：每项一张卡，开关打开即预填
 *    （协议默认、端点沿用 Base URL、模型空），同样支持拉取 + 多选。**没有视频**。
 *
 * Key 只写不读：值在 bridge（0600），这里只显示掩码与绿/红点。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { IconPlus, IconStop } from "./icons";
import {
  CAPABILITIES,
  PROVIDER_CAPABILITIES,
  addModels,
  agentModelChoices,
  assignRole,
  capabilityOf,
  capabilityTarget,
  clearRole,
  credentialNameFor,
  defaultCapabilityConfig,
  providerProblems,
  removeModel,
  removeProvider,
  roleSummary,
  roleTarget,
  setCapability,
  setModelProfile,
  setRoleModel,
  upsertProvider,
  type CapabilityKind,
  type ModelSettings,
  type ProviderProfile,
} from "../lib/providers";
import {
  CODEX_RESPONSES_REASONING,
  GLM_REASONING,
  MINIMAX_BUILT_IN_REASONING,
  MINIMAX_M3_REASONING,
  XIAOMI_REASONING,
  describeProfile,
  plainTextProfile,
  textChatProfile,
  visionChatProfile,
  type EndpointFormat,
  type InputModality,
  type ModelProfile,
  type ReasoningCapability,
} from "../lib/providerModel";
import { PROVIDER_PRESETS, presetById } from "../lib/providerPresets";
import { deleteCredential, listCredentials, listProviderModels, saveCredential, testRole, type CredentialInfo } from "../lib/providerApi";
import { createSystemTTS, type VoiceInfo } from "../lib/tts";

const ENDPOINT_FORMATS: Array<{ id: EndpointFormat; label: string }> = [
  { id: "chat_completions", label: "Chat Completions（OpenAI 兼容）" },
  { id: "responses", label: "Responses（OpenAI 新协议）" },
  { id: "messages", label: "Messages（Anthropic）" },
  { id: "custom_endpoint", label: "自定义" },
];

const REASONING_PRESETS: Array<{ id: string; label: string; value: ReasoningCapability }> = [
  { id: "none", label: "没有推理档（普通模型）", value: MINIMAX_BUILT_IN_REASONING },
  { id: "responses", label: "OpenAI Responses（low/medium/high/max）", value: CODEX_RESPONSES_REASONING },
  { id: "minimax-m3", label: "MiniMax M3（auto/off）", value: MINIMAX_M3_REASONING },
  { id: "xiaomi", label: "Xiaomi MiMo（off/low/medium/high）", value: XIAOMI_REASONING },
  { id: "glm", label: "GLM（off/high/max）", value: GLM_REASONING },
];

type SettingsSection = "roles" | "providers" | "voice";
type EditorTab = "connect" | "models" | "capabilities";

function newProviderId(name: string, taken: string[]): string {
  const stem = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "provider";
  if (!taken.includes(`p-${stem}`)) return `p-${stem}`;
  for (let index = 2; index < 100; index += 1) {
    if (!taken.includes(`p-${stem}-${index}`)) return `p-${stem}-${index}`;
  }
  return `p-${stem}-${Date.now().toString(36)}`;
}

/** A brand-new provider: only a name and an endpoint, everything else is chosen or fetched later. */
function blankProvider(): ProviderProfile {
  return {
    id: "",
    name: "",
    baseUrl: "https://api.openai.com/v1",
    credentialRef: null,
    endpointFormat: "chat_completions",
    enabled: true,
    models: [],
    modelProfiles: {},
    capabilities: {},
  };
}

export function SettingsPage({
  settings,
  onChange,
}: {
  /** Owned by the App, so the chat's model switch and this page never disagree. */
  settings: ModelSettings;
  onChange: (next: ModelSettings) => void;
}) {
  const [section, setSection] = useState<SettingsSection>("roles");
  /** `"new"` while adding, a provider id while editing, null while the list is showing. */
  const [editing, setEditing] = useState<"new" | string | null>(null);
  const [tab, setTab] = useState<EditorTab>("connect");
  const [credentials, setCredentials] = useState<CredentialInfo[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, { ok: boolean; detail: string; ms?: number } | "running">>({});
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [voiceId, setVoiceId] = useState(() => window.localStorage.getItem("shadowroom.voice") ?? "");

  const refreshCredentials = useCallback(async () => {
    try {
      setCredentials(await listCredentials());
    } catch {
      setCredentials([]);
    }
  }, []);

  useEffect(() => {
    void refreshCredentials();
  }, [refreshCredentials]);
  useEffect(() => {
    void createSystemTTS().voices().then(setVoices);
  }, []);

  const credentialFor = useCallback((name: string | null) => credentials.find((entry) => entry.name === name), [credentials]);
  const editingProvider = editing === "new" ? null : settings.providers.find((entry) => entry.id === editing) ?? null;

  const saveProvider = useCallback(
    (profile: ProviderProfile) => {
      const id = profile.id === "" ? newProviderId(profile.name, settings.providers.map((entry) => entry.id)) : profile.id;
      const credentialRef =
        profile.credentialRef ?? (profile.baseUrl.startsWith("http://localhost") || profile.baseUrl.startsWith("http://127.0.0.1") ? null : credentialNameFor(profile.name, credentials.map((entry) => entry.name)));
      onChange(upsertProvider(settings, { ...profile, id, credentialRef }));
      setEditing(id);
    },
    [credentials, onChange, settings],
  );

  const saveKey = useCallback(
    async (provider: ProviderProfile, key: string) => {
      const name = provider.credentialRef ?? credentialNameFor(provider.name, credentials.map((entry) => entry.name));
      try {
        const stored = await saveCredential(name, key);
        setNotice(`已保存 ${stored.name} 的 Key（${stored.masked}）`);
        await refreshCredentials();
        if (provider.credentialRef === null) saveProvider({ ...provider, credentialRef: name });
        return name;
      } catch (cause) {
        setNotice(`Key 没保存：${cause instanceof Error ? cause.message : String(cause)}`);
        return name;
      }
    },
    [credentials, refreshCredentials, saveProvider],
  );

  const runTest = useCallback(
    async (provider: ProviderProfile, kind: CapabilityKind, model: string) => {
      const key = `${provider.id}:${kind}:${model}`;
      const target = capabilityTarget(provider, kind);
      setTests((current) => ({ ...current, [key]: "running" }));
      try {
        const result = await testRole({
          provider: { baseUrl: target.baseUrl, credentialRef: provider.credentialRef, endpointFormat: target.protocol },
          capability: kind,
          model,
        });
        setTests((current) => ({ ...current, [key]: result }));
      } catch (cause) {
        setTests((current) => ({ ...current, [key]: { ok: false, detail: cause instanceof Error ? cause.message : String(cause) } }));
      }
    },
    [],
  );

  return (
    <section className="sr-settings">
      <header className="sr-settings-head">
        <h2 className="sr-settings-title">设置</h2>
        <span className="sr-settings-meta sr-mono">
          {settings.providers.length} 个供应商 ·{" "}
          {settings.providers.reduce((count, provider) => count + provider.models.length + Object.values(provider.capabilities).reduce((inner, config) => inner + (config?.models.length ?? 0), 0), 0)} 个模型
        </span>
      </header>

      {notice !== null && (
        <p className="sr-settings-notice" role="status">
          {notice}
          <button type="button" className="sr-icon-btn" aria-label="知道了" onClick={() => setNotice(null)}>
            <IconStop size={12} />
          </button>
        </p>
      )}

      <div className="sr-settings-body">
        <nav className="sr-settings-nav" aria-label="设置分区">
          {(
            [
              { id: "roles", label: "角色与路由", hint: "谁干什么" },
              { id: "providers", label: "供应商", hint: "端点 · 模型 · 能力" },
              { id: "voice", label: "通话与声音", hint: "通话音色" },
            ] as const
          ).map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="sr-settings-nav-item"
              data-active={section === entry.id || undefined}
              onClick={() => {
                setSection(entry.id);
                setEditing(null);
              }}
            >
              <span className="sr-settings-nav-label">{entry.label}</span>
              <span className="sr-settings-nav-hint sr-mono">{entry.hint}</span>
            </button>
          ))}
        </nav>

        <div className="sr-settings-pane">
          {section === "providers" &&
            (editing === null ? (
              <>
                <div className="sr-settings-pane-head">
                  <h3 className="sr-settings-h3">供应商</h3>
                  <button
                    type="button"
                    className="sr-btn sr-settings-add"
                    onClick={() => {
                      setEditing("new");
                      setTab("connect");
                    }}
                  >
                    <IconPlus size={14} /> 添加供应商
                  </button>
                </div>
                <p className="sr-settings-hint">
                  一个供应商 = 一个 Base URL + 一把 Key。同一家的对话、语音、生图都挂在它下面：
                  模型在「模型」页签里拉取，其它能力在「能力」页签里打开。
                </p>
                <ul className="sr-provider-list">
                  {settings.providers.map((provider) => {
                    const credential = credentialFor(provider.credentialRef);
                    const enabled = Object.entries(provider.capabilities)
                      .filter(([, config]) => (config?.models.length ?? 0) > 0)
                      .map(([kind]) => CAPABILITIES.find((entry) => entry.kind === kind)?.label.split(" · ")[0] ?? kind);
                    return (
                      <li key={provider.id} className="sr-provider-card" data-off={!provider.enabled || undefined}>
                        <div className="sr-provider-main">
                          <span className="sr-provider-label">{provider.name}</span>
                          <span className="sr-provider-url sr-mono">{provider.baseUrl}</span>
                          <span className="sr-provider-meta sr-mono">
                            {provider.models.length} 个对话模型
                            {enabled.length === 0 ? "" : ` · ${enabled.join(" · ")}`}
                            {" · "}
                            {provider.credentialRef === null
                              ? "不需要 Key"
                              : credential === undefined || credential.source === "missing"
                                ? "Key 未配置"
                                : credential.source === "env"
                                  ? `环境变量 ${credential.variable}`
                                  : credential.masked}
                          </span>
                        </div>
                        <div className="sr-provider-actions">
                          <button
                            type="button"
                            className="sr-btn"
                            onClick={() => {
                              setEditing(provider.id);
                              setTab("models");
                            }}
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            className="sr-btn"
                            onClick={() => onChange(upsertProvider(settings, { ...provider, enabled: !provider.enabled }))}
                          >
                            {provider.enabled ? "停用" : "启用"}
                          </button>
                          <button
                            type="button"
                            className="sr-btn sr-btn--danger"
                            onClick={() => {
                              onChange(removeProvider(settings, provider.id));
                              if (provider.credentialRef !== null) void deleteCredential(provider.credentialRef).then(refreshCredentials);
                            }}
                          >
                            删除
                          </button>
                        </div>
                      </li>
                    );
                  })}
                  {settings.providers.length === 0 && <li className="sr-settings-empty">还没有供应商。点「添加供应商」选一家。</li>}
                </ul>
              </>
            ) : (
              <ProviderEditor
                provider={editingProvider ?? blankProvider()}
                isNew={editing === "new"}
                tab={tab}
                onTab={setTab}
                credentials={credentials}
                tests={tests}
                onChange={(next) => (editing === "new" ? saveProvider(next) : onChange(upsertProvider(settings, next)))}
                onSaveKey={saveKey}
                onBack={() => setEditing(null)}
                onRemoveModel={(model, kind) => onChange(removeModel(settings, editingProvider?.id ?? "", model, kind))}
                onAddModels={(models, kind) => onChange(addModels(settings, editingProvider?.id ?? "", models, kind))}
                onProfile={(model, profile) => onChange(setModelProfile(settings, editingProvider?.id ?? "", model, profile))}
                onCapability={(kind, config) => onChange(setCapability(settings, editingProvider?.id ?? "", kind, config))}
                onTest={(kind, model) => editingProvider !== null && void runTest(editingProvider, kind, model)}
                providers={settings.providers}
              />
            ))}

          {section === "roles" && (
            <>
              <h3 className="sr-settings-h3">角色与路由</h3>
              <p className="sr-settings-hint">
                每一行是一个角色。对话页的模型开关只会列「主模型」——这家开了几个对话模型，那里就能切几个。
              </p>
              <ul className="sr-role-list">
                {CAPABILITIES.map(({ kind, label, hint }) => {
                  const target = roleTarget(settings, kind);
                  const candidates = settings.providers.filter((provider) => (capabilityOf(provider, kind)?.models.length ?? 0) > 0);
                  const models = target === undefined ? [] : capabilityTarget(target.provider, kind).models;
                  const test = target === undefined ? undefined : tests[`${target.provider.id}:${kind}:${target.model}`];
                  return (
                    <li key={kind} className="sr-role-row">
                      <div className="sr-role-name">
                        <span>{label}</span>
                        <span className="sr-role-hint sr-mono">{hint}</span>
                        <span className="sr-role-summary sr-mono">{roleSummary(settings, kind)}</span>
                      </div>
                      <div className="sr-role-controls">
                        <select
                          className="sr-input"
                          aria-label={`${label} 供应商`}
                          value={target?.provider.id ?? ""}
                          onChange={(event) => {
                            if (event.target.value === "") onChange(clearRole(settings, kind));
                            else onChange(assignRole(settings, kind, event.target.value));
                          }}
                        >
                          <option value="">未配置</option>
                          {candidates.map((provider) => (
                            <option key={provider.id} value={provider.id}>
                              {provider.name}
                            </option>
                          ))}
                        </select>
                        {candidates.length === 0 && (
                          <span className="sr-role-empty sr-mono">
                            还没有供应商给「{label.split(" · ")[0]}」加过模型——去供应商页拉一次
                          </span>
                        )}
                        {target !== undefined && (
                          <>
                            <select
                              className="sr-input"
                              aria-label={`${label} 模型`}
                              value={target.model}
                              onChange={(event) => onChange(setRoleModel(settings, kind, event.target.value))}
                            >
                              {models.map((model) => (
                                <option key={model} value={model}>
                                  {model}
                                </option>
                              ))}
                            </select>
                            <button type="button" className="sr-btn" disabled={test === "running"} onClick={() => void runTest(target.provider, kind, target.model)}>
                              {test === "running" ? "测试中…" : "测试"}
                            </button>
                          </>
                        )}
                      </div>
                      {test !== undefined && test !== "running" && (
                        <p className="sr-role-test sr-mono" data-ok={test.ok || undefined}>
                          {test.ok ? "✓" : "✗"} {test.detail}
                          {test.ms === undefined ? "" : ` · ${test.ms} ms`}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {section === "voice" && (
            <>
              <h3 className="sr-settings-h3">通话的声音</h3>
              <p className="sr-settings-hint">
                配了「语音合成 · TTS」供应商时，通话用它的音色（合成走 bridge，播放走 WebAudio）；
                没有配就回落到系统音色——那些听起来像机器人，属于兜底而不是推荐。
              </p>
              <div className="sr-voice-picker">
                <select
                  className="sr-input"
                  aria-label="通话音色"
                  value={voiceId}
                  onChange={(event) => {
                    const next = event.target.value;
                    setVoiceId(next);
                    if (next === "") window.localStorage.removeItem("shadowroom.voice");
                    else window.localStorage.setItem("shadowroom.voice", next);
                  }}
                >
                  <option value="">系统默认</option>
                  {voices.map((voice) => (
                    <option key={voice.id} value={voice.id}>
                      {voice.label} · {voice.lang}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="sr-btn"
                  disabled={voices.length === 0}
                  onClick={() =>
                    createSystemTTS().speak("你好，我是 Shadow，这段声音以后就是我在通话里的样子。", {
                      voiceId: voiceId === "" ? undefined : voiceId,
                    })
                  }
                >
                  试听
                </button>
                {voices.length === 0 && <span className="sr-role-empty sr-mono">这台机器没有系统语音，先用默认</span>}
              </div>
              {(() => {
                const tts = roleTarget(settings, "tts");
                return (
                  <p className="sr-role-test sr-mono" data-ok={tts !== undefined || undefined}>
                    {tts === undefined
                      ? "当前：系统音色（配置一个 TTS 供应商会好很多）"
                      : `当前：${tts.provider.name} · ${tts.model}`}
                  </p>
                );
              })()}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** 供应商编辑页：连接 / 模型 / 能力 三个页签（Shadow 的同名三页签）。 */
function ProviderEditor({
  provider,
  isNew,
  tab,
  onTab,
  credentials,
  tests,
  providers,
  onChange,
  onSaveKey,
  onBack,
  onRemoveModel,
  onAddModels,
  onProfile,
  onCapability,
  onTest,
}: {
  provider: ProviderProfile;
  isNew: boolean;
  tab: EditorTab;
  onTab: (tab: EditorTab) => void;
  credentials: CredentialInfo[];
  tests: Record<string, { ok: boolean; detail: string; ms?: number } | "running">;
  providers: ProviderProfile[];
  onChange: (next: ProviderProfile) => void;
  onSaveKey: (provider: ProviderProfile, key: string) => Promise<string>;
  onBack: () => void;
  onRemoveModel: (model: string, kind: CapabilityKind) => void;
  onAddModels: (models: string[], kind: CapabilityKind) => void;
  onProfile: (model: string, profile: ModelProfile | null) => void;
  onCapability: (kind: CapabilityKind, config: { protocol: EndpointFormat; baseUrl: string; models: string[] } | null) => void;
  onTest: (kind: CapabilityKind, model: string) => void;
}) {
  const [keyDraft, setKeyDraft] = useState("");
  const [presetId, setPresetId] = useState("");
  const [custom, setCustom] = useState(!isNew);
  const [editingModel, setEditingModel] = useState<{ kind: CapabilityKind; model: string } | null>(null);
  const credential = credentials.find((entry) => entry.name === provider.credentialRef);
  const problems = providerProblems(provider);

  const choosePreset = (id: string) => {
    setPresetId(id);
    if (id === "") return;
    if (id === "__custom") {
      setCustom(true);
      return;
    }
    const preset = presetById(id);
    if (preset === undefined) return;
    setCustom(false);
    onChange({
      ...provider,
      name: preset.label,
      baseUrl: preset.baseUrl,
      presetSource: preset.id,
      models: preset.models,
    });
  };

  return (
    <div className="sr-provider-editor">
      <div className="sr-settings-pane-head">
        <h3 className="sr-settings-h3">{isNew && provider.id === "" ? "添加供应商" : `编辑 ${provider.name || "供应商"}`}</h3>
        <div className="sr-provider-actions">
          <button type="button" className="sr-btn" onClick={onBack}>
            返回
          </button>
        </div>
      </div>

      <div className="sr-settings-subtabs" role="tablist">
        {(
          [
            { id: "connect", label: "连接" },
            { id: "models", label: `模型 · ${provider.models.length}` },
            { id: "capabilities", label: `能力 · ${Object.keys(provider.capabilities).length}` },
          ] as const
        ).map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className="sr-settings-subtab"
            data-active={tab === entry.id || undefined}
            onClick={() => onTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === "connect" && (
        <>
          {isNew && (
            <label className="sr-field">
              <span className="sr-field-label sr-mono">服务商</span>
              <select className="sr-input" aria-label="服务商" value={presetId} onChange={(event) => choosePreset(event.target.value)}>
                <option value="">选一家…</option>
                {PROVIDER_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label} · {preset.baseUrl}
                  </option>
                ))}
                <option value="__custom">自定义（自己填端点）</option>
              </select>
            </label>
          )}
          <div className="sr-provider-form" data-hidden={isNew && !custom || undefined}>
            <label className="sr-field">
              <span className="sr-field-label sr-mono">名称</span>
              <input className="sr-input" value={provider.name} onChange={(event) => onChange({ ...provider, name: event.target.value })} />
            </label>
            <label className="sr-field sr-field--wide">
              <span className="sr-field-label sr-mono">Base URL</span>
              <input className="sr-input" spellCheck={false} value={provider.baseUrl} onChange={(event) => onChange({ ...provider, baseUrl: event.target.value })} />
            </label>
            <label className="sr-field">
              <span className="sr-field-label sr-mono">协议</span>
              <select
                className="sr-input"
                value={provider.endpointFormat}
                onChange={(event) => onChange({ ...provider, endpointFormat: event.target.value as EndpointFormat })}
              >
                {ENDPOINT_FORMATS.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="sr-field">
              <span className="sr-field-label sr-mono">Credential{credential === undefined ? "" : ` · ${credential.source === "missing" ? "未配置" : credential.masked}`}</span>
              <input
                className="sr-input"
                spellCheck={false}
                value={provider.credentialRef ?? ""}
                placeholder={credentialNameFor(provider.name || "provider", credentials.map((entry) => entry.name))}
                onChange={(event) => onChange({ ...provider, credentialRef: event.target.value === "" ? null : event.target.value })}
              />
            </label>
            <label className="sr-field sr-field--wide">
              <span className="sr-field-label sr-mono">API Key（只写，不回显）</span>
              <div className="sr-key-row">
                <input className="sr-input" type="password" spellCheck={false} value={keyDraft} placeholder="sk-…" onChange={(event) => setKeyDraft(event.target.value)} />
                <button
                  type="button"
                  className="sr-btn sr-btn--accent"
                  disabled={keyDraft.trim() === ""}
                  onClick={() => {
                    void onSaveKey(provider, keyDraft.trim()).then(() => setKeyDraft(""));
                  }}
                >
                  保存 Key
                </button>
              </div>
            </label>
          </div>
          {problems.length > 0 && <p className="sr-settings-problem">{problems.join(" · ")}</p>}
          {provider.credentialRef !== null && (
            <p className="sr-role-test sr-mono" data-ok={credential !== undefined && credential.source !== "missing" || undefined}>
              {credential === undefined || credential.source === "missing"
                ? "Key 还未配置：粘贴后点「保存 Key」"
                : credential.source === "env"
                  ? `Key 来自环境变量 ${credential.variable}`
                  : `Key 已配置（${credential.masked}）`}
            </p>
          )}
        </>
      )}

      {tab === "models" && (
        <ModelManager
          provider={provider}
          kind="agent"
          models={provider.models}
          profiles={provider.modelProfiles}
          onAdd={(models) => onAddModels(models, "agent")}
          onRemove={(model) => onRemoveModel(model, "agent")}
          onEdit={(model) => setEditingModel({ kind: "agent", model })}
          onTestModel={(model) => onTest("agent", model)}
          test={editingModel === null ? undefined : tests[`${provider.id}:agent:${editingModel.model}`]}
        />
      )}

      {tab === "capabilities" && (
        <div className="sr-capability-list">
          {PROVIDER_CAPABILITIES.map(({ kind, label, hint }) => {
            const config = capabilityOf(provider, kind);
            const target = capabilityTarget(provider, kind);
            return (
              <section key={kind} className="sr-capability-card" data-on={config !== undefined || undefined}>
                <header className="sr-capability-head">
                  <div className="sr-capability-title">
                    <span className="sr-capability-name">{label}</span>
                    <span className="sr-capability-badge sr-mono" data-status={config === undefined ? "off" : config.models.length === 0 ? "needs-model" : "ready"}>
                      {config === undefined ? "未启用" : config.models.length === 0 ? "需配置模型" : "已启用"}
                    </span>
                    <p className="sr-capability-hint">{hint}</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={config !== undefined}
                    className="sr-capability-toggle"
                    data-on={config !== undefined || undefined}
                    onClick={() => onCapability(kind as Exclude<CapabilityKind, "agent">, config === undefined ? defaultCapabilityConfig(provider, kind as Exclude<CapabilityKind, "agent">) : null)}
                  >
                    {config === undefined ? "关" : "开"}
                  </button>
                </header>
                {config !== undefined && (
                  <div className="sr-capability-body">
                    <div className="sr-capability-grid">
                      <label className="sr-field">
                        <span className="sr-field-label sr-mono">协议</span>
                        <select
                          className="sr-input"
                          value={config.protocol}
                          onChange={(event) => onCapability(kind as Exclude<CapabilityKind, "agent">, { ...config, protocol: event.target.value as EndpointFormat })}
                        >
                          {ENDPOINT_FORMATS.map((entry) => (
                            <option key={entry.id} value={entry.id}>
                              {entry.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="sr-field sr-field--wide">
                        <span className="sr-field-label sr-mono">Endpoint（留空＝跟随 Base URL）</span>
                        <input
                          className="sr-input"
                          spellCheck={false}
                          value={config.baseUrl === provider.baseUrl ? "" : config.baseUrl}
                          placeholder={`${provider.baseUrl}（跟随）`}
                          onChange={(event) =>
                            onCapability(kind as Exclude<CapabilityKind, "agent">, { ...config, baseUrl: event.target.value === "" ? provider.baseUrl : event.target.value })
                          }
                        />
                      </label>
                    </div>
                    <ModelManager
                      provider={provider}
                      kind={kind}
                      models={config.models}
                      profiles={{}}
                      onAdd={(models) => onAddModels(models, kind)}
                      onRemove={(model) => onRemoveModel(model, kind)}
                      onEdit={(model) => setEditingModel({ kind, model })}
                      onTestModel={(model) => onTest(kind, model)}
                      test={editingModel !== null && editingModel.kind === kind ? tests[`${provider.id}:${kind}:${editingModel.model}`] : undefined}
                    />
                    <p className="sr-capability-target sr-mono">实际调用：{target.protocol} · {target.baseUrl || "（没填 Endpoint）"}</p>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {editingModel !== null && editingModel.kind === "agent" && (
        <ModelProfileEditor
          model={editingModel.model}
          profile={provider.modelProfiles[editingModel.model]}
          onChange={(next) => onProfile(editingModel.model, next)}
          onClose={() => setEditingModel(null)}
        />
      )}

      {providers.length > 0 && tab === "connect" && isNew === false && (
        <p className="sr-settings-hint sr-mono">同一家的模型都在这一个供应商下面，不需要为每个模型再填一次端点。</p>
      )}
    </div>
  );
}

/** 模型管理：chips + 拉取 + 搜索/多选/全选 + 加入所选（Shadow 的 `ProviderModelsManager`）。 */
function ModelManager({
  provider,
  kind,
  models,
  profiles,
  onAdd,
  onRemove,
  onEdit,
  onTestModel,
  test,
}: {
  provider: ProviderProfile;
  kind: CapabilityKind;
  models: string[];
  profiles: Record<string, ModelProfile>;
  onAdd: (models: string[]) => void;
  onRemove: (model: string) => void;
  onEdit: (model: string) => void;
  onTestModel: (model: string) => void;
  test?: { ok: boolean; detail: string; ms?: number } | "running";
}) {
  const [fetching, setFetching] = useState(false);
  const [fetched, setFetched] = useState<{ list: string[]; error?: string } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [manual, setManual] = useState("");

  const target = capabilityTarget(provider, kind);
  const fetchModels = useCallback(async () => {
    setFetching(true);
    try {
      const answer = await listProviderModels({
        baseUrl: target.baseUrl,
        credentialRef: provider.credentialRef,
        endpointFormat: target.protocol,
      });
      setFetched({ list: answer.models, ...(answer.error === undefined ? {} : { error: answer.error }) });
      setSelected(answer.models.filter((model) => !models.includes(model)));
    } finally {
      setFetching(false);
    }
  }, [models, provider.credentialRef, target.baseUrl, target.protocol]);

  const visible = useMemo(() => {
    const list = fetched?.list ?? [];
    const needle = query.trim().toLowerCase();
    return needle === "" ? list : list.filter((model) => model.toLowerCase().includes(needle));
  }, [fetched, query]);

  return (
    <div className="sr-model-manager">
      <div className="sr-model-chips">
        {models.map((model) => (
          <span key={model} className="sr-model-chip" data-on={true} title={kind === "agent" ? describeProfile(profiles[model]) : undefined}>
            <button type="button" className="sr-model-chip-name sr-mono" onClick={() => onEdit(model)}>
              {model}
            </button>
            <button type="button" className="sr-model-chip-x" aria-label={`移除 ${model}`} onClick={() => onRemove(model)}>
              ×
            </button>
          </span>
        ))}
        {models.length === 0 && <span className="sr-role-empty sr-mono">还没有模型——点「拉取模型」从端点读</span>}
      </div>

      <div className="sr-model-actions">
        <button type="button" className="sr-btn" disabled={fetching} onClick={() => void fetchModels()}>
          {fetching ? "拉取中…" : "拉取模型"}
        </button>
        <div className="sr-key-row">
          <input className="sr-input" value={manual} spellCheck={false} placeholder="手动加一个模型名（拉不到时的兜底）" onChange={(event) => setManual(event.target.value)} />
          <button
            type="button"
            className="sr-btn"
            disabled={manual.trim() === ""}
            onClick={() => {
              onAdd([manual.trim()]);
              setManual("");
            }}
          >
            加入
          </button>
        </div>
        {models.length > 0 && (
          <button type="button" className="sr-btn" disabled={test === "running"} onClick={() => onTestModel(models[0])}>
            {test === "running" ? "测试中…" : "测试"}
          </button>
        )}
      </div>

      {test !== undefined && test !== "running" && (
        <p className="sr-role-test sr-mono" data-ok={test.ok || undefined}>
          {test.ok ? "✓" : "✗"} {test.detail}
          {test.ms === undefined ? "" : ` · ${test.ms} ms`}
        </p>
      )}

      {fetched !== null && (
        <div className="sr-model-picker">
          <div className="sr-model-picker-head">
            <input className="sr-input" value={query} placeholder="搜索模型" onChange={(event) => setQuery(event.target.value)} />
            <button type="button" className="sr-btn" onClick={() => setSelected(visible)}>
              全选
            </button>
            <button type="button" className="sr-btn" onClick={() => setSelected([])}>
              取消全选
            </button>
          </div>
          {fetched.error !== undefined && <p className="sr-role-test sr-mono">{fetched.error}（可以手动加）</p>}
          <ul className="sr-model-picker-list sr-scroll">
            {visible.map((model) => (
              <li key={model}>
                <label className="sr-model-picker-row">
                  <input
                    type="checkbox"
                    checked={selected.includes(model)}
                    onChange={(event) =>
                      setSelected((current) => (event.target.checked ? [...current, model] : current.filter((entry) => entry !== model)))
                    }
                  />
                  <span className="sr-mono">{model}</span>
                  {models.includes(model) && <span className="sr-role-empty sr-mono">已加入</span>}
                </label>
              </li>
            ))}
            {visible.length === 0 && <li className="sr-role-empty sr-mono">{fetched.list.length === 0 ? "端点没有返回模型列表" : "没有匹配的模型"}</li>}
          </ul>
          <div className="sr-model-picker-foot">
            <button
              type="button"
              className="sr-btn sr-btn--accent"
              disabled={selected.length === 0}
              onClick={() => {
                onAdd(selected);
                setSelected([]);
              }}
            >
              加入所选（{selected.length}）
            </button>
            <button type="button" className="sr-btn" onClick={() => setFetched(null)}>
              收起
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 模型档编辑器：上下文、最大输出、模态、工具调用、推理档、别名、单价。 */
function ModelProfileEditor({
  model,
  profile,
  onChange,
  onClose,
}: {
  model: string;
  profile: ModelProfile | undefined;
  onChange: (next: ModelProfile | null) => void;
  onClose: () => void;
}) {
  const current: ModelProfile = profile ?? { inputModalities: ["text"], outputModalities: ["text"], supportsToolCalling: true, messageParts: ["text"] };
  const patch = (next: Partial<ModelProfile>) => onChange({ ...current, ...next });
  const toggleModality = (modality: InputModality, where: "inputModalities" | "outputModalities") => {
    const list = current[where];
    const nextModalities = list.includes(modality) ? list.filter((entry) => entry !== modality) : [...list, modality];
    const messageParts: ModelProfile["messageParts"] =
      where === "inputModalities"
        ? [
            ...(nextModalities.includes("text") ? ["text" as const] : []),
            ...(nextModalities.includes("image") ? ["image_url" as const] : []),
            ...(nextModalities.includes("audio") ? ["input_audio" as const] : []),
          ]
        : current.messageParts;
    onChange({ ...current, [where]: nextModalities, messageParts });
  };

  return (
    <div className="sr-model-profile">
      <div className="sr-settings-pane-head">
        <h4 className="sr-settings-h3 sr-mono">{model}</h4>
        <div className="sr-provider-actions">
          <button type="button" className="sr-btn" onClick={() => onChange(null)}>
            清空档案
          </button>
          <button type="button" className="sr-btn sr-btn--accent" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
      <div className="sr-capability-grid">
        <label className="sr-field">
          <span className="sr-field-label sr-mono">上下文窗口（token）</span>
          <input
            className="sr-input"
            type="number"
            value={current.contextWindowTokens ?? ""}
            placeholder="不知道就留空"
            onChange={(event) => patch({ contextWindowTokens: event.target.value === "" ? undefined : Number(event.target.value) })}
          />
        </label>
        <label className="sr-field">
          <span className="sr-field-label sr-mono">最大输出（token）</span>
          <input
            className="sr-input"
            type="number"
            value={current.maxOutputTokens ?? ""}
            placeholder="不知道就留空"
            onChange={(event) => patch({ maxOutputTokens: event.target.value === "" ? undefined : Number(event.target.value) })}
          />
        </label>
        <label className="sr-field">
          <span className="sr-field-label sr-mono">别名（逗号分隔）</span>
          <input
            className="sr-input"
            value={(current.aliases ?? []).join(", ")}
            placeholder="另一个写法"
            onChange={(event) => patch({ aliases: event.target.value.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "") })}
          />
        </label>
        <label className="sr-field">
          <span className="sr-field-label sr-mono">推理档</span>
          <select
            className="sr-input"
            value={REASONING_PRESETS.find((entry) => JSON.stringify(entry.value) === JSON.stringify(current.reasoning))?.id ?? "custom"}
            onChange={(event) => {
              const preset = REASONING_PRESETS.find((entry) => entry.id === event.target.value);
              patch({ reasoning: preset?.value });
            }}
          >
            <option value="none-native">（没有）</option>
            {REASONING_PRESETS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="sr-model-profile-toggles">
        <label className="sr-check">
          <input
            type="checkbox"
            checked={current.inputModalities.includes("image")}
            onChange={() => toggleModality("image", "inputModalities")}
          />
          <span>可以识别图片</span>
        </label>
        <label className="sr-check">
          <input type="checkbox" checked={current.inputModalities.includes("audio")} onChange={() => toggleModality("audio", "inputModalities")} />
          <span>可以听音频</span>
        </label>
        <label className="sr-check">
          <input
            type="checkbox"
            checked={current.supportsToolCalling}
            onChange={(event) => patch({ supportsToolCalling: event.target.checked })}
          />
          <span>会调用工具（MCP）</span>
        </label>
      </div>
      <p className="sr-settings-hint sr-mono">现在：{describeProfile(current)}</p>
      <div className="sr-provider-actions">
        <button type="button" className="sr-btn" onClick={() => onChange(textChatProfile(current.contextWindowTokens))}>
          按「纯文本」填
        </button>
        <button type="button" className="sr-btn" onClick={() => onChange(visionChatProfile(current.contextWindowTokens, current.reasoning))}>
          按「能看图」填
        </button>
        <button type="button" className="sr-btn" onClick={() => onChange(plainTextProfile(current.contextWindowTokens))}>
          按「本地小模型」填
        </button>
      </div>
    </div>
  );
}
