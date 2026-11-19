import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** `placementClassName` must be a full literal (Tailwind scans statically). `onChange(px, true)` only on commit (release, keyboard, double-click). The outward arrow key widens (right edge: ArrowRight; left edge: ArrowLeft); Home/End go to min/max. */
export function PaneResizeHandle({
  width,
  onChange,
  min,
  max,
  defaultWidth,
  step,
  edge,
  label,
  placementClassName,
}: {
  width: number;
  onChange: (px: number, commit: boolean) => void;
  min: number;
  max: number;
  defaultWidth: number;
  step: number;
  edge: "left" | "right";
  label: string;
  placementClassName: string;
}) {
  // Persist from `latest`, not the render-closure `width`: pointermove state may not be committed before pointerup in a real browser (jsdom cannot show this).
  const dragRef = useRef<{ startX: number; startWidth: number; latest: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const sign = edge === "right" ? 1 : -1;
  const clamp = (px: number) => Math.min(max, Math.max(min, Math.round(px)));

  useEffect(() => {
    if (!dragging) return;
    const { style } = document.body;
    const previous = { cursor: style.cursor, userSelect: style.userSelect };
    style.cursor = "col-resize";
    style.userSelect = "none";
    return () => {
      style.cursor = previous.cursor;
      style.userSelect = previous.userSelect;
    };
  }, [dragging]);

  function endDrag(): void {
    const drag = dragRef.current;
    if (!drag) return; // a lostpointercapture still arrives after pointerup
    dragRef.current = null;
    setDragging(false);
    onChange(drag.latest, true);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-dragging={dragging ? "" : undefined}
      className={cn("group/resize absolute inset-y-0 flex w-3 cursor-col-resize touch-none select-none justify-center outline-none", placementClassName)}
      // Not preventDefault on pointerdown: it would suppress the compatibility mouse events, which the double-click reset may rely on.
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { startX: event.clientX, startWidth: width, latest: width };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag) return;
        drag.latest = clamp(drag.startWidth + sign * (event.clientX - drag.startX));
        onChange(drag.latest, false);
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={() => onChange(defaultWidth, true)}
      onKeyDown={(event) => {
        const next = {
          ArrowLeft: width - sign * step,
          ArrowRight: width + sign * step,
          Home: min,
          End: max,
        }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        onChange(clamp(next), true);
      }}
    >
      {/* classes must be full literals (Tailwind static scan). Hover changes only the cursor (no line); the ring line shows only while dragging or keyboard-focused. */}
      <div
        aria-hidden="true"
        className="h-full w-0.5 rounded-full transition-colors group-focus-visible/resize:bg-ring group-data-[dragging]/resize:bg-ring"
      />
    </div>
  );
}
