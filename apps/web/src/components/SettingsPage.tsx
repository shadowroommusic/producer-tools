/**
 * Settings — who does what.
 *
 * Two questions, in this order: which services do I have keys for (服务商), and which of them does
 * each job (角色). The second question is the one the user actually asked: 主模型 answers the chat,
 * 语音合成 speaks, 音色克隆 makes a voice, 生图 draws. Only the first ever appears next to the send
 * button — the rule lives in `mainModelChoices()`, not in this file's layout.
 *
 * Keys are typed here and stored by the bridge (0600, `~/.shadowroom/credentials.json`); the list
 * below shows a mask and where it came from, never the value.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { IconPlus, IconStop } from "./icons";
import {
  CAPABILITIES,
  assignedSlot,
  assignRole,
  clearRole,
  credentialNameFor,
  emptySettings,
  loadModelSettings,
  providerProblems,
  removeProvider,
  roleSummary,
  saveModelSettings,
  upsertProvider,
  type CapabilityKind,
  type ModelSettings,
  type ProviderProfile,
  type ProviderProtocol,
} from "../lib/providers";
import { deleteCredential, listCredentials, listProviderModels, saveCredential, testRole, type CredentialInfo } from "../lib/providerApi";

const PROTOCOLS: Array<{ id: ProviderProtocol; label: string }> = [
  { id: "openai", label: "OpenAI 兼容（最常见）" },
  { id: "elevenlabs", label: "ElevenLabs（语音）" },
  { id: "custom", label: "自定义端点" },
];

/** A stable id for a new provider: readable, and never colliding with an existing one. */
function newProviderId(label: string, taken: string[]): string {
  const stem = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "provider";
  if (!taken.includes(`p-${stem}`)) return `p-${stem}`;
  for (let index = 2; index < 100; index += 1) {
    if (!taken.includes(`p-${stem}-${index}`)) return `p-${stem}-${index}`;
  }
  return `p-${stem}-${Date.now().toString(36)}`;
}

type Draft = {
  id: string | null;
  label: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  credentialRef: string;
  key: string;
};

const emptyDraft = (): Draft => ({
  id: null,
  label: "",
  baseUrl: "https://api.openai.com/v1",
  protocol: "openai",
  credentialRef: "",
  key: "",
});

