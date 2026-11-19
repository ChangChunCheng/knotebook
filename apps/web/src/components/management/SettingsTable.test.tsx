import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPortal } from "react-dom";
import { act, render, screen, within } from "@testing-library/react";
import i18n from "@/i18n";
import { Switch } from "@/components/ui/switch";
import {
  SettingsTable,
  orderSettingsTableColumns,
  settingsTableTracks,
  type SettingsTableColumn,
  type SettingsTableRow,
} from "./SettingsTable";

// jsdom does no layout: layout is always asserted through classes/inline style; real geometry is measured by e2e 26-settings-tables.
// ResizeObserver in test/setup.ts is a fake constructor that does nothing - cases verifying overflow swap in FakeResizeObserver themselves.

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  callback: ResizeObserverCallback;
  targets: Element[] = [];
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element): void {
    this.targets.push(target);
  }
  unobserve(): void {}
  disconnect(): void {
    this.targets = [];
  }
  fire(entries: Array<{ target: Element; borderBoxSize?: Array<{ inlineSize: number; blockSize: number }> }>): void {
    this.callback(entries as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver);
  }
}

function setOverflow(el: HTMLElement, scrollWidth: number, clientWidth: number): void {
  Object.defineProperty(el, "scrollWidth", { configurable: true, get: () => scrollWidth });
  Object.defineProperty(el, "clientWidth", { configurable: true, get: () => clientWidth });
}

const NAME: SettingsTableColumn = { id: "name", header: "Name", kind: "primary" };
const EMAIL: SettingsTableColumn = { id: "email", header: "Email", kind: "text" };
const LINK: SettingsTableColumn = { id: "url", header: "URL", kind: "url" };
const SIZE: SettingsTableColumn = { id: "size", header: "Size", kind: "fixed" };
const ROLE: SettingsTableColumn = { id: "role", header: "Role", kind: "control" };
const ACTIONS: SettingsTableColumn = { id: "actions", header: "Actions", kind: "actions", buttons: 3 };
const ENABLED: SettingsTableColumn = { id: "enabled", header: "Enabled", kind: "enabled" };
const ALL: SettingsTableColumn[] = [NAME, EMAIL, LINK, SIZE, ROLE, ACTIONS, ENABLED];

function row(id: string, name: string, extra: Partial<SettingsTableRow> = {}): SettingsTableRow {
  return {
    id,
    primary: { name },
    cells: {
      email: `${id}@example.com`,
      url: `https://example.com/${id}`,
      size: "1 MB",
      role: (
        <select aria-label={`Role for ${name}`} defaultValue="admin">
          <option value="admin">Admin</option>
        </select>
      ),
    },
    actions: (
      <button type="button" aria-label={`Edit ${name}`}>
        e
      </button>
    ),
    enabled: (labelledBy) => <Switch aria-labelledby={labelledBy} checked />,
    ...extra,
  };
}

const tableNamed = (name = "Things") => screen.getByRole("table", { name });
/** Only this table's own header (a nested sub-table's header is in the subtree too). */
const headersOf = (table: HTMLElement) =>
  within(table).getAllByRole("columnheader").filter((cell) => cell.closest('[role="table"]') === table);

