import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18n from "@/i18n";
import { useMediaZoom, type MediaZoomApi, type ZoomSource } from "./context";
import { MediaZoomProvider } from "./MediaZoomProvider";

// The test decides when the chunk finishes loading: checks that the shell is already there during the wait and can be closed, and takes over after loading.
const deferred = vi.hoisted(() => {
  const d: { promise: Promise<unknown>; resolve: (m: unknown) => void } = { promise: Promise.resolve(), resolve: () => {} };
  d.promise = new Promise(resolve => {
    d.resolve = resolve;
  });
  return d;
});
vi.mock("./lightbox-chunk", () => ({
  loadMediaLightbox: () => deferred.promise,
  loadedMediaLightbox: () => null,
  prefetchMediaLightbox: vi.fn(),
}));

const SOURCE: ZoomSource = { kind: "image", src: "/uploads/bob.png", alt: "bob.png", caption: "", naturalWidth: 400, naturalHeight: 300 };
let api: MediaZoomApi | null | undefined;
function Probe() {
  api = useMediaZoom();
  return null;
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("MediaZoomProvider: while the chunk loads", () => {
  it("open() shows the shell and grey block immediately; Esc closes it and returns focus to the zoom button", () => {
    render(
      <MediaZoomProvider>
        <Probe />
      </MediaZoomProvider>,
    );
    const button = document.createElement("button");
    document.body.append(button);
    const media = document.createElement("img");
    document.body.append(media);
    act(() => api!.open(SOURCE, { button, media }));
    const dialog = screen.getByRole("dialog", { name: "bob.png" });
    expect(dialog.querySelector("[data-zoom-skeleton]")).not.toBeNull();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api!.isOpen).toBe(false);
    expect(document.activeElement).toBe(button);
  });

  it("when the chunk finishes loading while the shell is open: switches to the zoom view with focus inside it, and one Esc closes and returns focus to the zoom button", async () => {
    render(
      <MediaZoomProvider>
        <Probe />
      </MediaZoomProvider>,
    );
    const button = document.createElement("button");
    document.body.append(button);
    const media = document.createElement("img");
    document.body.append(media);
    button.focus();
    act(() => api!.open(SOURCE, { button, media }));
    expect(document.querySelector("[data-zoom-fallback]")).not.toBeNull();
    const actual = await vi.importActual<typeof import("./MediaLightbox")>("./MediaLightbox");
    await act(async () => {
      deferred.resolve(actual);
      await deferred.promise;
    });
    await waitFor(() => expect(document.querySelector("[data-zoom-fallback]")).toBeNull());
    const dialog = screen.getByRole("dialog", { name: "bob.png" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(button));
  });
});
