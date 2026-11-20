import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18n from "@/i18n";
import { useMediaZoom, type MediaZoomApi, type ZoomOrigin, type ZoomSource } from "./context";
import { MediaZoomProvider } from "./MediaZoomProvider";
import { loadMediaLightbox } from "./lightbox-chunk";

const SOURCE: ZoomSource = {
  kind: "image",
  src: "/uploads/bob.png",
  alt: "bob.png",
  caption: "",
  naturalWidth: 400,
  naturalHeight: 300,
};

let api: MediaZoomApi | null | undefined;

function Probe() {
  api = useMediaZoom();
  return <span data-testid="state">{api === null ? "none" : String(api.isOpen)}</span>;
}

/** The zoom button and image on the page (outside React), so tests can remove them freely. */
function pageElements({ focusableWrap = true }: { focusableWrap?: boolean } = {}) {
  const wrap = document.createElement("div");
  if (focusableWrap) wrap.tabIndex = 0;
  const media = document.createElement("img");
  wrap.append(media);
  const button = document.createElement("button");
  button.textContent = "zoom";
  document.body.append(wrap, button);
  return { wrap, media, button };
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  api = undefined;
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

async function openWith(origin: ZoomOrigin) {
  render(
    <MediaZoomProvider>
      <Probe />
    </MediaZoomProvider>,
  );
  if (origin.button) origin.button.focus();
  act(() => api!.open(SOURCE, origin));
  const dialog = await screen.findByRole("dialog");
  return dialog;
}

describe("MediaZoomProvider", () => {
  it("useMediaZoom() outside the Provider returns null", () => {
    render(<Probe />);
    expect(api).toBeNull();
    expect(screen.getByTestId("state")).toHaveTextContent("none");
  });

  it("after open() the zoom view appears (the lazy chunk loads) and isOpen is true", async () => {
    const { media, button } = pageElements();
    await openWith({ button, media });
    expect(screen.getByRole("dialog", { name: "bob.png" })).toBeInTheDocument();
    expect(api!.isOpen).toBe(true);
    expect(screen.getByTestId("state")).toHaveTextContent("true");
  });

  it("chunk already loaded (e.g. prefetched): the zoom view renders as soon as it opens, without the shell", async () => {
    const { media, button } = pageElements();
    await loadMediaLightbox();
    render(
      <MediaZoomProvider>
        <Probe />
      </MediaZoomProvider>,
    );
    act(() => api!.open(SOURCE, { button, media }));
    expect(screen.getByRole("dialog", { name: "bob.png" })).toBeInTheDocument();
    expect(document.querySelector("[data-zoom-fallback]")).toBeNull();
  });

  it("Esc closes: the zoom view disappears, isOpen is false, focus returns to the zoom button", async () => {
    const { media, button } = pageElements();
    const dialog = await openWith({ button, media });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api!.isOpen).toBe(false);
    expect(screen.getByTestId("state")).toHaveTextContent("false");
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it("zoom button no longer on the page: focus returns to the image's nearest focusable ancestor", async () => {
    const { wrap, media, button } = pageElements();
    const dialog = await openWith({ button, media });
    button.remove();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(wrap));
  });

  it("no zoom button and the image has no focusable ancestor: closing does not throw and focus lands on body", async () => {
    const { media } = pageElements({ focusableWrap: false });
    const dialog = await openWith({ button: null, media });
    expect(() => fireEvent.keyDown(dialog, { key: "Escape" })).not.toThrow();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(document.body));
  });
});
