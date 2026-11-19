import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { formatBytes, type AvatarCandidateDto, type AvatarCropUpload } from "@knotebook/shared";
import i18n from "@/i18n";
import { AVATARS_QUERY_KEY } from "@/api/avatars";
import { AUTH_CONFIG_QUERY_KEY } from "@/api/authConfig";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import * as encode from "@/avatars/encode";
import { configureFiller, enqueueFill, resetFiller } from "@/avatars/display-filler";
import { settle } from "@/test/outside-click";
import { AvatarCropDialog } from "./AvatarCropDialog";

// jsdom has no canvas or createImageBitmap: the encoding module is replaced by a stand-in (real encoding is covered by e2e).
vi.mock("@/avatars/encode", () => ({
  decodeImage: vi.fn(),
  renderDisplay: vi.fn(),
}));

const MAX_UPLOAD = 10 * 1024 * 1024;
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

function candidate(over: Partial<AvatarCandidateDto> = {}): AvatarCandidateDto {
  return {
    id: ID,
    source: "upload",
    providerName: null,
    avatar: { id: ID, v: 3 },
    pending: false,
    current: false,
    crop: { x: 100, y: 0, size: 200 },
    originalWidth: 600,
    originalHeight: 400,
    originalSize: 1000,
    displaySize: 500,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { "content-type": "application/json" },
  });
}

// The original-image response uses bytes as the body, not `new Blob(...)`: the test's global Blob is jsdom's, which Node's built-in Response
// doesn't recognize - Node 22 throws "object.stream is not a function" on construction, Node 24 turns it into the string "[object Blob]",
// and neither puts the original image bytes into the response.
const ORIGINAL_BYTES = [137, 80, 78, 71, 13, 10, 26, 10];
function originalResponse(): Response {
  return new Response(new Uint8Array(ORIGINAL_BYTES), { headers: { "content-type": "image/png" } });
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
const closeBitmap = vi.fn();

// jsdom has no PointerEvent: add a MouseEvent carrying pointerId so clientX / clientY and pointerId get through.
class FakePointerEvent extends MouseEvent {
  pointerId: number;
  constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}

function setup(
  source: Parameters<typeof AvatarCropDialog>[0]["source"],
  respond: (call: Call) => Response | Promise<Response> = () => json(200, candidate()),
  opts: { maxUploadBytes?: number } = { maxUploadBytes: MAX_UPLOAD },
) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { method: (init?.method ?? "GET").toUpperCase(), url: String(input), body: init?.body };
      if (call.url === "/api/auth/config") return json(200, { providers: [], maxUploadBytes: opts.maxUploadBytes });
      calls.push(call);
      return respond(call);
    }),
  );
  let n = 0;
  const createObjectURL = vi.fn(() => `blob:crop-${++n}`);
  const revokeObjectURL = vi.fn();
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(AVATARS_QUERY_KEY, { candidates: [], auto: false, refreshable: [] });
  queryClient.setQueryData(AUTH_CONFIG_QUERY_KEY, { providers: [], maxUploadBytes: opts.maxUploadBytes });
  const onOpenChange = vi.fn();
  const onSaved = vi.fn();
  const tree = (open: boolean, current = source) => (
    <QueryClientProvider client={queryClient}>
      <AvatarCropDialog open={open} source={current} onOpenChange={onOpenChange} onSaved={onSaved} />
      <Toaster />
    </QueryClientProvider>
  );
  const view = render(tree(true));
  return { calls, queryClient, onOpenChange, onSaved, createObjectURL, revokeObjectURL, view, tree };
}

const newFile = () => ({ kind: "new", file: new File([new Uint8Array(8)], "alice.png", { type: "image/png" }) }) as const;

/** jsdom doesn't load blob: URLs; set the natural size by hand and fire load. */
async function loadImage(dialog: HTMLElement, width = 600, height = 400): Promise<HTMLImageElement> {
  const img = await waitFor(() => {
    const el = dialog.querySelector("img");
    expect(el).not.toBeNull();
    return el as HTMLImageElement;
  });
  Object.defineProperty(img, "naturalWidth", { configurable: true, value: width });
  Object.defineProperty(img, "naturalHeight", { configurable: true, value: height });
  fireEvent.load(img);
  return img;
}

async function openLoaded(source: Parameters<typeof setup>[0] = newFile(), respond?: Parameters<typeof setup>[1], opts?: Parameters<typeof setup>[2]) {
  const ctx = setup(source, respond, opts);
  const dialog = await screen.findByRole("dialog", { name: "Adjust picture" });
  const img = await loadImage(dialog);
  return { ...ctx, dialog, img };
}

