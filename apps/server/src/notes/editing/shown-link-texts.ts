/**
 * #387: a wikilink with no custom text must not be frozen into custom text by writes. Reads export it as `[current title](/notes/<id>)`; if the target is renamed and an agent writes that text back, the old title would be stored as a label. Bulk write-back (#385) keeps download-time text in its base table; `edit_note` has no base, so what each reader saw is tracked here in server memory (sha256 hashes only, per-entry TTL, per-user and site-wide caps). Process-local: after a restart writes follow the old rule (docs/known-limitations.md).
 * Collection happens under the editor lease and recording after it is released (a write must wait for a successful merge).
 */
import { createHash } from "node:crypto";
import { mapInlineArrays, wikilinkVisibleText, type WikilinkProps } from "@knotebook/shared";
import { keepLabelFree } from "../../transfer/link-texts.js";

export const SHOWN_LINK_TTL_MS = 24 * 60 * 60 * 1000;
export const SHOWN_LINK_MAX = 100_000;
export const SHOWN_LINK_PER_USER_MAX = 10_000;

export interface ShownLinks {
  free: Array<[string, string]>;
  custom: Array<[string, string]>;
}

export function shownLinkTextsOf(blocks: readonly unknown[], titles: ReadonlyMap<string, string>): ShownLinks {
  const out: ShownLinks = { free: [], custom: [] };
  mapInlineArrays([...blocks], inline => {
    for (const node of inline) {
      const n = node as { type?: unknown; props?: Partial<WikilinkProps> };
      if (n?.type !== "wikilink") continue;
      const props = n.props ?? {};
      const id = String(props.targetNoteId ?? "").toLowerCase();
      if (typeof props.label === "string" && props.label !== "") out.custom.push([id, props.label]);
      else out.free.push([id, wikilinkVisibleText(props, titles.get(id))]);
    }
    return inline;
  });
  return out;
}

const keyOf = (userId: string, targetId: string, text: string): string =>
  createHash("sha256").update(`${userId}\0${targetId.toLowerCase()}\0${text}`).digest("base64url");

export class ShownLinkTexts {
  private readonly entries = new Map<string, { exp: number; user: string }>();
  /** Per-user keys for the per-account cap, so one account can't wash out others' records. */
  private readonly byUser = new Map<string, Set<string>>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly perUserMax: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; max?: number; perUserMax?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? SHOWN_LINK_TTL_MS;
    this.max = opts.max ?? SHOWN_LINK_MAX;
    this.perUserMax = opts.perUserMax ?? SHOWN_LINK_PER_USER_MAX;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  private remove(k: string): void {
    const e = this.entries.get(k);
    if (e === undefined) return;
    this.entries.delete(k);
    const set = this.byUser.get(e.user);
    if (set === undefined) return;
    set.delete(k);
    if (set.size === 0) this.byUser.delete(e.user);
  }

  record(userId: string, shown: ShownLinks): void {
    if (shown.free.length === 0 && shown.custom.length === 0) return;
    const now = this.now();
    for (const [id, text] of shown.custom) this.remove(keyOf(userId, id, text));
    const exp = now + this.ttlMs;
    for (const [id, text] of shown.free) {
      const k = keyOf(userId, id, text);
      this.remove(k);
      this.entries.set(k, { exp, user: userId });
      let set = this.byUser.get(userId);
      if (set === undefined) this.byUser.set(userId, (set = new Set()));
      set.add(k);
    }
    const mine = this.byUser.get(userId);
    while (mine !== undefined && mine.size > this.perUserMax) this.remove(mine.values().next().value!);
    for (const [k, e] of this.entries) {
      if (e.exp > now && this.entries.size <= this.max) break;
      this.remove(k);
    }
  }

  has(userId: string, targetId: string, text: string): boolean {
    const k = keyOf(userId, targetId, text);
    const e = this.entries.get(k);
    if (e === undefined) return false;
    if (e.exp <= this.now()) {
      this.remove(k);
      return false;
    }
    return true;
  }

  /** Also returns the cleared (target, original text) pairs for the caller to record: the stored snapshotTitle is now the current title, so their expiry wouldn't be extended otherwise. */
  keepLabelFree<B>(blocks: B[], userId: string, candidates: ReadonlyArray<{ id: string; title: string }>): [B[], Array<[string, string]>] {
    const cleared: Array<[string, string]> = [];
    if (this.entries.size === 0) return [blocks, cleared];
    let titles: Map<string, string> | null = null;
    const titleOf = (id: string): string | undefined => {
      titles ??= new Map(candidates.map(c => [c.id.toLowerCase(), c.title]));
      return titles.get(id.toLowerCase());
    };
    const [out] = keepLabelFree(blocks, (id, text) => this.has(userId, id, text), titleOf, (id, text) => cleared.push([id, text]));
    return [out, cleared];
  }
}
