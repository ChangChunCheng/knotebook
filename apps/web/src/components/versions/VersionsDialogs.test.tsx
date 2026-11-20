import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseRefOrNull, vid, vlabel } from "@/test/version-fixtures";
import { useRef, useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { VersionCurrentDto, VersionDto, VersionListDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { Toaster, dismissAllToasts } from "@/components/ui/toast";
import { clickOutside } from "@/test/outside-click";
import { versionListKey } from "@/api/versions";
import { VersionsProvider, useVersions, useVersionsController } from "@/lib/versions-context";
import { VersionsDialogs } from "./VersionsDialogs";
import { useApplyFlow } from "./use-apply-flow";

const NOTE = "n1";
const v = (seq: number, over: Partial<VersionDto> = {}): VersionDto => ({ id: vid(seq), seq, kind: "auto", name: null, editors: [], baseSeq: null, base: baseRefOrNull(over.baseSeq), createdAt: "2026-10-09T00:00:00.000Z", ...over });
const cur = (over: Partial<VersionCurrentDto> = {}): VersionCurrentDto => ({ baseSeq: 2, base: baseRefOrNull(over.baseSeq === undefined ? 2 : over.baseSeq), dirty: false, nextSeq: 3, autoEnabled: true, ...over });
const listBody = (current: VersionCurrentDto): VersionListDto => ({ versions: [v(2), v(1)], current, nextBefore: null });

type Handler = (url: string, init?: RequestInit) => { status: number; body?: unknown } | undefined;
function stub(handler: Handler) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const r = handler(url, init);
      if (!r) throw new Error(`unexpected fetch: ${method} ${url}`);
      return Promise.resolve({ ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) } as Response);
    }),
  );
  return calls;
}

function Harness({ target }: { target: VersionDto }) {
  const s = useVersions();
  const flow = useApplyFlow(NOTE);
  return (
    <div>
      <button type="button" onClick={() => s.startPreview({ seq: target.seq, id: target.id, name: target.name })}>h-preview</button>
      <button type="button" onClick={() => void flow.requestApply(target)}>h-apply</button>
      <button type="button" onClick={() => s.openSave()}>h-save</button>
      <button type="button" onClick={() => s.openDialog({ kind: "rename", version: target })}>h-rename</button>
      <button type="button" onClick={() => s.openDialog({ kind: "delete", version: target })}>h-delete</button>
      <span data-testid="h-state">{JSON.stringify({ preview: s.preview, dialog: s.dialog?.kind ?? null })}</span>
      {/* Editor stand-in: focus is on a contenteditable at Ctrl+S. */}
      <div data-testid="h-editor" contentEditable suppressContentEditableWarning tabIndex={-1}>
        editor
      </div>
    </div>
  );
}
function Host({ target }: { target: VersionDto }) {
  const value = useVersionsController({ noteId: NOTE, enabled: true });
  // fallback: simulates the header kebab menu - the menu item unmounts in the same batch as its press (which opens the save dialog); `fake-menu-trigger` is the returnFocusRef handed down.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(true);
  return (
    <VersionsProvider value={value}>
      <Harness target={target} />
      <button ref={triggerRef} type="button">
        fake-menu-trigger
      </button>
      {menuOpen && (
        <button
          type="button"
          onClick={() => {
            setMenuOpen(false);
            value.openSave();
          }}
        >
          menu-item-save
        </button>
      )}
      {/* Mounted like NotePage does: only when dialog !== null, and unmounted on close. */}
      {value.dialog !== null && <VersionsDialogs returnFocusRef={triggerRef} />}
    </VersionsProvider>
  );
}
function renderDialogs(target: VersionDto = v(1)) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <Host target={target} />
      <Toaster />
    </QueryClientProvider>,
  );
  return { queryClient };
}
const hState = () => JSON.parse(screen.getByTestId("h-state").textContent!);
const LIST = `/api/notes/${NOTE}/versions?limit=50`;
const CUR = `/api/notes/${NOTE}/versions?limit=1`;
const APPLY1 = `/api/notes/${NOTE}/versions/1/apply`;