describe("SettingsTable", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("enforced column order: columns declared out of order are sorted as primary -> info columns (keeping declaration order) -> editable -> actions -> enabled, with a console.error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<SettingsTable label="Things" columns={[ENABLED, ROLE, SIZE, ACTIONS, EMAIL, NAME]} rows={[row("a", "Alpha")]} />);
    expect(headersOf(tableNamed()).map((cell) => cell.textContent)).toEqual(["Name", "Size", "Email", "Role", "Actions", "Enabled"]);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("欄位宣告順序"));
    expect(within(screen.getByRole("row", { name: "Alpha" })).getAllByRole("cell").map((cell) => cell.lastElementChild!.textContent)).toEqual([
      "Alpha",
      "1 MB",
      "a@example.com",
      "Admin",
      "e",
      "",
    ]);
    expect(tableNamed().style.getPropertyValue("--kb-table-cols")).toBe("minmax(14ch,2fr) max-content minmax(14ch,1fr) max-content 6.5rem 3.5rem");
  });

  it.each([
    ["grow unset: identical to the default verbatim", [NAME, EMAIL, LINK], "minmax(14ch,2fr) minmax(14ch,1fr) minmax(14ch,1.5fr)"],
    ["grow set: replaces that kind's default fr", [{ ...NAME, grow: 1 }, { ...EMAIL, grow: 1.5 }, { ...LINK, grow: 3 }], "minmax(14ch,1fr) minmax(14ch,1.5fr) minmax(14ch,3fr)"],
    ["grow has no effect on fixed/control", [NAME, { ...SIZE, grow: 4 }, { ...ROLE, grow: 4 }], "minmax(14ch,2fr) max-content max-content"],
  ] as const)("--kb-table-cols: grow %s", (_case, columns, expected) => {
    render(<SettingsTable label="Things" columns={[...columns]} rows={[row("a", "Alpha")]} />);
    expect(tableNamed().style.getPropertyValue("--kb-table-cols")).toBe(expected);
    expect(settingsTableTracks(orderSettingsTableColumns([...columns]))).toBe(expected);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("grow=%s is not a finite positive number: uses the default fr and console.error in dev mode", (grow) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const columns = [{ ...NAME, grow }, { ...EMAIL, grow }, { ...LINK, grow }];
    expect(settingsTableTracks(orderSettingsTableColumns(columns))).toBe("minmax(14ch,2fr) minmax(14ch,1fr) minmax(14ch,1.5fr)");
    expect(spy.mock.calls.filter(([message]) => String(message).includes("grow"))).toHaveLength(3);
  });

  it("declared per the rules: no console.error; orderSettingsTableColumns returns it as is", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<SettingsTable label="Things" columns={ALL} rows={[row("a", "Alpha")]} />);
    expect(spy).not.toHaveBeenCalled();
    expect(orderSettingsTableColumns(ALL)).toEqual(ALL);
  });

  it.each([
    ["all kinds", ALL, "minmax(14ch,2fr) minmax(14ch,1fr) minmax(14ch,1.5fr) max-content max-content 6.5rem 3.5rem"],
    ["actions is the last column (2 buttons): add 0.75rem more", [NAME, SIZE, { ...ACTIONS, buttons: 2 }], "minmax(14ch,2fr) max-content 5rem"],
    ["actions is the last column (1 button)", [NAME, EMAIL, { ...ACTIONS, buttons: 1 }], "minmax(14ch,2fr) minmax(14ch,1fr) 2.75rem"],
    ["4 buttons followed by enabled: nothing added", [NAME, { ...ACTIONS, buttons: 4 }, ENABLED], "minmax(14ch,2fr) 8.75rem 3.5rem"],
    ["no actions/enabled", [NAME, SIZE, ROLE], "minmax(14ch,2fr) max-content max-content"],
  ] as const)("--kb-table-cols: %s", (_case, columns, expected) => {
    render(<SettingsTable label="Things" columns={[...columns]} rows={[row("a", "Alpha")]} />);
    expect(tableNamed().style.getPropertyValue("--kb-table-cols")).toBe(expected);
    expect(settingsTableTracks(orderSettingsTableColumns([...columns]))).toBe(expected);
    expect(tableNamed()).toHaveClass("grid", "grid-cols-(--kb-table-cols)", "gap-x-3", "text-sm");
  });

  it("row name = the primary column text; the switch name = \"Enabled <row name>\" with aria-labelledby pointing at the header columnheader and the name text", () => {
    render(<SettingsTable label="Things" columns={ALL} rows={[row("a", "Alpha"), row("b", "Beta")]} />);
    expect(screen.getByRole("row", { name: "Alpha" })).toBeInTheDocument();
    const toggle = within(screen.getByRole("row", { name: "Beta" })).getByRole("switch", { name: "Enabled Beta" });
    const [headerRef, nameRef] = toggle.getAttribute("aria-labelledby")!.split(" ");
    expect(document.getElementById(headerRef!)).toHaveAttribute("role", "columnheader");
    expect(document.getElementById(nameRef!)).toHaveTextContent(/^Beta$/);
  });

  it("nameColumn = a non-primary column (email): the row name, switch name and details row name all use that column's text", () => {
    render(<SettingsTable label="Things" nameColumn="email" columns={ALL} rows={[row("a", "Alpha", { detail: "notes" })]} />);
    const dataRow = screen.getByRole("row", { name: "a@example.com" });
    expect(within(dataRow).getByRole("switch", { name: "Enabled a@example.com" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "a@example.com details" })).toBeInTheDocument();
  });

  it("nameColumn cell is not plain text: console.error in dev mode", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <SettingsTable label="Things" nameColumn="email" columns={ALL} rows={[row("a", "Alpha", { cells: { email: <b>a@example.com</b> } })]} />,
    );
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("nameColumn"));
  });

  it("rows=[]: only the empty text, no table, no scroll frame; title/titleAction remain", () => {
    render(
      <SettingsTable
        label="Things"
        columns={ALL}
        rows={[]}
        empty="Nothing yet."
        title="Models"
        titleAction={<button type="button">Add model</button>}
      />,
    );
    expect(screen.getByText("Nothing yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.getByText("Models")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add model" })).toBeInTheDocument();
  });

  it("title/titleAction also render when there are data rows", () => {
    render(<SettingsTable label="Things" columns={ALL} rows={[row("a", "Alpha")]} title="Models" titleAction={<button type="button">Add model</button>} />);
    expect(screen.getByText("Models")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add model" })).toBeInTheDocument();
  });

  it("details and error rows: separate rows (not subgrid), named \"<row name> details/error\", cell aria-colspan = column count; the error row comes before the details row with role=alert content; the bottom border is drawn only on the last row of a group", () => {
    render(
      <SettingsTable
        label="Things"
        columns={ALL}
        rows={[row("a", "Alpha", { detail: <p>Alpha notes</p>, error: "Role change failed" }), row("b", "Beta")]}
      />,
    );
    const dataRow = screen.getByRole("row", { name: "Alpha" });
    const errorRow = screen.getByRole("row", { name: "Alpha error" });
    const detailRow = screen.getByRole("row", { name: "Alpha details" });
    expect(dataRow.contains(detailRow)).toBe(false);
    expect(dataRow.compareDocumentPosition(errorRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(errorRow.compareDocumentPosition(detailRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(detailRow).getByRole("cell")).toHaveAttribute("aria-colspan", "7");
    expect(within(detailRow).getByText("Alpha notes")).toBeInTheDocument();
    expect(within(errorRow).getByRole("cell")).toHaveAttribute("aria-colspan", "7");
    expect(within(errorRow).getByRole("alert")).toHaveTextContent("Role change failed");
    expect(detailRow).toHaveClass("col-span-full");
    expect(detailRow).not.toHaveClass("grid-cols-subgrid");
    expect(within(detailRow).getByRole("cell").className).not.toMatch(/(^|\s)(px|pl|pr)-/);
    expect(dataRow).not.toHaveClass("border-b");
    expect(errorRow).not.toHaveClass("border-b");
    expect(detailRow).toHaveClass("border-b", "border-border");
    expect(screen.getByRole("row", { name: "Beta" })).toHaveClass("border-b", "border-border");
  });

  it("the name suffix of details/error rows goes through i18n (zh-TW)", async () => {
    await i18n.changeLanguage("zh-TW");
    render(<SettingsTable label="Things" columns={ALL} rows={[row("a", "Alpha", { detail: "notes", error: "x" })]} />);
    expect(screen.getByRole("row", { name: "Alpha 明細" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "Alpha 錯誤" })).toBeInTheDocument();
  });

  it("editing: the primary cell is kept, the other columns merge into one cell (aria-colspan = column count - 1, grid-column 2/-1) holding the caller's form, the whole row has bg-brand-soft, the sticky primary column is an opaque overlay, other columns (including the switch) are not shown", () => {
    // autoFocus and Enter-to-submit are behaviours of the caller's own form; the component neither forwards nor intercepts them - they are
    // covered by the token page's tests (focus after clicking the pencil, Enter saves), so only the structure is checked here.
    render(
      <SettingsTable
        label="Things"
        columns={ALL}
        rows={[row("a", "Alpha", { editing: <input aria-label="Label" defaultValue="draft" /> }), row("b", "Beta")]}
      />,
    );
    const editingRow = screen.getByRole("row", { name: "Alpha" });
    const cells = within(editingRow).getAllByRole("cell");
    expect(cells).toHaveLength(2);
    expect(cells[0]).toHaveTextContent(/^Alpha$/);
    expect(cells[1]).toHaveAttribute("aria-colspan", "6");
    expect(cells[1]).toHaveClass("col-[2/-1]");
    expect(within(cells[1]!).getByRole("textbox", { name: "Label" })).toBeInTheDocument();
    expect(editingRow).toHaveClass("bg-brand-soft");
    expect(cells[0]!.style.background).toBe("linear-gradient(var(--brand-soft), var(--brand-soft)), var(--kb-sticky-surface, var(--card))");
    expect(within(editingRow).queryByRole("switch")).toBeNull();
  });

  it("the primary column name's weight is decided by the caller (weight); the component defaults to regular weight and bolds no table", () => {
    render(
      <SettingsTable
        label="Things"
        columns={[NAME, SIZE]}
        rows={[
          { id: "n", primary: { name: "Plain" }, cells: { size: "1" } },
          { id: "m", primary: { name: "Medium", weight: "medium" }, cells: { size: "2" } },
          { id: "s", primary: { name: "Semi", weight: "semibold" }, cells: { size: "3" } },
        ]}
      />,
    );
    const nameOf = (rowName: string) => document.getElementById(screen.getByRole("row", { name: rowName }).getAttribute("aria-labelledby")!)!;
    expect(nameOf("Plain").className).not.toMatch(/(^|\s)font-/);
    expect(nameOf("Medium")).toHaveClass("font-medium");
    expect(nameOf("Semi")).toHaveClass("font-semibold");
  });

  it("top-level table: scroll frame role=region (name = label), overflow-x-auto + scroll-ps; tabIndex=0 only when overflowing and not removed while focused; --kb-sticky-w takes the header primary cell's borderBoxSize (fractions kept)", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    FakeResizeObserver.instances = [];
    render(<SettingsTable label="Things" columns={ALL} rows={[row("a", "Alpha")]} />);
    const box = screen.getByRole("region", { name: "Things" });
    expect(box).toHaveClass("overflow-x-auto", "scroll-ps-(--kb-sticky-w)");
    expect(box).not.toHaveAttribute("tabindex");
    const observer = FakeResizeObserver.instances.at(-1)!;
    const stickyHeader = headersOf(tableNamed())[0]!;
    expect(observer.targets).toEqual(expect.arrayContaining([box, stickyHeader.parentElement!, stickyHeader]));

    setOverflow(box, 900, 400);
    act(() => observer.fire([{ target: stickyHeader, borderBoxSize: [{ inlineSize: 123.25, blockSize: 30 }] }]));
    expect(box).toHaveAttribute("tabindex", "0");
    expect(box.style.getPropertyValue("--kb-sticky-w")).toBe("123.25px");

    act(() => box.focus());
    setOverflow(box, 400, 400);
    act(() => observer.fire([{ target: box }]));
    expect(box).toHaveAttribute("tabindex", "0");
    act(() => box.blur());
    expect(box).not.toHaveAttribute("tabindex");
  });

  it("the primary column's right divider is drawn only when the scroll frame overflows: data-overflowing toggles with the overflow, and sticky cells (header and data rows) have border-r only under it", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    FakeResizeObserver.instances = [];
    render(<SettingsTable label="Things" columns={ALL} rows={[row("a", "Alpha")]} />);
    const box = screen.getByRole("region", { name: "Things" });
    const observer = FakeResizeObserver.instances.at(-1)!;
    const stickyHeader = headersOf(tableNamed())[0]!;
    const stickyRowCell = within(screen.getByRole("row", { name: "Alpha" })).getAllByRole("cell")[0]!;
    expect(box).toHaveClass("group/box");
    for (const cell of [stickyHeader, stickyRowCell]) {
      expect(cell).toHaveClass("sticky", "group-data-[overflowing]/box:border-r");
      expect(cell).not.toHaveClass("border-r");
      // On phones (cards) there is no sticky: cells are transparent showing the card's surface; the overlay background of an editing row sits on the popover
      expect(cell).toHaveClass("bg-card", "max-sm:bg-transparent", "max-sm:[--kb-sticky-surface:var(--popover)]");
    }
    expect(box).not.toHaveAttribute("data-overflowing");

    setOverflow(box, 900, 400);
    act(() => observer.fire([{ target: box }]));
    expect(box).toHaveAttribute("data-overflowing");

    setOverflow(box, 400, 400);
    act(() => observer.fire([{ target: box }]));
    expect(box).not.toHaveAttribute("data-overflowing");
  });

  it("--kb-sticky-w uses only the borderBoxSize entry of the sticky cell: at mount, and in callbacks where only the scroll frame/header row changed, getBoundingClientRect (affected by transform scaling) neither writes nor overwrites it", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    FakeResizeObserver.instances = [];
    // Simulates the Dialog's zoom-in-95 opening animation: getBoundingClientRect measures the scaled 95% width.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 117.0875, 28.5));
    render(<SettingsTable label="Things" columns={ALL} rows={[row("a", "Alpha")]} />);
    const box = screen.getByRole("region", { name: "Things" });
    expect(box.style.getPropertyValue("--kb-sticky-w")).toBe("");
    const observer = FakeResizeObserver.instances.at(-1)!;
    const stickyHeader = headersOf(tableNamed())[0]!;
    act(() => observer.fire([{ target: stickyHeader, borderBoxSize: [{ inlineSize: 123.25, blockSize: 30 }] }]));
    act(() => observer.fire([{ target: box }, { target: stickyHeader.parentElement! }]));
    expect(box.style.getPropertyValue("--kb-sticky-w")).toBe("123.25px");
  });

  it("the primary column's id changes (the header primary cell becomes a new node): ResizeObserver subscribes to the new node and disconnects the old", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    FakeResizeObserver.instances = [];
    const { rerender } = render(<SettingsTable label="Things" columns={ALL} rows={[row("a", "Alpha")]} />);
    const first = FakeResizeObserver.instances.at(-1)!;
    rerender(<SettingsTable label="Things" columns={[{ ...NAME, id: "title" }, ...ALL.slice(1)]} rows={[row("a", "Alpha")]} />);
    const stickyHeader = headersOf(tableNamed())[0]!;
    expect(FakeResizeObserver.instances.at(-1)!.targets).toContain(stickyHeader);
    expect(first.targets).toHaveLength(0);
  });

  it("focus scroll compensation: when the focus target's left edge is under the sticky primary column's right edge scrollLeft is adjusted left (rounded up to an integer); when not covered, or when focus is inside the primary cell, nothing moves", () => {
    const badgeRow = row("a", "Alpha", { primary: { name: "Alpha", badges: <button type="button">Badge</button> } });
    render(<SettingsTable label="Things" columns={ALL} rows={[badgeRow]} />);
    const box = screen.getByRole("region", { name: "Things" });
    let scrollLeft = 241;
    Object.defineProperty(box, "scrollLeft", { configurable: true, get: () => scrollLeft, set: (value: number) => (scrollLeft = value) });
    const stickyHeader = headersOf(tableNamed())[0]!;
    const edit = screen.getByRole("button", { name: "Edit Alpha" });
    const role = screen.getByRole("combobox", { name: "Role for Alpha" });
    const badge = screen.getByRole("button", { name: "Badge" });
    const lefts = new Map<Element, number>([
      [stickyHeader, 0],
      [edit, 116.1], // under the sticky right edge (124.6875) by 8.5875px
      [role, 200], // right of the sticky edge
      [badge, 20], // inside the primary cell
    ]);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this === stickyHeader ? new DOMRect(0, 0, 124.6875, 30) : new DOMRect(lefts.get(this) ?? 0, 0, 32, 32);
    });

    act(() => edit.focus());
    expect(scrollLeft).toBe(232);

    scrollLeft = 241;
    act(() => role.focus());
    expect(scrollLeft).toBe(241);
    act(() => badge.focus());
    expect(scrollLeft).toBe(241);
  });

  it("focus compensation applies only to top-level data rows: buttons in details rows and sub-table rows with their left edge left of the sticky right edge do not move scrollLeft (they have no sticky cell and are fully visible; compensating would make mouse clicks miss)", () => {
    const detailRow = row("a", "Alpha", {
      detail: (
        <>
          <button type="button">Copy URL</button>
          <SettingsTable nested label="Sub" columns={[NAME, { ...ACTIONS, buttons: 2 }, ENABLED]} rows={[row("m", "Model one")]} />
        </>
      ),
    });
    render(<SettingsTable label="Things" columns={ALL} rows={[detailRow]} />);
    const box = screen.getByRole("region", { name: "Things" });
    let scrollLeft = 241;
    Object.defineProperty(box, "scrollLeft", { configurable: true, get: () => scrollLeft, set: (value: number) => (scrollLeft = value) });
    const stickyHeader = headersOf(tableNamed())[0]!;
    const copy = screen.getByRole("button", { name: "Copy URL" });
    const subEdit = screen.getByRole("button", { name: "Edit Model one" });
    const topEdit = screen.getByRole("button", { name: "Edit Alpha" });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this === stickyHeader ? new DOMRect(0, 0, 124.6875, 30) : new DOMRect(20, 0, 32, 32); // always left of the sticky right edge
    });

    act(() => copy.focus());
    expect(scrollLeft).toBe(241);
    act(() => subEdit.focus());
    expect(scrollLeft).toBe(241);
    // Contrast: with the same geometry a top-level data row's button is compensated (proves the no-move above is not because the measurement had no effect).
    act(() => topEdit.focus());
    expect(scrollLeft).toBe(136);
  });

  it("focus compensation handles only focus inside the scroll frame: when a control portaled to body from a row (a dialog) gets focus, React's onFocus bubbling up does not move scrollLeft either", () => {
    const portalRow = row("a", "Alpha", {
      actions: createPortal(
        <button type="button" aria-label="Dialog field">
          d
        </button>,
        document.body,
      ),
    });
    render(<SettingsTable label="Things" columns={ALL} rows={[portalRow]} />);
    const box = screen.getByRole("region", { name: "Things" });
    let scrollLeft = 241;
    Object.defineProperty(box, "scrollLeft", { configurable: true, get: () => scrollLeft, set: (value: number) => (scrollLeft = value) });
    const stickyHeader = headersOf(tableNamed())[0]!;
    const dialogField = screen.getByRole("button", { name: "Dialog field" });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this === stickyHeader ? new DOMRect(0, 0, 124.6875, 30) : new DOMRect(20, 0, 32, 32); // the dialog field's left edge is left of the sticky right edge
    });

    act(() => dialogField.focus());
    expect(scrollLeft).toBe(241);
    expect(box.contains(dialogField)).toBe(false);
  });

  it("primary column sticky (header cell and data-row primary cell: left-0, z-[1], opaque bg-card, right border only when overflowing, see the next case); nested sub-table is not sticky, has no scroll frame, header row sr-only, primary content pl-4, title row pl-7", () => {
    render(
      <>
        <SettingsTable label="Top" columns={ALL} rows={[row("a", "Alpha")]} />
        <SettingsTable nested label="Sub" title="Models" columns={[NAME, { ...ACTIONS, buttons: 2 }, ENABLED]} rows={[row("m", "Model one")]} />
      </>,
    );
    const topHeader = headersOf(screen.getByRole("table", { name: "Top" }))[0]!;
    const topCell = within(screen.getByRole("row", { name: "Alpha" })).getAllByRole("cell")[0]!;
    for (const el of [topHeader, topCell]) expect(el).toHaveClass("sticky", "left-0", "z-[1]", "bg-card", "border-border");
    const sub = screen.getByRole("table", { name: "Sub" });
    expect(screen.queryByRole("region", { name: "Sub" })).toBeNull();
    const subHeader = headersOf(sub)[0]!;
    const subCell = within(screen.getByRole("row", { name: "Model one" })).getAllByRole("cell")[0]!;
    expect(subHeader).not.toHaveClass("sticky");
    expect(subCell).not.toHaveClass("sticky");
    expect(subHeader.parentElement).toHaveClass("sr-only");
    expect(subCell.firstElementChild).toHaveClass("pl-4");
    expect(screen.getByText("Models").parentElement).toHaveClass("pl-7");
    // The sub-table's last row draws no bottom border (the outer details row draws it).
    expect(screen.getByRole("row", { name: "Model one" })).not.toHaveClass("border-b");
  });

  it("rows are subgrid with no items-center/gap/horizontal padding; cells stretch (flex items-center) with content wrapped in a single flex-1 min-w-0 child; the actions column is right-aligned (justify-end gap-1) and the enabled column is centered, set on the child", () => {
    render(<SettingsTable label="Things" columns={ALL} rows={[row("a", "Alpha")]} />);
    const dataRow = screen.getByRole("row", { name: "Alpha" });
    expect(dataRow).toHaveClass("col-span-full", "grid", "grid-cols-subgrid");
    expect(dataRow.className).not.toMatch(/(^|\s)(items-center|gap-\S+|px-\S+|pl-\S+|pr-\S+)(\s|$)/);
    const cells = within(dataRow).getAllByRole("cell");
    for (const cell of cells) {
      expect(cell).toHaveClass("flex", "items-center");
      // The content is always the last child; info and editable columns have an extra column name before it that shows only on phones.
      expect(cell.lastElementChild).toHaveClass("min-w-0", "flex-1");
      expect(cell.children.length).toBeLessThanOrEqual(2);
    }
    expect(cells[5]!.lastElementChild).toHaveClass("flex", "justify-end", "gap-1");
    expect(cells[6]!.lastElementChild).toHaveClass("flex", "justify-center");
    expect(cells[1]!.lastElementChild).toHaveClass("wrap-anywhere");
    expect(cells[0]!.lastElementChild).toHaveClass("wrap-anywhere");
    expect(cells[2]!.lastElementChild).toHaveClass("truncate");
    expect(cells[2]!.lastElementChild).toHaveAttribute("title", "https://example.com/a");
    expect(cells[3]!.lastElementChild).toHaveClass("whitespace-nowrap");
  });

  it("padding lives only in cells: the first cell pl-3, data rows py-2.5, header py-2; the last cell pr-3 except when the last cell is enabled; header text-xs grey, enabled centered, actions right-aligned and sr-only", () => {
    render(
      <>
        <SettingsTable label="Things" columns={ALL} rows={[row("a", "Alpha")]} />
        <SettingsTable label="Plans" columns={[NAME, { ...ACTIONS, buttons: 2 }]} rows={[row("p", "Plan one")]} />
      </>,
    );
    const cells = within(screen.getByRole("row", { name: "Alpha" })).getAllByRole("cell");
    expect(cells[0]).toHaveClass("pl-3", "py-2.5");
    expect(cells[6]!.className).not.toMatch(/(^|\s)(px|pl|pr)-/);
    expect(cells[5]!.className).not.toMatch(/(^|\s)pr-/);
    const planCells = within(screen.getByRole("row", { name: "Plan one" })).getAllByRole("cell");
    expect(planCells[1]).toHaveClass("pr-3");
    const headers = headersOf(tableNamed());
    expect(headers[0]).toHaveClass("py-2", "pl-3", "text-xs", "text-muted-foreground");
    expect(headers[6]!.firstElementChild).toHaveClass("text-center");
    expect(headers[5]!.firstElementChild).toHaveClass("text-right");
    expect(within(headers[5]!).getByText("Actions")).toHaveClass("sr-only");
  });

  it("cell tone: muted grey, danger red (set on the content child)", () => {
    render(
      <SettingsTable
        label="Things"
        columns={[NAME, SIZE, EMAIL]}
        rows={[row("a", "Alpha", { cells: { size: { content: "Expired", tone: "danger" }, email: { content: "a@example.com", tone: "muted" } } })]}
      />,
    );
    expect(screen.getByText("Expired")).toHaveClass("text-destructive");
    expect(screen.getByText("a@example.com")).toHaveClass("text-muted-foreground");
  });

  it("a name containing bidi override characters: the name is dir=ltr + unicode-bidi:isolate, label and subtitle are separate elements; the row name, details row name and switch name are the original string", () => {
    const name = "\u202Etxt.exe";
    render(
      <SettingsTable
        label="Things"
        columns={[NAME, ENABLED]}
        rows={[
          {
            id: "x",
            primary: { name, badges: <span>Built-in</span>, subtitles: ["Created today"] },
            enabled: (labelledBy) => <Switch aria-labelledby={labelledBy} />,
            detail: "notes",
          },
        ]}
      />,
    );
    expect(screen.getByRole("row", { name: `${name} details` })).toBeInTheDocument();
    const dataRow = screen.getByRole("row", { name });
    const nameEl = document.getElementById(dataRow.getAttribute("aria-labelledby")!)!;
    expect(nameEl).toHaveAttribute("dir", "ltr");
    expect(nameEl).toHaveClass("[unicode-bidi:isolate]");
    expect(nameEl.textContent).toBe(name);
    expect(nameEl.nextElementSibling).toHaveTextContent("Built-in");
    expect(within(dataRow).getByText("Created today")).not.toBe(nameEl);
    expect(screen.getByRole("switch", { name: `Enabled ${name}` })).toBeInTheDocument();
  });

  it("two rows with the same name: each has its own row name id, and its switch and details row point only at its own row", () => {
    render(<SettingsTable label="Things" columns={ALL} rows={[row("a", "Dup", { detail: "first" }), row("b", "Dup", { detail: "second" })]} />);
    const [first, second] = screen.getAllByRole("row", { name: "Dup" });
    expect(first!.getAttribute("aria-labelledby")).not.toBe(second!.getAttribute("aria-labelledby"));
    const toggles = screen.getAllByRole("switch", { name: "Enabled Dup" });
    expect(toggles).toHaveLength(2);
    expect(first).toContainElement(toggles[0]!);
    expect(second).toContainElement(toggles[1]!);
    for (const [index, toggle] of toggles.entries()) {
      const nameRef = toggle.getAttribute("aria-labelledby")!.split(" ")[1]!;
      expect([first, second][index]).toContainElement(document.getElementById(nameRef));
    }
    expect(screen.getAllByRole("row", { name: "Dup details" }).map((detail) => detail.textContent)).toEqual(["first", "second"]);
  });

  it("the table appears only after loading completes: ResizeObserver attaches then and the scroll frame is focusable on overflow; when rows drop to zero it switches to empty, no details row is left and ResizeObserver disconnects", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    FakeResizeObserver.instances = [];
    const { rerender } = render(<SettingsTable label="Things" columns={ALL} rows={[]} empty="Nothing" />);
    expect(FakeResizeObserver.instances).toHaveLength(0);
    rerender(<SettingsTable label="Things" columns={ALL} rows={[row("a", "Alpha", { detail: "notes" })]} empty="Nothing" />);
    const box = screen.getByRole("region", { name: "Things" });
    const observer = FakeResizeObserver.instances.at(-1)!;
    expect(observer.targets).toContain(box);
    setOverflow(box, 900, 400);
    act(() => observer.fire([{ target: box }]));
    expect(box).toHaveAttribute("tabindex", "0");
    rerender(<SettingsTable label="Things" columns={ALL} rows={[]} empty="Nothing" />);
    expect(observer.targets).toHaveLength(0);
    expect(screen.queryByRole("row", { name: "Alpha details" })).toBeNull();
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.getByText("Nothing")).toBeInTheDocument();
  });
});

