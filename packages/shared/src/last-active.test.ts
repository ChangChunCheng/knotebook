import { describe, expect, it } from "vitest";
import { LAST_ACTIVE_WRITE_INTERVAL_MS, ONLINE_WINDOW_MS } from "./index.js";

describe("#267 last-active constants", () => {
  it("write interval 1 minute, online window 5 minutes; the interval is far shorter than the window (a person who keeps being active is recorded at most one interval late and does not fall out of \"online\")", () => {
    expect(LAST_ACTIVE_WRITE_INTERVAL_MS).toBe(60_000);
    expect(ONLINE_WINDOW_MS).toBe(5 * 60_000);
    expect(LAST_ACTIVE_WRITE_INTERVAL_MS * 2).toBeLessThan(ONLINE_WINDOW_MS);
  });
});
