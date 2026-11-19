import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { MAX_PROVIDER_ICON_SOURCE_BYTES, type AdminAuthProviderDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ADMIN_AUTH_PROVIDERS_QUERY_KEY } from "@/api/adminAuth";
import { AUTH_CONFIG_QUERY_KEY } from "@/api/authConfig";
import { clickOutside, settle } from "@/test/outside-click";
import { ProviderIconDialog } from "./ProviderIconDialog";

const ID = "44444444-4444-4444-8444-444444444444";
const BASE: AdminAuthProviderDto = {
  id: ID,
  template: "gitlab",
  displayName: "Corp GitLab",
  issuerUrl: "https://gitlab.example.com",
  clientId: "corp",
  hasSecret: true,
  enabled: true,
  autoCreateEnabled: false,
  sortOrder: 0,
  legacyCallback: false,
  callbackUrl: `https://notes.example.com/api/auth/oidc/callback/${ID}`,
  insecureIssuer: false,
  issuerResolved: true,
  createdAt: "2026-10-07T00:00:00.000Z",
  iconKind: "template",
  icon: { type: "builtin", name: "gitlab" },
};
const UPLOADED_URL = `/api/auth/providers/${ID}/icon?v=2`;
const UPLOADED: AdminAuthProviderDto = { ...BASE, iconKind: "upload", icon: { type: "upload", url: UPLOADED_URL } };
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fakeResponse(status: number, body?: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: body === undefined ? () => Promise.reject(new Error("no body")) : () => Promise.resolve(body) } as unknown as Response;
}

interface Call { method: string; url: string; body: unknown }

/** jsdom has no createImageBitmap or canvas: stub the globals and prototype so the **real** `resizeProviderIcon` runs (type / size checks and resizing all go through it). */
function stubDecoder(result: { width: number; height: number } | "fail") {
  const createImageBitmap = vi.fn(async () => {
    if (result === "fail") throw new Error("decode failed");
    return { ...result, close: vi.fn() } as unknown as ImageBitmap;
  });
  vi.stubGlobal("createImageBitmap", createImageBitmap);
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage, imageSmoothingQuality: "low" } as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb: BlobCallback) => cb(new Blob([PNG_MAGIC], { type: "image/png" })));
  return { createImageBitmap, drawImage };
}

const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

/** provider comes from useQuery (same wiring as the AdminAuthPage card): a mutation's invalidate updates the prop. */
function LiveDialog({ fallback }: { fallback: AdminAuthProviderDto }) {
  const { data } = useQuery({
    queryKey: ADMIN_AUTH_PROVIDERS_QUERY_KEY,
    queryFn: async () => (await (await fetch("/api/admin/auth/providers")).json()) as AdminAuthProviderDto[],
  });
  return <ProviderIconDialog provider={data?.[0] ?? fallback} />;
}

function setup(
  provider: AdminAuthProviderDto,
  respond: (call: Call) => Response | Promise<Response> = () => fakeResponse(200, provider),
  live = false,
) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { method: (init?.method ?? "GET").toUpperCase(), url: String(input), body: init?.body };
      calls.push(call);
      return respond(call);
    }),
  );
  let n = 0;
  const createObjectURL = vi.fn(() => `blob:icon-${++n}`);
  const revokeObjectURL = vi.fn();
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Both keys are put in the cache first (no observer): after success, invalidate marks them isInvalidated - removing onSuccess's invalidate turns this red.
  queryClient.setQueryData(ADMIN_AUTH_PROVIDERS_QUERY_KEY, [provider]);
  queryClient.setQueryData(AUTH_CONFIG_QUERY_KEY, { providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: true } });
  render(
    <QueryClientProvider client={queryClient}>{live ? <LiveDialog fallback={provider} /> : <ProviderIconDialog provider={provider} />}</QueryClientProvider>,
  );
  return { calls, queryClient, createObjectURL, revokeObjectURL };
}

async function openDialog(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "Icon" }));
  return screen.findByRole("dialog", { name: "Sign-in service icon" });
}
const radio = (dialog: HTMLElement, name: string) => within(dialog).getByRole("radio", { name });
const previewOf = (dialog: HTMLElement, name: string) => radio(dialog, name).closest("label")!.querySelector("[data-provider-icon]");
function chooseFile(dialog: HTMLElement, file: File): void {
  fireEvent.click(radio(dialog, "Upload an image"));
  fireEvent.change(dialog.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [file] } });
}
const pngFile = (bytes = 64) => new File([new Uint8Array(bytes)], "logo.png", { type: "image/png" });
const mutations = (calls: Call[]) => calls.filter(c => c.method !== "GET");

