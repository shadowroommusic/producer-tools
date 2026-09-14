/**
 * The right dock: one thing only — the conversation.
 *
 * Plugin panels used to share this column behind a second tab; that made the dock read as two
 * different things and squeezed the work surface. Plugins now open as a page in the centre column
 * (`PluginPanelPage`), and the dock stays the chat you type into while the main page keeps the work.
 */
import type { ReactNode } from "react";
import { IconCollapse, IconExpand } from "./icons";

export function DockPanel({
  chat,
  onClose,
}: {
  /** The transcript plus the composer. */
  chat: ReactNode;
  onClose: () => void;
}) {
  return (
    <section className="sr-dock" aria-label="对话">
      <header className="sr-dock-head">
        <span className="sr-dock-label">对话</span>
        <div className="sr-dock-actions">
          <button
            type="button"
            className="sr-icon-btn"
            aria-label="收起对话"
            title="收起对话"
            onClick={onClose}
          >
            <IconCollapse size={16} />
          </button>
        </div>
      </header>
      <div className="sr-dock-body sr-scroll">
        <div className="sr-dock-chat">{chat}</div>
      </div>
    </section>
  );
}
