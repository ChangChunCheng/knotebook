// A one-shot request, held only in this tab: it is never part of the document, so peers and reloads never see it.
const TTL_MS = 2000;
const requested = new Map<string, number>();

export function requestMermaidEdit(blockId: string): void {
  const now = Date.now();
  // A request whose block never mounted (e.g. the transaction was filtered out) would otherwise stay forever.
  for (const [id, until] of requested) if (until <= now) requested.delete(id);
  requested.set(blockId, now + TTL_MS);
}

/** Read at mount; `consumeMermaidEdit` drops it afterwards (not read-and-delete, since React may run state initializers twice). */
export function peekMermaidEdit(blockId: string): boolean {
  const until = requested.get(blockId);
  return until !== undefined && until > Date.now();
}

export function consumeMermaidEdit(blockId: string): void {
  requested.delete(blockId);
}
