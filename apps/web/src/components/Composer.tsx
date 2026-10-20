/**
 * The composer card.
 *
 * Shape follows DeepSeek Harness (and Codex): attached context chips sit above the draft, the
 * toolbar below it holds the attach menu and the mode chips on the left and the model picker plus the
 * 34px send circle on the right. Plugins are *not* a mode here — they are picked from the attach menu,
 * the way Codex does it.
 */
import { useEffect, useRef, useState } from "react";
import type { AgentModel, Mention } from "../lib/agent";
import type { AgentAccess, EffortChoice } from "../lib/agent-settings";
import { ACCESS_LEVELS, accessLabel } from "../lib/agent-settings";
import type { CallState } from "../lib/call-states";
import { IconArrowUp, IconChevronDown, IconMic, IconPlugin, IconPlus, IconStop } from "./icons";

const MODES = ["标准", "极简"] as const;

export function Composer({
  variant,
  value,
  onChange,
  onSubmit,
  onStop,
  busy,
  mode,
  onModeChange,
  models = [],
  pendingModels = [],
  modelId,
  onModelSelect,
  effortId,
  effortChoice,
  onEffortSelect,
  access,
  onAccessSelect,
  settingsBusy = false,
  settingsNotice,
  attachments = [],
  onAttach,
  onDetach,
  plugins = [],
  pluginRoot = "",
  onOpenPlugin,
  notice,
  listening = false,
  voiceSupported = false,
  onToggleVoice,
  voiceMode = false,
  voiceState = "listening",
  voiceLevel,
  voicePartial,
  voiceNotice,
  onEndVoice,
  placeholder = "描述你想做的音乐或任务，例如：排一套 60 分钟的 tech house set",
}: {
  variant: "hero" | "docked";
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  busy: boolean;
  mode: string;
  onModeChange: (mode: string) => void;
  models?: AgentModel[];
  /** 主模型配好了但还没接上（Codex 侧通道未打通）：列出来，但点不动。 */
  pendingModels?: AgentModel[];
  modelId?: string;
  onModelSelect?: (id: string) => void;
  /** 当前生效的思考深度档；模型没有可映射档时为 undefined。 */
  effortId?: string;
  effortChoice?: EffortChoice;
  onEffortSelect?: (effort: string) => void;
  access?: AgentAccess;
  onAccessSelect?: (access: AgentAccess) => void;
  /** 回合进行中或设置更新中：模型/深度/权限三个控制全部禁用。 */
  settingsBusy?: boolean;
  /** 设置相关的反馈（成功「从下一轮开始生效」/ 失败原文），显示在输入框上方。 */
  settingsNotice?: string;
  attachments?: Mention[];
  onAttach?: (mention: Mention) => void;
  onDetach?: (name: string) => void;
  plugins?: Array<{ repo: string; label: string; connected: boolean }>;
  /** Directory the plugin checkouts live in; mentions need a real path. */
  pluginRoot?: string;
  onOpenPlugin?: (repo: string) => void;
  notice?: string;
  /** Voice control state (speech recognition). */
  listening?: boolean;
  voiceSupported?: boolean;
  onToggleVoice?: () => void;
  /** Call mode: the card becomes a waveform instead of a text box. */
  voiceMode?: boolean;
  /** 通话五态（类型住 lib/call-states，词表与渲染都只在球字幕一侧——F-2 的收敛）。 */
  voiceState?: CallState;
  voiceLevel?: () => number;
  /** Live interim words, shown while listening so the user can see what was heard. */
  voicePartial?: string;
  /** Something the call needs to say (no microphone, recognition refused…). */
  voiceNotice?: string | null;
  onEndVoice?: () => void;
  placeholder?: string;
}) {
  const [menu, setMenu] = useState<"none" | "attach" | "model" | "path" | "access">("none");
  const [path, setPath] = useState("");
  /**
   * 完全访问的风险门：每次打开都从零开始勾选，确认过了才提交——勾选状态绝不持久化
   * （Kimi #484 第 5 条）。切到别的档或关菜单即复位。
   */
  const [dangerArmed, setDangerArmed] = useState(false);
  const [dangerChecked, setDangerChecked] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const canSend = value.trim().length > 0 && !busy;
  const current = models.find((model) => model.id === modelId) ?? models.find((model) => model.isDefault) ?? models[0];
  const bars = useVoiceBars(voiceMode, voiceLevel);
  const effort = effortChoice ?? { kind: "hidden" as const };

  // Any click outside closes whichever popover is open — and re-arms the danger gate so the
  // checkbox can never survive into the next open (每次进入完全访问都要重新勾选).
  useEffect(() => {
    if (menu === "none") return;
    const onDown = (event: PointerEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) {
        setMenu("none");
        setDangerArmed(false);
        setDangerChecked(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [menu]);

  const closeMenus = () => {
    setMenu("none");
    setDangerArmed(false);
    setDangerChecked(false);
  };

  const chooseAccess = (level: AgentAccess) => {
    if (level === "danger-full-access") return; // 只能从风险门的确认按钮进
    closeMenus();
    onAccessSelect?.(level);
  };

  const confirmDanger = () => {
    if (!dangerChecked) return; // 未勾选：档位不变，什么都不提交
    closeMenus();
    onAccessSelect?.("danger-full-access");
  };

  const attachPath = () => {
    const trimmed = path.trim();
    if (trimmed === "") return;
    onAttach?.({
      name: trimmed.split("/").filter(Boolean).pop() ?? trimmed,
      path: trimmed,
      label: trimmed.split("/").filter(Boolean).pop() ?? trimmed,
    });
    setPath("");
    setMenu("none");
  };

  return (
    <div className="sr-composer" data-variant={variant} ref={root}>
      {(notice || settingsNotice) && (
        <div className="sr-composer-notice" role="status">
          {settingsNotice ?? notice}
        </div>
      )}
      {voiceMode ? (
        <div className="sr-composer-card sr-voicebar">
          <div className="sr-voicebar-wave" aria-hidden="true">
            {bars.map((value, index) => (
              <span
                key={index}
                className="sr-voicebar-bar"
                data-tail={index > bars.length - 6 || undefined}
                style={{ height: `${Math.max(6, Math.round(value * 100))}%` }}
              />
            ))}
          </div>
          {/* F-2（ui-review-kimi §③）：状态词只渲染在球旁字幕一处，这里只放「听到了什么」和
              两条静态提示。在想时状态在球字幕上，这一行没有可报的听写内容，就留白（data-empty 置灰）。 */}
          <p className="sr-voicebar-heard" data-empty={(voicePartial ?? "") === "" || undefined}>
            {voiceState === "listening"
              ? voicePartial !== undefined && voicePartial !== ""
                ? voicePartial
                : "说吧，停下我就接"
              : voiceState === "speaking"
                ? "（说话可以打断我）"
                : ""}
          </p>
          {voiceNotice !== null && voiceNotice !== undefined && (
            <p className="sr-voicebar-notice">{voiceNotice}</p>
          )}
          <div className="sr-voicebar-foot">
            <button type="button" className="sr-btn sr-voicebar-end" onClick={onEndVoice}>
              结束通话
            </button>
          </div>
        </div>
      ) : (
      <div className="sr-composer-card">
        {attachments.length > 0 && (
          <div className="sr-composer-accessory">
            {attachments.map((attachment) => (
              <span key={attachment.name} className="sr-ctx-chip" title={attachment.path}>
                <IconPlugin size={12} />
                <span className="sr-ctx-name sr-mono">{attachment.label}</span>
                <button
                  type="button"
                  className="sr-ctx-remove"
                  aria-label={`移除 ${attachment.label}`}
                  onClick={() => onDetach?.(attachment.name)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="sr-composer-scroll">
          <textarea
            className="sr-composer-input"
            value={value}
            rows={1}
            placeholder={placeholder}
            aria-label={placeholder}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setMenu("none");
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (canSend) onSubmit();
              }
            }}
          />
        </div>

        <div className="sr-composer-row">
          <div className="sr-composer-tools">
            <button
              type="button"
              className="sr-attach"
              aria-label="添加"
              title="添加"
              aria-haspopup="menu"
              aria-expanded={menu !== "none"}
              onClick={() => setMenu((open) => (open === "none" ? "attach" : "none"))}
            >
              <IconPlus size={14} />
            </button>
            <div className="sr-modes">
              {MODES.map((entry) => (
                <button
                  key={entry}
                  type="button"
                  className="sr-mode"
                  aria-pressed={entry === mode}
                  data-on={entry === mode || undefined}
                  onClick={() => onModeChange(entry)}
                >
                  {entry}
                </button>
              ))}
            </div>
          </div>
          <div className="sr-composer-trailing">
            {onToggleVoice && (
              <button
                type="button"
                className="sr-voice"
                aria-label={listening ? "停止语音输入" : "语音输入"}
                title={voiceSupported ? (listening ? "停止语音输入" : "语音输入") : "这个浏览器不支持语音识别"}
                aria-pressed={listening}
                data-listening={listening || undefined}
                disabled={!voiceSupported}
                onClick={onToggleVoice}
              >
                <IconMic size={16} />
              </button>
            )}
            <button
              type="button"
              className="sr-chip sr-chip--button"
              aria-haspopup="menu"
              aria-expanded={menu === "model"}
              title={settingsBusy ? "回合进行中" : (current?.description ?? "模型与思考深度")}
              disabled={settingsBusy}
              data-busy={settingsBusy || undefined}
              onClick={() => setMenu((open) => (open === "model" ? "none" : "model"))}
            >
              <span className="sr-chip-label">
                {current?.displayName ?? "默认模型"}
                {effortId !== undefined ? ` · ${effortId}` : ""}
              </span>
              <IconChevronDown size={12} />
            </button>
            {onAccessSelect !== undefined && access !== undefined && (
              <button
                type="button"
                className="sr-chip sr-chip--button sr-chip--access"
                aria-haspopup="menu"
                aria-expanded={menu === "access"}
                title={settingsBusy ? "回合进行中" : "访问权限（从下一轮开始生效）"}
                disabled={settingsBusy}
                data-busy={settingsBusy || undefined}
                data-access={access}
                onClick={() => setMenu((open) => (open === "access" ? "none" : "access"))}
              >
                <span className="sr-chip-label">{accessLabel(access)}</span>
                <IconChevronDown size={12} />
              </button>
            )}
            <button
              type="button"
              className={busy ? "sr-send sr-send--stop" : "sr-send"}
              aria-label={busy ? "停止这一轮" : "发送"}
              title={busy ? "停止这一轮" : "发送"}
              disabled={busy ? onStop === undefined : !canSend}
              onClick={busy ? onStop : onSubmit}
            >
              {busy ? <IconStop size={14} /> : <IconArrowUp size={16} />}
            </button>
          </div>
        </div>

        {menu === "attach" && (
          <div className="sr-menu" role="menu" aria-label="添加">
            <p className="sr-menu-title sr-mono">添加</p>
            <button
              type="button"
              role="menuitem"
              className="sr-menu-item"
              onClick={() => setMenu("path")}
            >
              <span className="sr-menu-label">文件和文件夹</span>
              <span className="sr-menu-hint">粘贴路径，随消息一起交给智能体</span>
            </button>
            {plugins.length > 0 && (
              <>
                <p className="sr-menu-title sr-mono">插件</p>
                {plugins.map((plugin) => (
                  <button
                    key={plugin.repo}
                    type="button"
                    role="menuitem"
                    className="sr-menu-item"
                    onClick={() => {
                      onAttach?.({
                        name: plugin.repo,
                        path: pluginRoot === "" ? plugin.repo : `${pluginRoot}/${plugin.repo}`,
                        label: plugin.label,
                      });
                      setMenu("none");
                    }}
                  >
                    <span className="sr-menu-label">{plugin.label}</span>
                    <span className="sr-menu-hint sr-mono">{plugin.repo}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        )}

        {menu === "path" && (
          <div className="sr-menu" role="menu" aria-label="文件和文件夹">
            <p className="sr-menu-title sr-mono">文件或文件夹路径</p>
            <input
              className="sr-input sr-menu-input"
              value={path}
              autoFocus
              spellCheck={false}
              placeholder="/Users/…/track.wav"
              onChange={(event) => setPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") attachPath();
                if (event.key === "Escape") setMenu("none");
              }}
            />
            <button type="button" className="sr-menu-item" onClick={attachPath}>
              <span className="sr-menu-label">附加这个路径</span>
            </button>
          </div>
        )}

        {menu === "model" && (
          <div className="sr-menu sr-menu--right" role="menu" aria-label="模型与思考深度">
            <p className="sr-menu-title sr-mono">模型</p>
            {models.length === 0 && <p className="sr-menu-hint">内核没启动，读不到模型列表。</p>}
            {pendingModels.map((model) => (
              <button
                key={model.id}
                type="button"
                role="menuitemradio"
                aria-checked={false}
                className="sr-menu-item"
                disabled
                title={model.description}
              >
                <span className="sr-menu-label">{model.displayName}</span>
                <span className="sr-menu-hint">{model.description}</span>
              </button>
            ))}
            {models.map((model) => (
              <button
                key={model.id}
                type="button"
                role="menuitemradio"
                aria-checked={model.id === current?.id}
                className="sr-menu-item"
                data-on={model.id === current?.id || undefined}
                onClick={() => {
                  onModelSelect?.(model.id);
                  closeMenus();
                }}
              >
                <span className="sr-menu-label">{model.displayName}</span>
                <span className="sr-menu-hint">{model.description}</span>
              </button>
            ))}
            {effort.kind === "list" && onEffortSelect !== undefined && (
              <>
                <p className="sr-menu-title sr-mono">思考深度</p>
                {effort.efforts.map((level) => (
                  <button
                    key={level}
                    type="button"
                    role="menuitemradio"
                    aria-checked={level === effortId}
                    className="sr-menu-item"
                    data-on={level === effortId || undefined}
                    onClick={() => {
                      onEffortSelect(level);
                      closeMenus();
                    }}
                  >
                    <span className="sr-menu-label">{level}</span>
                  </button>
                ))}
              </>
            )}
            {effort.kind === "locked" && (
              <>
                <p className="sr-menu-title sr-mono">思考深度</p>
                <div className="sr-menu-item" role="menuitemradio" aria-checked={true} data-locked="true">
                  <span className="sr-menu-label">
                    {effort.effort}
                    <span className="sr-menu-hint">锁定——这个模型自己内置推理</span>
                  </span>
                </div>
              </>
            )}
            {/* hidden：模型没有可映射的思考深度——整节不出现，也不往请求里带 effort。 */}
          </div>
        )}

        {menu === "access" && access !== undefined && (
          <div className="sr-menu sr-menu--right" role="menu" aria-label="访问权限">
            <p className="sr-menu-title sr-mono">访问权限 · 从下一轮开始生效</p>
            {ACCESS_LEVELS.filter((level) => !dangerArmed || level.id === "danger-full-access").map((level) => (
              <button
                key={level.id}
                type="button"
                role="menuitemradio"
                aria-checked={level.id === access && !dangerArmed}
                className="sr-menu-item"
                data-on={level.id === access && !dangerArmed ? true : undefined}
                onClick={() => {
                  if (level.id === "danger-full-access") {
                    setDangerArmed(true);
                    setDangerChecked(false);
                    return;
                  }
                  chooseAccess(level.id);
                }}
              >
                <span className="sr-menu-label">{level.label}</span>
                <span className="sr-menu-hint">{level.hint}</span>
              </button>
            ))}
            {dangerArmed && (
              <div className="sr-menu-danger" data-testid="access-danger-gate">
                <label className="sr-menu-danger-check">
                  <input
                    type="checkbox"
                    checked={dangerChecked}
                    onChange={(event) => setDangerChecked(event.target.checked)}
                  />
                  <span>我了解风险：可读写整盘、回合内不再询问</span>
                </label>
                <div className="sr-menu-danger-row">
                  <button type="button" className="sr-btn sr-menu-danger-cancel" onClick={closeMenus}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="sr-btn sr-menu-danger-confirm"
                    disabled={!dangerChecked}
                    aria-disabled={!dangerChecked}
                    onClick={confirmDanger}
                  >
                    确认完全访问
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      )}
    </div>
  );
}

/** Rolling loudness history for the call waveform (25 fps, newest on the right). */
function useVoiceBars(active: boolean, read: (() => number) | undefined): number[] {
  const [bars, setBars] = useState<number[]>(() => new Array(48).fill(0.08));
  useEffect(() => {
    if (!active || read === undefined) {
      setBars(new Array(48).fill(0.08));
      return;
    }
    let raf: number | null = null;
    let last = 0;
    const tick = (now: number) => {
      if (now - last > 40) {
        last = now;
        const level = Math.max(0.06, Math.min(1, read()));
        setBars((current) => [...current.slice(1), level]);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [active, read]);
  return bars;
}
