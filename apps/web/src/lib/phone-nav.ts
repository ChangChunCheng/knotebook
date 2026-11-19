export type BackTarget = { kind: "go"; delta: number } | { kind: "replace" };

/** A missing (deep link, reload) or stale index replaces the entry, so the system back button does not return to the same note. */
export function backTarget({ listIdx, currentIdx }: { listIdx: number | null; currentIdx: number | null }): BackTarget {
  if (listIdx !== null && currentIdx !== null && listIdx < currentIdx) return { kind: "go", delta: listIdx - currentIdx };
  return { kind: "replace" };
}

const LIST_IDX_KEY = "nav.listIdx";

export function historyIdx(): number | null {
  try {
    const idx = (window.history.state as { idx?: unknown } | null)?.idx;
    return typeof idx === "number" ? idx : null;
  } catch {
    return null;
  }
}

export function recordListIdx(): void {
  const idx = historyIdx();
  if (idx === null) return;
  try {
    sessionStorage.setItem(LIST_IDX_KEY, String(idx));
  } catch {
    /* no record: falls back to replace */
  }
}

export function clearListIdx(): void {
  try {
    sessionStorage.removeItem(LIST_IDX_KEY);
  } catch {
    /* no record: falls back to replace */
  }
}

export function readListIdx(): number | null {
  try {
    const raw = sessionStorage.getItem(LIST_IDX_KEY);
    if (raw === null) return null;
    const idx = Number(raw);
    return Number.isInteger(idx) ? idx : null;
  } catch {
    return null;
  }
}
