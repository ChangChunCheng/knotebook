import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRef, useState, type RefObject } from "react";
import { avatarUrl, type UserSuggestionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { UserEmailCombobox } from "./UserEmailCombobox";

const ANN: UserSuggestionDto = { userId: "u-ann", email: "ann@example.com", displayName: "Ann Example", avatar: null };
const ANDY: UserSuggestionDto = { userId: "u-andy", email: "andy@example.com", displayName: "Andy Example", avatar: null };

function suggestFetch(users: UserSuggestionDto[] = [ANN, ANDY]) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/users/suggest?")) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ users }) } as unknown as Response);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function Harness({ onSubmit, exclude, inDialog = false }: { onSubmit: (email: string) => void; exclude?: string[]; inDialog?: boolean }) {
  const [value, setValue] = useState("");
  const form = (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(value);
      }}
    >
      <UserEmailCombobox label="Email address" value={value} onChange={setValue} excludeUserIds={exclude} />
      <button type="submit">Add</button>
    </form>
  );
  if (!inDialog) return form;
  return (
    <Dialog open onOpenChange={() => onSubmit("__dialog_closed__")}>
      <DialogContent>
        <DialogTitle>Dialog</DialogTitle>
        <DialogDescription>desc</DialogDescription>
        {form}
      </DialogContent>
    </Dialog>
  );
}

/** The default harness disables retry; cases guarding `useUserSuggestions`' own `retry: false` pass `new QueryClient()` (retry left on). */
function renderHarness(
  props: Parameters<typeof Harness>[0],
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <Harness {...props} />
    </QueryClientProvider>,
  );
}

function input(): HTMLInputElement {
  return screen.getByRole("combobox", { name: "Email address" }) as HTMLInputElement;
}

async function typeAndWaitForList(text: string): Promise<HTMLElement> {
  fireEvent.change(input(), { target: { value: text } });
  return screen.findByRole("listbox", { name: "People you know" });
}

describe("UserEmailCombobox", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it(">= 2 characters and after the debounce before querying; rows show name + email; ARIA state", async () => {
    const fetchMock = suggestFetch();
    renderHarness({ onSubmit: vi.fn() });
    expect(input()).toHaveAttribute("aria-expanded", "false");

    fireEvent.change(input(), { target: { value: "a" } });
    await new Promise((r) => setTimeout(r, 300));
    expect(fetchMock).not.toHaveBeenCalled();

    const list = await typeAndWaitForList("an");
    expect(fetchMock).toHaveBeenCalledWith("/api/users/suggest?q=an", expect.anything());
    const options = within(list).getAllByRole("option");
    const expected = ["Ann Exampleann@example.com", "Andy Exampleandy@example.com"];
    expect(options).toHaveLength(expected.length);
    options.forEach((o, i) => expect(o).toHaveAccessibleName(expected[i]));
    expect(input()).toHaveAttribute("aria-expanded", "true");
    expect(input()).toHaveAttribute("aria-controls", list.id);
    expect(input()).not.toHaveAttribute("aria-activedescendant");
  });

  it("keyboard: Down/Up move (wrapping), Enter selects and fills the email without submitting the form", async () => {
    suggestFetch();
    const onSubmit = vi.fn();
    renderHarness({ onSubmit });
    const list = await typeAndWaitForList("an");
    const [first, second] = within(list).getAllByRole("option");

    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(input()).toHaveAttribute("aria-activedescendant", first!.id);
    expect(first).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(input()).toHaveAttribute("aria-activedescendant", second!.id);
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(input()).toHaveAttribute("aria-activedescendant", first!.id);
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(input()).toHaveAttribute("aria-activedescendant", second!.id);

    fireEvent.keyDown(input(), { key: "Enter" });
    expect(input()).toHaveValue("andy@example.com");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input()).toHaveAttribute("aria-expanded", "false");
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.submit(input().form!);
    expect(onSubmit).toHaveBeenCalledWith("andy@example.com");
  });

  it("clicking an option fills the email", async () => {
    suggestFetch();
    renderHarness({ onSubmit: vi.fn() });
    const list = await typeAndWaitForList("an");
    const option = within(list).getByRole("option", { name: /Ann Example/ });
    fireEvent.mouseDown(option);
    fireEvent.click(option);
    expect(input()).toHaveValue("ann@example.com");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("Enter does not intercept when nothing is highlighted: a fully typed email submits as usual", async () => {
    suggestFetch([]);
    const onSubmit = vi.fn();
    renderHarness({ onSubmit });
    fireEvent.change(input(), { target: { value: "someone@example.com" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.submit(input().form!);
    expect(onSubmit).toHaveBeenCalledWith("someone@example.com");
  });

  it("Esc closes the list but not the outer Dialog", async () => {
    suggestFetch();
    const onSubmit = vi.fn();
    renderHarness({ onSubmit, inDialog: true });
    await typeAndWaitForList("an");
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    // With the list already closed, Esc is left to the Dialog
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(onSubmit).toHaveBeenCalledWith("__dialog_closed__");
  });

  it("people in excludeUserIds are not listed", async () => {
    suggestFetch();
    renderHarness({ onSubmit: vi.fn(), exclude: [ANN.userId] });
    const list = await typeAndWaitForList("an");
    const options = within(list).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveAccessibleName("Andy Exampleandy@example.com");
  });

  it("query failure: no list, input stays usable, no retry (one request)", async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({ error: { code: "too_many_requests", message: "x" } }) } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);
    // Deliberately a QueryClient with retry left on: this guards `useUserSuggestions`' own `retry: false` (retrying a throttled request
    // only makes it worse). The component shows no error, so wait for the query itself to reach error; without `retry: false` query-core
    // retries 3 times by default (about 7s of backoff, which fits inside the global wait limit), so 4 requests would have been made by then and the count assertion fails.
    const queryClient = new QueryClient();
    renderHarness({ onSubmit: vi.fn() }, queryClient);
    fireEvent.change(input(), { target: { value: "an" } });
    // The empty-string query from mount (enabled false) is also in the cache and stays pending, so look for any query in error.
    const anyErrored = () => queryClient.getQueryCache().findAll({ queryKey: ["userSuggest"] }).some((q) => q.state.status === "error");
    await waitFor(() => expect(anyErrored()).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input()).toHaveValue("an");
  });
});