describe("ProviderIconDialog", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    // Unmount first (effect cleanup calls URL.revokeObjectURL) and then restore the stubs; in the reverse order, cases ending with picked non-null would throw a TypeError on unmount.
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  it("five options each have a preview; the initial selection = the current iconKind; the \"from template\" preview is the computed result (not the current icon)", async () => {
    // google template, currently GitLab logo selected: the from-template preview must be Google (using provider.icon as the preview would wrongly show GitLab).
    setup({ ...BASE, template: "google", iconKind: "gitlab", icon: { type: "builtin", name: "gitlab" } });
    const dialog = await openDialog();
    expect(radio(dialog, "GitLab logo")).toBeChecked();
    expect(previewOf(dialog, "Template default")).toHaveAttribute("data-provider-icon", "google");
    expect(previewOf(dialog, "GitLab logo")).toHaveAttribute("data-provider-icon", "gitlab");
    expect(previewOf(dialog, "Google logo")).toHaveAttribute("data-provider-icon", "google");
    expect(previewOf(dialog, "Upload an image")).toBeNull();
    expect(previewOf(dialog, "None")).toBeNull();
  });

  it("currently upload: \"Upload an image\" is selected and the preview is the DTO's uploaded image URL", async () => {
    setup(UPLOADED);
    const dialog = await openDialog();
    expect(radio(dialog, "Upload an image")).toBeChecked();
    expect(previewOf(dialog, "Upload an image")).toHaveAttribute("src", UPLOADED_URL);
  });

  it("clicking outside doesn't close (clickOutside); Esc closes", async () => {
    setup(BASE);
    const dialog = await openDialog();
    await clickOutside();
    expect(dialog).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("saving another option -> PATCH {iconKind}, closes, invalidates admin-auth and auth-config", async () => {
    const { calls, queryClient } = setup(BASE);
    const dialog = await openDialog();
    fireEvent.click(radio(dialog, "None"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mutations(calls)).toEqual([{ method: "PATCH", url: `/api/admin/auth/providers/${ID}`, body: JSON.stringify({ iconKind: "none" }) }]);
    expect(queryClient.getQueryState(ADMIN_AUTH_PROVIDERS_QUERY_KEY)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(AUTH_CONFIG_QUERY_KEY)?.isInvalidated).toBe(true);
  });

  it("choosing upload + a file really goes through resizing (512x256 drawn as 128x64) and the preview becomes blob:; save -> PUT FormData (file = icon.png, image/png), closes, invalidates", async () => {
    const { createImageBitmap, drawImage } = stubDecoder({ width: 512, height: 256 });
    const { calls, queryClient } = setup(BASE);
    const dialog = await openDialog();
    chooseFile(dialog, pngFile());
    // Wait point: the preview becoming blob: happens only after resizing finishes.
    await waitFor(() => expect(previewOf(dialog, "Upload an image")).toHaveAttribute("src", "blob:icon-1"));
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 128, 64);
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const [put] = mutations(calls);
    expect(put).toMatchObject({ method: "PUT", url: `/api/admin/auth/providers/${ID}/icon` });
    expect(put!.body).toBeInstanceOf(FormData);
    const file = (put!.body as FormData).get("file") as File;
    expect(file.name).toBe("icon.png");
    expect(file.type).toBe("image/png");
    // What is uploaded is the resized result (the stub toBlob returns 8 bytes), not the 64-byte original file.
    expect(file.size).toBe(PNG_MAGIC.length);
    expect(mutations(calls)).toHaveLength(1);
    expect(queryClient.getQueryState(ADMIN_AUTH_PROVIDERS_QUERY_KEY)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(AUTH_CONFIG_QUERY_KEY)?.isInvalidated).toBe(true);
  });

  it("failure -> role=alert in the dialog shows errors.<code>, stays open, can be pressed again", async () => {
    setup(BASE, () => fakeResponse(400, { error: { code: "invalid_body", message: "Invalid request body." } }));
    const dialog = await openDialog();
    fireEvent.click(radio(dialog, "Google logo"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(i18n.t("errors.invalid_body"));
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("upload failure (PUT 413 / 415) -> role=alert in the dialog shows errors.<code>, stays open, no invalidate", async () => {
    for (const [status, code] of [
      [413, "file_too_large"],
      [415, "unsupported_media_type"],
    ] as const) {
      stubDecoder({ width: 64, height: 64 });
      const { calls, queryClient } = setup(BASE, call =>
        call.method === "PUT" ? fakeResponse(status, { error: { code, message: "x" } }) : fakeResponse(200, BASE),
      );
      const dialog = await openDialog();
      chooseFile(dialog, pngFile());
      await waitFor(() => expect(previewOf(dialog, "Upload an image")).toHaveAttribute("src", "blob:icon-1"));
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
      // Wait point: the alert only appears after the PUT returns and catch has run.
      expect(await within(dialog).findByRole("alert"), code).toHaveTextContent(i18n.t(`errors.${code}`));
      expect(screen.getByRole("dialog"), code).toBe(dialog);
      expect(mutations(calls), code).toMatchObject([{ method: "PUT", url: `/api/admin/auth/providers/${ID}/icon` }]);
      expect(queryClient.getQueryState(ADMIN_AUTH_PROVIDERS_QUERY_KEY)?.isInvalidated, code).toBe(false);
      expect(queryClient.getQueryState(AUTH_CONFIG_QUERY_KEY)?.isInvalidated, code).toBe(false);
      cleanupDialog();
    }
  });

  it("while submitting: save button disabled, text Saving...", async () => {
    setup(BASE, () => new Promise<Response>(() => {}));
    const dialog = await openDialog();
    fireEvent.click(radio(dialog, "None"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    const saving = await within(dialog).findByRole("button", { name: "Saving…" });
    expect(saving).toBeDisabled();
  });

  it("closing releases the resized blob: via revokeObjectURL", async () => {
    stubDecoder({ width: 64, height: 64 });
    const { revokeObjectURL } = setup(BASE);
    const dialog = await openDialog();
    chooseFile(dialog, pngFile());
    await waitFor(() => expect(previewOf(dialog, "Upload an image")).toHaveAttribute("src", "blob:icon-1"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:icon-1"));
  });

  it("choosing GIF / SVG -> only-PNG/JPEG/WebP message, no decode, save disabled, no request", async () => {
    for (const type of ["image/gif", "image/svg+xml"]) {
      const { createImageBitmap } = stubDecoder({ width: 10, height: 10 });
      const { calls } = setup(BASE);
      const dialog = await openDialog();
      chooseFile(dialog, new File([new Uint8Array(8)], "x", { type }));
      expect(await within(dialog).findByRole("alert"), type).toHaveTextContent("Only PNG, JPEG and WebP images are accepted.");
      expect(createImageBitmap, type).not.toHaveBeenCalled();
      expect(within(dialog).getByRole("button", { name: "Save" }), type).toBeDisabled();
      expect(mutations(calls), type).toEqual([]);
      cleanupDialog();
    }
  });

  it("image over 5 MB -> size-limit message, no decode, no request", async () => {
    const { createImageBitmap } = stubDecoder({ width: 10, height: 10 });
    const { calls } = setup(BASE);
    const dialog = await openDialog();
    chooseFile(dialog, new File([new Uint8Array(MAX_PROVIDER_ICON_SOURCE_BYTES + 1)], "big.png", { type: "image/png" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The image must be 5 MB or smaller.");
    expect(createImageBitmap).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(mutations(calls)).toEqual([]);
  });

  it("decode failure -> \"can't read this image\" message, no request; choosing a good one and then a bad one -> the previous preview is cleared and save is disabled", async () => {
    stubDecoder({ width: 64, height: 64 });
    const { calls } = setup(BASE);
    const dialog = await openDialog();
    chooseFile(dialog, pngFile());
    await waitFor(() => expect(previewOf(dialog, "Upload an image")).toHaveAttribute("src", "blob:icon-1"));
    stubDecoder("fail");
    fireEvent.change(dialog.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [pngFile(32)] } });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("This image can't be read.");
    expect(previewOf(dialog, "Upload an image")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(mutations(calls)).toEqual([]);
  });

  it("no change then save -> closes, no request; currently upload with no new file -> save is clickable, closes, no request", async () => {
    for (const provider of [BASE, UPLOADED]) {
      const { calls } = setup(provider);
      const dialog = await openDialog();
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
      // Wait point: the dialog closing = handleSave has finished.
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(mutations(calls), provider.iconKind).toEqual([]);
      cleanupDialog();
    }
  });

  it("choosing upload, currently not upload, no file chosen yet -> save disabled", async () => {
    setup(BASE);
    const dialog = await openDialog();
    fireEvent.click(radio(dialog, "Upload an image"));
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Choose image…" })).toBeEnabled();
  });

  it("race: choose a file, cancel before resizing finishes -> reopen -> resizing then finishes: the stale result is discarded (no preview, no blob: created), save is disabled for the upload option with no file chosen, no PUT", async () => {
    const { drawImage } = stubDecoder({ width: 64, height: 64 });
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        await gate;
        return { width: 64, height: 64, close: vi.fn() } as unknown as ImageBitmap;
      }),
    );
    const { calls, createObjectURL } = setup(BASE);
    let dialog = await openDialog();
    chooseFile(dialog, pngFile());
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    dialog = await openDialog();
    release();
    // Wait point: drawImage called = the old resize really finished decoding; then let the awaits after toBlob and the React update run through.
    await waitFor(() => expect(drawImage).toHaveBeenCalledTimes(1));
    await settle();
    expect(createObjectURL).not.toHaveBeenCalled();
    fireEvent.click(radio(dialog, "Upload an image"));
    expect(previewOf(dialog, "Upload an image")).toBeNull();
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Choose image…" })).toBeEnabled();
    expect(mutations(calls)).toEqual([]);
  });

  it("choose upload and a file, or hit an error -> cancel -> reopen: selection returns to the current iconKind, no old preview, no old error; Save sends no request", async () => {
    stubDecoder({ width: 64, height: 64 });
    const { calls } = setup(BASE);
    let dialog = await openDialog();
    chooseFile(dialog, pngFile());
    await waitFor(() => expect(previewOf(dialog, "Upload an image")).toHaveAttribute("src", "blob:icon-1"));
    chooseFile(dialog, new File([new Uint8Array(8)], "x.gif", { type: "image/gif" }));
    await within(dialog).findByRole("alert");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    dialog = await openDialog();
    expect(radio(dialog, "Template default")).toBeChecked();
    expect(previewOf(dialog, "Upload an image")).toBeNull();
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mutations(calls)).toEqual([]);
  });
  it("while the upload is saving: Cancel disabled, Esc and the top-right X can't close; closes only after the PUT returns and the list refetch finishes; reopened with Upload selected, pressing Save sends no request", async () => {
    stubDecoder({ width: 64, height: 64 });
    let releasePut!: () => void;
    const putGate = new Promise<void>(resolve => {
      releasePut = resolve;
    });
    let releaseGet!: () => void;
    const getGate = new Promise<void>(resolve => {
      releaseGet = resolve;
    });
    let putDone = false;
    // provider is supplied by useQuery (wired like the card): after the PUT succeeds the invalidate refetches the upload version, and this GET is delayed by getGate.
    const { calls } = setup(
      BASE,
      async call => {
        if (call.method === "PUT") {
          await putGate;
          putDone = true;
          return fakeResponse(200, UPLOADED);
        }
        if (putDone) await getGate;
        return fakeResponse(200, putDone ? [UPLOADED] : [BASE]);
      },
      true,
    );
    const dialog = await openDialog();
    chooseFile(dialog, pngFile());
    await waitFor(() => expect(previewOf(dialog, "Upload an image")).toHaveAttribute("src", "blob:icon-1"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mutations(calls)).toHaveLength(1));
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect(cancel).toBeDisabled();
    fireEvent.click(cancel);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await settle();
    expect(screen.getByRole("dialog")).toBe(dialog);

    releasePut();
    await waitFor(() => expect(calls.filter(c => c.method === "GET" && putDone).length).toBeGreaterThan(0));
    await settle();
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByRole("button", { name: "Saving…" })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await settle();
    expect(screen.getByRole("dialog")).toBe(dialog);

    releaseGet();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // Reopened: the list is already the upload version and Upload is selected; pressing Save with nothing touched -> no request, closes (guards against sending a PATCH that would clear the just-uploaded image).
    const reopened = await openDialog();
    expect(radio(reopened, "Upload an image")).toBeChecked();
    const afterOpen = calls.length;
    fireEvent.click(within(reopened).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.length).toBe(afterOpen);
    expect(mutations(calls).map(c => c.method)).toEqual(["PUT"]);
  });

  it("while the PATCH is saving: Cancel disabled, Esc and the top-right X can't close; closes only after the PATCH returns", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const { calls } = setup(BASE, async call => {
      if (call.method === "PATCH") await gate;
      return fakeResponse(200, BASE);
    });
    const dialog = await openDialog();
    fireEvent.click(radio(dialog, "None"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mutations(calls)).toHaveLength(1));
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await settle();
    expect(screen.getByRole("dialog")).toBe(dialog);
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

/** In looped cases unmount the previous round before each re-render (testing-library's automatic cleanup only runs in afterEach). */
function cleanupDialog(): void {
  cleanup();
  vi.restoreAllMocks();
}