export function SettingsPage({
  settings,
  onChange,
}: {
  /** Owned by the App, so the chat's model switch and this page never disagree. */
  settings: ModelSettings;
  onChange: (next: ModelSettings) => void;
}) {
  const setSettings = (next: ModelSettings | ((current: ModelSettings) => ModelSettings)) =>
    onChange(typeof next === "function" ? next(settings) : next);
  const [credentials, setCredentials] = useState<CredentialInfo[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** Model lists per provider, fetched the first time a dropdown needs them. */
  const [models, setModels] = useState<Record<string, { list: string[]; error?: string; loading?: boolean }>>({});
  /** Per-role test results, keyed by role. */
  const [tests, setTests] = useState<Record<string, { ok: boolean; detail: string; ms?: number } | "running">>({});

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

  const credentialFor = useCallback(
    (name: string | null) => credentials.find((entry) => entry.name === name),
    [credentials],
  );

  const loadModels = useCallback(
    async (provider: ProviderProfile) => {
      setModels((current) => ({ ...current, [provider.id]: { list: current[provider.id]?.list ?? [], loading: true } }));
      const answer = await listProviderModels(provider);
      setModels((current) => ({ ...current, [provider.id]: { list: answer.models, ...(answer.error === undefined ? {} : { error: answer.error }) } }));
    },
    [],
  );

  const problems = useMemo(() => (draft === null ? [] : providerProblems(draft)), [draft]);

  const saveDraft = useCallback(async () => {
    if (draft === null || problems.length > 0) return;
    setSaving(true);
    try {
      const cleanLabel = draft.label.trim();
      const credentialRef =
        draft.credentialRef.trim() !== ""
          ? draft.credentialRef.trim().toLowerCase()
          : credentialNameFor(cleanLabel, credentials.map((entry) => entry.name));
      if (draft.key.trim() !== "") {
        const stored = await saveCredential(credentialRef, draft.key.trim());
        setNotice(`已保存 ${stored.name} 的 Key（${stored.masked}）`);
        await refreshCredentials();
      }
      const profile: ProviderProfile = {
        id: draft.id ?? newProviderId(cleanLabel, settings.providers.map((entry) => entry.id)),
        label: cleanLabel,
        baseUrl: draft.baseUrl.trim().replace(/\/+$/, ""),
        credentialRef: draft.key.trim() === "" && draft.credentialRef.trim() === "" ? null : credentialRef,
        protocol: draft.protocol,
        enabled: true,
      };
      setSettings((current) => upsertProvider(current, profile));
      setDraft(null);
    } catch (cause) {
      setNotice(`没保存：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setSaving(false);
    }
  }, [credentials, draft, problems.length, refreshCredentials, settings.providers]);

  const runTest = useCallback(
    async (role: CapabilityKind, provider: ProviderProfile, model: string, voice?: string) => {
      setTests((current) => ({ ...current, [role]: "running" }));
      try {
        const result = await testRole({ provider, capability: role, model, ...(voice === undefined ? {} : { voice }) });
        setTests((current) => ({ ...current, [role]: result }));
      } catch (cause) {
        setTests((current) => ({
          ...current,
          [role]: { ok: false, detail: cause instanceof Error ? cause.message : String(cause) },
        }));
      }
    },
    [],
  );

  return (
    <section className="sr-settings">
      <header className="sr-settings-head">
        <h2 className="sr-settings-title">设置</h2>
        <span className="sr-settings-meta sr-mono">
          {settings.providers.length} 个服务商 · {settings.slots.length} 个模型
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

      {/* ① 服务商：端点 + 凭证名。Key 交给 bridge，这里只显示掩码。 */}
      <section className="sr-settings-section">
        <h3 className="sr-settings-h3">模型服务商</h3>
        <p className="sr-settings-hint">
          一个服务商就是「一个网址 + 一把 Key」。同一个服务商可以同时提供对话、语音、生图——
          下面按角色分配就行。Key 存在本机（只有你这个用户读得到），界面里只显示后四位。
        </p>

        <ul className="sr-provider-list">
          {settings.providers.map((provider) => {
            const credential = credentialFor(provider.credentialRef);
            return (
              <li key={provider.id} className="sr-provider-card" data-off={!provider.enabled || undefined}>
                <div className="sr-provider-main">
                  <span className="sr-provider-label">{provider.label}</span>
                  <span className="sr-provider-url sr-mono">{provider.baseUrl}</span>
                  <span className="sr-provider-meta sr-mono">
                    {PROTOCOLS.find((entry) => entry.id === provider.protocol)?.label ?? provider.protocol}
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
                  <button
                    type="button"
                    className="sr-btn"
                    onClick={() =>
                      setDraft({
                        id: provider.id,
                        label: provider.label,
                        baseUrl: provider.baseUrl,
                        protocol: provider.protocol,
                        credentialRef: provider.credentialRef ?? "",
                        key: "",
                      })
                    }
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="sr-btn"
                    onClick={() => setSettings((current) => upsertProvider(current, { ...provider, enabled: !provider.enabled }))}
                  >
                    {provider.enabled ? "停用" : "启用"}
                  </button>
                  <button
                    type="button"
                    className="sr-btn sr-btn--danger"
                    onClick={() => {
                      setSettings((current) => removeProvider(current, provider.id));
                      if (provider.credentialRef !== null) void deleteCredential(provider.credentialRef).then(refreshCredentials);
                    }}
                  >
                    删除
                  </button>
                </div>
              </li>
            );
          })}
          {settings.providers.length === 0 && <li className="sr-settings-empty">还没有服务商。添加一个，就能把角色指过去。</li>}
        </ul>

        {draft === null ? (
          <button type="button" className="sr-btn sr-settings-add" onClick={() => setDraft(emptyDraft())}>
            <IconPlus size={14} /> 添加服务商
          </button>
        ) : (
          <div className="sr-provider-form">
            <label className="sr-field">
              <span className="sr-field-label sr-mono">名称</span>
              <input
                className="sr-input"
                value={draft.label}
                placeholder="OpenAI"
                onChange={(event) => setDraft({ ...draft, label: event.target.value })}
              />
            </label>
            <label className="sr-field sr-field--wide">
              <span className="sr-field-label sr-mono">Base URL</span>
              <input
                className="sr-input"
                value={draft.baseUrl}
                spellCheck={false}
                placeholder="https://api.openai.com/v1"
                onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
              />
            </label>
            <label className="sr-field">
              <span className="sr-field-label sr-mono">协议</span>
              <select
                className="sr-input"
                value={draft.protocol}
                onChange={(event) => setDraft({ ...draft, protocol: event.target.value as ProviderProtocol })}
              >
                {PROTOCOLS.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="sr-field">
              <span className="sr-field-label sr-mono">凭证名</span>
              <input
                className="sr-input"
                value={draft.credentialRef}
                spellCheck={false}
                placeholder={credentialNameFor(draft.label || "provider", credentials.map((entry) => entry.name))}
                onChange={(event) => setDraft({ ...draft, credentialRef: event.target.value })}
              />
            </label>
            <label className="sr-field sr-field--wide">
              <span className="sr-field-label sr-mono">API Key{draft.id === null ? "" : "（留空表示不改）"}</span>
              <input
                className="sr-input"
                type="password"
                value={draft.key}
                spellCheck={false}
                placeholder="sk-…"
                onChange={(event) => setDraft({ ...draft, key: event.target.value })}
              />
            </label>
            <div className="sr-provider-form-actions">
              {problems.length > 0 && <span className="sr-settings-problem">{problems.join(" · ")}</span>}
              <button type="button" className="sr-btn" onClick={() => setDraft(null)}>
                取消
              </button>
              <button
                type="button"
                className="sr-btn sr-btn--accent"
                disabled={saving || problems.length > 0}
                onClick={() => void saveDraft()}
              >
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ② 角色：谁干什么。对话页只会用「主模型」这一行。 */}
      <section className="sr-settings-section">
        <h3 className="sr-settings-h3">角色</h3>
        <p className="sr-settings-hint">
          每一行是一个角色。对话页的模型开关只列「主模型」；语音、生图这些只在设置里改，不会跑到输入框旁边。
        </p>
        <ul className="sr-role-list">
          {CAPABILITIES.map(({ kind, label, hint }) => {
            /** The half-typed row matters here too: a provider is chosen before its model is named. */
            const slot = assignedSlot(settings, kind);
            const provider = settings.providers.find((entry) => entry.id === slot?.providerId);
            const list = provider === undefined ? undefined : models[provider.id];
            const test = tests[kind];
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
                    aria-label={`${label} 服务商`}
                    value={provider?.id ?? ""}
                    onChange={(event) => {
                      if (event.target.value === "") {
                        setSettings((current) => clearRole(current, kind));
                        return;
                      }
                      const next = settings.providers.find((entry) => entry.id === event.target.value);
                      if (next === undefined) return;
                      setSettings((current) => assignRole(current, kind, next.id, slot?.model ?? ""));
                      if (models[next.id] === undefined) void loadModels(next);
                    }}
                  >
                    <option value="">未配置</option>
                    {settings.providers.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.label}
                      </option>
                    ))}
                  </select>

                  {provider === undefined ? (
                    <span className="sr-role-empty sr-mono">选一个服务商</span>
                  ) : (
                    <>
                      {list !== undefined && list.list.length > 0 ? (
                        <select
                          className="sr-input"
                          aria-label={`${label} 模型`}
                          value={slot?.model ?? ""}
                          onChange={(event) => setSettings((current) => assignRole(current, kind, provider.id, event.target.value, slot?.metadata))}
                        >
                          <option value="">选模型…</option>
                          {list.list.map((model) => (
                            <option key={model} value={model}>
                              {model}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          className="sr-input"
                          aria-label={`${label} 模型名`}
                          value={slot?.model ?? ""}
                          spellCheck={false}
                          placeholder={list?.loading === true ? "读取模型列表…" : "模型名"}
                          onChange={(event) => setSettings((current) => assignRole(current, kind, provider.id, event.target.value, slot?.metadata))}
                        />
                      )}
                      <button
                        type="button"
                        className="sr-btn"
                        title={list?.error ?? "从服务商读取模型列表"}
                        onClick={() => void loadModels(provider)}
                      >
                        {list?.loading === true ? "…" : "取模型"}
                      </button>
                    </>
                  )}

                  {kind === "tts" && provider !== undefined && (
                    <input
                      className="sr-input sr-input--num"
                      aria-label="音色"
                      value={slot?.metadata?.voice ?? ""}
                      spellCheck={false}
                      placeholder="音色（如 alloy）"
                      onChange={(event) =>
                        setSettings((current) => assignRole(current, kind, provider.id, slot?.model ?? "", { voice: event.target.value }))
                      }
                    />
                  )}

                  {provider !== undefined && slot !== undefined && slot.model !== "" && (
                    <button
                      type="button"
                      className="sr-btn"
                      disabled={test === "running"}
                      onClick={() => void runTest(kind, provider, slot.model, slot.metadata?.voice)}
                    >
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
                {list?.error !== undefined && <p className="sr-role-test sr-mono">{list.error}（可以直接手填模型名）</p>}
              </li>
            );
          })}
        </ul>
      </section>
    </section>
  );
}