describe("SettingsTable phone card layout (max-sm)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("top-level table: header row sr-only on phones, scroll frame does not scroll horizontally, primary column not sticky and no right border", () => {
    render(<SettingsTable label="Things" columns={ALL} rows={[row("a", "Alpha")]} />);
    const header = headersOf(tableNamed())[0]!;
    expect(header.parentElement).toHaveClass("max-sm:sr-only");
    expect(screen.getByRole("region", { name: "Things" })).toHaveClass("max-sm:overflow-x-visible");
    const primary = within(screen.getByRole("row", { name: "Alpha" })).getAllByRole("cell")[0]!;
    for (const el of [header, primary]) expect(el).toHaveClass("max-sm:static", "max-sm:group-data-[overflowing]/box:border-r-0");
  });

  it("data rows are auto-wrapping flex (cards) on phones; the table is a single column", () => {
    render(<SettingsTable label="Things" columns={ALL} rows={[row("a", "Alpha")]} />);
    expect(tableNamed()).toHaveClass("max-sm:grid-cols-1");
    expect(screen.getByRole("row", { name: "Alpha" })).toHaveClass("max-sm:flex", "max-sm:flex-wrap", "max-sm:py-2");
  });

  it("per-cell phone width: primary, info and editable columns take a line each; the actions column fills the rest and the enabled column is right-aligned", () => {
    render(<SettingsTable label="Things" columns={ALL} rows={[row("a", "Alpha")]} />);
    const cells = within(screen.getByRole("row", { name: "Alpha" })).getAllByRole("cell");
    for (const index of [0, 1, 2, 3, 4]) expect(cells[index]).toHaveClass("max-sm:basis-full");
    expect(cells[5]).toHaveClass("max-sm:flex-1");
    expect(cells[6]).toHaveClass("max-sm:ml-auto");
    for (const cell of cells) expect(cell).toHaveClass("max-sm:px-3", "max-sm:py-1");
  });

  it("info and editable columns have a visible column name before them (aria-hidden, phone only); primary, actions and enabled do not; semantic queries are unaffected", () => {
    render(<SettingsTable label="Things" columns={ALL} rows={[row("a", "Alpha")]} />);
    const cells = within(screen.getByRole("row", { name: "Alpha" })).getAllByRole("cell");
    for (const [index, text] of [[1, "Email"], [2, "URL"], [3, "Size"], [4, "Role"]] as const) {
      const label = cells[index]!.firstElementChild!;
      expect(label).toHaveTextContent(text);
      expect(label).toHaveAttribute("aria-hidden", "true");
      expect(label).toHaveClass("sm:hidden");
      expect(cells[index]!.lastElementChild).toHaveClass("min-w-0", "flex-1");
    }
    for (const index of [0, 5, 6]) expect(cells[index]!.querySelector("[aria-hidden='true'][class*='sm:hidden']")).toBeNull();
    // An aria-hidden column name is not in the accessible name, and the header still provides the columnheader.
    expect(within(tableNamed()).getAllByRole("columnheader")).toHaveLength(7);
    expect(screen.getByRole("combobox", { name: "Role for Alpha" })).toBeInTheDocument();
  });

  it("a cell with empty content (no actions, no value) collapses to sr-only on phones (still in the layout tree so the header mapping does not shift) and leaves no line with only a column name", () => {
    render(<SettingsTable label="Things" columns={ALL} rows={[row("a", "Alpha", { actions: undefined, cells: { ...row("a", "Alpha").cells, email: undefined } })]} />);
    const cells = within(screen.getByRole("row", { name: "Alpha" })).getAllByRole("cell");
    for (const index of [1, 5]) {
      expect(cells[index]).toHaveClass("max-sm:has-[>div:empty]:sr-only");
      // Built by concatenation: Tailwind scans test files, and writing the whole string would generate an unused CSS rule.
      expect(cells[index]!.className).not.toContain(["has-[>div:empty]", "hidden"].join(":"));
      // The selector must really match the DOM: an empty cell matches, a cell with content does not.
      expect(cells[index]!.matches(":has(> div:empty)")).toBe(true);
    }
    for (const index of [0, 2, 3, 4, 6]) expect(cells[index]!.matches(":has(> div:empty)")).toBe(false);
  });

  it("when the enable switch is alone on a line (no action buttons), on touch the cell is at least 48px high and the hit area does not reach into the line above", () => {
    render(<SettingsTable label="Things" columns={ALL} rows={[row("a", "Alpha", { actions: undefined })]} />);
    const cells = within(screen.getByRole("row", { name: "Alpha" })).getAllByRole("cell");
    expect(cells[6]).toHaveClass("max-sm:pointer-coarse:min-h-12");
  });

  it("editing: the merged cell and the primary column take a line each", () => {
    render(<SettingsTable label="Things" columns={ALL} rows={[row("a", "Alpha", { editing: <input aria-label="Label" /> })]} />);
    const cells = within(screen.getByRole("row", { name: "Alpha" })).getAllByRole("cell");
    expect(cells[0]).toHaveClass("max-sm:basis-full");
    expect(cells[1]).toHaveClass("max-sm:basis-full", "max-sm:px-3");
  });

  it("a nested sub-table uses the card layout too; its header is sr-only already", () => {
    render(<SettingsTable nested label="Sub" columns={[NAME, EMAIL, ACTIONS]} rows={[row("m", "Model one")]} />);
    expect(screen.getByRole("row", { name: "Model one" })).toHaveClass("max-sm:flex");
    expect(within(screen.getByRole("row", { name: "Model one" })).getAllByRole("cell")[1]!.firstElementChild).toHaveTextContent("Email");
  });

  it("the url column wraps on phones (no ellipsis truncation, full text visible); desktop is still truncate", () => {
    render(<SettingsTable label="Things" columns={ALL} rows={[row("a", "Alpha")]} />);
    const inner = within(screen.getByRole("row", { name: "Alpha" })).getAllByRole("cell")[2]!.lastElementChild!;
    expect(inner).toHaveClass("truncate", "max-sm:overflow-visible", "max-sm:whitespace-normal", "max-sm:text-clip", "max-sm:wrap-anywhere");
  });

  it("the column name aligns with the first line of the value (not vertically centered for multi-line values); editable columns (tall controls) and the actions and enabled columns stay centered", () => {
    render(<SettingsTable label="Things" columns={ALL} rows={[row("a", "Alpha")]} />);
    const cells = within(screen.getByRole("row", { name: "Alpha" })).getAllByRole("cell");
    for (const index of [1, 2, 3]) {
      expect(cells[index]).toHaveClass("max-sm:items-start");
      expect(cells[index]!.firstElementChild).toHaveClass("leading-5");
    }
    for (const index of [4, 5, 6]) expect(cells[index]!.className).not.toContain("max-sm:items-start");
  });

  it("touch (coarse pointer) on phones: action buttons and the switch each extend a 44 hit area outward and button spacing widens so they do not overlap; desktop and tablet are unchanged", () => {
    render(<SettingsTable label="Things" columns={ALL} rows={[row("a", "Alpha")]} />);
    const cells = within(screen.getByRole("row", { name: "Alpha" })).getAllByRole("cell");
    const actions = cells[5]!.lastElementChild!;
    expect(actions).toHaveClass("gap-1", "max-sm:pointer-coarse:gap-3");
    for (const token of [
      "max-sm:pointer-coarse:[&_button]:relative",
      "max-sm:pointer-coarse:[&_button]:after:absolute",
      "max-sm:pointer-coarse:[&_button]:after:-inset-1.5",
      "max-sm:pointer-coarse:[&_button]:after:content-['']",
    ]) {
      expect(actions).toHaveClass(token);
    }
    const enabled = cells[6]!.lastElementChild!;
    for (const token of [
      "max-sm:pointer-coarse:[&_[role=switch]]:relative",
      "max-sm:pointer-coarse:[&_[role=switch]]:after:absolute",
      "max-sm:pointer-coarse:[&_[role=switch]]:after:-inset-x-2.5",
      "max-sm:pointer-coarse:[&_[role=switch]]:after:-inset-y-4",
      "max-sm:pointer-coarse:[&_[role=switch]]:after:content-['']",
    ]) {
      expect(enabled).toHaveClass(token);
    }
    // Only on phone width + coarse pointer: no touch class without max-sm.
    expect(actions.className).not.toMatch(/(^|\s)pointer-coarse:/);
  });

});
