import { useState } from "react";

const MODES = ["标准", "极简", "Code Mode"] as const;
const CAPABILITIES = ["创造", "MCP", "Skills"] as const;

export function Composer({
  value,
  onChange,
  onSubmit,
  busy,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  const [mode, setMode] = useState<string>(MODES[0]);
  const [capabilities, setCapabilities] = useState<string[]>(["MCP"]);

  const toggle = (item: string) =>
    setCapabilities((current) =>
      current.includes(item) ? current.filter((entry) => entry !== item) : [...current, item],
    );

  return (
    <div className="sr-composer">
      <textarea
        className="sr-composer-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="描述你想做的音乐或任务，例如：给这段 128 BPM 的 tech house 排一套 60 分钟的 set"
        rows={4}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) onSubmit();
        }}
      />
      <div className="sr-composer-row">
        <div className="sr-segmented">
          {MODES.map((item) => (
            <button
              key={item}
              className={`sr-segmented-item${mode === item ? " is-active" : ""}`}
              onClick={() => setMode(item)}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="sr-chips">
          {CAPABILITIES.map((item) => (
            <button
              key={item}
              className={`sr-chip${capabilities.includes(item) ? " is-on" : ""}`}
              onClick={() => toggle(item)}
            >
              {item}
            </button>
          ))}
        </div>
        <button className="sr-button sr-button--accent" onClick={onSubmit} disabled={busy}>
          {busy ? "运行中…" : "发送"}
        </button>
      </div>
    </div>
  );
}
