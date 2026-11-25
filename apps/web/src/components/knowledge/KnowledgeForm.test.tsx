import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { KnowledgeEntry } from "@knotebook/shared";
import { DEFAULT_KNOWLEDGE_FIELD_VIEW, listKnowledgeInBlocks, readKnowledgeInfo } from "@knotebook/shared";
import i18n from "@/i18n";
import { P, mountEditor, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";
import { PHONE_QUERY } from "@/lib/layout-tiers";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { removeKnowledge, todayLocalDate } from "./commands";
import { useKnowledgeController, type KnowledgeController } from "./controller";
import { KnowledgeForm } from "./KnowledgeForm";
import { KnowledgeLayer } from "./KnowledgeLayer";
import { KnowledgeRefSourceContext, type KnowledgeRefSource } from "./ref-source";
import type { KnowledgeFieldsValue } from "./fields-context";
import { customFieldView, fieldView, stubMedia, withFields } from "./test-support";
import "@/i18n/knowledge-strings";

const NOTE = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-2222-3333-4444-555555555555";

const K = (n: number, extra: Record<string, unknown> = {}) => ({ knowledgeId: `k_0000000${n}`, knowledgeWhen: `when ${n}`, knowledgeConclusion: `conclusion ${n}`, ...extra });
const heading = (text: string, id: string, props: Record<string, unknown> = {}): PartialBlockLike => ({ id, type: "heading", props: { level: 1, ...props }, content: text }) as PartialBlockLike;

const cleanups: (() => void)[] = [];
function mount(content: PartialBlockLike[]): AnyEditor {
  const m = mountEditor(content, { collab: true });
  cleanups.push(m.destroy);
  return m.editor;
}

// The test editor has no knowledge plugin, so the list is read from the document.
function entriesOf(editor: AnyEditor): readonly KnowledgeEntry[] {
  return listKnowledgeInBlocks(editor.document as never);
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  stubMedia([]);
});
afterEach(() => {
  cleanup();
  while (cleanups.length) cleanups.pop()!();
  vi.restoreAllMocks();
});

function renderForm(editor: AnyEditor, blockId: string, over: { close?: () => void; phone?: boolean; fields?: Partial<KnowledgeFieldsValue> } = {}) {
  const close = over.close ?? vi.fn();
  const view = render(withFields(<KnowledgeForm editor={editor} blockId={blockId} getEntries={() => entriesOf(editor)} noteId={NOTE} phone={over.phone ?? false} close={close} />, over.fields));
  return { close, ...view };
}
const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const infoOf = (editor: AnyEditor, id: string) => readKnowledgeInfo(editor.getBlock(id)!.props as Record<string, unknown>);

