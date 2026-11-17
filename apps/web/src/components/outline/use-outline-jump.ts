import { useCallback, useEffect, useRef } from "react";
import { jumpToHeading } from "./outline-jump";

/**
 * Jump handler for an outline: {@link jumpToHeading} inside `root`, then `markJumped(id)` so the picked heading
 * stays current. One jump at a time: a new pick cancels the previous one's pending wait and flash; unmounting cancels too.
 */
export function useOutlineJump(root: HTMLElement | null, markJumped: (id: string) => void): (id: string) => void {
  const cancelJump = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      cancelJump.current?.();
      cancelJump.current = null;
    },
    [],
  );
  return useCallback(
    (id: string) => {
      if (!root) return;
      cancelJump.current?.();
      cancelJump.current = jumpToHeading(root, id);
      markJumped(id);
    },
    [root, markJumped],
  );
}
