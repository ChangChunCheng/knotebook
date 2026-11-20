/**
 * Insert dialog for the `/` menu "Link" item (issue #99).
 * The main behaviours (submit/cancel/validation/a11y) use a real `BlockNoteEditor` that is not mounted into the DOM (`BlockNoteEditor.create({ schema: noteSchema })`, as in `markdown-link.test.ts`):
 * URL validation shares `resolveTrailingMarkdownLink`, which needs the real `tryParseMarkdownToBlocks`, and a fake editor would only test our own mock.
 * In this group `open` is always `true` (`onOpenChange` is a spy, not wired back to state), so the Dialog never unmounts and
 * `editor.focus()` (hooked on `onCloseAutoFocus`) is never called, so it needs no stub.
 * Focus return is a separate describe that mounts into the real DOM (`editor.mount(container)`, as `mountedEditor()` in `NoteEditorView.test.tsx`)
 * with a controlled wrapper holding the `open` state, so the Dialog really unmounts: a spy having been called is not the outcome,
 * so it asserts that `document.activeElement` really lands on the editor's `.ProseMirror` node.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { BlockNoteEditor } from "@blocknote/core";
import i18n from "@/i18n";
import { clickOutside } from "@/test/outside-click";
import { noteSchema } from "@/collab/schema";
import { LinkDialog } from "./LinkDialog";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple; any by repo convention
let editor: BlockNoteEditor<any, any, any>;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
  editor = BlockNoteEditor.create({ schema: noteSchema }) as BlockNoteEditor<any, any, any>;
});

function renderDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (v: { text: string; href: string }) => void;
  initialText?: string;
  initialUrl?: string;
}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <LinkDialog editor={editor} {...props} />
    </I18nextProvider>,
  );
}

describe("LinkDialog", () => {
  it("clicking outside the dialog doesn't close it and filled content stays (form-style guard; Esc still closing is covered by ui/dialog.test)", async () => {
    const onOpenChange = vi.fn();
    renderDialog({ open: true, onOpenChange, onSubmit: vi.fn() });
    fireEvent.change(screen.getByLabelText(i18n.t("note.link.textLabel")), { target: { value: "keep" } });
    await clickOutside();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText(i18n.t("note.link.textLabel"))).toHaveValue("keep");
  });

  it("text + valid URL -> onSubmit receives { text, href }", () => {
    const onSubmit = vi.fn();
    renderDialog({ open: true, onOpenChange: vi.fn(), onSubmit });

    fireEvent.change(screen.getByLabelText(i18n.t("note.link.textLabel")), { target: { value: "我的連結" } });
    fireEvent.change(screen.getByLabelText(i18n.t("note.link.urlLabel")), { target: { value: "https://example.com" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("note.link.insert") }));

    expect(onSubmit).toHaveBeenCalledWith({ text: "我的連結", href: "https://example.com" });
  });

  it("invalid URL (javascript: scheme) -> onSubmit not called, invalidUrl error shown", () => {
    const onSubmit = vi.fn();
    renderDialog({ open: true, onOpenChange: vi.fn(), onSubmit });

    fireEvent.change(screen.getByLabelText(i18n.t("note.link.urlLabel")), { target: { value: "javascript:alert(1)" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("note.link.insert") }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(i18n.t("note.link.invalidUrl"))).toBeInTheDocument();
  });

  it("URL field whose front part is eaten by the trailing match (a shape like `) [y](actual URL`) -> onSubmit not called, shows invalidUrl", () => {
    const onSubmit = vi.fn();
    renderDialog({ open: true, onOpenChange: vi.fn(), onSubmit });

    // `resolveTrailingMarkdownLink` only recognises the tail: the assembled textBefore is `[x](https://x.com) [y](https://evil.com)`,
    // whose tail still parses as a valid link (href is evil.com), but that isn't the whole URL the user thinks they entered,
    // so it must be blocked rather than silently inserting evil.com.
    fireEvent.change(screen.getByLabelText(i18n.t("note.link.urlLabel")), {
      target: { value: "https://x.com) [y](https://evil.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("note.link.insert") }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(i18n.t("note.link.invalidUrl"))).toBeInTheDocument();
  });

  it("initialText/initialUrl prefill both fields; empty when not passed", () => {
    const view = renderDialog({ open: true, onOpenChange: vi.fn(), onSubmit: vi.fn(), initialText: "picked", initialUrl: "https://example.com" });
    expect(screen.getByLabelText(i18n.t("note.link.textLabel"))).toHaveValue("picked");
    expect(screen.getByLabelText(i18n.t("note.link.urlLabel"))).toHaveValue("https://example.com");
    view.unmount();
    renderDialog({ open: true, onOpenChange: vi.fn(), onSubmit: vi.fn() });
    expect(screen.getByLabelText(i18n.t("note.link.textLabel"))).toHaveValue("");
    expect(screen.getByLabelText(i18n.t("note.link.urlLabel"))).toHaveValue("");
  });

  it("cancel -> onSubmit not called", () => {
    const onSubmit = vi.fn();
    renderDialog({ open: true, onOpenChange: vi.fn(), onSubmit });

    fireEvent.change(screen.getByLabelText(i18n.t("note.link.urlLabel")), { target: { value: "https://example.com" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("home.cancel") }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("blank display text + valid URL -> onSubmit receives text === href (fallback)", () => {
    const onSubmit = vi.fn();
    renderDialog({ open: true, onOpenChange: vi.fn(), onSubmit });

    fireEvent.change(screen.getByLabelText(i18n.t("note.link.urlLabel")), { target: { value: "https://example.com" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("note.link.insert") }));

    expect(onSubmit).toHaveBeenCalledWith({ text: "https://example.com", href: "https://example.com" });
  });

  it("a11y: each field has a bound <label for>, the error message is bound to the URL field via aria-describedby", () => {
    renderDialog({ open: true, onOpenChange: vi.fn(), onSubmit: vi.fn() });

    const textInput = screen.getByLabelText(i18n.t("note.link.textLabel"));
    const urlInput = screen.getByLabelText(i18n.t("note.link.urlLabel"));
    expect(textInput.tagName).toBe("INPUT");
    expect(urlInput.tagName).toBe("INPUT");
    // useId ids aren't hard-coded, but the two fields' ids must still differ, otherwise <label for> collides.
    expect(textInput.id).not.toBe(urlInput.id);

    fireEvent.change(urlInput, { target: { value: "javascript:alert(1)" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("note.link.insert") }));

    const error = screen.getByText(i18n.t("note.link.invalidUrl"));
    expect(urlInput).toHaveAttribute("aria-describedby", error.id);
  });
});

/**
 * Focus return: asserting only that the `editor.focus` spy was called doesn't show it took effect (with the real editor and component,
 * without stubbing `.focus`, `document.activeElement` can stay on `<body>`), so this measures the real result.
 */
