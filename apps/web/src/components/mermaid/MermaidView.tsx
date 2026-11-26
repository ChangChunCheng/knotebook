import { useEffect, useRef, useState, type JSX, type KeyboardEvent, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { cachedMermaid, preloadMermaid, renderMermaid, type MermaidRenderResult, type MermaidTheme } from "@/lib/mermaid";
import { useMediaZoom } from "@/components/media-zoom/context";
import { svgIntrinsicSize } from "@/components/media-zoom/svg-size";
import { prefetchMediaLightbox } from "@/components/media-zoom/lightbox-chunk";
import { ZoomButton } from "@/components/media-zoom/ZoomButton";
import { tourTarget } from "@/lib/tour-targets";
import { useIsPhone } from "@/lib/layout-tiers";
import { cn } from "@/lib/utils";

/** Start rendering 600px before a diagram scrolls into view; vertical only, because notes scroll vertically. */
export const MERMAID_ROOT_MARGIN = "600px 0px";

function hasIntersectionObserver(): boolean {
  return typeof IntersectionObserver !== "undefined";
}

/**
 * Required as the IntersectionObserver root: the note page scrolls an inner `overflow-y-auto` container, so with
 * the default root (the viewport) the target is clipped by that container first and the 600px `rootMargin`
 * never applies: a diagram renders only once actually visible. On phones (< 640px) that container is
 * `overflow-y: visible` and the document scrolls, no ancestor matches, and `null` (the viewport) is correct.
 * The search starts outside `.bn-editor` because BlockNote columns set `overflow-x:auto`, which makes
 * their overflowY compute to `auto` although they never scroll vertically; stopping at a column would
 * report every diagram inside it as near, i.e. render on mount. Editor internals (columns, table wrappers)
 * are never the note's scroll container. Outside an editor the search starts at the parent.
 */
function scrollRootOf(el: Element): Element | null {
  const start = el.closest(".bn-editor")?.parentElement ?? el.parentElement;
  for (let parent = start; parent !== null; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") return parent;
  }
  return null;
}

function renderKey(code: string, theme: MermaidTheme): string {
  return `${theme}\n${code}`;
}

interface Rendered {
  key: string;
  code: string;
  result: MermaidRenderResult;
}

function initialRendered(code: string, theme: MermaidTheme): Rendered | null {
  const key = renderKey(code, theme);
  if (code.trim().length === 0) return { key, code, result: { ok: false, message: "" } };
  const svg = cachedMermaid(code, theme);
  return svg === null ? null : { key, code, result: { ok: true, svg } };
}
export interface MermaidViewProps {
  code: string;
  editable: boolean;
  theme: MermaidTheme;
  /** Called only when the source actually changed (see `commit`). */
  onChange(code: string): void;
  /** Opens the source editor on mount, for a block the user just created by typing. */
  initiallyEditing?: boolean;
  /** Called after the source editor closes by any route; `viaEscape` tells Esc from blur. */
  onClose?: (viaEscape: boolean) => void;
}

/**
 * Kept separate from spec.tsx so it takes plain props and is testable in jsdom (tests mock lib/mermaid, which
 * can't run there).
 *
 * The SVG is injected with `dangerouslySetInnerHTML`; that is safe only while `lib/mermaid.ts` keeps
 * `securityLevel: "strict"` (mermaid's built-in DOMPurify) and `htmlLabels: false` and never calls
 * `bindFunctions`. Read that file's notes before changing it.
 */
export function MermaidView({ code, editable, theme, onChange, initiallyEditing = false, onClose }: MermaidViewProps): JSX.Element {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(initiallyEditing && editable);
  const [draft, setDraft] = useState(code);
  const [rendered, setRendered] = useState<Rendered | null>(() => initialRendered(code, theme));
  const result = rendered?.result ?? null;
  const rootRef = useRef<HTMLDivElement>(null);
  const diagramRef = useRef<HTMLDivElement>(null);
  const zoom = useMediaZoom();
  // Without IntersectionObserver everything counts as near: better to render all than none.
  const [near, setNear] = useState(() => !hasIntersectionObserver());

  // Preload the mermaid chunk on mount even off-screen, but not for empty blocks: new empty blocks are common and shouldn't pull in the whole dependency (same empty-source rule as `renderMermaid`).
  const hasSource = code.trim().length > 0;
  useEffect(() => {
    if (hasSource) preloadMermaid();
  }, [hasSource]);

  // The scrolling ancestor differs across the phone breakpoint (document vs content container), so re-find the root.
  const phone = useIsPhone();
  useEffect(() => {
    const el = rootRef.current;
    if (el === null || !hasIntersectionObserver()) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const last = entries[entries.length - 1];
        if (last !== undefined) setNear(last.isIntersecting);
      },
      { root: scrollRootOf(el), rootMargin: MERMAID_ROOT_MARGIN },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [phone]);

  // A theme-only change on a far-away diagram keeps the old render until it comes near, so visible
  // diagrams switch first instead of queueing behind every off-screen one; the 600px margin usually
  // re-renders it before it scrolls back. A code change (e.g. by a co-editor) re-renders at once
  // because the old image no longer matches the source.
  const key = renderKey(code, theme);
  const upToDate = rendered?.key === key;
  const codeChanged = rendered !== null && rendered.code !== code;
  const wanted = near || codeChanged;

  // `cancelled` is required: renders are async and an older one can resolve after a newer one,
  // painting a stale result over it. abort() drops requests still queued (scrolled away, unmounted,
  // code changed again) so they don't render for nothing; one already rendering can't be stopped and
  // finishes into the cache, so scrolling back hits it.
  useEffect(() => {
    if (!wanted || upToDate) return;
    let cancelled = false;
    const controller = new AbortController();
    renderMermaid(code, theme, { signal: controller.signal }).then(
      (next) => {
        if (!cancelled) setRendered({ key, code, result: next });
      },
      (err: unknown) => {
        // Only this cleanup aborts, so an AbortError implies `cancelled`. A rejection without
        // `cancelled` (only a bug in `renderMermaid` causes one) must not be swallowed: surface it as an
        // error state so the user at least sees the source, or the diagram stays on the placeholder forever.
        if (cancelled) return;
        setRendered({ key, code, result: { ok: false, message: err instanceof Error ? err.message : String(err) } });
      },
    );
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [code, theme, key, wanted, upToDate]);

  const startEditing = (): void => {
    setDraft(code);
    setEditing(true);
  };

  /** No `onChange` when unchanged: this is a shared document, and a pointless `updateBlock` makes a Yjs update, a store push, and dirties others' undo stacks. */
  const commit = (viaEscape = false): void => {
    setEditing(false);
    if (draft !== code) onChange(draft);
    onClose?.(viaEscape);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter is not intercepted: diagram source is multi-line. Only Esc means "done".
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation(); // keep Esc from reaching editor/dialog handlers
      commit(true);
    }
  };

  const canZoom = zoom !== null && !editing && result?.ok === true;

  const openZoom = (button: HTMLElement | null, media: Element): void => {
    if (zoom === null || result === null || !result.ok) return;
    const svg = diagramRef.current?.querySelector("svg");
    if (!svg) return;
    const box = svgIntrinsicSize(svg) ?? svg.getBoundingClientRect();
    const naturalWidth = box.width;
    const naturalHeight = box.height;
    if (!(naturalWidth > 0 && naturalHeight > 0)) return;
    zoom.open({ kind: "svg", svg: result.svg, naturalWidth, naturalHeight }, { button, media });
  };

  const openFromButton = (event: MouseEvent<HTMLButtonElement>): void => {
    // Read-only: this button isn't focusable, so focus returns to the focusable diagram container.
    openZoom(editable ? event.currentTarget : null, diagramRef.current ?? event.currentTarget);
  };

  const readOnlyZoomProps =
    canZoom && !editable
      ? {
          role: "button" as const,
          tabIndex: 0,
          "aria-label": t("note.zoom.openDiagram"),
          onClick: (event: MouseEvent<HTMLDivElement>) => {
            // Links from `click X href` in the diagram navigate instead of opening zoom.
            if ((event.target as Element).closest("a") !== null) return;
            // Releasing a drag-selection over the diagram also fires click.
            if (window.getSelection()?.isCollapsed === false) return;
            openZoom(null, event.currentTarget);
          },
          onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
            if (event.target !== event.currentTarget) return;
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault(); // Space would scroll the page
            openZoom(null, event.currentTarget);
          },
        }
      : {};

  const body = (() => {
    if (result === null) {
      // Fixed min-height placeholder avoids a layout jump from 0 height. Only before the first render:
      // on a code change the old image stays until the new one is ready. Pulse only near the viewport:
      // offscreen animation still costs style recalculation and repaint every frame, which slows
      // scrolling in long notes with many diagrams.
      return (
        <div
          aria-busy="true"
          className={cn(
            "flex min-h-40 items-center justify-center rounded-md bg-muted/40 text-sm text-muted-foreground",
            near && "motion-safe:animate-pulse",
          )}
        >
          {t("note.mermaid.rendering")}
        </div>
      );
    }
    if (result.ok) {
      return <div ref={diagramRef} className="flex justify-center overflow-x-auto" dangerouslySetInnerHTML={{ __html: result.svg }} />;
    }
    // An empty message means empty source (a new block), not an error.
    if (result.message === "") {
      return <p className="text-sm text-muted-foreground">{t("note.mermaid.empty")}</p>;
    }
    return (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-destructive">
          {t("note.mermaid.error")}：{result.message}
        </p>
        {/* source must show with the error, or users (especially viewers) can't see what the diagram says or fix it */}
        <pre className="overflow-x-auto rounded-md bg-muted/40 p-3 font-mono text-xs">{code}</pre>
      </div>
    );
  })();

  // Viewers keep the source button: it is their only way to see the source unless it has a syntax error.
  // While editing there is no button (Esc and clicking elsewhere both commit); the hint goes below the textarea
  // because it is long and would cover the source if overlaid top-right.
  // The control group must not nest in the click-to-edit button: nested <button> is invalid HTML and one click fires both.
  // Overlapping clicks go to the group: when editable the source button does the same as clicking the diagram;
  // when read-only the button's own action wins. The part of a `click X href` link covered by the group can't be
  // clicked (hovering reveals the group first).
  // Hidden with opacity, not `hidden`, so it stays in the tab order; still clickable while invisible, which is
  // fine because a mouse hovers (revealing it) first. Touch devices have no hover, so they keep it dimly visible.
  // On read-only touch devices the zoom button is hidden: tapping the diagram already zooms.
  // If a button is ever added while editing, preventDefault on mousedown: otherwise the textarea blur
  // commits first and the click looks dead.
  // The group's position comes from `.block-control-group` in `index.css` and the buttons share `.block-control`
  // with the code block's language picker (#111); the outer element is `relative` as the containing block.
  // `w-full` is required: BlockNote's `bn-block-content` is flex and would shrink-wrap the block to its
  // content width (about 140px).
  return (
    <div
      ref={rootRef}
      className="group relative w-full"
      onPointerEnter={canZoom ? prefetchMediaLightbox : undefined}
      {...tourTarget("flowchart")}
    >
      {editing ? null : (
        <div
          className={cn(
            "block-control-group",
            "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-60 [@media(hover:none)]:group-focus-within:opacity-100",
          )}
        >
          <button type="button" onClick={startEditing} className="block-control">
            {editable ? t("note.mermaid.edit") : t("note.mermaid.showSource")}
          </button>
          {canZoom ? (
            <ZoomButton
              onClick={openFromButton}
              // Read-only: keyboard and screen readers use the adjacent diagram container (same action); this button is mouse-only.
              {...(editable ? {} : { tabIndex: -1, "aria-hidden": true as const })}
              className={editable ? undefined : "[@media(hover:none)]:hidden"}
            />
          ) : null}
        </div>
      )}

      {editing ? (
        <>
          <textarea
            aria-label={t("note.mermaid.sourceLabel")}
            value={draft}
            autoFocus
            readOnly={!editable}
            spellCheck={false}
            rows={Math.max(3, draft.split("\n").length + 1)}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => commit()}
            onKeyDown={handleKeyDown}
            className="w-full resize-y rounded-md border border-input bg-muted/40 p-3 font-mono text-sm pointer-coarse:text-base outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <p className="mt-1 text-right text-xs text-muted-foreground">{t("note.mermaid.escHint")}</p>
        </>
      ) : editable ? (
        <button
          type="button"
          aria-label={t("note.mermaid.editArea")}
          // Links from `click X href` handle their own clicks: <a> inside <button> is invalid, and one click would both navigate and start editing.
          onClick={(event) => {
            if ((event.target as Element).closest("a") !== null) return;
            startEditing();
          }}
          className={cn("block w-full cursor-text rounded-md border border-transparent p-2 text-left", "hover:border-input")}
        >
          {body}
        </button>
      ) : (
        <div
          className={cn("py-2", readOnlyZoomProps.role !== undefined && "cursor-zoom-in")}
          {...readOnlyZoomProps}
        >
          {body}
        </div>
      )}
    </div>
  );
}
