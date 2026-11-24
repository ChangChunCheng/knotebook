import { vi } from "vitest";
import { createElement, type ReactNode } from "react";
import {
  listKnowledgeInBlocks,
  resolveKnowledgeFieldView,
  type KnowledgeBlockLike,
  type KnowledgeBuiltinFieldKey,
  type KnowledgeCustomFieldType,
  type KnowledgeEntry,
  type KnowledgeFieldDefRow,
  type KnowledgeFieldOverrideRow,
  type KnowledgeFieldView,
} from "@knotebook/shared";
import { KnowledgeFieldsContext, type KnowledgeFieldsValue } from "./fields-context";

export interface KnowledgeFixture {
  id: string;
  blockId: string;
  level?: number;
  title?: string;
  props?: Record<string, string>;
}

export function knowledgeBlocks(items: KnowledgeFixture[], plain: Array<{ blockId: string; title: string }> = []): KnowledgeBlockLike[] {
  return [
    ...items.map((i) => ({
      id: i.blockId,
      type: "heading",
      props: { level: i.level ?? 1, knowledgeId: i.id, knowledgeWhen: "when alice", knowledgeConclusion: "conclusion bob", ...i.props },
      content: i.title ?? `Heading ${i.blockId}`,
    })),
    ...plain.map((p) => ({ id: p.blockId, type: "heading", props: { level: 1 }, content: p.title })),
  ];
}

export function knowledgeEntries(items: KnowledgeFixture[]): KnowledgeEntry[] {
  return listKnowledgeInBlocks(knowledgeBlocks(items));
}

/** DOM shaped like BlockNote's top-level blocks: `.bn-block-outer[data-id] > .bn-block > .bn-block-content > .bn-inline-content`. */
export function blocksHtml(ids: Array<{ blockId: string; title: string }>): string {
  return ids
    .map(
      (b) =>
        `<div class="bn-block-outer" data-id="${b.blockId}"><div class="bn-block"><div class="bn-block-content" data-content-type="heading"><h2 class="bn-inline-content">${b.title}</h2></div></div></div>`,
    )
    .join("");
}

/** jsdom lays nothing out: the column is 800 wide and every heading's text ends 200px in. */
export function stubLayout(): void {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.matches("[data-testid='col'], .kb-diff")) return new DOMRect(0, 0, 800, 2000);
    if (this.matches(".bn-inline-content")) return new DOMRect(0, 0, 600, 30);
    return new DOMRect(0, 0, 0, 0);
  });
  vi.spyOn(Range.prototype, "getClientRects").mockImplementation(() => [new DOMRect(0, 0, 200, 30)] as unknown as DOMRectList);
}

export function stubMedia(matching: string[]): void {
  window.matchMedia = ((query: string) => ({
    matches: matching.includes(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

/** Site settings with the given builtin fields turned off and basis options renamed or hidden. */
export function fieldView(over: { off?: KnowledgeBuiltinFieldKey[]; options?: Array<{ key: string; enabled?: boolean; name?: string }> } = {}): KnowledgeFieldView {
  const site: KnowledgeFieldOverrideRow[] = [
    ...(over.off ?? []).map((fieldRef) => ({ fieldRef, optionKey: "", enabled: false, name: null, position: null })),
    ...(over.options ?? []).map((o) => ({ fieldRef: "evidence" as const, optionKey: o.key, enabled: o.enabled ?? null, name: o.name ?? null, position: null })),
  ];
  return resolveKnowledgeFieldView({ defs: [], site });
}

export interface CustomFieldFixture {
  key: string;
  type: KnowledgeCustomFieldType;
  name: string;
  enabled?: boolean;
  position?: number;
  options?: Array<{ key: string; name: string; enabled?: boolean }>;
}

/** Built-in fields as `over` sets them, followed by the given custom fields. */
export function customFieldView(custom: CustomFieldFixture[], over: Parameters<typeof fieldView>[0] = {}): KnowledgeFieldView {
  const base = fieldView(over);
  const defs: KnowledgeFieldDefRow[] = [];
  const site: KnowledgeFieldOverrideRow[] = [];
  custom.forEach((f, i) => {
    const fieldRef = `x-${f.key}` as const;
    defs.push({ kind: "field", fieldRef, key: f.key, type: f.type, createdAt: `2026-01-01T00:00:0${i}Z` });
    site.push({ fieldRef, optionKey: "", enabled: f.enabled ?? null, name: f.name, position: f.position ?? i });
    (f.options ?? []).forEach((o, j) => {
      defs.push({ kind: "option", fieldRef, key: o.key, type: null, createdAt: `2026-01-01T00:00:0${j}Z` });
      site.push({ fieldRef, optionKey: o.key, enabled: o.enabled ?? null, name: o.name, position: j });
    });
  });
  return { fields: [...base.fields, ...resolveKnowledgeFieldView({ defs, site }).fields.filter((f) => !f.builtin)] };
}

export function withFields(children: ReactNode, value: Partial<KnowledgeFieldsValue> = {}): ReactNode {
  return createElement(KnowledgeFieldsContext.Provider, { value: { view: value.view ?? fieldView(), status: value.status ?? "ready" } }, children);
}