describe("KnowledgeForm layout", () => {
  it("fields come in the order status, when to read, conclusion, basis, last verified, with Remove in the title row only for existing knowledge", () => {
    const editor = mount([heading("Alpha", "a", K(1)), heading("Plain", "b")]);
    const { container, unmount } = renderForm(editor, "a");
    const order = [...container.querySelectorAll("label, [id$='status-label']")].map((el) => el.textContent);
    expect(order).toEqual(["Status", "When to read", "Conclusion", "Basis", "Last verified"]);
    const titleRow = container.querySelector("h2")!.parentElement!;
    expect(within(titleRow).getByRole("button", { name: "Remove knowledge info" })).toBeInTheDocument();
    unmount();
    renderForm(editor, "b");
    expect(screen.queryByRole("button", { name: "Remove knowledge info" })).toBeNull();
  });

  it("when to read and conclusion are single-line inputs without maxLength and without a counter", () => {
    const editor = mount([heading("Alpha", "a", K(1))]);
    renderForm(editor, "a");
    for (const label of ["When to read", "Conclusion"]) {
      const el = input(label);
      expect(el.tagName).toBe("INPUT");
      expect(el.hasAttribute("maxlength")).toBe(false);
    }
    expect(document.body.textContent).not.toMatch(/\d+\s*\/\s*\d+/);
  });

  it("the status control has Verified, Needs review and Outdated, and a legacy dated heading opens as Verified", () => {
    const legacy = mount([heading("Alpha", "a", K(1, { knowledgeVerified: "2026-01-02" })), heading("Beta", "b", K(2)), heading("Plain", "c")]);
    const radiosOf = () => within(screen.getByRole("radiogroup", { name: "Status" })).getAllByRole("radio");
    const view = renderForm(legacy, "a");
    expect(radiosOf().map((r) => r.textContent)).toEqual(["Verified", "Needs review", "Outdated"]);
    expect(radiosOf().map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    view.unmount();
    const undated = renderForm(legacy, "b");
    expect(radiosOf().map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    undated.unmount();
    renderForm(legacy, "c");
    expect(radiosOf().map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
  });

  it("status is three segmented buttons and the selected Needs review button is amber", () => {
    const editor = mount([heading("Alpha", "a", K(1, { knowledgeStatus: "unverified" }))]);
    renderForm(editor, "a");
    const group = screen.getByRole("radiogroup", { name: "Status" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["Verified", "Needs review", "Outdated"]);
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    expect(radios[1]!.className).toContain("amber");
    fireEvent.click(radios[0]!);
    expect(radios[1]!.className).not.toContain("amber");
    expect(radios[0]!.getAttribute("aria-checked")).toBe("true");
  });

  it("arrow keys move the status selection", () => {
    const editor = mount([heading("Alpha", "a", K(1, { knowledgeStatus: "verified" }))]);
    renderForm(editor, "a");
    const radios = within(screen.getByRole("radiogroup")).getAllByRole("radio");
    radios[0]!.focus();
    fireEvent.keyDown(radios[0]!, { key: "ArrowRight" });
    expect(radios[1]!.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(radios[1]);
  });

  it("Today sits next to the date and fills today's local date without changing the status", () => {
    const editor = mount([heading("Alpha", "a", K(1, { knowledgeStatus: "unverified" }))]);
    renderForm(editor, "a");
    const date = input("Last verified");
    const button = screen.getByRole("button", { name: "Today" });
    expect(date.parentElement).toBe(button.parentElement);
    fireEvent.click(button);
    expect(date.value).toBe(todayLocalDate());
    expect(screen.getByRole("radio", { name: "Needs review" }).getAttribute("aria-checked")).toBe("true");
  });

  it("choosing Verified fills today's date when the date field is on", () => {
    const editor = mount([heading("Alpha", "a", K(1, { knowledgeStatus: "unverified", knowledgeVerified: "2025-01-02" }))]);
    const { unmount } = renderForm(editor, "a");
    fireEvent.click(screen.getByRole("radio", { name: "Verified" }));
    expect(input("Last verified").value).toBe(todayLocalDate());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(infoOf(editor, "a")).toMatchObject({ status: "verified", verified: todayLocalDate() });
    unmount();

    const off = mount([heading("Beta", "b", K(2, { knowledgeStatus: "unverified", knowledgeVerified: "2025-01-02" }))]);
    renderForm(off, "b", { fields: { view: fieldView({ off: ["verified"] }) } });
    fireEvent.click(screen.getByRole("radio", { name: "Verified" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(infoOf(off, "b")).toMatchObject({ status: "verified", verified: "2025-01-02" });
  });

  it("arrow keys onto Verified fill today's date too", () => {
    const editor = mount([heading("Alpha", "a", K(1, { knowledgeStatus: "unverified" }))]);
    renderForm(editor, "a");
    const radios = within(screen.getByRole("radiogroup")).getAllByRole("radio");
    fireEvent.keyDown(radios[1]!, { key: "ArrowLeft" });
    expect(radios[0]!.getAttribute("aria-checked")).toBe("true");
    expect(input("Last verified").value).toBe(todayLocalDate());
  });

  it("hides turned-off fields", () => {
    const editor = mount([heading("Alpha", "a", K(1, { knowledgeStatus: "outdated" }))]);
    const { container } = renderForm(editor, "a", { fields: { view: fieldView({ off: ["conclusion", "evidence", "verified", "superseded_by"] }) } });
    expect(screen.queryByRole("textbox", { name: "Conclusion" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "When to read" })).toBeInTheDocument();
    const order = [...container.querySelectorAll("label, span[id$='-label']")].map((el) => el.textContent);
    expect(order).toEqual(["Status", "When to read"]);
    expect(screen.queryByRole("combobox", { name: "Replaced by" })).toBeNull();
  });

  it("with when to read and conclusion off the checked status takes the first focus", () => {
    const editor = mount([heading("Alpha", "a", K(1, { knowledgeStatus: "verified" }))]);
    const { container } = renderForm(editor, "a", { fields: { view: fieldView({ off: ["when", "conclusion"] }) } });
    expect(container.querySelector("[data-kb-autofocus]")).toBe(screen.getByRole("radio", { name: "Verified" }));
  });

  it("the basis list offers renamed options and shows a stored hidden one as turned off", () => {
    const sizers = (root: HTMLElement) => [...root.querySelectorAll("[data-select-sizer]")].map((n) => n.textContent);
    const editor = mount([heading("Alpha", "a", K(1, { knowledgeEvidence: "inferred" })), heading("Beta", "b", K(2, { knowledgeEvidence: "tested" }))]);
    const renamed = renderForm(editor, "b", { fields: { view: fieldView({ options: [{ key: "docs", name: "Spec" }] }) } });
    expect(sizers(renamed.container)).toEqual(["Not filled", "Tested", "Spec", "Inferred"]);
    renamed.unmount();

    const hidden = renderForm(editor, "a", { fields: { view: fieldView({ options: [{ key: "inferred", enabled: false }] }) } });
    const trigger = screen.getByRole("combobox", { name: "Basis" });
    expect(trigger.querySelector("[data-select-text]")!.textContent).toBe("Inferred (turned off)");
    expect(sizers(hidden.container)).toEqual(["Not filled", "Tested", "Documentation", "Inferred (turned off)"]);
    fireEvent.change(input("When to read"), { target: { value: "edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(infoOf(editor, "a")).toMatchObject({ when: "edited", evidence: "inferred" });
  });

  it("an empty basis reads Not filled", () => {
    const editor = mount([heading("Alpha", "a", K(1))]);
    renderForm(editor, "a");
    expect(screen.getByRole("combobox", { name: "Basis" }).querySelector("[data-select-text]")!.textContent).toBe("Not filled");
  });

  it("Save stays disabled while the fields are loading, and only the status shows", () => {
    const editor = mount([heading("Alpha", "a", K(1))]);
    const { close } = renderForm(editor, "a", { fields: { status: "loading" } });
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    expect(screen.queryByLabelText("When to read")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Outdated" }));
    fireEvent.click(save);
    fireEvent.keyDown(screen.getByRole("radio", { name: "Outdated" }), { key: "Enter" });
    expect(close).not.toHaveBeenCalled();
    expect(infoOf(editor, "a")!.status).toBe("");
  });

  it("when the fields fail to load the form shows the builtin defaults and can save", () => {
    const editor = mount([heading("Alpha", "a", K(1, { knowledgeEvidence: "docs", knowledgeVerified: "2026-01-02", knowledgeStatus: "verified" }))]);
    const spy = vi.spyOn(editor, "updateBlock");
    const { close } = renderForm(editor, "a", { fields: { status: "error", view: DEFAULT_KNOWLEDGE_FIELD_VIEW } });
    for (const label of ["When to read", "Conclusion", "Basis", "Last verified"]) expect(screen.getByLabelText(label)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Outdated" }));
    expect(screen.getByRole("combobox", { name: "Replaced by" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Verified" }));
    fireEvent.change(input("Last verified"), { target: { value: "2026-01-02" } });
    fireEvent.change(input("Conclusion"), { target: { value: "edited" } });
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(close).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls.at(-1)![1]).toEqual({ props: { knowledgeConclusion: "edited" } });
  });

  it("the footer shows the Esc hint on the left and Cancel, Save on the right", () => {
    const editor = mount([heading("Alpha", "a", K(1))]);
    renderForm(editor, "a");
    const hint = screen.getByText("Esc to cancel");
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const save = screen.getByRole("button", { name: "Save" });
    expect(hint.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(cancel.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("on a phone the footer buttons are 44px high and there is no Esc hint", () => {
    const editor = mount([heading("Alpha", "a", K(1))]);
    render(
      <Dialog open>
        <DialogContent>
          {withFields(<KnowledgeForm editor={editor} blockId="a" getEntries={() => entriesOf(editor)} noteId={NOTE} phone close={() => {}} />)}
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByRole("button", { name: "Save" }).className).toContain("h-11");
    expect(screen.getByRole("button", { name: "Cancel" }).className).toContain("h-11");
    expect(screen.queryByText("Esc to cancel")).toBeNull();
  });
});

describe("KnowledgeForm saving", () => {
  it("Save writes one edit, closes, and Enter in a field saves too", () => {
    const editor = mount([heading("Alpha", "a", K(1))]);
    const { close } = renderForm(editor, "a");
    fireEvent.change(input("Conclusion"), { target: { value: "new text" } });
    fireEvent.keyDown(input("Conclusion"), { key: "Enter" });
    expect(infoOf(editor, "a")).toMatchObject({ id: "k_00000001", when: "when 1", conclusion: "new text" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("Enter that confirms an input-method composition does not save", () => {
    const editor = mount([heading("Alpha", "a", K(1))]);
    const { close } = renderForm(editor, "a");
    fireEvent.change(input("Conclusion"), { target: { value: "ni" } });
    fireEvent.keyDown(input("Conclusion"), { key: "Enter", isComposing: true });
    fireEvent.keyDown(input("Conclusion"), { key: "Enter", keyCode: 229 });
    expect(close).not.toHaveBeenCalled();
    expect(infoOf(editor, "a")!.conclusion).toBe("conclusion 1");
  });

  it("emptying every field of existing knowledge that needs review asks for a field instead of saving; Remove clears the knowledge", () => {
    const editor = mount([heading("Alpha", "a", K(1))]);
    const { close, unmount } = renderForm(editor, "a");
    fireEvent.change(input("When to read"), { target: { value: "" } });
    fireEvent.change(input("Conclusion"), { target: { value: " " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Fill in at least one field.");
    expect(close).not.toHaveBeenCalled();
    expect(infoOf(editor, "a")).toMatchObject({ id: "k_00000001", when: "when 1", conclusion: "conclusion 1", status: "" });
    fireEvent.change(input("Conclusion"), { target: { value: "kept" } });
    expect(screen.queryByRole("alert")).toBeNull();
    unmount();
    const again = renderForm(editor, "a");
    fireEvent.click(screen.getByRole("button", { name: "Remove knowledge info" }));
    expect(infoOf(editor, "a")).toBeNull();
    expect(again.close).toHaveBeenCalledTimes(1);
  });

  it("emptying every field while choosing Verified or Outdated saves just the status", () => {
    const editor = mount([heading("Alpha", "a", K(1)), heading("Beta", "b", K(2))]);
    const { close, unmount } = renderForm(editor, "a");
    fireEvent.change(input("When to read"), { target: { value: "" } });
    fireEvent.change(input("Conclusion"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("radio", { name: "Outdated" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(close).toHaveBeenCalledTimes(1);
    expect(infoOf(editor, "a")).toMatchObject({ id: "k_00000001", when: "", conclusion: "", status: "outdated" });
    unmount();
    const fresh = mount([heading("Plain", "c")]);
    const created = renderForm(fresh, "c");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(created.close).toHaveBeenCalledTimes(1);
    expect(infoOf(fresh, "c")).toMatchObject({ status: "unverified" });
  });

  it("a half-typed date refuses to save and says so instead of clearing the stored date", () => {
    const editor = mount([heading("Alpha", "a", K(1, { knowledgeVerified: "2026-01-02" }))]);
    const { close } = renderForm(editor, "a");
    const date = input("Last verified");
    Object.defineProperty(date, "validity", { value: { badInput: true }, configurable: true });
    fireEvent.change(input("Conclusion"), { target: { value: "edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const message = screen.getByText("Enter a complete date.");
    expect(date.getAttribute("aria-describedby")).toBe(message.id);
    expect(date.getAttribute("aria-invalid")).toBe("true");
    expect(close).not.toHaveBeenCalled();
    expect(infoOf(editor, "a")).toMatchObject({ conclusion: "conclusion 1", verified: "2026-01-02" });
  });

  it("Remove is hidden once a collaborator has removed the knowledge info", async () => {
    const editor = mount([heading("Alpha", "a", K(1)), P("p", "p")]);
    renderForm(editor, "a");
    expect(screen.getByRole("button", { name: "Remove knowledge info" })).toBeInTheDocument();
    act(() => {
      removeKnowledge(editor, "a");
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove knowledge info" })).toBeNull());
  });

  it("past 200 or 300 code points the field shows the too-long message and Save is refused; under the limit no message shows", () => {
    const editor = mount([heading("Alpha", "a", K(1))]);
    const { close } = renderForm(editor, "a");
    fireEvent.change(input("When to read"), { target: { value: "x".repeat(200) } });
    expect(screen.queryByText(/At most/)).toBeNull();
    fireEvent.change(input("When to read"), { target: { value: "x".repeat(201) } });
    expect(screen.getByText("At most 200 characters (now 201).")).toBeInTheDocument();
    expect(input("When to read").getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(input("Conclusion"), { target: { value: "😀".repeat(301) } });
    expect(screen.getByText("At most 300 characters (now 301).")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(close).not.toHaveBeenCalled();
    expect(infoOf(editor, "a")!.when).toBe("when 1");
  });

  it("a value with line breaks written elsewhere is shown with spaces and left unchanged when another field is saved", () => {
    const editor = mount([heading("Alpha", "a", K(1, { knowledgeConclusion: "first\nsecond" }))]);
    renderForm(editor, "a");
    expect(input("Conclusion").value).toBe("first second");
    fireEvent.change(input("When to read"), { target: { value: "changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(infoOf(editor, "a")).toMatchObject({ when: "changed", conclusion: "first\nsecond" });
  });

  it("editing such a field saves the edited text with line breaks turned into spaces", () => {
    const editor = mount([heading("Alpha", "a", K(1, { knowledgeConclusion: "first\nsecond" }))]);
    renderForm(editor, "a");
    fireEvent.change(input("Conclusion"), { target: { value: "first second third" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(infoOf(editor, "a")!.conclusion).toBe("first second third");
  });

  it("an over-limit value written elsewhere doesn't block saving another field, but editing that field must bring it under the limit", () => {
    const editor = mount([heading("Alpha", "a", K(1, { knowledgeWhen: "w".repeat(250) }))]);
    const { close } = renderForm(editor, "a");
    fireEvent.change(input("Conclusion"), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(close).toHaveBeenCalledTimes(1);
    expect(infoOf(editor, "a")).toMatchObject({ when: "w".repeat(250), conclusion: "short" });
  });

  it("an edited field that stays over the limit blocks saving", () => {
    const editor = mount([heading("Alpha", "a", K(1, { knowledgeWhen: "w".repeat(250) }))]);
    const { close } = renderForm(editor, "a");
    fireEvent.change(input("When to read"), { target: { value: "w".repeat(240) } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(close).not.toHaveBeenCalled();
  });

  it("a heading that a collaborator turned into a paragraph closes the form with a notice and writes nothing", async () => {
    const editor = mount([heading("Alpha", "a", K(1)), P("para", "p")]);
    const { close } = renderForm(editor, "a");
    fireEvent.change(input("Conclusion"), { target: { value: "typed" } });
    act(() => {
      editor.updateBlock("a", { type: "paragraph" } as never);
    });
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(editor.getBlock("a")!.type).toBe("paragraph");
    expect(editor.getBlock("p")).toBeDefined();
    expect(editor.getBlock("a")!.props).not.toHaveProperty("knowledgeConclusion", "typed");
  });
});

describe("KnowledgeForm replacement picker", () => {
  const three = () => mount([heading("Alpha", "a", K(1)), heading("Beta", "b", K(2)), heading("Gamma", "c", K(3))]);
  const pickOutdated = () => fireEvent.click(screen.getByRole("radio", { name: "Outdated" }));

  it("choosing Outdated shows the optional replacement picker after last verified", () => {
    const editor = three();
    const { container } = renderForm(editor, "a");
    expect(screen.queryByRole("combobox", { name: "Replaced by" })).toBeNull();
    pickOutdated();
    const picker = screen.getByRole("combobox", { name: "Replaced by" });
    const names = [...container.querySelectorAll("label, span[id$='-label']")].map((el) => el.textContent);
    expect(names.indexOf("Status")).toBeLessThan(names.indexOf("Last verified"));
    expect(names.indexOf("Last verified")).toBeLessThan(names.indexOf("Replaced by"));
    expect(picker).toBeInTheDocument();
    expect(container.querySelector("[data-kb-optional]")!.textContent).toBe("Optional");
  });

  it("Outdated can be saved with Replaced by left empty", () => {
    const editor = three();
    const { close } = renderForm(editor, "a");
    pickOutdated();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(close).toHaveBeenCalledTimes(1);
    expect(infoOf(editor, "a")).toMatchObject({ status: "outdated", supersededBy: "" });
  });

  it("the picker lists the note's other knowledge but not this one, and stores a bare id", async () => {
    const editor = three();
    const { close } = renderForm(editor, "a");
    pickOutdated();
    fireEvent.focus(screen.getByRole("combobox", { name: "Replaced by" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("Beta"), expect.stringContaining("Gamma")]));
    expect(options.some((o) => o.textContent!.includes("Alpha"))).toBe(false);
    fireEvent.mouseDown(options.find((o) => o.textContent!.includes("Beta"))!);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(infoOf(editor, "a")).toMatchObject({ status: "outdated", supersededBy: "k_00000002" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("typing narrows the list and Enter picks the highlighted row without saving the form", async () => {
    const editor = three();
    const { close } = renderForm(editor, "a");
    pickOutdated();
    const combo = screen.getByRole("combobox", { name: "Replaced by" });
    fireEvent.focus(combo);
    fireEvent.change(combo, { target: { value: "gam" } });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    fireEvent.keyDown(combo, { key: "Enter" });
    expect(close).not.toHaveBeenCalled();
    expect(combo.getAttribute("aria-expanded")).toBe("false");
    expect((combo as HTMLInputElement).value).toBe("Gamma");
  });

  it("a same-note replacement that no longer exists shows the missing text, and one in another note shows the other-note text", async () => {
    const gone = mount([heading("Alpha", "a", K(1, { knowledgeStatus: "outdated", knowledgeSupersededBy: "k_0000000f" }))]);
    renderForm(gone, "a");
    const combo = screen.getByRole("combobox", { name: "Replaced by" }) as HTMLInputElement;
    await waitFor(() => expect(combo.value).toBe("knowledge that no longer exists"));
    cleanup();
    const other = mount([heading("Alpha", "a", K(1, { knowledgeStatus: "outdated", knowledgeSupersededBy: `${OTHER}#k_0000000f` }))]);
    renderForm(other, "a");
    const combo2 = screen.getByRole("combobox", { name: "Replaced by" }) as HTMLInputElement;
    await waitFor(() => expect(combo2.value).toBe("knowledge in another note"));
  });

  it("switching away from Outdated drops the replacement", () => {
    const editor = mount([heading("Alpha", "a", K(1, { knowledgeStatus: "outdated", knowledgeSupersededBy: "k_00000002" })), heading("Beta", "b", K(2))]);
    renderForm(editor, "a");
    fireEvent.click(screen.getByRole("radio", { name: "Verified" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(infoOf(editor, "a")).toMatchObject({ status: "verified", supersededBy: "" });
  });
});

describe("KnowledgeForm replacement picker with a ref source", () => {
  const remoteHit = { ref: `${OTHER}#k_0000000f`, noteId: OTHER, noteTitle: "Other note", blockId: "z", heading: "Elsewhere", conclusion: "", href: `/n/${OTHER}` };
  const setup = (search: KnowledgeRefSource["search"]) => {
    const editor = mount([heading("Alpha", "a", K(1)), heading("Beta", "b", K(2))]);
    const source: KnowledgeRefSource = { search: vi.fn(search), resolve: () => Promise.resolve(null) };
    const close = vi.fn();
    render(
      <KnowledgeRefSourceContext.Provider value={source}>
        {withFields(<KnowledgeForm editor={editor} blockId="a" getEntries={() => entriesOf(editor)} noteId={NOTE} phone={false} close={close} />)}
      </KnowledgeRefSourceContext.Provider>,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Outdated" }));
    const combo = screen.getByRole("combobox", { name: "Replaced by" });
    fireEvent.focus(combo);
    return { editor, source, combo, close };
  };
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("without a ref source only This note is listed, exactly as before", async () => {
    const editor = mount([heading("Alpha", "a", K(1)), heading("Beta", "b", K(2))]);
    renderForm(editor, "a");
    fireEvent.click(screen.getByRole("radio", { name: "Outdated" }));
    fireEvent.focus(screen.getByRole("combobox", { name: "Replaced by" }));
    await advance(0);
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.queryByText("This note")).toBeNull();
    expect(screen.queryByText("Other notes")).toBeNull();
  });

  it("the other-note section appears 250 ms after typing stops and a blank query asks nothing", async () => {
    const { source, combo } = setup(() => Promise.resolve([remoteHit]));
    await advance(1000);
    expect(source.search).not.toHaveBeenCalled();
    fireEvent.change(combo, { target: { value: "else" } });
    await advance(249);
    expect(source.search).not.toHaveBeenCalled();
    await advance(1);
    expect(source.search).toHaveBeenCalledTimes(1);
    expect(source.search).toHaveBeenCalledWith("else", expect.any(AbortSignal));
    await advance(0);
    expect(screen.getByRole("option", { name: /Elsewhere/ })).toBeInTheDocument();
    expect(screen.getByText("This note")).toBeInTheDocument();
    expect(screen.getByText("Other notes")).toBeInTheDocument();
  });

  it("typing again within the delay sends one search, and typing after it aborts the previous one", async () => {
    const signals: AbortSignal[] = [];
    const { source, combo } = setup((_q, signal) => {
      signals.push(signal!);
      return new Promise(() => {});
    });
    fireEvent.change(combo, { target: { value: "e" } });
    await advance(100);
    fireEvent.change(combo, { target: { value: "el" } });
    await advance(250);
    expect(source.search).toHaveBeenCalledTimes(1);
    expect(source.search).toHaveBeenLastCalledWith("el", expect.any(AbortSignal));
    fireEvent.change(combo, { target: { value: "els" } });
    expect(signals[0]!.aborted).toBe(true);
    await advance(250);
    expect(source.search).toHaveBeenCalledTimes(2);
  });

  it("nothing is sent while an input-method composition is in progress", async () => {
    const { source, combo } = setup(() => Promise.resolve([]));
    fireEvent.compositionStart(combo);
    fireEvent.change(combo, { target: { value: "ㄅ" } });
    await advance(1000);
    expect(source.search).not.toHaveBeenCalled();
    fireEvent.compositionEnd(combo);
    fireEvent.change(combo, { target: { value: "步" } });
    await advance(250);
    expect(source.search).toHaveBeenCalledWith("步", expect.any(AbortSignal));
  });

  it("choosing an other-note candidate stores noteId#knowledgeId", async () => {
    const { editor, combo } = setup(() => Promise.resolve([remoteHit]));
    fireEvent.change(combo, { target: { value: "else" } });
    await advance(250);
    await advance(0);
    fireEvent.mouseDown(screen.getByRole("option", { name: /Elsewhere/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(infoOf(editor, "a")).toMatchObject({ status: "outdated", supersededBy: `${OTHER}#k_0000000f` });
  });

  it("a failed other-note search says so under This note's results, which stay usable", async () => {
    const { editor, combo } = setup(() => Promise.reject(new Error("offline")));
    fireEvent.change(combo, { target: { value: "bet" } });
    await advance(250);
    await advance(0);
    expect(screen.getByText("Couldn't search other notes.")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("option", { name: /Beta/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(infoOf(editor, "a")).toMatchObject({ supersededBy: "k_00000002" });
  });

  it("a 429 says to wait instead of the generic failure", async () => {
    const { combo } = setup(() => Promise.reject(Object.assign(new Error("slow down"), { status: 429 })));
    fireEvent.change(combo, { target: { value: "bet" } });
    await advance(250);
    await advance(0);
    expect(screen.getByText("Too many searches. Try again in a minute.")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't search other notes.")).toBeNull();
  });

  it("an aborted search is not reported as a failure", async () => {
    const { combo } = setup((_q, signal) => new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    fireEvent.change(combo, { target: { value: "bet" } });
    await advance(250);
    fireEvent.change(combo, { target: { value: "beta" } });
    await advance(0);
    expect(screen.queryByText("Couldn't search other notes.")).toBeNull();
  });
});

let lastController: KnowledgeController | null = null;
function Host({ editor, container, editable = true, fields }: { editor: AnyEditor; container: HTMLElement; editable?: boolean; fields?: Partial<KnowledgeFieldsValue> }) {
  const controller = useKnowledgeController();
  lastController = controller;
  const [entries, setEntries] = useState(() => entriesOf(editor));
  useEffect(() => editor.onChange(() => setEntries(entriesOf(editor))), [editor]);
  return withFields(<KnowledgeLayer container={container} entries={entries} editable={editable} noteId={NOTE} controller={controller} editor={editor} />, fields);
}

describe("edit surface in the layer", () => {
  function layerWith(content: PartialBlockLike[], editable = true, fields?: Partial<KnowledgeFieldsValue>) {
    const m = mountEditor(content, { collab: true });
    cleanups.push(m.destroy);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, 600, 30));
    vi.spyOn(Range.prototype, "getClientRects").mockImplementation(() => [new DOMRect(0, 0, 200, 30)] as unknown as DOMRectList);
    render(<Host editor={m.editor} container={m.container} editable={editable} fields={fields} />);
    return m.editor;
  }
  const openEdit = (id: string) => act(() => lastController!.open(id, "edit", null));

  it("a click outside does not close the form; Escape and Cancel do", async () => {
    const editor = layerWith([heading("Alpha", "a", K(1)), P("para", "p")]);
    openEdit("a");
    expect(await screen.findByRole("heading", { name: "Knowledge info" })).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    fireEvent.mouseDown(document.body);
    fireEvent.click(document.body);
    expect(screen.getByRole("heading", { name: "Knowledge info" })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Knowledge info" })).toBeNull());
    openEdit("a");
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Knowledge info" })).toBeNull());
    expect(infoOf(editor, "a")!.conclusion).toBe("conclusion 1");
  });

  it("Escape with the replacement list open closes only the list; a second Escape closes the form", async () => {
    layerWith([heading("Alpha", "a", K(1)), heading("Beta", "b", K(2))]);
    openEdit("a");
    fireEvent.click(await screen.findByRole("radio", { name: "Outdated" }));
    const combo = screen.getByRole("combobox", { name: "Replaced by" });
    fireEvent.focus(combo);
    await screen.findAllByRole("option");
    fireEvent.keyDown(combo, { key: "Escape" });
    await waitFor(() => expect(combo.getAttribute("aria-expanded")).toBe("false"));
    expect(screen.getByRole("heading", { name: "Knowledge info" })).toBeInTheDocument();
    fireEvent.keyDown(combo, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Knowledge info" })).toBeNull());
  });

  it("Escape with the member list open closes only the list; a second Escape closes the form", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve(null) } as unknown as Response)));
    try {
      const m = mountEditor([heading("Alpha", "a", K(1))], { collab: true });
      cleanups.push(m.destroy);
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, 600, 30));
      vi.spyOn(Range.prototype, "getClientRects").mockImplementation(() => [new DOMRect(0, 0, 200, 30)] as unknown as DOMRectList);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={client}>
          <Host editor={m.editor} container={m.container} fields={{ view: customFieldView([{ key: "owner", type: "member", name: "Owner" }]) }} />
        </QueryClientProvider>,
      );
      openEdit("a");
      const combo = await screen.findByRole("combobox", { name: "Owner" });
      fireEvent.focus(combo);
      expect(combo).toHaveAttribute("aria-expanded", "true");
      fireEvent.keyDown(combo, { key: "Escape" });
      await waitFor(() => expect(combo.getAttribute("aria-expanded")).toBe("false"));
      expect(screen.getByRole("heading", { name: "Knowledge info" })).toBeInTheDocument();
      fireEvent.keyDown(combo, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("heading", { name: "Knowledge info" })).toBeNull());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("opens on a heading that is not knowledge yet and Save turns it into knowledge", async () => {
    const editor = layerWith([heading("Plain", "b"), P("para", "p")]);
    openEdit("b");
    fireEvent.change(await screen.findByLabelText("When to read"), { target: { value: "alice reads this" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(infoOf(editor, "b")).toMatchObject({ when: "alice reads this" }));
    await waitFor(() => expect(screen.queryByLabelText("When to read")).toBeNull());
  });

  it("Save returns focus to the element that opened it", async () => {
    const editor = layerWith([heading("Plain", "b"), P("para", "p")]);
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    cleanups.push(() => opener.remove());
    act(() => lastController!.open("b", "edit", opener));
    fireEvent.change(await screen.findByLabelText("When to read"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(infoOf(editor, "b")).not.toBeNull();
  });

  it("the first field has the focus when the form opens", async () => {
    layerWith([heading("Alpha", "a", K(1))]);
    openEdit("a");
    const when = await screen.findByLabelText("When to read");
    await waitFor(() => expect(document.activeElement).toBe(when));
  });

  it("there is no edit surface for a viewer", async () => {
    layerWith([heading("Alpha", "a", K(1))], false);
    openEdit("a");
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(screen.queryByLabelText("When to read")).toBeNull();
  });

  it("the form closes when the heading is deleted by someone else", async () => {
    const editor = layerWith([heading("Alpha", "a", K(1)), P("para", "p")]);
    openEdit("a");
    await screen.findByLabelText("When to read");
    act(() => {
      editor.removeBlocks(["a"]);
    });
    await waitFor(() => expect(screen.queryByLabelText("When to read")).toBeNull());
  });

  it("on a phone the form opens in a dialog whose title is the form title", async () => {
    stubMedia([PHONE_QUERY]);
    layerWith([heading("Alpha", "a", K(1))]);
    openEdit("a");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Knowledge info" })).toBeInTheDocument();
  });

  it("the phone sheet shows Mark as verified and Edit for an editor, and nothing for a viewer", async () => {
    stubMedia([PHONE_QUERY]);
    const editor = layerWith([heading("Alpha", "a", K(1, { knowledgeStatus: "unverified" })), P("para", "p")]);
    act(() => lastController!.open("a", "view", null));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Mark as verified" }));
    expect(infoOf(editor, "a")).toMatchObject({ verified: todayLocalDate(), status: "verified" });
  });

  it.each([
    ["the date field is off", { view: fieldView({ off: ["verified"] }) }],
    ["the fields are still loading", { status: "loading" as const }],
    ["the fields failed to load", { status: "error" as const }],
  ])("Mark as verified changes only the status when %s", async (_name, fields) => {
    stubMedia([PHONE_QUERY]);
    const editor = layerWith([heading("Alpha", "a", K(1, { knowledgeStatus: "unverified", knowledgeVerified: "2025-01-02" })), P("para", "p")], true, fields);
    act(() => lastController!.open("a", "view", null));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Mark as verified" }));
    expect(infoOf(editor, "a")).toMatchObject({ verified: "2025-01-02", status: "verified" });
  });

  it("the phone sheet has no actions for a viewer", async () => {
    stubMedia([PHONE_QUERY]);
    layerWith([heading("Alpha", "a", K(1))], false);
    act(() => lastController!.open("a", "view", null));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Mark as verified" })).toBeNull();
  });
});

describe("KnowledgeForm custom fields", () => {
  const CUSTOM = customFieldView([
    { key: "team", type: "text", name: "Team" },
    { key: "stage", type: "select", name: "Stage", options: [{ key: "draft", name: "Draft" }, { key: "done", name: "Done" }, { key: "old", name: "Old", enabled: false }] },
    { key: "off", type: "text", name: "Retired", enabled: false },
    { key: "due", type: "date", name: "Due" },
    { key: "docs", type: "link", name: "Docs" },
    { key: "owner", type: "member", name: "Owner" },
  ]);

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        const body = url === "/api/knowledge/members" ? { byId: [], byToken: [] } : url === "/api/auth/me" ? null : { users: [] };
        return Promise.resolve({ ok: url !== "/api/auth/me", status: url === "/api/auth/me" ? 401 : 200, json: () => Promise.resolve(body) } as unknown as Response);
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  function renderCustom(editor: AnyEditor, blockId: string, close = vi.fn()) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        {withFields(<KnowledgeForm editor={editor} blockId={blockId} getEntries={() => entriesOf(editor)} noteId={NOTE} phone={false} close={close} />, { view: CUSTOM })}
      </QueryClientProvider>,
    );
    return close;
  }

  it("each enabled custom field gets its input in settings order and turned-off ones are absent", () => {
    const editor = mount([heading("Alpha", "a", K(1, { knowledgeCustom: '{"off":"kept"}' }))]);
    renderCustom(editor, "a");
    const form = document.querySelector("form")!;
    const labels = [...form.querySelectorAll("label, [id$='status-label'], [id$='-label']")].map((el) => el.textContent);
    expect(labels.slice(-5)).toEqual(["Team", "Stage", "Due", "Docs", "Owner"]);
    expect(labels).not.toContain("Retired");
    expect(input("Team").type).toBe("text");
    expect(input("Due").type).toBe("date");
    expect(screen.getByRole("combobox", { name: "Owner" })).toBeInTheDocument();
  });

  it("the single choice offers Not filled and the enabled options, plus a stored turned-off option marked as such", () => {
    const editor = mount([heading("Alpha", "a", K(1, { knowledgeCustom: '{"stage":"old"}' }))]);
    renderCustom(editor, "a");
    const trigger = screen.getByRole("combobox", { name: "Stage" });
    expect(trigger.querySelector("[data-select-text]")!.textContent).toBe("Old (turned off)");
    const sizers = [...trigger.querySelectorAll("[data-select-sizer]")].map((n) => n.textContent);
    expect(sizers).toEqual(["Not filled", "Draft", "Done", "Old (turned off)"]);
  });

  it("filled custom values are saved under their keys, keeping a turned-off field's value", () => {
    const editor = mount([heading("Alpha", "a", K(1, { knowledgeStatus: "unverified", knowledgeCustom: '{"off":"kept"}' }))]);
    const close = renderCustom(editor, "a");
    fireEvent.change(input("Team"), { target: { value: "core" } });
    fireEvent.change(input("Due"), { target: { value: "2026-03-04" } });
    fireEvent.change(input("Docs"), { target: { value: "https://example.com/a" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(close).toHaveBeenCalled();
    expect(editor.getBlock("a")!.props.knowledgeCustom).toBe('{"docs":"https://example.com/a","due":"2026-03-04","off":"kept","team":"core"}');
  });

  it("a link with another scheme is shown as text and blocks saving in the form", () => {
    const editor = mount([heading("Alpha", "a", K(1, { knowledgeStatus: "unverified" }))]);
    const close = renderCustom(editor, "a");
    fireEvent.change(input("Docs"), { target: { value: "javascript:alert(1)" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(close).not.toHaveBeenCalled();
    expect(input("Docs")).toHaveAttribute("aria-invalid", "true");
    expect(document.getElementById(input("Docs").getAttribute("aria-describedby")!)).toHaveTextContent("Enter a link starting with http:// or https://, or a path on this site.");
    expect(document.activeElement).toBe(input("Docs"));
    expect(infoOf(editor, "a")!.custom).toEqual({});
    fireEvent.change(input("Docs"), { target: { value: "/n/alice/page" } });
    expect(input("Docs")).not.toHaveAttribute("aria-invalid");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(close).toHaveBeenCalled();
  });

  it("a custom text over the limit blocks saving with the length message", () => {
    const editor = mount([heading("Alpha", "a", K(1, { knowledgeStatus: "unverified" }))]);
    const close = renderCustom(editor, "a");
    fireEvent.change(input("Team"), { target: { value: "t".repeat(301) } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(close).not.toHaveBeenCalled();
    expect(document.getElementById(input("Team").getAttribute("aria-describedby")!)).toHaveTextContent("At most 300 characters (now 301).");
  });
});
