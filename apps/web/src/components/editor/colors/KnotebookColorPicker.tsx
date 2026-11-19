import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { isCustomColor } from "@knotebook/shared";
import { useComponentsContext, useDictionary } from "@blocknote/react";
import { KeepOpenMenuItem } from "./KeepOpenMenuItem";
import type { ColorSection } from "./types";

export const NAMED_COLORS = ["default", "gray", "brown", "red", "orange", "yellow", "green", "blue", "purple", "pink"] as const;

export interface ColorSectionProps {
  color: string;
  setColor(c: string): void;
  onCustom(e: MouseEvent): void;
}

interface KnotebookColorPickerProps {
  text?: ColorSectionProps;
  background?: ColorSectionProps;
  /** `data-kb-color-return` prefix of "Custom…": used to find the item to refocus on return; must be unique within one dropdown. */
  returnPrefix: string;
}

function ColorSwatch({ section, value }: { section: ColorSection; value: string | undefined }) {
  const attr = section === "text" ? { "data-text-color": value } : { "data-background-color": value };
  return (
    <span {...attr} aria-hidden="true" className="bn-color-icon pointer-events-none h-4 w-4 text-xs leading-4">
      {value === undefined ? null : "A"}
    </span>
  );
}

function Section({ section, props, returnPrefix }: { section: ColorSection; props: ColorSectionProps; returnPrefix: string }) {
  const Components = useComponentsContext()!;
  const dict = useDictionary();
  const { t } = useTranslation();
  const { color, setColor, onCustom } = props;
  const custom = isCustomColor(color);
  return (
    <>
      <Components.Generic.Menu.Label>
        {section === "text" ? dict.color_picker.text_title : dict.color_picker.background_title}
      </Components.Generic.Menu.Label>
      {NAMED_COLORS.map((c) => (
        <Components.Generic.Menu.Item
          key={c}
          data-test={`${section}-color-${c}`}
          icon={<ColorSwatch section={section} value={c} />}
          checked={color === c}
          onClick={() => setColor(c)}
        >
          {dict.color_picker.colors[c]}
        </Components.Generic.Menu.Item>
      ))}
      {/* Swaps in the panel within the same dropdown, so unlike other items it must not close the menu */}
      <KeepOpenMenuItem
        data-test={`${section}-color-custom`}
        data-kb-color-return={`${returnPrefix}-${section}`}
        icon={<ColorSwatch section={section} value={custom ? color : undefined} />}
        checked={custom}
        onClick={onCustom}
      >
        {t("colors.custom")}
      </KeepOpenMenuItem>
    </>
  );
}

/** Checkmarks: built-in colours keep BlockNote's `data-test` values and tick only on an exact name match; "Custom…" only when the current value is a canonical hex code, so a non-canonical legacy value (e.g. pasted `rgb(…)`) ticks nothing. */
export function KnotebookColorPicker({ text, background, returnPrefix }: KnotebookColorPickerProps) {
  return (
    <>
      {text && <Section section="text" props={text} returnPrefix={returnPrefix} />}
      {background && <Section section="background" props={background} returnPrefix={returnPrefix} />}
    </>
  );
}
