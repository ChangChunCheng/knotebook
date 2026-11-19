import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { isCustomColor } from "@knotebook/shared";
import { useEditorState } from "@blocknote/react";
import { applyColor } from "@/components/editor/colors/apply-color";
import { CustomColorPanel } from "@/components/editor/colors/CustomColorPanel";
import { NAMED_COLORS } from "@/components/editor/colors/KnotebookColorPicker";
import { sectionProp, type ColorSection } from "@/components/editor/colors/types";
import { pushRecentColor } from "@/lib/recent-colors";
import { cn } from "@/lib/utils";
import { BlockNoteScope } from "./BlockNoteScope";
import type { MobileToolbarEditor } from "./toolbar-modes";

/** Pill (52) + spacing and top margin: the panel's max height is visible height minus this. */
const PANEL_CHROME_PX = 112;

const keepFocus = (event: MouseEvent) => event.preventDefault();

function swatchAttr(section: ColorSection, value: string) {
  return section === "text" ? { "data-text-color": value } : { "data-background-color": value };
}

function Swatch({ section, value, label, selected, onClick }: { section: ColorSection; value: string; label: string; selected: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      onMouseDown={keepFocus}
      onClick={onClick}
      className="flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        {...swatchAttr(section, value)}
        aria-hidden="true"
        className={cn("bn-color-icon pointer-events-none size-8 text-sm", selected && "ring-2 ring-ring ring-offset-2 ring-offset-card")}
      >
        A
      </span>
    </button>
  );
}

function ColorRow({
  editor,
  section,
  current,
  onCustom,
}: {
  editor: MobileToolbarEditor;
  section: ColorSection;
  current: string;
  onCustom(): void;
}) {
  const { t } = useTranslation();
  const dict = editor.dictionary.color_picker;
  const custom = isCustomColor(current);
  return (
    <div role="group" aria-label={section === "text" ? dict.text_title : dict.background_title} className="flex flex-col">
      <div aria-hidden="true" className="px-3 text-xs text-muted-foreground">
        {section === "text" ? dict.text_title : dict.background_title}
      </div>
      <div className="flex items-center overflow-x-auto px-2 [scrollbar-width:none]">
        {NAMED_COLORS.map((name) => (
          <Swatch
            key={name}
            section={section}
            value={name}
            label={dict.colors[name]}
            selected={current === name}
            onClick={() => applyColor(editor, section, { kind: "inline" }, name)}
          />
        ))}
        <button
          type="button"
          aria-label={t("colors.custom")}
          aria-pressed={custom}
          onMouseDown={keepFocus}
          onClick={onCustom}
          className={cn(
            "ml-1 flex h-11 shrink-0 items-center gap-1 rounded-full border border-border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            custom && "ring-2 ring-ring",
          )}
        >
          {custom && <span {...swatchAttr(section, current)} aria-hidden="true" className="bn-color-icon size-5 text-[10px]" />}
          {t("colors.custom")}
        </button>
      </div>
    </div>
  );
}

/**
 * Takes the keyboard's place (min `height`; with the keyboard back up for hex input it shrinks to content height). Applies to the editor's selection,
 * which ProseMirror keeps after blur, so focus needn't go back to the editor first.
 * On mount focus moves to the panel root (`tabIndex=-1`): the editor blur's `relatedTarget` then lands inside the toolbar, so `NotePage` still counts as editing
 * and doesn't unmount the toolbar; when a page swap unmounts the clicked button, focus returns to the root.
 */
export function ColorPanel({
  editor,
  height,
  keyboardOpen,
  inset,
  onMeasure,
}: {
  editor: MobileToolbarEditor;
  height: number;
  keyboardOpen: boolean;
  inset: number;
  onMeasure?(height: number): void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<"swatches" | ColorSection>("swatches");
  const { t } = useTranslation();
  const colors = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const styles = (current?.getActiveStyles() ?? {}) as Record<string, unknown>;
      return { text: String(styles.textColor || "default"), background: String(styles.backgroundColor || "default") };
    },
  });

  // Recompute the min height on rotation (viewport height changed), else in landscape the panel is taller than the space available.
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);
  useEffect(() => {
    const onResize = () => setViewportHeight(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !onMeasure || typeof ResizeObserver === "undefined") return;
    // No layout yet (measured 0): don't report, keep the remembered keyboard height.
    const report = () => {
      if (root.offsetHeight > 0) onMeasure(root.offsetHeight);
    };
    const observer = new ResizeObserver(report);
    observer.observe(root);
    report();
    return () => observer.disconnect();
  }, [onMeasure]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root && !root.contains(document.activeElement)) root.focus({ preventScroll: true });
  }, [page]);

  return (
    <BlockNoteScope>
      <div
        ref={rootRef}
        data-mobile-color-panel=""
        tabIndex={-1}
        role="group"
        aria-label={t("mobileToolbar.colorPanel")}
        style={{ minHeight: keyboardOpen ? 0 : Math.min(height, Math.max(0, viewportHeight - PANEL_CHROME_PX)), maxHeight: `calc(100dvh - ${inset}px - ${PANEL_CHROME_PX}px)` }}
        className="pointer-events-auto -mx-2 box-border flex w-[calc(100%+1rem)] flex-col gap-2 overflow-y-auto border-t border-border bg-card pb-[calc(0.5rem+env(safe-area-inset-bottom))] pt-2 text-foreground shadow-lg outline-none"
      >
        {page === "swatches" ? (
          <>
            <ColorRow editor={editor} section="text" current={colors.text} onCustom={() => setPage("text")} />
            <ColorRow editor={editor} section="background" current={colors.background} onCustom={() => setPage("background")} />
          </>
        ) : (
          <div className="mx-auto">
            <CustomColorPanel
              request={{ section: page, target: { kind: "inline" }, current: page === "text" ? colors.text : colors.background, byKeyboard: false, returnTo: `mobile-${sectionProp(page)}` }}
              onBack={() => setPage("swatches")}
              onApply={(hex) => {
                if (applyColor(editor, page, { kind: "inline" }, hex)) pushRecentColor(hex);
                setPage("swatches");
              }}
            />
          </div>
        )}
      </div>
    </BlockNoteScope>
  );
}
