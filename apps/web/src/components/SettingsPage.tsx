/**
 * Settings — who does what.
 *
 * Four pages inside one workspace, in the order a person needs them:
 *
 * - **角色与路由**: one row per job (主模型 / 语音合成 / 音色克隆 / 语音识别 / 生图), pointing at a
 *   provider's capability. This is the page that answers "who answers my messages".
 * - **供应商**: the provider list, and a provider editor where capabilities are switched on. Each
 *   capability card carries its own protocol, endpoint and default model; anything left blank
 *   inherits the chat endpoint (see `lib/providers.ts`).
 * - **通话与声音**: which voice the call speaks with.
 *
 * Keys are typed in the provider editor and stored by the bridge (0600, `~/.shadowroom/credentials.json`);
 * this page only ever shows a mask and where it came from.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { IconPlus, IconStop } from "./icons";
import {
  CAPABILITIES,
  CAPABILITY_DEFAULTS,
  assignRole,
  capabilityModels,
  capabilityOf,
  capabilityStatus,
  capabilityStatusLabel,
  capabilityTarget,
  clearRole,
  credentialNameFor,
  providerProblems,
  removeProvider,
  roleSummary,
  roleTarget,
  setCapability,
  upsertProvider,
  type CapabilityKind,
  type ModelSettings,
  type ProviderProfile,
  type ProviderProtocol,
} from "../lib/providers";
import { deleteCredential, listCredentials, listProviderModels, saveCredential, testRole, type CredentialInfo } from "../lib/providerApi";
import { createSystemTTS, type VoiceInfo } from "../lib/tts";

const PROTOCOLS: Array<{ id: ProviderProtocol; label: string }> = [
  { id: "openai", label: "OpenAI 兼容" },
  { id: "elevenlabs", label: "ElevenLabs" },
  { id: "custom", label: "自定义" },
];

type SettingsSection = "roles" | "providers" | "voice";

/** A stable id for a new provider: readable, and never colliding with an existing one. */
function newProviderId(label: string, taken: string[]): string {
  const stem = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "provider";
  if (!taken.includes(`p-${stem}`)) return `p-${stem}`;
  for (let index = 2; index < 100; index += 1) {
    if (!taken.includes(`p-${stem}-${index}`)) return `p-${stem}-${index}`;
  }
  return `p-${stem}-${Date.now().toString(36)}`;
}

