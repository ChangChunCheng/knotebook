import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { HeadingAnchorButtons } from "./HeadingAnchorButtons";

// DOM hand-built after BlockNote's structure: .bn-block-outer[data-id] > .bn-block > .bn-block-content[data-content-type] > .bn-inline-content.
const BLOCKS = `
  <div class="bn-block-outer" data-id="h1"><div class="bn-block"><div class="bn-block-content" data-content-type="heading"><h2 class="bn-inline-content">Title</h2></div></div></div>
  <div class="bn-block-outer" data-id="p1"><div class="bn-block"><div class="bn-block-content" data-content-type="paragraph"><p class="bn-inline-content">Body</p></div></div></div>
  <div class="bn-block-outer" data-id="li"><div class="bn-block"><div class="bn-block-content" data-content-type="bulletListItem"><p class="bn-inline-content">item</p></div>
    <div class="bn-block-group"><div class="bn-block-outer" data-id="h3"><div class="bn-block"><div class="bn-block-content" data-content-type="heading"><h3 class="bn-inline-content">Nested</h3></div></div></div></div></div></div>
  <div class="bn-block-column-list" data-node-type="columnList" data-id="r"><div class="bn-block-column" data-node-type="column" data-id="rc0">
    <div class="bn-block-outer" data-id="hc"><div class="bn-block"><div class="bn-block-content" data-content-type="heading"><h2 class="bn-inline-content">InColumn</h2></div></div></div></div>
    <div class="bn-block-column" data-node-type="column" data-id="rc1"><div class="bn-block-outer" data-id="pc"><div class="bn-block"><div class="bn-block-content" data-content-type="paragraph"><p class="bn-inline-content">Beside</p></div></div></div></div></div>`;

/** jsdom rects are all 0: pads geometry by selector (other elements still return 0). */
function stubRects(rects: Array<[string, DOMRect]>) {
  return vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return rects.find(([selector]) => this.matches(selector))?.[1] ?? new DOMRect(0, 0, 0, 0);
  });
}

function Host() {
  const [el, setEl] = useState<HTMLElement | null>(null);
  return (
    <div ref={setEl} className="relative" data-testid="col">
      <div dangerouslySetInnerHTML={{ __html: BLOCKS }} />
      <HeadingAnchorButtons container={el} linkBase={() => "https://kb.example.com/n/h/s"} />
      <Toaster />
    </div>
  );
}

