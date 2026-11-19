import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useWikilinkTitleOf, wikilinkIdsIn } from "./use-wikilink-titles";
import type { DiffBlock } from "./version-diff";

const ID1 = "11111111-1111-4111-8111-111111111111";
const a: DiffBlock[] = [{ id: "A", type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: ID1 } }], children: [] }];

describe("#269 useWikilinkTitleOf", () => {
  it("wikilinkIdsIn walks inline content, tables and children", () => {
    const out = new Set<string>();
    wikilinkIdsIn([{ id: "t", type: "table", content: { type: "tableContent", rows: [{ cells: [[{ type: "wikilink", props: { targetNoteId: "x" } }]] }] }, children: [{ id: "c", type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: "y" } }] }] }], out);
    expect([...out].sort()).toEqual(["x", "y"]);
    const obj = new Set<string>();
    // Table cells in the object form `{ type: "tableCell", ... }` are walked too.
    wikilinkIdsIn([{ id: "t2", type: "table", content: { type: "tableContent", rows: [{ cells: [{ type: "tableCell", content: [{ type: "wikilink", props: { targetNoteId: "z" } }] }] }] } }], obj);
    expect([...obj]).toEqual(["z"]);
  });

  it("list refetch with unchanged relevant titles => same function; changed relevant titles => new function; without QueryClient => always undefined", () => {
    const qc = new QueryClient();
    qc.setQueryData(["notes"], [{ id: ID1, title: "One" }, { id: "other", title: "X" }]);
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useWikilinkTitleOf(a, a), { wrapper });
    const first = result.current;
    expect(first(ID1)).toBe("One");
    act(() => qc.setQueryData(["notes"], [{ id: ID1, title: "One" }, { id: "other", title: "Changed" }]));
    expect(result.current).toBe(first);
    act(() => qc.setQueryData(["notes"], [{ id: ID1, title: "Two" }]));
    expect(result.current).not.toBe(first);
    expect(result.current(ID1)).toBe("Two");
    const bare = renderHook(() => useWikilinkTitleOf(a, a));
    expect(bare.result.current(ID1)).toBeUndefined();
  });

  it("an old document storing an uppercase targetNoteId still matches the list's lowercase id (sameNoteId), and the title is found using the document's raw string", () => {
    const lower = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const upper: DiffBlock[] = [{ id: "U", type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: lower.toUpperCase() } }], children: [] }];
    const qc = new QueryClient();
    qc.setQueryData(["notes"], [{ id: lower, title: "One" }]);
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useWikilinkTitleOf(upper, null), { wrapper });
    expect(result.current(lower.toUpperCase())).toBe("One");
  });
});