/** A brand-new provider: name, endpoint, protocol, key — no capabilities until they are switched on. */
function blankProvider(): ProviderProfile {
  return {
    id: "",
    label: "",
    baseUrl: "https://api.openai.com/v1",
    credentialRef: null,
    protocol: "openai",
    enabled: true,
    capabilities: { agent: { enabled: true, defaultModel: "" } },
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
  /** The provider being edited, or null when the list page is showing. */
  const [editing, setEditing] = useState<ProviderProfile | null>(null);
  const [credentials, setCredentials] = useState<CredentialInfo[]>([]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [models, setModels] = useState<Record<string, { list: string[]; error?: string; loading?: boolean }>>({});
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

  const credentialFor = useCallback(
    (name: string | null) => credentials.find((entry) => entry.name === name),
    [credentials],
  );

  const loadModels = useCallback(async (provider: ProviderProfile, kind: CapabilityKind) => {
    const key = `${provider.id}:${kind}`;
    const target = capabilityTarget(provider, kind);
    setModels((current) => ({ ...current, [key]: { list: current[key]?.list ?? [], loading: true } }));
    const answer = await listProviderModels({
      baseUrl: target.baseUrl,
      credentialRef: provider.credentialRef,
      protocol: target.protocol,
    });
    setModels((current) => ({
      ...current,
      [key]: { list: answer.models, ...(answer.error === undefined ? {} : { error: answer.error }) },
    }));
  }, []);

  const runTest = useCallback(
    async (provider: ProviderProfile, kind: CapabilityKind) => {
      const key = `${provider.id}:${kind}`;
      const target = capabilityTarget(provider, kind);
      if (target.model === "" || target.baseUrl === "") return;
      setTests((current) => ({ ...current, [key]: "running" }));
      try {
        const result = await testRole({
          provider: { baseUrl: target.baseUrl, credentialRef: provider.credentialRef, protocol: target.protocol },
          capability: kind,
          model: target.model,
          ...(target.options.voice === undefined ? {} : { voice: target.options.voice }),
        });
        setTests((current) => ({ ...current, [key]: result }));
      } catch (cause) {
        setTests((current) => ({
          ...current,
          [key]: { ok: false, detail: cause instanceof Error ? cause.message : String(cause) },
        }));
      }
    },
    [],
  );

  const problems = useMemo(() => (editing === null ? [] : providerProblems(editing)), [editing]);

  const saveEditing = useCallback(async () => {
    if (editing === null || problems.length > 0) return;
    setSaving(true);
    try {
      const label = editing.label.trim();
      const id = editing.id === "" ? newProviderId(label, settings.providers.map((entry) => entry.id)) : editing.id;
      const credentialRef =
        editing.credentialRef ?? credentialNameFor(label, credentials.map((entry) => entry.name));
      const profile: ProviderProfile = {
        ...editing,
        id,
        label,
        baseUrl: editing.baseUrl.trim().replace(/\/+$/, ""),
        credentialRef: editing.capabilities.agent === undefined && editing.credentialRef === null ? null : credentialRef,
      };
      onChange(upsertProvider(settings, profile));
      setEditing(null);
      setNotice(`已保存 ${profile.label}`);
    } catch (cause) {
      setNotice(`没保存：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setSaving(false);
    }
  }, [credentials, editing, onChange, problems.length, settings]);

  const saveKey = useCallback(
    async (provider: ProviderProfile, key: string) => {
      const name = provider.credentialRef ?? credentialNameFor(provider.label, credentials.map((entry) => entry.name));
      try {
        const stored = await saveCredential(name, key);
        setNotice(`已保存 ${stored.name} 的 Key（${stored.masked}）`);
        await refreshCredentials();
        return name;
      } catch (cause) {
        setNotice(`Key 没保存：${cause instanceof Error ? cause.message : String(cause)}`);
        return name;
      }
    },
    [credentials, refreshCredentials],
  );

  return (
    <section className="sr-settings">
      <header className="sr-settings-head">
        <h2 className="sr-settings-title">设置</h2>
        <span className="sr-settings-meta sr-mono">
          {settings.providers.length} 个服务商 · {settings.providers.reduce((count, provider) => count + Object.values(provider.capabilities).filter((entry) => entry?.enabled).length, 0)} 项能力
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
              { id: "providers", label: "供应商", hint: "端点与能力" },
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
                  <button type="button" className="sr-btn sr-settings-add" onClick={() => setEditing(blankProvider())}>
                    <IconPlus size={14} /> 添加供应商
                  </button>
                </div>
                <p className="sr-settings-hint">
                  一个供应商就是「一个网址 + 一把 Key」。同一家可以同时提供对话、语音、生图——
                  在它的编辑页里把能力一个个打开即可。
                </p>
                <ul className="sr-provider-list">
                  {settings.providers.map((provider) => {
                    const credential = credentialFor(provider.credentialRef);
                    const enabled = (Object.keys(CAPABILITY_DEFAULTS) as CapabilityKind[])
                      .filter((kind) => capabilityOf(provider, kind).enabled)
                      .map((kind) => CAPABILITIES.find((entry) => entry.kind === kind)?.label ?? kind);
                    return (
                      <li key={provider.id} className="sr-provider-card" data-off={!provider.enabled || undefined}>
                        <div className="sr-provider-main">
                          <span className="sr-provider-label">{provider.label}</span>
                          <span className="sr-provider-url sr-mono">{provider.baseUrl}</span>
                          <span className="sr-provider-meta sr-mono">
                            能力：{enabled.length === 0 ? "还没开" : enabled.join(" · ")}
                            {" · "}
                            {provider.credentialRef === null
                              ? "不需要 Key"
                              : credential === undefined || credential.source === "missing"
                                ? "Key 未配置"
                                : credential.source === "env"
                                  ? `来自环境变量 ${credential.variable}`
                                  : credential.masked}
                          </span>
                        </div>
                        <div className="sr-provider-actions">
                          <button type="button" className="sr-btn" onClick={() => setEditing(provider)}>
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
                  {settings.providers.length === 0 && <li className="sr-settings-empty">还没有供应商。</li>}
                </ul>
              </>
            ) : (
              <ProviderEditor
                provider={editing}
                credentials={credentials}
                models={models}
                tests={tests}
                saving={saving}
                problems={problems}
                onChange={setEditing}
                onLoadModels={loadModels}
                onTest={runTest}
                onSaveKey={saveKey}
                onCancel={() => setEditing(null)}
                onSave={() => void saveEditing()}
              />
            ))}

          {section === "roles" && (
            <>
              <h3 className="sr-settings-h3">角色与路由</h3>
              <p className="sr-settings-hint">
                每一行是一个角色。对话页的模型开关只会列「主模型」；语音、生图这些只在设置里改，
                不会跑到输入框旁边。
              </p>
              <ul className="sr-role-list">
                {CAPABILITIES.map(({ kind, label, hint }) => {
                  const target = roleTarget(settings, kind);
                  const candidates = settings.providers.filter((provider) => capabilityOf(provider, kind).enabled);
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
                            const next = event.target.value;
                            if (next === "") {
                              onChange(clearRole(settings, kind));
                              return;
                            }
                            onChange(assignRole(settings, kind, next));
                          }}
                        >
                          <option value="">未配置</option>
                          {candidates.map((provider) => (
                            <option key={provider.id} value={provider.id}>
                              {provider.label}
                            </option>
                          ))}
                        </select>
                        {candidates.length === 0 && (
                          <span className="sr-role-empty sr-mono">
                            还没有哪个供应商开了「{label}」——去供应商页打开
                          </span>
                        )}
                        {target !== undefined && (
                          <>
                            <select
                              className="sr-input"
                              aria-label={`${label} 模型`}
                              value={target.model}
                              onChange={(event) =>
                                onChange(
                                  setCapability(settings, target.provider.id, kind, { defaultModel: event.target.value }),
                                )
                              }
                            >
                              {capabilityModels(target.provider, kind).map((model) => (
                                <option key={model} value={model}>
                                  {model}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              className="sr-btn"
                              disabled={tests[`${target.provider.id}:${kind}`] === "running"}
                              onClick={() => void runTest(target.provider, kind)}
                            >
                              {tests[`${target.provider.id}:${kind}`] === "running" ? "测试中…" : "测试"}
                            </button>
                          </>
                        )}
                      </div>
                      {(() => {
                        const test = tests[`${target?.provider.id ?? ""}:${kind}`];
                        if (test === undefined || test === "running") return null;
                        return (
                          <p className="sr-role-test sr-mono" data-ok={test.ok || undefined}>
                            {test.ok ? "✓" : "✗"} {test.detail}
                            {test.ms === undefined ? "" : ` · ${test.ms} ms`}
                          </p>
                        );
                      })()}
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
                语音通话用哪个音色说话。列表来自这台机器装了的系统语音（macOS 在「系统设置 → 辅助功能 →
                朗读内容」里可以补装更好听的声音）；桌面包以后会换成自带音色，这里的名字到时候仍然有效。
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
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** The provider editor: identity, credential, then one card per capability. */
function ProviderEditor({
  provider,
  credentials,
  models,
  tests,
  saving,
  problems,
  onChange,
  onLoadModels,
  onTest,
  onSaveKey,
  onCancel,
  onSave,
}: {
  provider: ProviderProfile;
  credentials: CredentialInfo[];
  models: Record<string, { list: string[]; error?: string; loading?: boolean }>;
  tests: Record<string, { ok: boolean; detail: string; ms?: number } | "running">;
  saving: boolean;
  problems: string[];
  onChange: (next: ProviderProfile) => void;
  onLoadModels: (provider: ProviderProfile, kind: CapabilityKind) => Promise<void>;
  onTest: (provider: ProviderProfile, kind: CapabilityKind) => Promise<void>;
  onSaveKey: (provider: ProviderProfile, key: string) => Promise<string>;
  onCancel: () => void;
  onSave: () => void;
}) {
  const [keyDraft, setKeyDraft] = useState("");
  const credential = credentials.find((entry) => entry.name === provider.credentialRef);

  return (
    <div className="sr-provider-editor">
      <div className="sr-settings-pane-head">
        <h3 className="sr-settings-h3">{provider.id === "" ? "添加供应商" : `编辑 ${provider.label}`}</h3>
        <div className="sr-provider-actions">
          <button type="button" className="sr-btn" onClick={onCancel}>
            返回
          </button>
          <button type="button" className="sr-btn sr-btn--accent" disabled={saving || problems.length > 0} onClick={onSave}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
      {problems.length > 0 && <p className="sr-settings-problem">{problems.join(" · ")}</p>}

      <div className="sr-provider-form">
        <label className="sr-field">
          <span className="sr-field-label sr-mono">名称</span>
          <input
            className="sr-input"
            value={provider.label}
            placeholder="OpenAI"
            onChange={(event) => onChange({ ...provider, label: event.target.value })}
          />
        </label>
        <label className="sr-field sr-field--wide">
          <span className="sr-field-label sr-mono">对话端点</span>
          <input
            className="sr-input"
            value={provider.baseUrl}
            spellCheck={false}
            onChange={(event) => onChange({ ...provider, baseUrl: event.target.value })}
          />
        </label>
        <label className="sr-field">
          <span className="sr-field-label sr-mono">协议</span>
          <select
            className="sr-input"
            value={provider.protocol}
            onChange={(event) => onChange({ ...provider, protocol: event.target.value as ProviderProtocol })}
          >
            {PROTOCOLS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <label className="sr-field">
          <span className="sr-field-label sr-mono">
            凭证名
            {credential !== undefined && credential.source !== "missing" ? ` · ${credential.masked}` : ""}
          </span>
          <input
            className="sr-input"
            value={provider.credentialRef ?? ""}
            spellCheck={false}
            placeholder={credentialNameFor(provider.label || "provider", credentials.map((entry) => entry.name))}
            onChange={(event) => onChange({ ...provider, credentialRef: event.target.value === "" ? null : event.target.value })}
          />
        </label>
        <label className="sr-field sr-field--wide">
          <span className="sr-field-label sr-mono">API Key（留空表示不改）</span>
          <div className="sr-key-row">
            <input
              className="sr-input"
              type="password"
              value={keyDraft}
              spellCheck={false}
              placeholder="sk-…"
              onChange={(event) => setKeyDraft(event.target.value)}
            />
            <button
              type="button"
              className="sr-btn"
              disabled={keyDraft.trim() === ""}
              onClick={() => {
                void onSaveKey(provider, keyDraft.trim()).then((name) => {
                  setKeyDraft("");
                  if (provider.credentialRef === null && name !== "") onChange({ ...provider, credentialRef: name });
                });
              }}
            >
              保存 Key
            </button>
          </div>
        </label>
      </div>

      <h4 className="sr-settings-h3">能力</h4>
      <p className="sr-settings-hint">
        打开这家提供的能力。每张卡片里的协议与端点**留空就跟着对话端点走**（改了对话端点，它们自动跟着改），
        模型名和音色可以按需要填。
      </p>
      <div className="sr-capability-list">
        {CAPABILITIES.map(({ kind, label, hint }) => {
          const config = capabilityOf(provider, kind);
          const status = capabilityStatus(provider, kind, credentials.find((entry) => entry.name === provider.credentialRef));
          const target = capabilityTarget(provider, kind);
          const key = `${provider.id}:${kind}`;
          const modelList = models[key];
          const test = tests[key];
          return (
            <section key={kind} className="sr-capability-card" data-on={config.enabled || undefined} data-status={status}>
              <header className="sr-capability-head">
                <div className="sr-capability-title">
                  <span className="sr-capability-name">{label}</span>
                  <span className="sr-capability-badge sr-mono" data-status={status}>
                    {capabilityStatusLabel(status)}
                  </span>
                  <p className="sr-capability-hint">{hint}</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={config.enabled}
                  className="sr-capability-toggle"
                  data-on={config.enabled || undefined}
                  onClick={() =>
                    onChange(
                      config.enabled
                        ? ((): ProviderProfile => {
                            const capabilities = { ...provider.capabilities };
                            delete capabilities[kind];
                            return { ...provider, capabilities };
                          })()
                        : ((): ProviderProfile => {
                            const defaults = CAPABILITY_DEFAULTS[kind];
                            return {
                              ...provider,
                              capabilities: {
                                ...provider.capabilities,
                                [kind]: {
                                  enabled: true,
                                  defaultModel: config.defaultModel ?? defaults.model,
                                  ...(defaults.options === undefined ? {} : { options: { ...defaults.options } }),
                                },
                              },
                            };
                          })(),
                    )
                  }
                >
                  {config.enabled ? "开" : "关"}
                </button>
              </header>

              {config.enabled && (
                <div className="sr-capability-body">
                  <div className="sr-capability-grid">
                    <label className="sr-field">
                      <span className="sr-field-label sr-mono">协议</span>
                      <select
                        className="sr-input"
                        value={config.protocol ?? ""}
                        onChange={(event) =>
                          onChange(
                            setCapabilityOf(provider, kind, {
                              protocol: event.target.value === "" ? undefined : (event.target.value as ProviderProtocol),
                            }),
                          )
                        }
                      >
                        <option value="">跟随供应商（{provider.protocol}）</option>
                        {PROTOCOLS.map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {entry.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="sr-field sr-field--wide">
                      <span className="sr-field-label sr-mono">端点（留空＝跟随对话端点）</span>
                      <input
                        className="sr-input"
                        value={config.baseUrl ?? ""}
                        spellCheck={false}
                        placeholder={`${provider.baseUrl}（跟随）`}
                        onChange={(event) =>
                          onChange(setCapabilityOf(provider, kind, { baseUrl: event.target.value === "" ? undefined : event.target.value }))
                        }
                      />
                    </label>
                    <label className="sr-field">
                      <span className="sr-field-label sr-mono">
                        {kind === "agent" ? "默认模型（必填）" : "模型"}
                      </span>
                      <div className="sr-key-row">
                        <input
                          className="sr-input"
                          value={config.defaultModel ?? ""}
                          spellCheck={false}
                          placeholder={modelList?.loading === true ? "读取中…" : CAPABILITY_DEFAULTS[kind].model || "模型名"}
                          onChange={(event) => onChange(setCapabilityOf(provider, kind, { defaultModel: event.target.value }))}
                        />
                        <button type="button" className="sr-btn" onClick={() => void onLoadModels(provider, kind)}>
                          {modelList?.loading === true ? "…" : "取模型"}
                        </button>
                      </div>
                    </label>
                    {kind === "tts" && (
                      <label className="sr-field">
                        <span className="sr-field-label sr-mono">音色</span>
                        <input
                          className="sr-input"
                          value={config.options?.voice ?? ""}
                          spellCheck={false}
                          placeholder="alloy"
                          onChange={(event) =>
                            onChange(
                              setCapabilityOf(provider, kind, {
                                options: { ...(config.options ?? {}), voice: event.target.value },
                              }),
                            )
                          }
                        />
                      </label>
                    )}
                  </div>

                  {modelList !== undefined && modelList.list.length > 0 && (
                    <div className="sr-model-chips">
                      {modelList.list.slice(0, 40).map((model) => (
                        <button
                          key={model}
                          type="button"
                          className="sr-model-chip sr-mono"
                          data-on={config.defaultModel === model || undefined}
                          onClick={() => onChange(setCapabilityOf(provider, kind, { defaultModel: model }))}
                        >
                          {model}
                        </button>
                      ))}
                    </div>
                  )}
                  {modelList?.error !== undefined && (
                    <p className="sr-role-test sr-mono">{modelList.error}（可以直接手填模型名）</p>
                  )}

                  <div className="sr-capability-foot">
                    <span className="sr-capability-target sr-mono" title={`${target.baseUrl}${target.endpointPath ?? ""}`}>
                      实际调用：{target.protocol} · {target.baseUrl || "（没填端点）"}
                    </span>
                    <button
                      type="button"
                      className="sr-btn"
                      disabled={test === "running" || target.model === "" || target.baseUrl === ""}
                      onClick={() => void onTest(provider, kind)}
                    >
                      {test === "running" ? "测试中…" : "测试"}
                    </button>
                    {test !== undefined && test !== "running" && (
                      <span className="sr-role-test sr-mono" data-ok={test.ok || undefined}>
                        {test.ok ? "✓" : "✗"} {test.detail}
                        {test.ms === undefined ? "" : ` · ${test.ms} ms`}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** Patch one capability in place, keeping the "absent means inherit" rule. */
function setCapabilityOf(provider: ProviderProfile, kind: CapabilityKind, patch: Record<string, unknown>): ProviderProfile {
  const current = provider.capabilities[kind] ?? { enabled: true };
  const next: Record<string, unknown> = { ...current, ...patch };
  for (const key of Object.keys(next)) {
    if (next[key] === undefined) delete next[key];
  }
  return { ...provider, capabilities: { ...provider.capabilities, [kind]: next as never } };
}
