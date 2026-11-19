/**
 * Android fires `contextmenu` at the moment of a long press (its threshold can be shorter than
 * 500 ms), so one arriving mid-press is intercepted; a mouse right-click is not. After a long
 * press the browser may send mousedown/mouseup/click on release, which `suppressing()` tells the
 * caller to swallow.
 */
export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP_PX = 10;

interface PointLike {
  pointerType: string;
  clientX: number;
  clientY: number;
}

export interface LongPress {
  down(e: PointLike): void;
  move(e: PointLike): void;
  end(): void;
  reset(): void;
  contextMenu(): boolean;
  suppressing(): boolean;
  consumeClick(): boolean;
  dispose(): void;
}

export function createLongPress(onLongPress: () => void): LongPress {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let fired = false;
  let startX = 0;
  let startY = 0;
  const stop = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = false;
  };
  const fire = () => {
    stop();
    fired = true;
    onLongPress();
  };
  return {
    down(e) {
      stop();
      fired = false;
      if (e.pointerType !== "touch") return;
      pending = true;
      startX = e.clientX;
      startY = e.clientY;
      timer = setTimeout(fire, LONG_PRESS_MS);
    },
    move(e) {
      if (pending && Math.hypot(e.clientX - startX, e.clientY - startY) > LONG_PRESS_SLOP_PX) stop();
    },
    end: stop,
    reset() {
      stop();
      fired = false;
    },
    contextMenu() {
      if (pending) fire();
      return fired;
    },
    suppressing: () => fired,
    consumeClick() {
      const was = fired;
      fired = false;
      return was;
    },
    dispose: stop,
  };
}
