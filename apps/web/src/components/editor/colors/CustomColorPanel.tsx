import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type Ref,
} from "react";
import { useTranslation } from "react-i18next";
import { isCustomColor } from "@knotebook/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { readRecentColors } from "@/lib/recent-colors";
import { parseHexInput } from "./hex-input";
import type { PanelRequest } from "./types";

const ColorfulPicker = lazy(() => import("./ColorfulPicker"));

interface CustomColorPanelProps {
  request: PanelRequest;
  onBack(): void;
  onApply(hex: string): void;
  pinFocus?: boolean;
  ref?: Ref<HTMLDivElement>;
}

const AUTOFOCUS = "data-autofocus";

/**
 * Makes the outer Mantine `useFocusTrap` (format toolbar) refocus onto the panel's currently focused element.
 * The toolbar repaints (e.g. a co-editor typing before the selection remaps it) and the trap re-runs `focusNode`,
 * moving focus to the first `[data-autofocus]` (else first tabbable), so later typing misses the hex field.
 * `data-autofocus` on the focused element turns that into `.focus()` on itself. The dropdown's own initial-focus
 * placeholder carries the attribute too and precedes the panel: it is removed while the panel has focus and restored on leave/unmount.
 * Drag-handle and table-handle menus have no such trap.
 */
function usePinnedFocus(enabled: boolean, rootRef: { current: HTMLDivElement | null }) {
  const state = useRef<{ marked: HTMLElement | null; stripped: HTMLElement[] }>({ marked: null, stripped: [] });

  const release = useCallback(() => {
    const { marked, stripped } = state.current;
    marked?.removeAttribute(AUTOFOCUS);
    for (const el of stripped) el.setAttribute(AUTOFOCUS, "true");
    state.current = { marked: null, stripped: [] };
  }, []);

  useEffect(() => release, [release]);

  if (!enabled) return {};
  return {
    onFocus: (e: FocusEvent<HTMLDivElement>) => {
      const root = rootRef.current;
      const target = e.target;
      if (!root) return;
      const s = state.current;
      if (s.marked && s.marked !== target) s.marked.removeAttribute(AUTOFOCUS);
      root
        .closest("[data-menu-dropdown]")
        ?.querySelectorAll<HTMLElement>(`[${AUTOFOCUS}]`)
        .forEach((el) => {
          if (root.contains(el)) return;
          el.removeAttribute(AUTOFOCUS);
          s.stripped.push(el);
        });
      target.setAttribute(AUTOFOCUS, "");
      s.marked = target;
    },
    onBlur: (e: FocusEvent<HTMLDivElement>) => {
      if (!rootRef.current?.contains(e.relatedTarget as Node | null)) release();
    },
  };
}

function panelTabbables(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]")).filter(
    (el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled,
  );
}

function initialHex(current: string): string {
  if (isCustomColor(current)) return current;
  return readRecentColors()[0] ?? "#";
}

/** Plain `<button>`s, not Menu.Item: its tabIndex is -1, so Tab can't reach it. */
export function CustomColorPanel({ request, onBack, onApply, pinFocus = false, ref }: CustomColorPanelProps) {
  const { t } = useTranslation();
  const errorId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(() => initialHex(request.current));
  const [shown, setShown] = useState<string | undefined>(() => parseHexInput(text) ?? undefined);
  const [recent] = useState(readRecentColors);
  const parsed = parseHexInput(text);
  // Only "#" or blank means nothing typed yet: not flagged as an error, but can't be applied.
  const invalid = parsed === null && text.trim() !== "" && text.trim() !== "#";
  const pinned = usePinnedFocus(pinFocus, rootRef);

  // The clicked "Custom…" unmounts with the item list and focus falls to body; the root menu treats keydown outside the dropdown as click-outside and closes,
  // so focus must enter the panel on mount: hex field for mouse/trackpad/keyboard, panel root for touch (no on-screen keyboard).
  useLayoutEffect(() => {
    const fine = window.matchMedia?.("(pointer: fine)").matches ?? false;
    const target = fine || request.byKeyboard ? inputRef.current : rootRef.current;
    target?.focus({ preventScroll: true });
    // Focus is decided once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stable callback ref: a new function each render makes React call it again with null, then the node.
  const setRootRef = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  const update = (value: string) => {
    setText(value);
    const hex = parseHexInput(value);
    if (hex) setShown(hex);
  };

  // Block only ArrowUp/ArrowDown: Mantine's MenuDropdown preventDefaults them and moves focus to a menu item, freezing the hex field caret.
  // Other keys (Tab, Escape) must propagate: the dropdown's Tab wrap, the toolbar focus trap and click-outside close all listen on document.
  //
  // Tab wraps inside the panel first: if the panel's last element is also the toolbar's last (e.g. table cell selected, no button after colour),
  // the document-level trap would wrap focus to the toolbar's first button and the next key would close the menu. With focus already moved, the trap doesn't intervene.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.stopPropagation();
      return;
    }
    if (e.key !== "Tab" || e.defaultPrevented) return;
    const items = panelTabbables(rootRef.current);
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (!e.shiftKey && e.target === last) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && e.target === first) {
      e.preventDefault();
      last.focus();
    }
  };

  const previewAttr = request.section === "text" ? { "data-text-color": shown } : { "data-background-color": shown };

  return (
    <div
      ref={setRootRef}
      // 200px (react-colorful's fixed width) + p-1 each side; colours come from BlockNote's menu variables, not the frame.
      className="kb-color-panel flex w-[208px] flex-col gap-2 bg-(--bn-colors-menu-background) p-1 text-(--bn-colors-menu-text) outline-none"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      {...pinned}
    >
      <Button type="button" variant="ghost" size="sm" className="self-start" onClick={onBack}>
        <span aria-hidden="true">←</span>
        {t("colors.back")}
      </Button>
      <Suspense fallback={<div data-kb-color-picker-fallback="" className="h-[200px] w-[200px]" />}>
        <ColorfulPicker
          color={shown}
          onChange={update}
          saturationLabel={t("colors.saturation_label")}
          hueLabel={t("colors.hue_label")}
        />
      </Suspense>
      <div className="flex items-center gap-2">
        <span
          {...previewAttr}
          aria-hidden="true"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-input text-sm"
        >
          Aa
        </span>
        <Input
          ref={inputRef}
          value={text}
          onChange={(e) => update(e.target.value)}
          onKeyDown={(e) => {
            // An Enter that confirms IME composition is not "apply".
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            e.preventDefault();
            if (parsed) onApply(parsed);
          }}
          aria-label={t("colors.hex_label")}
          placeholder={t("colors.hex_placeholder")}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={invalid ? errorId : undefined}
          spellCheck={false}
          autoComplete="off"
          className={invalid ? "min-w-0 flex-1 border-destructive" : "min-w-0 flex-1"}
        />
      </div>
      {invalid && (
        <p id={errorId} className="text-xs text-destructive">
          {t("colors.hex_invalid")}
        </p>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="border border-input"
        disabled={parsed === null}
        onClick={() => {
          if (parsed) onApply(parsed);
        }}
      >
        {t("colors.apply")}
      </Button>
      {recent.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="px-1 text-xs text-muted-foreground">{t("colors.recent")}</div>
          <div className="flex flex-wrap gap-0.5">
            {recent.map((hex) => (
              <Button key={hex} type="button" variant="ghost" size="icon" aria-label={hex} onClick={() => onApply(hex)}>
                <span data-background-color={hex} className="h-5 w-5 rounded-sm border border-input" />
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
