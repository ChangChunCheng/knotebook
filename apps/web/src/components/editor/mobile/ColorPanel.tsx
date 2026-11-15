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

/** 膠囊（52）＋間距與上緣留白：色盤最高只能到「可視高度 − 這個值」。 */
const PANEL_CHROME_PX = 112;

const keepFocus = (event: MouseEvent) => event.preventDefault();

function swatchAttr(section: ColorSection, value: string) {
  return section === "text" ? { "data-text-color": value } : { "data-background-color": value };
}

/** 色票：視覺 32、點擊區 44；目前套用中的那格加外圈。 */
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
 * 色盤：鍵盤收下去之後佔著鍵盤原本的位置（最少 `height`，鍵盤又升起時＝輸入色碼，改成貼內容高）。
 * 上面一列文字色、下面一列背景色，每列最後是「自訂…」，點了在這裡換頁（沿用桌機的 `CustomColorPanel`、`applyColor`，不另寫顏色邏輯）。
 * 套用到編輯器目前的選取：編輯器失焦後 ProseMirror 的選取還在，所以不必先把焦點還給編輯器。
 *
 * 焦點：掛上時先把焦點移到這個面板根（`tabIndex=-1`）。這樣編輯器失焦時 `relatedTarget` 落在工具列內，
 * `NotePage` 仍判定在編輯中、工具列不會卸載；換頁時被點的按鈕隨頁面卸載，也會把焦點收回面板根。
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
  /** 色盤實際高度（換頁、轉向都會變）；文件尾端的空白與游標避讓靠它。 */
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

  // 轉向（視窗高度變了）時重算最小高度，不然橫拿時色盤比可用高度還高。
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);
  useEffect(() => {
    const onResize = () => setViewportHeight(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !onMeasure || typeof ResizeObserver === "undefined") return;
    // 還沒有版面（量到 0）就不報，沿用記下的鍵盤高
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
