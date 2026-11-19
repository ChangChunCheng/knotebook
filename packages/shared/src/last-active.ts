/** Must stay well below `ONLINE_WINDOW_MS`, so continuously active users always show as online. */
export const LAST_ACTIVE_WRITE_INTERVAL_MS = 60 * 1000;

export const ONLINE_WINDOW_MS = 5 * 60 * 1000;
