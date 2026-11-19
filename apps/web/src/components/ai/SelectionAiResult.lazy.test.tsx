import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { SUMMARIZE_ACTION_ID, type AiActionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { createTestEditor, renderAiHost, selectInBlock, stubAiFetch, type AiCall, type AnyEditor } from "@/test/ai-host";
import { useAiSession, type AiSessionValue } from "./AiSession";
import { SelectionAiResult } from "./SelectionAiResult";

/**
 * Timing cases for the preview-ready signal (#263): the lazy preview module is replaced by a controllable stand-in covering only three
 * timings (pending / ready / render error); when ready it calls `onReady(preview)` and on unmount `onReady(null)` per the real module's
 * contract. The real module's behaviour is tested in SelectionAiResult.test.tsx (the stand-in only relaxes timing, it is not stricter than the real one).
 */
const gate = vi.hoisted(() => ({
  mode: "ready" as "ready" | "pending" | "crash",
  promise: Promise.resolve(),
  release: () => {},
}));

vi.mock("@/components/versions/VersionsLazy", async () => {
  const { useEffect } = await import("react");
  function Gate(): null {
    if (gate.mode === "crash") throw new Error("preview render bug");
    if (gate.mode === "pending") throw gate.promise;
    return null;
  }
  function Ready({ preview, onReady }: { preview: unknown; onReady: (ready: unknown) => void }) {
    useEffect(() => {
      onReady(preview);
      return () => onReady(null);
    }, [preview, onReady]);
    return <div data-testid="selection-ai-preview" />;
  }
  return {
    SelectionAiPreview: (props: { preview: unknown; onReady: (ready: unknown) => void }) => (
      <>
        <Gate />
        <Ready {...props} />
      </>
    ),
  };
});

const SUMMARIZE: AiActionDto = { id: SUMMARIZE_ACTION_ID, name: "Summarize", applyMode: "preview", kind: "quick" };

let session!: AiSessionValue;
let editor: AnyEditor;

/** Same as ResultHost in SelectionAiResult.test.tsx: mounted only when `phase === "done"` (the anchor is never changed in this file, so anchorOk is always true). */
function ResultHost() {
  session = useAiSession();
  return session.state.phase === "done" ? <SelectionAiResult state={session.state} anchorOk run={(action) => action()} /> : null;
}

async function mount() {
  editor = createTestEditor([{ id: "p1", type: "paragraph", content: "alpha beta gamma" }]);
  const ai = stubAiFetch({ actions: [SUMMARIZE] });
  renderAiHost({ editor, children: <ResultHost /> });
  await waitFor(() => expect(session.actions).toHaveLength(1));
  return ai;
}

async function finish(call: AiCall, text: string) {
  await act(async () => {
    call.delta(text);
    call.done();
  });
  await waitFor(() => expect(session.state.phase).toBe("done"));
}

function setPending(): void {
  gate.mode = "pending";
  gate.promise = new Promise<void>((resolve) => {
    gate.release = resolve;
  });
}

describe("SelectionAiResult: preview ready signal (#263)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    gate.mode = "ready";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lazy module not ready (pending): apply is disabled and loading is shown; apply is enabled once ready", async () => {
    const ai = await mount();
    setPending();
    selectInBlock(editor, "p1", 0, 5);
    act(() => session.open());
    act(() => {
      session.start(SUMMARIZE.id);
    });
    await finish(ai.calls[0]!, "SUMMARY");
    expect(screen.getByText("Loading preview…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    gate.mode = "ready";
    await act(async () => {
      gate.release();
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled());
  });

  it("preview render error (boundary error state): apply is disabled, the preview error text is shown, discard still works", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ai = await mount();
    gate.mode = "crash";
    selectInBlock(editor, "p1", 0, 5);
    act(() => session.open());
    act(() => {
      session.start(SUMMARIZE.id);
    });
    await finish(ai.calls[0]!, "SUMMARY");
    expect(await screen.findByText("The preview couldn't be shown.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(session.state.phase).toBe("idle");
  });

  it("second preview (module already cached): after retry, apply can still be enabled once the new result is ready", async () => {
    const ai = await mount();
    selectInBlock(editor, "p1", 0, 5);
    act(() => session.open());
    act(() => {
      session.start(SUMMARIZE.id);
    });
    await finish(ai.calls[0]!, "FIRST");
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await finish(ai.calls[1]!, "SECOND");
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled());
  });
});
