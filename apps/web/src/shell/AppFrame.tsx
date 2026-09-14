/**
 * Three-column shell frame: sidebar | conversation | dock.
 *
 * Owns the grid tracks and the two drag handles (pointer capture + rAF throttling), and solves the
 * columns from the frame's own measured width — not the window's — so a collapsed sidebar widens
 * the conversation without any resize. Same contract as DeepSeek Harness's ui-layout.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  computeColumns,
  defaultDockWidth,
  DOCK_RAIL,
  SIDEBAR_AUTO_COLLAPSE,
  SIDEBAR_DEFAULT,
} from "./columns";

/** One drag handle: 8px hit strip straddling a column border. */
function DragHandle({
  side,
  left,
  onStart,
  onDrag,
  onEnd,
}: {
  side: "sidebar" | "rightbar";
  left: number;
  onStart: () => void;
  onDrag: (dx: number) => void;
  onEnd: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const origin = useRef(0);
  const latest = useRef(0);
  const frame = useRef<number | null>(null);
  const capture = useRef<{ element: HTMLDivElement; id: number } | null>(null);
  const callbacks = useRef({ onStart, onDrag, onEnd });
  callbacks.current = { onStart, onDrag, onEnd };

  const endDrag = useCallback(() => {
    const active = capture.current;
    if (active === null) return;
    capture.current = null;
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    if (active.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id);
    setDragging(false);
    callbacks.current.onEnd();
  }, []);

  useEffect(() => endDrag, [endDrag]);

  const finish = (event: React.PointerEvent<HTMLDivElement>) => {
    if (capture.current?.id !== event.pointerId) return;
    callbacks.current.onDrag(event.clientX - origin.current);
    endDrag();
  };

  return (
    <div
      className="sr-handle"
      style={{ left }}
      data-side={side}
      data-dragging={dragging || undefined}
      onPointerDown={(event) => {
        if (event.button !== 0 || capture.current !== null) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        capture.current = { element: event.currentTarget, id: event.pointerId };
        origin.current = event.clientX;
        latest.current = event.clientX;
        callbacks.current.onStart();
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (capture.current?.id !== event.pointerId) return;
        latest.current = event.clientX;
        frame.current ??= requestAnimationFrame(() => {
          frame.current = null;
          callbacks.current.onDrag(latest.current - origin.current);
        });
      }}
      onPointerUp={finish}
      onPointerCancel={(event) => {
        if (capture.current?.id === event.pointerId) endDrag();
      }}
      onLostPointerCapture={(event) => {
        if (capture.current?.id === event.pointerId) endDrag();
      }}
    />
  );
}

export function AppFrame({
  sidebar,
  main,
  dock,
  dockRail,
  dockCollapsed = false,
}: {
  sidebar: (shell: { collapsed: boolean; toggleSidebar: () => void }) => ReactNode;
  main: ReactNode;
  dock: ReactNode;
  /** The shortcuts shown in the dock column while the dock itself is closed. */
  dockRail?: ReactNode;
  dockCollapsed?: boolean;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState(() => window.innerWidth);
  const [sidebarPref, setSidebarPref] = useState(SIDEBAR_DEFAULT);
  const [narrowExpanded, setNarrowExpanded] = useState(false);
  const [dockWidth, setDockWidth] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    const element = frameRef.current;
    if (element === null) return;
    let raf: number | null = null;
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      if (width > 0) setViewport(width);
    };
    measure();
    const observer = new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = null;
        measure();
      });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, []);

  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE;
  const collapsed = narrow ? !narrowExpanded : sidebarPref === 0;
  const sidebarPreference = collapsed ? 0 : sidebarPref === 0 ? SIDEBAR_DEFAULT : sidebarPref;
  const dockPreference = dockWidth ?? defaultDockWidth(viewport);
  const columns = computeColumns(viewport, sidebarPreference, dockCollapsed ? 0 : dockPreference);
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const dockWidthRef = useRef(columns.rightbar);
  dockWidthRef.current = columns.rightbar;

  const sidebarBase = useRef(0);
  const dockBase = useRef(0);

  const toggleSidebar = useCallback(() => {
    if (narrow) {
      setNarrowExpanded((expanded) => !expanded);
      return;
    }
    setSidebarPref((current) => (current === 0 ? SIDEBAR_DEFAULT : 0));
  }, [narrow]);

  const template = `${columns.sidebar}px minmax(0, 1fr) ${dockCollapsed ? DOCK_RAIL : columns.rightbar}px`;
  const sidebarNode = useMemo(
    () => sidebar({ collapsed, toggleSidebar }),
    [sidebar, collapsed, toggleSidebar],
  );

  return (
    <div
      ref={frameRef}
      className="sr-frame"
      style={{ gridTemplateColumns: template }}
      data-dragging={dragging || undefined}
      data-sidebar-collapsed={collapsed || undefined}
      data-dock-collapsed={dockCollapsed || undefined}
    >
      <div className="sr-frame-sidebar">{sidebarNode}</div>
      <div className="sr-frame-main">{main}</div>
      {/* With no room for a track the panel floats over the centre — mark it so it reads as a
          drawer (shadow, its own edge) instead of looking like it ate the work surface. */}
      <div
        className="sr-frame-dock"
        data-collapsed={dockCollapsed || undefined}
        data-floating={!dockCollapsed && columns.rightbar === 0 ? true : undefined}
      >
        {dockCollapsed ? dockRail : dock}
      </div>

      {!collapsed && (
        <DragHandle
          side="sidebar"
          left={columns.sidebar}
          onStart={() => {
            sidebarBase.current = columnsRef.current.sidebar;
            setDragging(true);
          }}
          onDrag={(dx) => setSidebarPref(sidebarBase.current + dx)}
          onEnd={() => setDragging(false)}
        />
      )}
      {!dockCollapsed && columns.rightbar > 0 && (
        <DragHandle
          side="rightbar"
          left={viewport - columns.rightbar}
          onStart={() => {
            dockBase.current = dockWidthRef.current;
            setDragging(true);
          }}
          onDrag={(dx) => setDockWidth(dockBase.current - dx)}
          onEnd={() => setDragging(false)}
        />
      )}
    </div>
  );
}
