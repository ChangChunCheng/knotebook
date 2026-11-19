import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
  type SVGProps,
} from "react";
import { useTranslation } from "react-i18next";
import { flip, offset, shift, size, type UseFloatingOptions } from "@floating-ui/react";
import { GenericPopover, useBlockNoteEditor, useEditorState, type GenericPopoverReference } from "@blocknote/react";
import { posToDOMRect } from "@tiptap/core";
import {
  COLUMN_LIST_TYPE,
  CONTINUE_WRITING_ACTION_ID,
  INSTRUCTION_MAX_CODE_POINTS,
  REWRITE_ACTION_ID,
  SUMMARIZE_ACTION_ID,
  TRANSLATE_ACTION_ID,
  truncateCodePoints,
} from "@knotebook/shared";
import { verifyAnchor } from "@/ai/anchor";
import { blockRange, type BlockRange } from "@/ai/selection";
import { Button } from "@/components/ui/button";
import { Sparkles, X } from "@/components/ui/icons";
import { ChevronsRight, Languages, ListCollapse, PenLine, Send } from "@/components/ui/icons-extra";
import { useIsPhone } from "@/lib/layout-tiers";
import { stickyTopInset } from "@/lib/page-scroll";
import { activeAnchorOf, useAiSession, type AiTarget } from "./AiSession";
import { SelectionAiResult, type BoxFocusTarget, type RunWithFocus } from "./SelectionAiResult";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

const QUICK_ICONS: Record<string, IconComponent> = {
  [REWRITE_ACTION_ID]: PenLine,
  [TRANSLATE_ACTION_ID]: Languages,
  [SUMMARIZE_ACTION_ID]: ListCollapse,
  [CONTINUE_WRITING_ACTION_ID]: ChevronsRight,
};

/** Left + right `border` (1px each): box width = block width + border, so the preview's text column equals the block width. */
const BOX_BORDER_X = 2;
const NO_DISMISS = { enabled: false };
const NO_FOCUS_MANAGER = { disabled: true };
const ELEMENT_PROPS = { style: { zIndex: 40 } };

/** A regular block has `.bn-block-outer`; when the anchor expands to a whole column list, the list has no outer, so query the list node itself. */
function anchorBlockElement(root: Element | null | undefined, id: string): HTMLElement | null {
  if (!root) return null;
  return (
    root.querySelector<HTMLElement>(`.bn-block-outer[data-id="${id}"]`) ??
    root.querySelector<HTMLElement>(`[data-node-type="${COLUMN_LIST_TYPE}"][data-id="${id}"]`)
  );
}

