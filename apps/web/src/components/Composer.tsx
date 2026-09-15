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
  otherMainModels = [],
  modelId,
  onModelSelect,
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
  /** 主模型配置好但还没接上 harness 的：列出来，但点不动。 */
  otherMainModels?: AgentModel[];
  modelId?: string;
  onModelSelect?: (id: string) => void;
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
  voiceState?: "listening" | "thinking" | "speaking";
  voiceLevel?: () => number;
  /** Live interim words, shown while listening so the user can see what was heard. */
  voicePartial?: string;
  /** Something the call needs to say (no microphone, recognition refused…). */
  voiceNotice?: string | null;
  onEndVoice?: () => void;
  placeholder?: string;
}) {
  const [menu, setMenu] = useState<"none" | "attach" | "model" | "path">("none");
  const [path, setPath] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const canSend = value.trim().length > 0 && !busy;
  const current = models.find((model) => model.id === modelId) ?? models.find((model) => model.isDefault) ?? models[0];
  const bars = useVoiceBars(voiceMode, voiceLevel);

  // Any click outside closes whichever popover is open.
  useEffect(() => {
    if (menu === "none") return;
    const onDown = (event: PointerEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setMenu("none");
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [menu]);

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
      {notice && (
        <div className="sr-composer-notice" role="status">
          {notice}
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
          <p className="sr-voicebar-heard" data-empty={(voicePartial ?? "") === "" || undefined}>
            {voiceState === "listening"
              ? voicePartial !== undefined && voicePartial !== ""
                ? voicePartial
                : "说吧，停下我就接"
              : voiceState === "thinking"
                ? "在想……"
                : "（说话可以打断我）"}
          </p>
          {voiceNotice !== null && voiceNotice !== undefined && (
            <p className="sr-voicebar-notice">{voiceNotice}</p>
          )}
          <div className="sr-voicebar-foot">
            <span className="sr-voicebar-status">
              <span className="sr-voicebar-dot" data-state={voiceState} />
              {voiceState === "listening" ? "正在听" : voiceState === "thinking" ? "正在想" : "正在说"}
            </span>
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
              title={current?.description ?? "选择模型"}
              onClick={() => setMenu((open) => (open === "model" ? "none" : "model"))}
            >
              <span className="sr-chip-label">{current?.displayName ?? "默认模型"}</span>
              <IconChevronDown size={12} />
            </button>
            <button
              type="button"
              className={busy ? "sr-send sr-send--stop" : "sr-send"}
              aria-label={busy ? "停止" : "发送"}
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
          <div className="sr-menu sr-menu--right" role="menu" aria-label="选择模型">
            <p className="sr-menu-title sr-mono">模型</p>
            {models.length === 0 && <p className="sr-menu-hint">内核没启动，读不到模型列表。</p>}
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
                  setMenu("none");
                }}
              >
                <span className="sr-menu-label">{model.displayName}</span>
                <span className="sr-menu-hint">{model.description}</span>
              </button>
            ))}
            {/*
              The main model is the *only* model this menu may ever offer (语音、生图 等在设置里).
              A custom 主模型 that is configured but not yet wired shows up switched off, so the
              menu never lies about what can answer right now.
            */}
            {otherMainModels.map((model) => (
              <button
                key={model.id}
                type="button"
                role="menuitemradio"
                aria-checked={false}
                className="sr-menu-item"
                disabled
                title="在设置里配好了，但要等 harness 接入后才由它回答"
              >
                <span className="sr-menu-label">{model.displayName}</span>
                <span className="sr-menu-hint">{model.description}</span>
              </button>
            ))}
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