/**
 * Group add-member field (#331, several addresses): `multiple`; `locked` set = batch add running (readOnly).
 * `pasteAs`: like GroupMembersSection's handlePaste - prevents the default paste and sets the value outside (not through onChange).
 */
function MultiHarness({ inputRef, pasteAs }: { inputRef?: RefObject<HTMLInputElement | null>; pasteAs?: string }) {
  const [value, setValue] = useState("");
  const [locked, setLocked] = useState(false);
  return (
    <form onSubmit={(event) => event.preventDefault()}>
      <UserEmailCombobox
        ref={inputRef}
        multiple
        readOnly={locked}
        label="Email address"
        value={value}
        onChange={setValue}
        onPaste={
          pasteAs === undefined
            ? undefined
            : (event) => {
                event.preventDefault();
                setValue(pasteAs);
              }
        }
      />
      <label>
        <input type="checkbox" checked={locked} onChange={(event) => setLocked(event.target.checked)} />
        Lock
      </label>
    </form>
  );
}

function renderMulti(props: Parameters<typeof MultiHarness>[0] = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MultiHarness {...props} />
    </QueryClientProvider>,
  );
}

function typeAt(text: string, caret = text.length): void {
  fireEvent.change(input(), { target: { value: text, selectionStart: caret, selectionEnd: caret } });
}