/** Nearest scrolling ancestor (the note card's `overflow-y-auto`); null on phones, where the document scrolls instead of the note card. */
function scrollParentOf(el: Element | null | undefined): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    if (/(auto|scroll|overlay)/.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

/**
 * - Input/streaming/error states use the built-in toolbar's middleware order.
 * - Result state covers the first block (zero-height reference at its top edge, `bottom-start`) and extends down over the following
 *   paragraphs; no flip, since flipping up would cover the paragraph above; `shift()` stays against horizontal overflow and `size()` uses
 *   the height below the box top. The top edge is clamped to the scroll container (never over the header); without a block element it
 *   falls back to posBefore's coordinates. The reference `element` matches `PositionPopover` (editor root blockGroup) so autoUpdate
 *   attaches the scroll listener and the box follows the block.
 * - `role="region"`, not `dialog`: global shortcuts and the version preview's Esc bail out when a dialog is on the page.
 * - Focus: opening moves it to the input (the first chip without Instruct), the only unconditional move. Other transitions move focus only
 *   if it was inside the box at that moment: submit/chip/retry -> cancel; done/error -> box container; restore -> box container;
 *   apply/cancel/close -> editor. Whether focus is inside is recorded before unmount; afterwards `document.activeElement` is just body.
 *   Only Esc inside the box counts.
 */
export function SelectionAiBox() {
  const { t } = useTranslation();
  const editor = useBlockNoteEditor();
  const session = useAiSession();
  const { state, editable, actions } = session;
  const anchor = activeAnchorOf(state);
  const boxOpen = state.phase !== "idle";

  const snapshot = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      if (!current || !anchor) return null;
      return {
        position: current.transact((tr) => blockRange(tr.doc, anchor.blockIds[0])),
        status: verifyAnchor(current, anchor),
      };
    },
  });
  const lastPositionRef = useRef<BlockRange | null>(null);
  if (!boxOpen) lastPositionRef.current = null;
  else if (snapshot?.position) lastPositionRef.current = snapshot.position;
  const position = boxOpen ? (lastPositionRef.current ?? undefined) : undefined;
  const anchorOk = snapshot?.status === "ok";

  const firstBlockId = anchor?.blockIds[0];
  const [blockWidth, setBlockWidth] = useState(0);
  useEffect(() => {
    if (!firstBlockId) return;
    const el = anchorBlockElement(editor.domElement, firstBlockId);
    if (!el) return;
    const measure = () => setBlockWidth(el.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [editor, firstBlockId]);
  const boxWidth = blockWidth > 0 ? `min(${blockWidth + BOX_BORDER_X}px, calc(100vw - 16px))` : undefined;

  // The reference object stays the same across phases: its getBoundingClientRect reads refs written during render, so the recompute
  // for the new `bottom-start` placement already sees the result-state rect. A new reference would only attach in GenericPopover's
  // passive effect, pairing the old rect with the new placement.
  const overlay = state.phase === "done";
  const overlayRef = useRef(overlay);
  overlayRef.current = overlay;
  const firstBlockIdRef = useRef(firstBlockId);
  firstBlockIdRef.current = firstBlockId;
  const from = position?.from;
  const to = position?.to;
  const phone = useIsPhone();
  const reference = useMemo<GenericPopoverReference | undefined>(() => {
    if (from === undefined || to === undefined) return undefined;
    const atAnchor = () => posToDOMRect(editor.prosemirrorView, from, to);
    let scroller: HTMLElement | null = null;
    const overlayRect = () => {
      const blockId = firstBlockIdRef.current;
      const block = blockId ? anchorBlockElement(editor.domElement, blockId) : null;
      const rect = block ? block.getBoundingClientRect() : atAnchor();
      // null isn't cached: on phones the document scrolls, so it is looked up again each time. Crossing 640px rebuilds the reference with
      // `phone`, so a found scroller is looked up again too.
      if (!scroller || !scroller.isConnected) scroller = scrollParentOf(editor.domElement);
      // No scrolling ancestor (phone): clamp to the pinned header's bottom edge.
      const clipTop = scroller ? scroller.getBoundingClientRect().top : phone ? stickyTopInset() : 0;
      return new DOMRect(rect.left, Math.max(rect.top, clipTop), rect.width, 0);
    };
    return {
      element: editor.domElement?.firstElementChild ?? undefined,
      getBoundingClientRect: () => (overlayRef.current ? overlayRect() : atAnchor()),
    };
  }, [editor, from, to, phone]);

  const floatingOptions = useMemo<UseFloatingOptions>(() => {
    const maxHeight = size({
      apply({ availableHeight, elements }) {
        const cap = Math.max(0, Math.floor(Math.min(window.innerHeight * 0.4, availableHeight)));
        elements.floating.style.setProperty("--kb-ai-box-max-h", `${cap}px`);
      },
    });
    return {
      open: boxOpen && editable,
      placement: overlay ? "bottom-start" : "top-start",
      middleware: overlay ? [shift(), maxHeight] : [offset(10), shift(), flip(), maxHeight],
    };
  }, [boxOpen, editable, overlay]);

  // floating-ui's transition mounts the box a render after the phase changes, so a layout effect keyed on phase alone sees a null ref;
  // track "mounted" in state and wait for it before moving focus.
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [boxEl, setBoxEl] = useState<HTMLDivElement | null>(null);
  const setBoxRef = useCallback((el: HTMLDivElement | null) => {
    boxRef.current = el;
    setBoxEl(el);
  }, []);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const firstChipRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const focusInsideRef = useRef(false);
  const pendingFocusRef = useRef<BoxFocusTarget | null>(null);
  const prevPhaseRef = useRef(state.phase);

  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      focusInsideRef.current = boxRef.current?.contains(event.target as Node) ?? false;
    };
    // Clicking a non-focusable spot outside moves focus to body (focusout, no focusin), so the flag would stay true. But a pointerdown
    // outside doesn't imply focus left (touch scroll, scrollbar drag, preventDefault'd mousedown), so re-read `activeElement` one
    // macrotask later, after the browser's default focus move.
    let recheck: ReturnType<typeof setTimeout> | undefined;
    const onPointerDown = () => {
      clearTimeout(recheck);
      recheck = setTimeout(() => {
        recheck = undefined;
        focusInsideRef.current = boxRef.current?.contains(document.activeElement) ?? false;
      }, 0);
    };
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      clearTimeout(recheck);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, []);

  const run = useCallback<RunWithFocus>((action, target) => {
    const inside = focusInsideRef.current || (boxRef.current?.contains(document.activeElement) ?? false);
    const result = action();
    if (inside && result !== false) pendingFocusRef.current = target;
  }, []);

  const [instruction, setInstruction] = useState("");
  const inputTarget = state.phase === "input" ? state.target : null;
  const focusedTargetRef = useRef<AiTarget | null>(null);
  useLayoutEffect(() => {
    // Once per new target, after the box mounts: clear the input (reopening doesn't reuse the old instruction) and focus it, or the first
    // chip when there is no input.
    if (!inputTarget || !boxEl || focusedTargetRef.current === inputTarget) return;
    focusedTargetRef.current = inputTarget;
    setInstruction("");
    // preventScroll: the box may not be positioned yet (still at the portal origin) and focusing would scroll the note there. Every
    // programmatic focus move inside the box uses preventScroll: opening, submitting and finishing must never change the note's scroll position.
    (textareaRef.current ?? firstChipRef.current)?.focus({ preventScroll: true });
  }, [inputTarget, boxEl]);

  useLayoutEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = state.phase;
    if (prev === "streaming" && (state.phase === "done" || state.phase === "error") && pendingFocusRef.current === null && focusInsideRef.current) {
      pendingFocusRef.current = "container";
    }
    const target = pendingFocusRef.current;
    if (target === null) return;
    pendingFocusRef.current = null;
    if (target === "cancel") cancelRef.current?.focus({ preventScroll: true });
    // preventScroll: the user may have scrolled away while streaming, and the done/restore focus move must not scroll the page back to the
    // box (jsdom can't measure this; e2e covers it). editor.focus() goes through ProseMirror's view.focus(), which already uses
    // focusPreventScroll.
    else if (target === "container") boxRef.current?.focus({ preventScroll: true });
    else editor.focus();
  }, [state, editor]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    event.preventDefault(); // NotePage's page-wide Esc ignores defaultPrevented events
    event.stopPropagation();
    run(() => (state.phase === "streaming" ? session.cancel() : session.close()), "editor");
  };

  const instructAction = actions.find((action) => action.kind === "instruct");
  const quickActions = actions.filter((action) => action.kind === "quick");
  const submit = () => {
    if (!instructAction) return;
    const value = instruction.trim();
    if (value === "") return;
    run(() => session.start(instructAction.id, value), "cancel");
  };

  // After a direct apply the anchor is the inserted block; its changes only affect Restore, not the "original changed" notice.
  const showStale = boxOpen && !anchorOk && !(state.phase === "done" && state.applied !== null);
  const discardRow = (
    <div className="flex justify-end px-3 py-2">
      <Button type="button" variant="ghost" size="sm" onClick={() => run(() => session.close(), "editor")}>
        {t("ai.box.discard")}
      </Button>
    </div>
  );

  return (
    <GenericPopover
      reference={reference}
      useFloatingOptions={floatingOptions}
      useDismissProps={NO_DISMISS}
      focusManagerProps={NO_FOCUS_MANAGER}
      elementProps={ELEMENT_PROPS}
    >
      {position !== undefined && boxOpen && editable && (
        <div
          ref={setBoxRef}
          role="region"
          aria-label={t("ai.box.label")}
          data-testid="selection-ai-box"
          // Marker: the note page's undo shortcut yields while the box is open (`@/collab/page-undo`).
          data-kb-ai-box=""
          tabIndex={-1}
          onKeyDown={onKeyDown}
          style={{ width: boxWidth }}
          className="flex max-h-[var(--kb-ai-box-max-h,40vh)] max-w-[calc(100vw-16px)] flex-col overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md outline-none"
        >
          {showStale && (
            <p role="status" className="px-3 pt-2 text-xs text-destructive">
              {t("ai.box.stale")}
            </p>
          )}

          {state.phase === "input" &&
            (anchorOk ? (
              <div className="flex flex-wrap items-start gap-1 p-2 text-sm">
                {instructAction && (
                  <>
                    <textarea
                      ref={textareaRef}
                      rows={1}
                      aria-label={t("ai.box.inputLabel")}
                      placeholder={t("ai.box.placeholder")}
                      value={instruction}
                      onChange={(event) => setInstruction(truncateCodePoints(event.target.value, INSTRUCTION_MAX_CODE_POINTS))}
                      onKeyDown={(event) => {
                        // `isComposing`: Enter while choosing an IME candidate must not submit (same as FilePanel.tsx); Shift+Enter inserts a newline.
                        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                          event.preventDefault();
                          submit();
                        }
                      }}
                      className="field-sizing-content max-h-[5.75rem] min-h-8 min-w-40 flex-1 resize-none bg-transparent px-2 py-1.5 pointer-coarse:text-base outline-none"
                    />
                    <Button type="button" variant="ghost" size="icon" aria-label={t("ai.box.send")} title={t("ai.box.send")} onClick={submit}>
                      <Send aria-hidden="true" className="h-4 w-4" />
                    </Button>
                  </>
                )}
                <div className="flex flex-wrap items-center gap-1">
                  {quickActions.map((action, index) => {
                    const Icon = QUICK_ICONS[action.id] ?? Sparkles;
                    return (
                      <Button
                        key={action.id}
                        ref={index === 0 ? firstChipRef : undefined}
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={action.name}
                        title={action.name}
                        onClick={() => run(() => session.start(action.id), "cancel")}
                      >
                        <Icon aria-hidden="true" className="h-4 w-4" />
                      </Button>
                    );
                  })}
                  <Button type="button" variant="ghost" size="icon" aria-label={t("ai.box.close")} title={t("ai.box.close")} onClick={() => run(() => session.close(), "editor")}>
                    <X aria-hidden="true" className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ) : (
              discardRow
            ))}

          {state.phase === "streaming" && (
            <div className="space-y-2 p-3 text-sm">
              <p className="text-xs font-medium text-muted-foreground">
                {state.request.kind === "instruct" ? t("ai.box.instructLabel") : state.request.actionName}
              </p>
              <p className="text-muted-foreground">{t("ai.box.streaming")}</p>
              {state.partial && <p className="whitespace-pre-wrap">{state.partial}</p>}
              <div className="flex justify-end gap-2">
                {/* Anchor lost: Discard only (plus Cancel while streaming). */}
                {!anchorOk && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => run(() => session.close(), "editor")}>
                    {t("ai.box.discard")}
                  </Button>
                )}
                <Button ref={cancelRef} type="button" variant="outline" size="sm" onClick={() => run(() => session.cancel(), "editor")}>
                  {t("ai.box.cancel")}
                </Button>
              </div>
            </div>
          )}

          {state.phase === "done" && <SelectionAiResult state={state} anchorOk={anchorOk} run={run} />}

          {state.phase === "error" &&
            (anchorOk ? (
              <div className="space-y-2 p-3 text-sm">
                <p role="alert" className="text-destructive">
                  {t(`errors.${state.code}`, { defaultValue: t("errors.fallback") })}
                </p>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => run(() => session.close(), "editor")}>
                    {t("ai.box.close")}
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => run(() => session.retry(), "cancel")}>
                    {t("ai.box.retry")}
                  </Button>
                </div>
              </div>
            ) : (
              discardRow
            ))}
        </div>
      )}
    </GenericPopover>
  );
}
