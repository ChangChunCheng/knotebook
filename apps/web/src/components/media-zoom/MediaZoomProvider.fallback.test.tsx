import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { useMediaZoom, type MediaZoomApi, type ZoomSource } from "./context";
import { MediaZoomProvider } from "./MediaZoomProvider";

// chunk 永遠載不完：驗證外殼在等待期間就已經出現、而且關得掉。
vi.mock("./lightbox-chunk", () => ({
  loadMediaLightbox: () => new Promise<never>(() => {}),
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

describe("MediaZoomProvider：chunk 載入期間", () => {
  it("open() 當下就顯示外殼與灰塊；Esc 關掉並把焦點還給放大鈕", () => {
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
});