describe("UserEmailCombobox multiple (group add-member field with several addresses)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("text + inputMode email (not type=email: native validation would reject several addresses); ref points at the input", () => {
    suggestFetch();
    const ref = createRef<HTMLInputElement>();
    renderMulti({ inputRef: ref });
    expect(input()).toHaveAttribute("type", "text");
    expect(input()).toHaveAttribute("inputmode", "email");
    expect(ref.current).toBe(input());
  });

  it("editing a middle address queries only the address at the caret; selecting replaces just that one without appending a separator and puts the caret after the separator", async () => {
    const fetchMock = suggestFetch();
    renderMulti();
    typeAt("a@x.com, an, c@y.com", "a@x.com, an".length);
    const list = await screen.findByRole("listbox", { name: "People you know" });
    expect(fetchMock).toHaveBeenCalledWith("/api/users/suggest?q=an", expect.anything());
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(["/api/users/suggest?q=an"]);
    const option = within(list).getByRole("option", { name: /Ann Example/ });
    fireEvent.mouseDown(option);
    fireEvent.click(option);
    expect(input()).toHaveValue("a@x.com, ann@example.com, c@y.com");
    expect(input().selectionStart).toBe("a@x.com, ann@example.com, ".length);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("full-width separators (U+FF0C, U+FF1B, U+3001 and U+3000) also count as boundaries; selecting at the last address appends \", \" and leaves the other addresses untouched", async () => {
    const fetchMock = suggestFetch();
    renderMulti();
    typeAt("a@x.com，b@y.com；c@z.com、d@w.com　an");
    await screen.findByRole("listbox", { name: "People you know" });
    expect(fetchMock).toHaveBeenCalledWith("/api/users/suggest?q=an", expect.anything());
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(input()).toHaveValue("a@x.com，b@y.com；c@z.com、d@w.com　ann@example.com, ");
    expect(input().selectionStart).toBe(input().value.length);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("after a selection, typing the next address queries only the new segment; addresses already in the field are not suggested again (case-insensitive)", async () => {
    const fetchMock = suggestFetch();
    renderMulti();
    typeAt("ANN@example.com, an");
    const list = await screen.findByRole("listbox", { name: "People you know" });
    expect(fetchMock).toHaveBeenCalledWith("/api/users/suggest?q=an", expect.anything());
    const options = within(list).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveAccessibleName("Andy Exampleandy@example.com");
  });

  it("caret on a separator (no address on either side): no query, list stays closed", async () => {
    const fetchMock = suggestFetch();
    renderMulti();
    typeAt("ann@example.com, ");
    await new Promise((r) => setTimeout(r, 300));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("readOnly (batch add running): an open list closes, Down and value changes do not open it, nothing can be selected", async () => {
    suggestFetch();
    renderMulti();
    typeAt("a@x.com, an");
    await screen.findByRole("listbox", { name: "People you know" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Lock" }));
    expect(input()).toHaveAttribute("readonly");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input()).toHaveAttribute("aria-expanded", "false");

    fireEvent.keyDown(input(), { key: "ArrowDown" });
    typeAt("a@x.com, and");
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(input()).toHaveValue("a@x.com, and");
  });

  it("moving the caret to another address closes the old address's list; Enter does not replace the address under the caret", async () => {
    suggestFetch();
    renderMulti();
    // React's onSelect must first see focusin (to record the active input); on later mouseup/keyup it compares the selection range for changes
    input().focus();
    fireEvent.focusIn(input());
    typeAt("bob@example.com, an");
    await screen.findByRole("listbox", { name: "People you know" });
    // Put the caret inside bob's address with mouseup: React only recomputes the selection on mouseup (an option's mousedown in earlier tests does not count)
    input().setSelectionRange(2, 2);
    fireEvent.mouseUp(input());
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(input()).toHaveValue("bob@example.com, an");
  });

  it("a paste handled by the outer component (default prevented, value set directly) closes the list", async () => {
    suggestFetch();
    renderMulti({ pasteAs: "a@x.com, b@y.com" });
    typeAt("an");
    await screen.findByRole("listbox", { name: "People you know" });
    fireEvent.paste(input(), { clipboardData: { getData: () => "a@x.com\nb@y.com" } });
    expect(input()).toHaveValue("a@x.com, b@y.com");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("selection that leaves the value unchanged (the selected address is the fully typed one and a separator already follows) moves the caret after the separator; typing on does not pull the caret back", async () => {
    suggestFetch();
    renderMulti();
    typeAt("ann@example.com, c@y.com", 2);
    const list = await screen.findByRole("listbox", { name: "People you know" });
    const option = within(list).getByRole("option", { name: /Ann Example/ });
    fireEvent.mouseDown(option);
    fireEvent.click(option);
    expect(input()).toHaveValue("ann@example.com, c@y.com");
    expect(input().selectionStart).toBe("ann@example.com, ".length);
    typeAt("ann@example.com, c@y.comx");
    expect(input().selectionStart).toBe("ann@example.com, c@y.comx".length);
  });

  it("Enter while an IME is composing does not select (left to the IME)", async () => {
    suggestFetch();
    renderMulti();
    typeAt("an");
    await screen.findByRole("listbox", { name: "People you know" });
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Enter", isComposing: true });
    expect(input()).toHaveValue("an");
    expect(screen.getByRole("listbox", { name: "People you know" })).toBeInTheDocument();
  });
});

describe("UserEmailCombobox option avatars", () => {
  const REF = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", v: 4 };

  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function firstOption(users: UserSuggestionDto[]): Promise<HTMLElement> {
    suggestFetch(users);
    renderHarness({ onSubmit: vi.fn() });
    const list = await typeAndWaitForList("an");
    return within(list).getAllByRole("option")[0]!;
  }

  it("with an avatar: the option starts with the image, src carries the version and is lazy, the wrapper is aria-hidden", async () => {
    const option = await firstOption([{ ...ANN, avatar: REF }]);
    const avatar = option.firstElementChild as HTMLElement;
    const img = avatar.querySelector("img");
    expect(img).toHaveAttribute("src", avatarUrl(REF.id, REF.v));
    expect(img).toHaveAttribute("loading", "lazy");
    expect(avatar).toHaveAttribute("aria-hidden", "true");
  });

  it("avatar null: initial letter and no img; the accessible name excludes the initial", async () => {
    const option = await firstOption([ANN]);
    const avatar = option.firstElementChild as HTMLElement;
    expect(avatar.querySelector("img")).toBeNull();
    expect(avatar.textContent).toBe("A");
    expect(screen.getByRole("option", { name: "Ann Exampleann@example.com" })).toBe(option);
  });

  it("old server without the avatar field: no error, shows the initial", async () => {
    const legacy = { ...ANN } as Record<string, unknown>;
    delete legacy.avatar;
    const option = await firstOption([legacy as unknown as UserSuggestionDto]);
    expect((option.firstElementChild as HTMLElement).textContent).toBe("A");
  });

  it("image load failure falls back to the initial", async () => {
    const option = await firstOption([{ ...ANN, avatar: REF }]);
    const avatar = option.firstElementChild as HTMLElement;
    fireEvent.error(avatar.querySelector("img")!);
    expect(avatar.querySelector("img")).toBeNull();
    expect(avatar.textContent).toBe("A");
  });
});
