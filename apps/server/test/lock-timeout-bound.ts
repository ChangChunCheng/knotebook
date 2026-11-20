/**
 * Shared constants for the family of assertions "the injected short lock_timeout really took effect" (imports nothing: the `vi.mock` factory loads this file
 * dynamically, which must not pull the mocked module back in).
 *
 * Files using it put `vi.mock("../src/storage/tx/quota.js", ...)` at the top, replacing the default `DEFAULT_STORAGE_LOCK_TIMEOUT_MS` (product value 5000) with
 * `SLOW_DEFAULT_LOCK_TIMEOUT_MS`; function-level tests `set local lock_timeout` to the same value inside the transaction. The injected value (200/300 ms) and the
 * "didn't take effect, fell back to the default" value (60 s) differ by 200x, and the wall-clock bound `INJECTED_LOCK_TIMEOUT_BOUND_MS` sits at 20 s, far from both:
 * however busy the machine, a request blocked by a lock for 300 ms won't take almost 20 s more; if the injection didn't take effect it waits the full 60 s before the 409
 * and this assertion goes red (60 s is still inside the global 120 s testTimeout, so what fails is the assertion, not a timeout).
 */
export const SLOW_DEFAULT_LOCK_TIMEOUT_MS = 60_000;
export const INJECTED_LOCK_TIMEOUT_BOUND_MS = 20_000;