describe("#269 heading # button", () => {
  const writeText = vi.fn(() => Promise.resolve());
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    writeText.mockClear();
  });
  let spies: Array<{ mockRestore: () => void }> = [];
  afterEach(() => {
    dismissAllToasts();
    for (const spy of spies) spy.mockRestore();
    spies = [];
  });

  it("the # sits 4px right of the heading text, vertically centered on the text's first line (not at the block's left edge: the side menu covers it while editable); does not exceed the column's right edge; recomputes on layout change (resize)", () => {
    // Column (100,50) width 800; button 17x20; heading inline box two lines high 72, first line (the Range's first client rect) height 30.
    const text: [string, DOMRect] = ['[data-id="h1"] .bn-inline-content', new DOMRect(100, 78, 200, 72)];
    let firstLine = new DOMRect(100, 80, 150, 30);
    spies.push(
      stubRects([
        ['[data-testid="col"]', new DOMRect(100, 50, 800, 1000)],
        ['.bn-block-outer[data-id="h1"]', new DOMRect(100, 60, 700, 90)],
        ['button[aria-label="Copy link to this section"]', new DOMRect(0, 0, 17, 20)],
        text,
      ]),
      vi.spyOn(Range.prototype, "getClientRects").mockImplementation(() => [firstLine] as unknown as DOMRectList),
    );
    render(<Host />);
    fireEvent.pointerOver(screen.getByText("Title"));
    const button = screen.getByRole("button", { name: "Copy link to this section" });
    expect(button.style.left).toBe("204px"); // text right edge 300 - column left 100 + 4
    expect(button.style.top).toBe("35px"); // first line top 80 - column top 50 + (first line height 30 - button height 20) / 2
    text[1] = new DOMRect(100, 90, 300, 72);
    firstLine = new DOMRect(100, 94, 300, 24);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(button.style.left).toBe("304px");
    expect(button.style.top).toBe("46px"); // 94 - 50 + (24 - 20) / 2
    text[1] = new DOMRect(100, 90, 800, 72); // text reaches the column's right edge
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(button.style.left).toBe("783px"); // min(900 - 100 + 4, column width 800 - button width 17)
  });

  it("pointer leaving the whole article column hides the #", () => {
    render(<Host />);
    fireEvent.pointerOver(screen.getByText("Title"));
    expect(screen.getByRole("button", { name: "Copy link to this section" })).toBeInTheDocument();
    fireEvent.pointerLeave(screen.getByTestId("col"));
    expect(screen.queryByRole("button", { name: "Copy link to this section" })).not.toBeInTheDocument();
  });

  it("pointer entering a heading shows the #; clicking copies <base>#b-<id> and toasts; moving to a normal paragraph hides it", async () => {
    render(<Host />);
    expect(screen.queryByRole("button", { name: "Copy link to this section" })).not.toBeInTheDocument();
    fireEvent.pointerOver(screen.getByText("Title"));
    fireEvent.click(screen.getByRole("button", { name: "Copy link to this section" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://kb.example.com/n/h/s#b-h1"));
    expect(await screen.findByText("Block link copied")).toBeInTheDocument();
    fireEvent.pointerOver(screen.getByText("Body"));
    expect(screen.queryByRole("button", { name: "Copy link to this section" })).not.toBeInTheDocument();
  });

  it("a nested heading (under a list) still shows it and copies the innermost block's id; moving the pointer onto the # button itself does not hide it", async () => {
    render(<Host />);
    fireEvent.pointerOver(screen.getByText("Nested"));
    const button = screen.getByRole("button", { name: "Copy link to this section" });
    fireEvent.pointerOver(button);
    fireEvent.click(screen.getByRole("button", { name: "Copy link to this section" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://kb.example.com/n/h/s#b-h3"));
  });

  it("pointer resting on list item text (its child block is a heading, it is not itself) shows no #", () => {
    render(<Host />);
    fireEvent.pointerOver(screen.getByText("Title"));
    expect(screen.getByRole("button", { name: "Copy link to this section" })).toBeInTheDocument();
    fireEvent.pointerOver(screen.getByText("item"));
    expect(screen.queryByRole("button", { name: "Copy link to this section" })).not.toBeInTheDocument();
  });

  it("a heading inside a column shows no #; moving there from a top-level heading hides it", () => {
    render(<Host />);
    fireEvent.pointerOver(screen.getByText("InColumn"));
    expect(screen.queryByRole("button", { name: "Copy link to this section" })).not.toBeInTheDocument();
    fireEvent.pointerOver(screen.getByText("Title"));
    expect(screen.getByRole("button", { name: "Copy link to this section" })).toBeInTheDocument();
    fireEvent.pointerOver(screen.getByText("InColumn"));
    expect(screen.queryByRole("button", { name: "Copy link to this section" })).not.toBeInTheDocument();
  });

  it("selection caret on a heading (keyboard) shows the # and copies that heading; moving the caret to a normal paragraph hides it", async () => {
    render(<Host />);
    const caretTo = (text: string) => {
      act(() => {
        document.getSelection()!.collapse(screen.getByText(text).firstChild!, 1);
        document.dispatchEvent(new Event("selectionchange"));
      });
    };
    caretTo("Title");
    fireEvent.click(screen.getByRole("button", { name: "Copy link to this section" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://kb.example.com/n/h/s#b-h1"));
    caretTo("Body");
    expect(screen.queryByRole("button", { name: "Copy link to this section" })).not.toBeInTheDocument();
  });

  it("clipboard failure shows an error toast", async () => {
    writeText.mockImplementationOnce(() => Promise.reject(new Error("denied")));
    render(<Host />);
    fireEvent.pointerOver(screen.getByText("Title"));
    fireEvent.click(screen.getByRole("button", { name: "Copy link to this section" }));
    expect(await screen.findByText("Couldn't copy the link.")).toBeInTheDocument();
  });
});