describe("VersionsDialogs + useApplyFlow", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("save: the description is a fixed sentence that does not announce a version number (#272); the name is trimmed before sending; toast 'Saved as <name> (short id)'; the dialog closes", async () => {
    const calls = stub((url, init) => {
      if (url === LIST) return { status: 200, body: listBody(cur({ dirty: true })) };
      if (url === `/api/notes/${NOTE}/versions` && init?.method === "POST") return { status: 201, body: { ...v(3, { kind: "manual", name: "里程碑" }), upgraded: false } };
      return undefined;
    });
    renderDialogs();
    fireEvent.click(screen.getByText("h-save"));
    const dialog = await screen.findByRole("dialog", { name: "Save current version" });
    expect(await within(dialog).findByText("Creates a new version from the current content.")).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent(/\bv\d+\b|0003aaa/);
    fireEvent.change(within(dialog).getByLabelText("Version name (optional)"), { target: { value: "  里程碑 " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved as 里程碑 (0003aaa)")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "里程碑" });
    await waitFor(() => expect(hState().dialog).toBeNull());
  });

  it("clicking outside the save dialog does not close it (form type, dismissOnOutside={false}) and the typed name stays", async () => {
    stub((url) => (url === LIST ? { status: 200, body: listBody(cur({ dirty: true })) } : undefined));
    renderDialogs();
    fireEvent.click(screen.getByText("h-save"));
    const dialog = await screen.findByRole("dialog", { name: "Save current version" });
    fireEvent.change(within(dialog).getByLabelText("Version name (optional)"), { target: { value: "草稿" } });
    await clickOutside();
    expect(screen.getByRole("dialog", { name: "Save current version" })).toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).getByLabelText("Version name (optional)")).toHaveValue("草稿");
  });

  it("saving when the content equals the base (upgraded:true) -> the toast follows the version in the response, not the cached base", async () => {
    stub((url, init) => {
      if (url === LIST) return { status: 200, body: listBody(cur({ baseSeq: 9 })) };
      if (url === `/api/notes/${NOTE}/versions` && init?.method === "POST") return { status: 201, body: { ...v(2, { kind: "manual" }), upgraded: true } };
      return undefined;
    });
    renderDialogs();
    fireEvent.click(screen.getByText("h-save"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Save" }));
    expect(await screen.findByText(`Same content as ${vlabel(2)} — it is now a manual version`)).toBeInTheDocument();
  });

  it("apply: refetched current is not dirty -> POSTs apply directly (discardUnsaved:false, with versionId), no dialog, a toast, and the preview is left", async () => {
    const calls = stub((url) => {
      if (url === CUR) return { status: 200, body: listBody(cur({ dirty: false })) };
      if (url === APPLY1) return { status: 200, body: { current: cur({ baseSeq: 1 }) } };
      if (url === LIST) return { status: 200, body: listBody(cur()) };
      return undefined;
    });
    renderDialogs();
    fireEvent.click(screen.getByText("h-preview"));
    fireEvent.click(screen.getByText("h-apply"));
    expect(await screen.findByText(`Applied ${vlabel(1)}`)).toBeInTheDocument();
    expect(calls.find((c) => c.url === APPLY1)?.body).toEqual({ versionId: vid(1), discardUnsaved: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(hState().preview).toBeNull();
  });

  it("the panel cache says clean but the refetch before applying finds dirty -> the three-choice dialog appears (always refetches)", async () => {
    const calls = stub((url) => {
      if (url === CUR) return { status: 200, body: listBody(cur({ dirty: true })) };
      return undefined;
    });
    const { queryClient } = renderDialogs();
    queryClient.setQueryData(versionListKey(NOTE, "all"), { pages: [listBody(cur({ dirty: false }))], pageParams: [undefined] });
    // The seed must land on the key the panel reads (#258: once the key grew longer, a seed landed on a key nobody reads and this case's premise was empty).
    expect(queryClient.getQueryData(versionListKey(NOTE, "all"))).toBeDefined();
    fireEvent.click(screen.getByText("h-apply"));
    const dialog = await screen.findByRole("dialog", { name: `Apply ${vlabel(1)}` });
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Apply without saving" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save current version" })).toBeInTheDocument();
    expect(calls.some((c) => c.url === APPLY1)).toBe(false);
  });

  it("three-choice: cancel -> no apply call; apply without saving -> discardUnsaved:true", async () => {
    const calls = stub((url) => {
      if (url === CUR) return { status: 200, body: listBody(cur({ dirty: true })) };
      if (url === APPLY1) return { status: 200, body: { current: cur({ baseSeq: 1 }) } };
      return undefined;
    });
    renderDialogs();
    fireEvent.click(screen.getByText("h-apply"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.some((c) => c.url === APPLY1)).toBe(false);
    fireEvent.click(screen.getByText("h-apply"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Apply without saving" }));
    expect(await screen.findByText(`Applied ${vlabel(1)}`)).toBeInTheDocument();
    expect(calls.find((c) => c.url === APPLY1)?.body).toEqual({ versionId: vid(1), discardUnsaved: true });
  });

  it("three-choice: save the current version -> opens the save dialog; after saving it applies automatically (discardUnsaved:false), and the POST order is save then apply", async () => {
    const calls = stub((url, init) => {
      if (url === CUR) return { status: 200, body: listBody(cur({ dirty: true })) };
      if (url === LIST) return { status: 200, body: listBody(cur({ dirty: true })) };
      if (url === `/api/notes/${NOTE}/versions` && init?.method === "POST") return { status: 201, body: { ...v(3, { kind: "manual" }), upgraded: false } };
      if (url === APPLY1) return { status: 200, body: { current: cur({ baseSeq: 1 }) } };
      return undefined;
    });
    renderDialogs();
    fireEvent.click(screen.getByText("h-apply"));
    fireEvent.click(within(await screen.findByRole("dialog", { name: `Apply ${vlabel(1)}` })).getByRole("button", { name: "Save current version" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Save current version" })).getByRole("button", { name: "Save" }));
    expect(await screen.findByText(`Applied ${vlabel(1)}`)).toBeInTheDocument();
    const posts = calls.filter((c) => c.method === "POST").map((c) => c.url);
    expect(posts).toEqual([`/api/notes/${NOTE}/versions`, APPLY1]);
    expect(calls.find((c) => c.url === APPLY1)?.body).toEqual({ versionId: vid(1), discardUnsaved: false });
  });

  it("a direct apply receiving 409 version_unsaved_changes -> the three-choice dialog appears instead", async () => {
    stub((url) => {
      if (url === CUR) return { status: 200, body: listBody(cur({ dirty: false })) };
      if (url === APPLY1) return { status: 409, body: { error: { code: "version_unsaved_changes", message: "The note has changes that aren't in any saved version." } } };
      return undefined;
    });
    renderDialogs();
    fireEvent.click(screen.getByText("h-apply"));
    expect(await screen.findByRole("dialog", { name: `Apply ${vlabel(1)}` })).toBeInTheDocument();
  });

  it("409 version_mismatch -> toast errors.version_mismatch, the list is invalidated, the preview is left and there is no dialog", async () => {
    const calls = stub((url) => {
      if (url === CUR) return { status: 200, body: listBody(cur({ dirty: false })) };
      if (url === APPLY1) return { status: 409, body: { error: { code: "version_mismatch", message: "x" } } };
      return undefined;
    });
    const { queryClient } = renderDialogs();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    fireEvent.click(screen.getByText("h-preview"));
    fireEvent.click(screen.getByText("h-apply"));
    expect(await screen.findByText(i18n.t("errors.version_mismatch"))).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith({ queryKey: ["notes", NOTE, "versions"] });
    expect(hState().preview).toBeNull();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls.filter((c) => c.url === APPLY1)).toHaveLength(1);
  });

  it("rename: an auto version shows the will-become-manual notice; submits PATCH { name }; an all-blank name sends null", async () => {
    const calls = stub((url, init) => {
      if (url === `/api/notes/${NOTE}/versions/1` && init?.method === "PATCH") return { status: 200, body: v(1, { kind: "manual" }) };
      return undefined;
    });
    renderDialogs(v(1, { kind: "auto", name: "舊名" }));
    fireEvent.click(screen.getByText("h-rename"));
    const dialog = await screen.findByRole("dialog", { name: `Edit name of ${vlabel(1, "舊名")}` });
    expect(within(dialog).getByText("Naming an automatic version makes it a manual version, which is kept until you delete it.")).toBeInTheDocument();
    const input = within(dialog).getByLabelText("Version name (optional)");
    expect(input).toHaveValue("舊名");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Version name updated")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ name: null });
  });

  it("delete: success -> DELETE and a toast; deleting the previewed version leaves the preview", async () => {
    stub((url, init) => {
      if (url === `/api/notes/${NOTE}/versions/1` && init?.method === "DELETE") return { status: 204 };
      return undefined;
    });
    renderDialogs();
    fireEvent.click(screen.getByText("h-preview"));
    fireEvent.click(screen.getByText("h-delete"));
    const dialog = await screen.findByRole("dialog", { name: `Delete ${vlabel(1)}?` });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText(`Deleted ${vlabel(1)}`)).toBeInTheDocument();
    expect(hState().preview).toBeNull();
  });

  it("editor has focus -> open the save dialog -> cancel / close after saving -> focus returns to the editor in both cases (a controlled Dialog has no Trigger, so Radix does not restore it by itself)", async () => {
    stub((url, init) => {
      if (url === LIST) return { status: 200, body: listBody(cur({ dirty: true })) };
      if (url === `/api/notes/${NOTE}/versions` && init?.method === "POST") return { status: 201, body: { ...v(3, { kind: "manual" }), upgraded: false } };
      return undefined;
    });
    renderDialogs();
    const editor = screen.getByTestId("h-editor");
    editor.focus();
    expect(document.activeElement).toBe(editor);
    fireEvent.click(screen.getByText("h-save"));
    let dialog = await screen.findByRole("dialog", { name: "Save current version" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(editor));
    fireEvent.click(screen.getByText("h-save"));
    dialog = await screen.findByRole("dialog", { name: "Save current version" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText(`Saved as ${vlabel(3)}`)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(editor));
  });

  it("fallback: the save dialog opened from the kebab menu (the recorded menu item is already unmounted) -> cancel -> focus falls back to the kebab trigger button", async () => {
    stub((url) => (url === LIST ? { status: 200, body: listBody(cur({ dirty: true })) } : undefined));
    renderDialogs();
    const item = screen.getByText("menu-item-save");
    item.focus();
    expect(document.activeElement).toBe(item);
    fireEvent.click(item);
    const dialog = await screen.findByRole("dialog", { name: "Save current version" });
    expect(screen.queryByText("menu-item-save")).not.toBeInTheDocument();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "fake-menu-trigger" })));
  });

  it("focus is on body when the dialog opens (nothing to give it back to) -> after closing it falls back to the kebab trigger button, not body", async () => {
    stub((url) => (url === LIST ? { status: 200, body: listBody(cur({ dirty: true })) } : undefined));
    renderDialogs();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(screen.getByText("h-save"));
    const dialog = await screen.findByRole("dialog", { name: "Save current version" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "fake-menu-trigger" })));
  });

  it("three-choice -> when Save current version swaps to the save dialog, focus stays inside the new dialog (not pulled back to the editor); it returns to the editor only after saving and applying", async () => {
    stub((url, init) => {
      if (url === CUR) return { status: 200, body: listBody(cur({ dirty: true })) };
      if (url === LIST) return { status: 200, body: listBody(cur({ dirty: true })) };
      if (url === `/api/notes/${NOTE}/versions` && init?.method === "POST") return { status: 201, body: { ...v(3, { kind: "manual" }), upgraded: false } };
      if (url === APPLY1) return { status: 200, body: { current: cur({ baseSeq: 1 }) } };
      return undefined;
    });
    renderDialogs();
    const editor = screen.getByTestId("h-editor");
    editor.focus();
    fireEvent.click(screen.getByText("h-apply"));
    fireEvent.click(within(await screen.findByRole("dialog", { name: `Apply ${vlabel(1)}` })).getByRole("button", { name: "Save current version" }));
    const save = await screen.findByRole("dialog", { name: "Save current version" });
    await waitFor(() => expect(save.contains(document.activeElement)).toBe(true));
    // When the old dialog unmounts, FocusScope's restore event fires at setTimeout 0: wait past that tick and focus must still be inside the new dialog.
    await new Promise((r) => setTimeout(r, 50));
    expect(save.contains(document.activeElement)).toBe(true);
    fireEvent.click(within(save).getByRole("button", { name: "Save" }));
    expect(await screen.findByText(`Applied ${vlabel(1)}`)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(editor));
  });

  it("save then apply: between a successful save and the apply finishing the submit button cannot be pressed again (a second click does not trigger a second POST)", async () => {
    let releaseApply: () => void = () => {};
    const calls: Array<{ method: string; url: string }> = [];
    const res = (status: number, body?: unknown) => ({ ok: status < 400, status, json: () => Promise.resolve(body) }) as Response;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        calls.push({ method, url });
        if (url === CUR || url === LIST) return Promise.resolve(res(200, listBody(cur({ dirty: true }))));
        if (url === `/api/notes/${NOTE}/versions` && method === "POST") return Promise.resolve(res(201, { ...v(3, { kind: "manual" }), upgraded: false }));
        if (url === APPLY1) return new Promise<Response>((resolve) => (releaseApply = () => resolve(res(200, { current: cur({ baseSeq: 1 }) }))));
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
    renderDialogs();
    fireEvent.click(screen.getByText("h-apply"));
    fireEvent.click(within(await screen.findByRole("dialog", { name: `Apply ${vlabel(1)}` })).getByRole("button", { name: "Save current version" }));
    const save = await screen.findByRole("dialog", { name: "Save current version" });
    const submit = within(save).getByRole("button", { name: "Save" });
    fireEvent.click(submit);
    // The save already succeeded (toast shown) and the apply POST has not returned yet.
    expect(await screen.findByText(`Saved as ${vlabel(3)}`)).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.url === APPLY1)).toBe(true));
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    fireEvent.submit(submit.closest("form")!);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.filter((c) => c.method === "POST" && c.url === `/api/notes/${NOTE}/versions`)).toHaveLength(1);
    expect(calls.filter((c) => c.url === APPLY1)).toHaveLength(1);
    releaseApply();
    expect(await screen.findByText(`Applied ${vlabel(1)}`)).toBeInTheDocument();
  });

  it("a delete hitting 409 version_is_base -> an inline error inside the dialog and the dialog stays", async () => {
    stub((url, init) => {
      if (url === `/api/notes/${NOTE}/versions/1` && init?.method === "DELETE") return { status: 409, body: { error: { code: "version_is_base", message: "x" } } };
      return undefined;
    });
    renderDialogs();
    fireEvent.click(screen.getByText("h-delete"));
    const dialog = await screen.findByRole("dialog", { name: `Delete ${vlabel(1)}?` });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(i18n.t("errors.version_is_base"));
    expect(screen.getByRole("dialog", { name: `Delete ${vlabel(1)}?` })).toBeInTheDocument();
  });
});