const px = (value: string) => Number.parseFloat(value);
const left = (img: HTMLElement) => px(img.style.left);
const top = (img: HTMLElement) => px(img.style.top);
const width = (img: HTMLElement) => px(img.style.width);
const cropArea = (dialog: HTMLElement) => within(dialog).getByRole("application");
const slider = (dialog: HTMLElement) => within(dialog).getByRole("slider", { name: "Zoom" }) as HTMLInputElement;
const saveButton = (dialog: HTMLElement) => within(dialog).getByRole("button", { name: /^(Save|Uploading…)$/ });
const mutations = (calls: Call[]) => calls.filter(c => c.method !== "GET");

describe("AvatarCropDialog", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.stubGlobal("PointerEvent", FakePointerEvent);
    vi.mocked(encode.decodeImage).mockResolvedValue({ width: 600, height: 400, close: closeBitmap } as unknown as ImageBitmap);
    vi.mocked(encode.renderDisplay).mockResolvedValue(new Blob([new Uint8Array(4)], { type: "image/webp" }));
  });
  afterEach(() => {
    cleanup();
    dismissAllToasts();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  describe("opening and accessible names", () => {
    it("dialog has a name and description; the crop area is role application with an aria-roledescription; the slider is named \"Zoom\"", async () => {
      const { dialog } = await openLoaded();
      expect(dialog).toHaveAccessibleDescription("Drag to move. Use the slider or scroll to zoom.");
      const area = cropArea(dialog);
      expect(area).toHaveAttribute("aria-roledescription", "Crop area");
      expect(area).toHaveAttribute("tabindex", "0");
      expect(slider(dialog)).toBeInTheDocument();
    });

    it("after opening, focus is on the crop area (keyboard users needn't Tab first)", async () => {
      const { dialog } = await openLoaded();
      await settle();
      expect(cropArea(dialog)).toHaveFocus();
    });

    it("zh-TW name and description", async () => {
      await i18n.changeLanguage("zh-TW");
      setup(newFile());
      const dialog = await screen.findByRole("dialog", { name: "調整頭貼" });
      expect(within(dialog).getByRole("application")).toHaveAttribute("aria-roledescription", "裁切區域");
      expect(within(dialog).getByRole("slider", { name: "縮放" })).toBeInTheDocument();
    });

    it("Save is disabled before the image loads, enabled after", async () => {
      setup(newFile());
      const dialog = await screen.findByRole("dialog", { name: "Adjust picture" });
      expect(saveButton(dialog)).toBeDisabled();
      expect(slider(dialog)).toBeDisabled();
      await loadImage(dialog);
      expect(saveButton(dialog)).toBeEnabled();
    });

    it("initial value: new file centered at minimum zoom (600x400 in a 280 viewport: scale 0.7)", async () => {
      const { img } = await openLoaded();
      expect(width(img)).toBeCloseTo(420);
      expect(left(img)).toBeCloseTo(-70);
      expect(top(img)).toBeCloseTo(0);
    });

    it("initial value: an existing candidate uses its crop (size 200 -> scale 1.4, x 100 -> left -140)", async () => {
      const { img } = await openLoaded({ kind: "existing", candidate: candidate() }, ({ url }) =>
        url.endsWith("/original") ? originalResponse() : json(200, candidate()),
      );
      expect(width(img)).toBeCloseTo(840);
      expect(left(img)).toBeCloseTo(-140);
      expect(top(img)).toBeCloseTo(0);
    });
  });

  describe("keyboard", () => {
    // Zoom 1.4 first so both axes have room to move (image 840x560).
    async function zoomedIn() {
      const ctx = await openLoaded();
      fireEvent.change(slider(ctx.dialog), { target: { value: "1.4" } });
      return ctx;
    }

    it("arrow keys move 10 px, Shift moves 50 px (the image follows the arrow keys)", async () => {
      const { dialog, img } = await zoomedIn();
      const area = cropArea(dialog);
      const x0 = left(img);
      const y0 = top(img);
      fireEvent.keyDown(area, { key: "ArrowLeft" });
      expect(left(img)).toBeCloseTo(x0 - 10);
      fireEvent.keyDown(area, { key: "ArrowRight", shiftKey: true });
      expect(left(img)).toBeCloseTo(x0 - 10 + 50);
      fireEvent.keyDown(area, { key: "ArrowUp" });
      expect(top(img)).toBeCloseTo(y0 - 10);
      fireEvent.keyDown(area, { key: "ArrowDown", shiftKey: true });
      expect(top(img)).toBeCloseTo(y0 - 10 + 50);
    });

    it("movement is clamped: the image never leaves the viewport (top-left <= 0, bottom-right >= viewport)", async () => {
      const { dialog, img } = await zoomedIn();
      const area = cropArea(dialog);
      for (let i = 0; i < 40; i++) fireEvent.keyDown(area, { key: "ArrowRight", shiftKey: true });
      expect(left(img)).toBe(0);
      for (let i = 0; i < 40; i++) fireEvent.keyDown(area, { key: "ArrowLeft", shiftKey: true });
      expect(left(img)).toBeCloseTo(280 - 840);
      for (let i = 0; i < 40; i++) fireEvent.keyDown(area, { key: "ArrowUp", shiftKey: true });
      expect(top(img)).toBeCloseTo(280 - 560);
      for (let i = 0; i < 40; i++) fireEvent.keyDown(area, { key: "ArrowDown", shiftKey: true });
      expect(top(img)).toBe(0);
    });

    it("+ / - change zoom one step, clamped to the limits (600x400: 0.7 to 4)", async () => {
      const { dialog, img } = await openLoaded();
      const area = cropArea(dialog);
      const w0 = width(img);
      fireEvent.keyDown(area, { key: "+" });
      expect(width(img)).toBeGreaterThan(w0);
      fireEvent.keyDown(area, { key: "-" });
      expect(width(img)).toBeCloseTo(w0);
      for (let i = 0; i < 5; i++) fireEvent.keyDown(area, { key: "-" });
      expect(width(img)).toBeCloseTo(420); // Minimum zoom: the short side exactly fills the viewport
      for (let i = 0; i < 40; i++) fireEvent.keyDown(area, { key: "+" });
      expect(width(img)).toBeCloseTo(2400); // 4 × 600
      expect(Number(slider(dialog).value)).toBeCloseTo(4);
    });

    it("=, - and arrow keys with Ctrl / Cmd / Alt aren't intercepted (browser page zoom works as usual); = without a modifier is intercepted", async () => {
      const { dialog, img } = await zoomedIn();
      const area = cropArea(dialog);
      const w0 = width(img);
      const x0 = left(img);
      for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
        expect(fireEvent.keyDown(area, { key: "=", ...mod })).toBe(true);
        expect(fireEvent.keyDown(area, { key: "-", ...mod })).toBe(true);
        expect(fireEvent.keyDown(area, { key: "0", ...mod })).toBe(true);
        expect(fireEvent.keyDown(area, { key: "ArrowLeft", ...mod })).toBe(true);
      }
      expect(width(img)).toBeCloseTo(w0);
      expect(left(img)).toBeCloseTo(x0);
      expect(fireEvent.keyDown(area, { key: "=" })).toBe(false);
      expect(width(img)).toBeGreaterThan(w0);
    });

    it("arrow keys don't move the image while the slider has focus (the event is handled only by the crop area)", async () => {
      const { dialog, img } = await zoomedIn();
      const x0 = left(img);
      fireEvent.keyDown(slider(dialog), { key: "ArrowLeft" });
      expect(left(img)).toBeCloseTo(x0);
    });
  });

  describe("slider, wheel, drag", () => {
    it("slider changes zoom", async () => {
      const { dialog, img } = await openLoaded();
      fireEvent.change(slider(dialog), { target: { value: "1.4" } });
      expect(width(img)).toBeCloseTo(840);
    });

    it("slider range = zoom limits", async () => {
      const { dialog } = await openLoaded();
      expect(Number(slider(dialog).min)).toBeCloseTo(0.7);
      expect(Number(slider(dialog).max)).toBeCloseTo(4);
    });

    it("wheel up zooms in, wheel down zooms out", async () => {
      const { dialog, img } = await openLoaded();
      const area = cropArea(dialog);
      const w0 = width(img);
      fireEvent.wheel(area, { deltaY: -100 });
      const w1 = width(img);
      expect(w1).toBeGreaterThan(w0);
      fireEvent.wheel(area, { deltaY: 100 });
      expect(width(img)).toBeCloseTo(w0);
    });

    it("the wheel event is preventDefault'ed (the page behind doesn't scroll)", async () => {
      const { dialog } = await openLoaded();
      const event = new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true });
      cropArea(dialog).dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });

    it("single-finger drag pans (the image follows the finger) and stops moving after release", async () => {
      const { dialog, img } = await openLoaded();
      const area = cropArea(dialog);
      const x0 = left(img);
      fireEvent.pointerDown(area, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(area, { pointerId: 1, clientX: 90, clientY: 100 });
      expect(left(img)).toBeCloseTo(x0 - 10);
      fireEvent.pointerMove(area, { pointerId: 1, clientX: 60, clientY: 100 });
      expect(left(img)).toBeCloseTo(x0 - 40);
      fireEvent.pointerUp(area, { pointerId: 1, clientX: 60, clientY: 100 });
      fireEvent.pointerMove(area, { pointerId: 1, clientX: 20, clientY: 100 });
      expect(left(img)).toBeCloseTo(x0 - 40);
    });

    it("drag is clamped", async () => {
      const { dialog, img } = await openLoaded();
      const area = cropArea(dialog);
      fireEvent.pointerDown(area, { pointerId: 1, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(area, { pointerId: 1, clientX: 1000, clientY: 1000 });
      expect(left(img)).toBe(0);
      expect(top(img)).toBe(0);
    });

    it("two-finger pinch zooms in", async () => {
      const { dialog, img } = await openLoaded();
      const area = cropArea(dialog);
      const w0 = width(img);
      fireEvent.pointerDown(area, { pointerId: 1, clientX: 100, clientY: 140 });
      fireEvent.pointerDown(area, { pointerId: 2, clientX: 180, clientY: 140 });
      fireEvent.pointerMove(area, { pointerId: 2, clientX: 260, clientY: 140 });
      expect(width(img)).toBeGreaterThan(w0);
    });
  });

  describe("save", () => {
    it("new file: POST /api/auth/avatars with original, display and crop (integers)", async () => {
      const { dialog, calls, onSaved, onOpenChange } = await openLoaded();
      fireEvent.click(saveButton(dialog));
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      const [call] = mutations(calls);
      expect(call).toMatchObject({ method: "POST", url: "/api/auth/avatars" });
      const form = call!.body as FormData;
      expect((form.get("original") as File).name).toBe("alice.png");
      expect((form.get("display") as File).name).toBe("display.webp");
      const crop = JSON.parse(form.get("crop") as string) as Record<string, number>;
      expect(crop).toEqual({ x: 100, y: 0, size: 400, width: 600, height: 400 } satisfies AvatarCropUpload);
      for (const v of Object.values(crop)) expect(Number.isInteger(v)).toBe(true);
      expect(vi.mocked(encode.renderDisplay)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(encode.renderDisplay).mock.calls[0]![1]).toEqual({ x: 100, y: 0, size: 400 });
      expect(closeBitmap).toHaveBeenCalledTimes(1);
      expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: ID }));
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    });

    it("crop follows zoom and drag (integers, inside the image)", async () => {
      const { dialog, calls, onSaved } = await openLoaded();
      fireEvent.change(slider(dialog), { target: { value: "1.4" } }); // size 200
      fireEvent.keyDown(cropArea(dialog), { key: "ArrowRight", shiftKey: true });
      fireEvent.click(saveButton(dialog));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      const crop = JSON.parse((mutations(calls)[0]!.body as FormData).get("crop") as string) as { x: number; y: number; size: number };
      expect(crop.size).toBe(200);
      expect(crop.x + crop.size).toBeLessThanOrEqual(600);
      expect(crop.y + crop.size).toBeLessThanOrEqual(400);
      for (const v of Object.values(crop)) expect(Number.isInteger(v)).toBe(true);
    });

    it("adjusting an existing candidate: fetch the original first, PUT /api/auth/avatars/:id/display with version, without original", async () => {
      const { dialog, calls, onSaved } = await openLoaded({ kind: "existing", candidate: candidate() }, ({ url }) =>
        url.endsWith("/original") ? originalResponse() : json(200, candidate()),
      );
      expect(calls[0]).toMatchObject({ method: "GET", url: `/api/auth/avatars/${ID}/original` });
      fireEvent.click(saveButton(dialog));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      const [call] = mutations(calls);
      expect(call).toMatchObject({ method: "PUT", url: `/api/auth/avatars/${ID}/display` });
      const form = call!.body as FormData;
      expect(form.get("version")).toBe("3");
      expect(form.get("original")).toBeNull();
      expect(JSON.parse(form.get("crop") as string)).toEqual({ x: 100, y: 0, size: 200, width: 600, height: 400 } satisfies AvatarCropUpload);
      const decoded = vi.mocked(encode.decodeImage).mock.calls[0]![0];
      expect(decoded.type).toBe("image/png");
      expect(Array.from(new Uint8Array(await decoded.arrayBuffer()))).toEqual(ORIGINAL_BYTES);
    });

    it("adjusting an existing candidate: the submitted version is the one at the time the original was fetched, unchanged even if props change to a newer version later (on avatar_outdated the server's reply closes the dialog through the existing flow)", async () => {
      const respond = ({ url, method }: Call) => {
        if (url.endsWith("/original")) return originalResponse();
        return method === "PUT" ? json(409, { error: { code: "avatar_outdated", message: "x" } }) : json(200, candidate());
      };
      const ctx = await openLoaded({ kind: "existing", candidate: candidate() }, respond);
      ctx.view.rerender(ctx.tree(true, { kind: "existing", candidate: candidate({ avatar: { id: ID, v: 4 } }) }));
      fireEvent.click(saveButton(ctx.dialog));
      await waitFor(() => expect(ctx.onOpenChange).toHaveBeenCalledWith(false));
      const [call] = mutations(ctx.calls);
      expect((call!.body as FormData).get("version")).toBe("3");
    });

    it("while uploading: button disabled and shows \"Uploading...\", Esc and cancel can't close; closes after completion", async () => {
      let release: (r: Response) => void = () => {};
      const pending = new Promise<Response>(resolve => (release = resolve));
      const { dialog, onOpenChange, calls } = await openLoaded(newFile(), () => pending);
      fireEvent.click(saveButton(dialog));
      await waitFor(() => expect(mutations(calls)).toHaveLength(1));
      const busy = within(dialog).getByRole("button", { name: "Uploading…" });
      expect(busy).toBeDisabled();
      expect(slider(dialog)).toBeDisabled();
      expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
      fireEvent.keyDown(dialog, { key: "Escape" });
      await settle();
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog", { name: "Adjust picture" })).toBeInTheDocument();
      await act(async () => {
        release(json(200, candidate()));
      });
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    });

    it("clicking X while uploading can't close either; Esc closes when nothing is uploading", async () => {
      let release: (r: Response) => void = () => {};
      const pending = new Promise<Response>(resolve => (release = resolve));
      const { dialog, onOpenChange, calls } = await openLoaded(newFile(), () => pending);
      fireEvent.click(saveButton(dialog));
      await waitFor(() => expect(mutations(calls)).toHaveLength(1));
      fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
      await settle();
      expect(onOpenChange).not.toHaveBeenCalled();
      await act(async () => {
        release(json(200, candidate()));
      });
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
      onOpenChange.mockClear();
      fireEvent.keyDown(dialog, { key: "Escape" });
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    });
  });

  describe("while uploading", () => {
    it("the crop area can't move or zoom: keyboard, drag and wheel all do nothing; what is submitted is the crop at the moment Save was pressed", async () => {
      let release: (r: Response) => void = () => {};
      const pending = new Promise<Response>(resolve => (release = resolve));
      const { dialog, calls, img } = await openLoaded(newFile(), () => pending);
      const area = cropArea(dialog);
      fireEvent.change(slider(dialog), { target: { value: "1.4" } });
      fireEvent.click(saveButton(dialog));
      await waitFor(() => expect(mutations(calls)).toHaveLength(1));
      const w0 = width(img);
      const x0 = left(img);
      const y0 = top(img);
      fireEvent.keyDown(area, { key: "ArrowLeft", shiftKey: true });
      fireEvent.keyDown(area, { key: "+" });
      fireEvent.pointerDown(area, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(area, { pointerId: 1, clientX: 60, clientY: 80 });
      fireEvent.wheel(area, { deltaY: -200 });
      expect(left(img)).toBeCloseTo(x0);
      expect(top(img)).toBeCloseTo(y0);
      expect(width(img)).toBeCloseTo(w0);
      await act(async () => {
        release(json(200, candidate()));
      });
    });
  });

  describe("while uploading (drag already started)", () => {
    it("hold and drag first, then start the upload: later pointermove events no longer move the crop", async () => {
      let release: (r: Response) => void = () => {};
      const pending = new Promise<Response>(resolve => (release = resolve));
      const { dialog, calls, img } = await openLoaded(newFile(), () => pending);
      const area = cropArea(dialog);
      fireEvent.change(slider(dialog), { target: { value: "1.4" } });
      fireEvent.pointerDown(area, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.click(saveButton(dialog));
      await waitFor(() => expect(mutations(calls)).toHaveLength(1));
      const x0 = left(img);
      const y0 = top(img);
      fireEvent.pointerMove(area, { pointerId: 1, clientX: 60, clientY: 80 });
      expect(left(img)).toBeCloseTo(x0);
      expect(top(img)).toBeCloseTo(y0);
      await act(async () => {
        release(json(200, candidate()));
      });
    });
  });

  describe("viewport size change", () => {
    function fakeObserver() {
      const callbacks: Array<() => void> = [];
      const disconnect = vi.fn();
      class FakeResizeObserver {
        constructor(cb: () => void) {
          callbacks.push(cb);
        }
        observe() {}
        unobserve() {}
        disconnect = disconnect;
      }
      vi.stubGlobal("ResizeObserver", FakeResizeObserver);
      return { callbacks, disconnect };
    }

    it("the box grows with zoom already at the maximum: crop center unchanged", async () => {
      const { callbacks } = fakeObserver();
      const { dialog, calls, onSaved } = await openLoaded();
      fireEvent.change(slider(dialog), { target: { value: slider(dialog).max } });
      Object.defineProperty(cropArea(dialog), "clientWidth", { configurable: true, value: 400 });
      act(() => callbacks.forEach(cb => cb()));
      fireEvent.click(saveButton(dialog));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      const crop = JSON.parse((mutations(calls)[0]!.body as FormData).get("crop") as string) as Record<string, number>;
      expect(crop.size).toBe(100);
      expect(Math.abs(crop.x! + crop.size! / 2 - 300)).toBeLessThanOrEqual(1);
      expect(Math.abs(crop.y! + crop.size! / 2 - 200)).toBeLessThanOrEqual(1);
    });

    it("box measures 0 -> no recomputation and no error", async () => {
      const { callbacks } = fakeObserver();
      const { dialog, img } = await openLoaded();
      fireEvent.change(slider(dialog), { target: { value: "1.4" } });
      const w0 = width(img);
      Object.defineProperty(cropArea(dialog), "clientWidth", { configurable: true, value: 0 });
      expect(() => act(() => callbacks.forEach(cb => cb()))).not.toThrow();
      expect(width(img)).toBeCloseTo(w0);
      expect(screen.getByRole("dialog", { name: "Adjust picture" })).toBeInTheDocument();
    });

    it("closing the dialog stops the size observer", async () => {
      const { disconnect } = fakeObserver();
      const ctx = await openLoaded();
      expect(disconnect).not.toHaveBeenCalled();
      ctx.view.rerender(ctx.tree(false));
      await waitFor(() => expect(disconnect).toHaveBeenCalled());
    });

    it("when the box side length changes, the image scales proportionally and the saved crop is unchanged", async () => {
      const callbacks: Array<() => void> = [];
      class FakeResizeObserver {
        constructor(cb: () => void) {
          callbacks.push(cb);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
      vi.stubGlobal("ResizeObserver", FakeResizeObserver);
      const { dialog, img, calls, onSaved } = await openLoaded();
      fireEvent.change(slider(dialog), { target: { value: "1.4" } });
      expect(width(img)).toBeCloseTo(840);
      Object.defineProperty(cropArea(dialog), "clientWidth", { configurable: true, value: 140 });
      act(() => callbacks.forEach(cb => cb()));
      expect(width(img)).toBeCloseTo(420);
      expect(left(img)).toBeCloseTo(-140);
      fireEvent.click(saveButton(dialog));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      const crop = JSON.parse((mutations(calls)[0]!.body as FormData).get("crop") as string) as Record<string, number>;
      expect(crop).toEqual({ x: 200, y: 100, size: 200, width: 600, height: 400 } satisfies AvatarCropUpload);
    });
  });

  describe("error routing", () => {
    async function saveWith(respond: (call: Call) => Response, opts?: Parameters<typeof setup>[2]) {
      const ctx = await openLoaded(newFile(), respond, opts);
      fireEvent.click(saveButton(ctx.dialog));
      return ctx;
    }
    const failure = (status: number, code: string, extra: Record<string, unknown> = {}) => () =>
      json(status, { error: { code, message: "SERVER WORDING THAT MUST NOT BE USED" }, ...extra });

    it("413: shows \"over {size} limit\" where the size is the site's upload limit; doesn't rely on message", async () => {
      const { dialog, onOpenChange } = await saveWith(failure(413, "anything_at_all"));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(`The image is larger than the ${formatBytes(MAX_UPLOAD)} limit.`);
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(saveButton(dialog)).toBeEnabled();
    });

    it("413 but the site gives no limit: falls back to the generic upload-failed text", async () => {
      const { dialog } = await saveWith(failure(413, "anything_at_all"), { maxUploadBytes: undefined });
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("Upload failed. Please try again.");
    });

    it("415: can't read this image", async () => {
      const { dialog } = await saveWith(failure(415, "unsupported_media_type"));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("Couldn't read this image. PNG, JPEG and WebP are supported.");
    });

    it("storage_quota_exceeded: the existing \"storage full\" text plus usage", async () => {
      const { dialog } = await saveWith(
        failure(409, "storage_quota_exceeded", { storage: { incomingBytes: 10, usedBytes: 2048, quotaBytes: 4096 } }),
      );
      const alert = await within(dialog).findByRole("alert");
      expect(alert).toHaveTextContent("Storage is full");
      expect(alert).toHaveTextContent(`${formatBytes(2048)} of ${formatBytes(4096)} used`);
      const parts = Array.from(alert.children).map(el => el.textContent);
      expect(parts).toEqual(["Storage is full", `${formatBytes(2048)} of ${formatBytes(4096)} used. Ask a site admin for more space.`]);
    });

    it("storage_quota_exceeded without usage numbers: generic sentence", async () => {
      const { dialog } = await saveWith(failure(409, "storage_quota_exceeded"));
      const alert = await within(dialog).findByRole("alert");
      expect(alert).toHaveTextContent("Storage is full");
      expect(alert).not.toHaveTextContent("of");
    });

    it("server_busy: the existing server-busy message", async () => {
      const { dialog } = await saveWith(failure(409, "server_busy"));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("The server is busy. Please try again shortly.");
    });

    it("too_many_requests (429): the existing too-many-requests message", async () => {
      const { dialog } = await saveWith(failure(429, "too_many_requests"));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("Too many requests. Please slow down.");
    });

    it("other (500): upload failed, try again", async () => {
      const { dialog } = await saveWith(failure(500, "internal"));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("Upload failed. Please try again.");
    });

    it("network interruption: upload failed, try again, and the button is clickable again", async () => {
      const ctx = await openLoaded(newFile(), () => {
        throw new TypeError("Failed to fetch");
      });
      fireEvent.click(saveButton(ctx.dialog));
      expect(await within(ctx.dialog).findByRole("alert")).toHaveTextContent("Upload failed. Please try again.");
      expect(saveButton(ctx.dialog)).toBeEnabled();
    });

    it("avatar_outdated: hint, closes the dialog, refetches the candidate list", async () => {
      const { dialog, onOpenChange, queryClient } = await saveWith(failure(409, "avatar_outdated"));
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
      expect(await screen.findByText("This picture was updated elsewhere. Open it again to adjust.")).toBeInTheDocument();
      expect(queryClient.getQueryState(AVATARS_QUERY_KEY)?.isInvalidated).toBe(true);
      expect(dialog).toBeDefined();
    });

    it("decode failure (decode throws): can't read this image, not submitted", async () => {
      vi.mocked(encode.decodeImage).mockRejectedValue(new Error("cannot decode image"));
      const { dialog, calls } = await saveWith(() => json(200, candidate()));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("Couldn't read this image. PNG, JPEG and WebP are supported.");
      expect(mutations(calls)).toHaveLength(0);
    });

    it("encode failure (can't draw or output too large): not submitted, button recovers", async () => {
      vi.mocked(encode.renderDisplay).mockRejectedValue(new Error("encoded image too large"));
      const { dialog, calls } = await saveWith(() => json(200, candidate()));
      expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
      expect(mutations(calls)).toHaveLength(0);
      expect(saveButton(dialog)).toBeEnabled();
      expect(closeBitmap).toHaveBeenCalled();
    });

    it("the browser can't read the image (img load fails, e.g. HEIC): can't read it, Save disabled", async () => {
      setup(newFile());
      const dialog = await screen.findByRole("dialog", { name: "Adjust picture" });
      const img = await waitFor(() => {
        const el = dialog.querySelector("img");
        expect(el).not.toBeNull();
        return el as HTMLImageElement;
      });
      fireEvent.error(img);
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("Couldn't read this image. PNG, JPEG and WebP are supported.");
      expect(saveButton(dialog)).toBeDisabled();
    });

    it("the existing candidate's original no longer exists (404): says it wasn't found rather than upload failed, Save disabled", async () => {
      setup({ kind: "existing", candidate: candidate() }, () => json(404, { error: { code: "not_found", message: "x" } }));
      const dialog = await screen.findByRole("dialog", { name: "Adjust picture" });
      const alert = await within(dialog).findByRole("alert");
      expect(alert).toHaveTextContent("We couldn't find what you were looking for.");
      expect(alert).not.toHaveTextContent("Upload failed");
      expect(saveButton(dialog)).toBeDisabled();
    });

    it("reading the existing candidate's original fails (network): says the image can't be read, not upload failed", async () => {
      setup({ kind: "existing", candidate: candidate() }, () => {
        throw new TypeError("Failed to fetch");
      });
      const dialog = await screen.findByRole("dialog", { name: "Adjust picture" });
      const alert = await within(dialog).findByRole("alert");
      expect(alert).toHaveTextContent("Couldn't read this image.");
      expect(alert).not.toHaveTextContent("Upload failed");
      expect(saveButton(dialog)).toBeDisabled();
    });

    it("zh-TW: 413 and upload failed in Chinese", async () => {
      await i18n.changeLanguage("zh-TW");
      const ctx = setup(newFile(), failure(413, "x"));
      const dialog = await screen.findByRole("dialog", { name: "調整頭貼" });
      await loadImage(dialog);
      fireEvent.click(within(dialog).getByRole("button", { name: "儲存" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(`圖片超過 ${formatBytes(MAX_UPLOAD)} 上限。`);
      expect(ctx.calls.length).toBeGreaterThan(0);
    });
  });

  describe("mutual exclusion with background regeneration", () => {
    function fillerDeps() {
      const fetchOriginal = vi.fn(async () => new Blob([new Uint8Array([1])], { type: "image/png" }));
      configureFiller({ fetchOriginal, putDisplay: vi.fn(async () => ({})), invalidate: vi.fn() });
      return fetchOriginal;
    }

    it("while an existing candidate's crop dialog is open, background regeneration skips that candidate; it is handled after the dialog closes", async () => {
      resetFiller();
      const fetchOriginal = fillerDeps();
      const ctx = setup({ kind: "existing", candidate: candidate() });
      await screen.findByRole("dialog", { name: "Adjust picture" });
      enqueueFill({ id: ID, v: 3 });
      await settle();
      expect(fetchOriginal).not.toHaveBeenCalled();
      ctx.view.rerender(ctx.tree(false));
      await waitFor(() => expect(fetchOriginal).toHaveBeenCalledTimes(1));
      resetFiller();
    });

    it("unmounting (e.g. navigating away) also unregisters", async () => {
      resetFiller();
      const fetchOriginal = fillerDeps();
      const ctx = setup({ kind: "existing", candidate: candidate() });
      await screen.findByRole("dialog", { name: "Adjust picture" });
      enqueueFill({ id: ID, v: 3 });
      await settle();
      expect(fetchOriginal).not.toHaveBeenCalled();
      ctx.view.unmount();
      await waitFor(() => expect(fetchOriginal).toHaveBeenCalledTimes(1));
      resetFiller();
    });

    it("adjusting an existing candidate and saving successfully: the queued regeneration for it is dropped (regenerating again would only hit a version conflict)", async () => {
      resetFiller();
      const fetchOriginal = fillerDeps();
      const { dialog, onSaved, view, tree } = await openLoaded({ kind: "existing", candidate: candidate() });
      enqueueFill({ id: ID, v: 3 });
      fireEvent.click(saveButton(dialog));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      view.rerender(tree(false)); // The parent closes the dialog after onSaved: unregistered, so the queue shouldn't still hold this one.
      await settle();
      expect(fetchOriginal).not.toHaveBeenCalled();
      resetFiller();
    });

    it("a crop dialog for a new upload registers no candidate (regeneration proceeds as usual)", async () => {
      resetFiller();
      const fetchOriginal = fillerDeps();
      setup(newFile());
      await screen.findByRole("dialog", { name: "Adjust picture" });
      enqueueFill({ id: ID, v: 3 });
      await waitFor(() => expect(fetchOriginal).toHaveBeenCalledTimes(1));
      resetFiller();
    });
  });

  describe("blob URL", () => {
    it("new file: opening creates one blob URL for the <img>, released on close", async () => {
      const ctx = setup(newFile());
      const dialog = await screen.findByRole("dialog", { name: "Adjust picture" });
      const img = await waitFor(() => {
        const el = dialog.querySelector("img");
        expect(el).not.toBeNull();
        return el as HTMLImageElement;
      });
      expect(img).toHaveAttribute("src", "blob:crop-1");
      expect(ctx.createObjectURL).toHaveBeenCalledTimes(1);
      expect(ctx.revokeObjectURL).not.toHaveBeenCalled();
      ctx.view.rerender(ctx.tree(false));
      await waitFor(() => expect(ctx.revokeObjectURL).toHaveBeenCalledWith("blob:crop-1"));
    });

    it("released on unmount", async () => {
      const ctx = setup(newFile());
      await screen.findByRole("dialog", { name: "Adjust picture" });
      await waitFor(() => expect(ctx.createObjectURL).toHaveBeenCalled());
      ctx.view.unmount();
      expect(ctx.revokeObjectURL).toHaveBeenCalledWith("blob:crop-1");
    });

    it("existing candidate: blob URL created only after the original arrives, released on close; closing before the original returns creates none", async () => {
      let release: (r: Response) => void = () => {};
      const pending = new Promise<Response>(resolve => (release = resolve));
      const ctx = setup({ kind: "existing", candidate: candidate() }, () => pending);
      await screen.findByRole("dialog", { name: "Adjust picture" });
      expect(ctx.createObjectURL).not.toHaveBeenCalled();
      ctx.view.rerender(ctx.tree(false));
      await act(async () => {
        release(originalResponse());
        await settle();
      });
      expect(ctx.createObjectURL).not.toHaveBeenCalled();
    });
  });
});
