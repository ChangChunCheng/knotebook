/**
 * Two `setImmediate`s: one returns in the same loop iteration's check phase, so from poll
 * (I/O) timers and new I/O get no turn, and from timers the expired timers don't. Two cross
 * a full timers + poll round (collaborative WebSocket messages are handled in poll).
 * Always yield by time budget (`YIELD_AFTER_MS`, one timer shared across loops and recursion).
 */
import { setImmediate as setImmediateP } from "node:timers/promises";

export const YIELD_AFTER_MS = 20;

export async function yieldToLoop(): Promise<void> {
  await setImmediateP();
  await setImmediateP();
}
