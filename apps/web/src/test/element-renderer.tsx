import { createRef, forwardRef, useImperativeHandle, useState, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { BlockNoteEditor } from "@blocknote/core";

/**
 * **elementRenderer** (the same as the copy inlined in `components/wikilink/menu.test.tsx` and `collab/link-sync.test.tsx`): for an editor that is `editor.mount()`ed,
 * not headless, and has no `<BlockNoteView>`, the `toDOM` of a wikilink (React inline content) needs `editor.elementRenderer` to render,
 * otherwise it throws `elementRenderer not available, expected headless editor`. Copied from the shape of BlockNote's unexported `ElementRenderer.tsx`, wrapped in
 * `QueryClientProvider` / `MemoryRouter` (`WikilinkInline` uses `useNotes` / `useNavigate`; an empty array in `["notes"]` = the "resolved, no hit" state).
 */
type ElementRendererHandle = (node: ReactNode, container: HTMLElement) => void;

const TestElementRenderer = forwardRef<ElementRendererHandle>((_props, ref) => {
  const [singleRenderData, setSingleRenderData] = useState<{ node: ReactNode; container: HTMLElement } | undefined>();
  useImperativeHandle(
    ref,
    () => (node: ReactNode, container: HTMLElement) => {
      flushSync(() => setSingleRenderData({ node, container }));
      setSingleRenderData(undefined);
    },
    [],
  );
  return singleRenderData ? createPortal(singleRenderData.node, singleRenderData.container) : null;
});
TestElementRenderer.displayName = "TestElementRenderer";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor generic triple; any per repo convention
export function attachTestElementRenderer(editor: BlockNoteEditor<any, any, any>): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(["notes"], []);
  const rendererRef = createRef<ElementRendererHandle>();
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <TestElementRenderer ref={rendererRef} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  editor.elementRenderer = rendererRef.current!;
}
