import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vid, vlabel, vtarget } from "@/test/version-fixtures";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { VersionDto, VersionListDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { useMemo } from "react";
import { useVersionList, type VersionTarget } from "@/api/versions";
import { KIND_FILTER_STORAGE_KEY, VersionsProvider, useVersions, useVersionsController } from "@/lib/versions-context";
import { ComparePicker } from "./ComparePicker";

const NOTE = "n1";
const FIRST = `/api/notes/${NOTE}/versions?limit=50`;
const FIRST_MANUAL = `/api/notes/${NOTE}/versions?kind=manual&limit=50`;
const ver = (seq: number, name: string | null = null, kind: VersionDto["kind"] = "manual"): VersionDto => ({ id: vid(seq), seq, kind, name, editors: [], baseSeq: null, base: null, createdAt: "2026-10-09T00:00:00.000Z" });
const list = (versions: VersionDto[], nextBefore: number | null = null): VersionListDto => ({
  versions,
  current: { baseSeq: versions[0]?.seq ?? null, base: versions[0] ? { id: versions[0].id, name: versions[0].name, deleted: false } : null, dirty: false, nextSeq: (versions[0]?.seq ?? 0) + 1, autoEnabled: true },
  nextBefore,
});

function stub(routes: Record<string, unknown>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (!(url in routes)) throw new Error(`unexpected fetch: ${url}`);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(routes[url]) } as Response);
    }),
  );
  return calls;
}

/** Probe for the list having loaded: the trigger already has a label before the list arrives (it falls back to the name remembered at selection), so it cannot tell whether the list arrived. Same query key, so it shares the cache with the picker. */
function ListProbe() {
  const { kindFilter } = useVersions();
  const list = useVersionList(NOTE, true, kindFilter);
  return <span data-testid="rows">{list.data ? "loaded" : "pending"}</span>;
}
async function listLoaded() {
  await waitFor(() => expect(screen.getByTestId("rows")).toHaveTextContent("loaded"));
}

/** Controller state probe: left = preview, right = compareRight. `startPreview` is wrapped to count calls (re-selecting the same version does not call it). */
const startCalls: unknown[] = [];
function Host({ start }: { start: VersionTarget }) {
  const inner = useVersionsController({ noteId: NOTE, enabled: true });
  const value = useMemo(
    () => ({
      ...inner,
      startPreview: (t: VersionTarget) => {
        startCalls.push(t);
        inner.startPreview(t);
      },
    }),
    [inner],
  );
  return (
    <VersionsProvider value={value}>
      <button type="button" onClick={() => value.startPreview(start)}>
        go
      </button>
      <ListProbe />
      <button type="button" onClick={() => value.setKindFilter("manual")}>
        filter-manual
      </button>
      <span data-testid="left">{JSON.stringify(value.preview)}</span>
      <span data-testid="right">{JSON.stringify(value.compareRight)}</span>
      {value.preview && (
        <>
          <ComparePicker side="left" />
          <ComparePicker side="right" />
        </>
      )}
    </VersionsProvider>
  );
}

function renderPicker(start = vtarget(2)) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <Host start={start} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText("go"));
}

async function openPicker(name: "Left side" | "Right side") {
  fireEvent.pointerDown(await screen.findByRole("button", { name }), { button: 0, ctrlKey: false });
  return screen.findByRole("menu");
}