describe("LinkDialog - focus return (real editor, mounted in the DOM)", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    editor.mount(container);
  });

  afterEach(() => {
    editor.unmount();
    container.remove();
  });

  /** `Dialog` is a controlled component: to make it really unmount (triggering `onCloseAutoFocus`), this level has to catch `onOpenChange`
   * and update state, instead of passing a fixed `open` like the group above. */
  function ControlledLinkDialog({ onSubmit }: { onSubmit: (v: { text: string; href: string }) => void }) {
    const [open, setOpen] = useState(true);
    return <LinkDialog editor={editor} open={open} onOpenChange={setOpen} onSubmit={onSubmit} />;
  }

  function renderControlled(onSubmit: (v: { text: string; href: string }) => void) {
    return render(
      <I18nextProvider i18n={i18n}>
        <ControlledLinkDialog onSubmit={onSubmit} />
      </I18nextProvider>,
    );
  }

  /** Whether focus is on the editor's ProseMirror root, not whether onOpenChange/focus was called. */
  function editorIsFocused(): boolean {
    return document.activeElement?.classList.contains("ProseMirror") === true;
  }

  it("after a successful submit: focus returns to the editor", async () => {
    renderControlled(vi.fn());
    fireEvent.change(screen.getByLabelText(i18n.t("note.link.urlLabel")), { target: { value: "https://example.com" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("note.link.insert") }));

    await waitFor(() => expect(editorIsFocused()).toBe(true));
  });

  it("after cancel: focus returns to the editor", async () => {
    renderControlled(vi.fn());
    fireEvent.click(screen.getByRole("button", { name: i18n.t("home.cancel") }));

    await waitFor(() => expect(editorIsFocused()).toBe(true));
  });

  it("after closing with Esc: focus returns to the editor", async () => {
    renderControlled(vi.fn());
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    await waitFor(() => expect(editorIsFocused()).toBe(true));
  });
});
