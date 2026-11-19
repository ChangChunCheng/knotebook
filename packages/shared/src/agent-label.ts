// Shared so server writes and the web's grey-text check derive the same label from a token name.
// AGENT_LABEL_RE must match the DB CHECK api_tokens_agent_label_chk.
// Browser-safe: only normalize/toLowerCase/regex. Derived on read, snapshotted on write.
export function deriveAgentLabel(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? "";
  const cleaned = first.normalize("NFKC").toLowerCase().replace(/[^A-Za-z0-9._-]/g, "").slice(0, 32);
  return cleaned.length > 0 ? cleaned : "agent";
}

export const AGENT_LABEL_RE = /^[A-Za-z0-9._-]{1,32}$/;