describe("ComparePicker", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
    startCalls.length = 0;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("the trigger shows 'name (short id)' (the name from the list row) with the right side defaulting to 'Current state'; dropdown items use the same label; aria-labels Left side / Right side", async () => {
    stub({ [FIRST]: list([ver(2, "定稿"), ver(1)]) });
    renderPicker();
    await listLoaded();
    const left = screen.getByRole("button", { name: "Left side" });
    expect(left.textContent).toBe("定稿 (0002aaa)");
    // A long name is truncated so it does not stretch the banner past one row; the full label goes in title.
    expect(within(left).getByText("定稿 (0002aaa)")).toHaveClass("max-w-48", "truncate");
    expect(within(left).getByText("定稿 (0002aaa)")).toHaveAttribute("title", "定稿 (0002aaa)");
    expect(screen.getByRole("button", { name: "Right side" }).textContent).toBe("Current state");
    const menu = await openPicker("Left side");
    expect(within(menu).getByRole("menuitemradio", { name: vlabel(2, "定稿") })).toHaveAttribute("aria-checked", "true");
  });

  it("re-selecting the already-ticked version in the left dropdown does not call startPreview (no re-sampling of the current state, no rebuilding of the preview)", async () => {
    stub({ [FIRST]: list([ver(2), ver(1)]) });
    renderPicker();
    await listLoaded();
    expect(startCalls).toHaveLength(1); // the call from 'go'
    fireEvent.click(within(await openPicker("Left side")).getByRole("menuitemradio", { name: vlabel(2) }));
    expect(startCalls).toHaveLength(1);
    expect(screen.getByTestId("right")).toHaveTextContent('"current"');
  });

  it("while the next page is loading the load item is disabled and clicking again does not send another request", async () => {
    const page2 = `/api/notes/${NOTE}/versions?before=2&limit=50`;
    const calls: string[] = [];
    let release!: () => void;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === FIRST) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(list([ver(2)], 2)) } as Response);
        if (url === page2)
          return new Promise<Response>((r) => (release = () => r({ ok: true, status: 200, json: () => Promise.resolve(list([ver(1)])) } as Response)));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    renderPicker();
    await listLoaded();
    const menu = await openPicker("Left side");
    const item = within(menu).getByRole("menuitem", { name: "Load older versions" });
    fireEvent.click(item);
    await waitFor(() => expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Load older versions" })).toHaveAttribute("data-disabled"));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Load older versions" }));
    expect(calls.filter((u) => u === page2)).toHaveLength(1);
    release();
    await waitFor(() => expect(within(screen.getByRole("menu")).getByRole("menuitemradio", { name: vlabel(1) })).toBeInTheDocument());
    expect(calls.filter((u) => u === page2)).toHaveLength(1);
  });

  it("the left options are all versions in the list (no 'Current state') with aria-checked on the current value", async () => {
    stub({ [FIRST]: list([ver(3), ver(2), ver(1)]) });
    renderPicker();
    await listLoaded();
    const menu = await openPicker("Left side");
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent)).toEqual([vlabel(3), vlabel(2), vlabel(1)]);
    expect(within(menu).getByRole("menuitemradio", { name: vlabel(2) })).toHaveAttribute("aria-checked", "true");
    expect(within(menu).getByRole("menuitemradio", { name: vlabel(3) })).toHaveAttribute("aria-checked", "false");
  });

  it("the right options are 'Current state' first plus all versions; the default tick is on 'Current state'", async () => {
    stub({ [FIRST]: list([ver(2), ver(1)]) });
    renderPicker();
    await listLoaded();
    const menu = await openPicker("Right side");
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent)).toEqual(["Current state", vlabel(2), vlabel(1)]);
    expect(items[0]).toHaveAttribute("aria-checked", "true");
  });

  it("choosing left -> startPreview (left changes, right stays)", async () => {
    stub({ [FIRST]: list([ver(3), ver(2), ver(1)]) });
    renderPicker();
    await listLoaded();
    const menu = await openPicker("Left side");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: vlabel(1) }));
    expect(screen.getByTestId("left")).toHaveTextContent(JSON.stringify(vtarget(1)));
    expect(screen.getByTestId("right")).toHaveTextContent('"current"');
    await waitFor(() => expect(screen.getByRole("button", { name: "Left side" })).toHaveTextContent(vlabel(1)));
  });

  it("#272: choosing a named version -> the selection target carries the name (the trigger shows it when the list later filters it out)", async () => {
    stub({ [FIRST]: list([ver(3, "里程碑"), ver(2), ver(1)]) });
    renderPicker();
    await listLoaded();
    fireEvent.click(within(await openPicker("Left side")).getByRole("menuitemradio", { name: vlabel(3, "里程碑") }));
    expect(screen.getByTestId("left")).toHaveTextContent(JSON.stringify(vtarget(3, "里程碑")));
  });

  it("choosing right -> setCompareRight (a version / back to Current state); left stays", async () => {
    stub({ [FIRST]: list([ver(3), ver(2), ver(1)]) });
    renderPicker();
    await listLoaded();
    fireEvent.click(within(await openPicker("Right side")).getByRole("menuitemradio", { name: vlabel(3) }));
    expect(screen.getByTestId("right")).toHaveTextContent(JSON.stringify(vtarget(3)));
    expect(screen.getByTestId("left")).toHaveTextContent(JSON.stringify(vtarget(2)));
    await waitFor(() => expect(screen.getByRole("button", { name: "Right side" })).toHaveTextContent(vlabel(3)));
    fireEvent.click(within(await openPicker("Right side")).getByRole("menuitemradio", { name: "Current state" }));
    expect(screen.getByTestId("right")).toHaveTextContent('"current"');
  });

  it("with a next page -> 'Load older versions' at the bottom of the menu; clicking calls fetchNextPage, the menu stays open and the new versions appear among the options", async () => {
    const calls = stub({
      [FIRST]: list([ver(2)], 2),
      [`/api/notes/${NOTE}/versions?before=2&limit=50`]: list([ver(1)]),
    });
    renderPicker();
    await listLoaded();
    const menu = await openPicker("Right side");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Load older versions" }));
    await waitFor(() => expect(calls).toContain(`/api/notes/${NOTE}/versions?before=2&limit=50`));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByRole("menu")).getByRole("menuitemradio", { name: vlabel(1) })).toBeInTheDocument());
    expect(within(screen.getByRole("menu")).queryByRole("menuitem", { name: "Load older versions" })).not.toBeInTheDocument();
  });

  it("loading the next page fails -> no automatic retry (one request); the item stays and can be pressed again", async () => {
    const page2 = `/api/notes/${NOTE}/versions?before=2&limit=50`;
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === FIRST) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(list([ver(2)], 2)) } as Response);
        if (url === page2) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }) } as Response);
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    renderPicker();
    await listLoaded();
    const menu = await openPicker("Left side");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Load older versions" }));
    await waitFor(() => expect(calls.filter((u) => u === page2)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 300));
    expect(calls.filter((u) => u === page2)).toHaveLength(1);
    await waitFor(() => expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Load older versions" })).not.toHaveAttribute("data-disabled"));
  });

  it("no next page -> no 'Load older versions'", async () => {
    stub({ [FIRST]: list([ver(2), ver(1)]) });
    renderPicker();
    await listLoaded();
    const menu = await openPicker("Left side");
    expect(within(menu).queryByRole("menuitem", { name: "Load older versions" })).not.toBeInTheDocument();
  });

  describe("follows the list filter (#258)", () => {
    const AUTO = (seq: number) => ver(seq, null, "auto");

    it("manual only: both dropdowns list only manual versions ('Current state' on the right stays); a previewed version filtered out still shows its name on the trigger (using the name remembered at selection when the list lacks it, #272)", async () => {
      window.localStorage.setItem(KIND_FILTER_STORAGE_KEY, "manual");
      stub({ [FIRST_MANUAL]: list([ver(3), ver(1)]) });
      renderPicker(vtarget(2, "草稿"));
      await listLoaded();
      expect(screen.getByRole("button", { name: "Left side" }).textContent).toBe(vlabel(2, "草稿"));
      const left = within(await openPicker("Left side"));
      expect(left.getAllByRole("menuitemradio").map((i) => i.textContent)).toEqual([vlabel(3), vlabel(1)]);
      expect(left.getAllByRole("menuitemradio").every((i) => i.getAttribute("aria-checked") === "false")).toBe(true);
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      const right = within(await openPicker("Right side"));
      expect(right.getAllByRole("menuitemradio").map((i) => i.textContent)).toEqual(["Current state", vlabel(3), vlabel(1)]);
    });

    it("a version selected on the right is filtered out: the trigger still shows its label; changing the filter does not touch preview / compareRight", async () => {
      stub({ [FIRST]: list([ver(3), AUTO(2), ver(1)]), [FIRST_MANUAL]: list([ver(3), ver(1)]) });
      renderPicker(vtarget(3));
      await listLoaded();
      fireEvent.click(within(await openPicker("Right side")).getByRole("menuitemradio", { name: vlabel(2) }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Right side" })).toHaveTextContent(vlabel(2)));
      fireEvent.click(screen.getByText("filter-manual"));
      await waitFor(() => expect(screen.getByTestId("rows")).toHaveTextContent("loaded"));
      expect(screen.getByRole("button", { name: "Right side" }).textContent).toBe(vlabel(2));
      expect(screen.getByRole("button", { name: "Left side" }).textContent).toBe(vlabel(3));
      expect(screen.getByTestId("right")).toHaveTextContent(JSON.stringify(vtarget(2)));
      expect(screen.getByTestId("left")).toHaveTextContent(JSON.stringify(vtarget(3)));
      expect(startCalls).toHaveLength(1);
      const right = within(await openPicker("Right side"));
      expect(right.getAllByRole("menuitemradio").map((i) => i.textContent)).toEqual(["Current state", vlabel(3), vlabel(1)]);
    });

    it("live sharing: when the panel switches to manual only, already-mounted dropdown options change at once", async () => {
      stub({ [FIRST]: list([ver(3), AUTO(2), ver(1)]), [FIRST_MANUAL]: list([ver(3), ver(1)]) });
      renderPicker(vtarget(3));
      await listLoaded();
      expect(within(await openPicker("Left side")).getAllByRole("menuitemradio").map((i) => i.textContent)).toEqual([vlabel(3), vlabel(2), vlabel(1)]);
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      fireEvent.click(screen.getByText("filter-manual"));
      await waitFor(() => expect(screen.getByTestId("rows")).toHaveTextContent("loaded"));
      expect(within(await openPicker("Left side")).getAllByRole("menuitemradio").map((i) => i.textContent)).toEqual([vlabel(3), vlabel(1)]);
    });

    it("\"Load older versions\" sends kind=manual and the cursor", async () => {
      window.localStorage.setItem(KIND_FILTER_STORAGE_KEY, "manual");
      const calls = stub({
        [FIRST_MANUAL]: list([ver(5)], 5),
        [`/api/notes/${NOTE}/versions?kind=manual&before=5&limit=50`]: list([ver(2)]),
      });
      renderPicker(vtarget(5));
      await listLoaded();
      fireEvent.click(within(await openPicker("Left side")).getByRole("menuitem", { name: "Load older versions" }));
      await waitFor(() => expect(calls).toContain(`/api/notes/${NOTE}/versions?kind=manual&before=5&limit=50`));
      await waitFor(() => expect(within(screen.getByRole("menu")).getByRole("menuitemradio", { name: vlabel(2) })).toBeInTheDocument());
    });
  });
});
