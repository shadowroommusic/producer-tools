/**
 * The composer card: 22px capsule, accessory row, growing draft, toolbar row with the attach
 * control, the mode chips and the 34px send circle. Geometry is DeepSeek Harness's InputBar; the
 * modes and the plugin chip are ours.
 */
import { useRef } from "react";
import { IconArrowUp, IconChevronDown, IconPlus, IconStop } from "./icons";

const MODES = ["标准", "极简", "Code Mode"] as const;

export function Composer({
  variant,
  value,
  onChange,
  onSubmit,
  onStop,
  busy,
  mode,
  onModeChange,
  plugin,
  onPluginClick,
  notice,
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
  plugin?: { label: string; repo: string };
  onPluginClick?: () => void;
  notice?: string;
  placeholder?: string;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const canSend = value.trim().length > 0 && !busy;

  return (
    <div className="sr-composer" data-variant={variant}>
      {notice && (
        <div className="sr-composer-notice" role="status">
          {notice}
        </div>
      )}
      <div className="sr-composer-card">
        <div className="sr-composer-scroll">
          <textarea
            ref={input}
            className="sr-composer-input"
            value={value}
            rows={1}
            placeholder={placeholder}
            aria-label={placeholder}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (canSend) onSubmit();
              }
            }}
          />
        </div>
        <div className="sr-composer-row">
          <div className="sr-composer-tools">
            <button type="button" className="sr-attach" aria-label="添加上下文" title="添加上下文">
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
            {plugin && (
              <button
                type="button"
                className="sr-chip sr-chip--button"
                title={`打开 ${plugin.repo} 面板`}
                onClick={onPluginClick}
              >
                <span className="sr-chip-label">{plugin.label}</span>
                <IconChevronDown size={12} />
              </button>
            )}
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
      </div>
    </div>
  );
}
