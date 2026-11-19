import type { MouseEvent } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { useBlockNoteEditor, useComponentsContext, useDictionary, useEditorState } from "@blocknote/react";
import { applyColor } from "./apply-color";
import { ColorMenuBody, useColorMenu } from "./ColorMenuBody";
import { KnotebookColorPicker, type ColorSectionProps } from "./KnotebookColorPicker";
import { sectionProp, type ColorSection } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple (repo convention)
type AnyEditor = BlockNoteEditor<any, any, any>;

function hasColorStyle(editor: AnyEditor, section: ColorSection): boolean {
  const prop = sectionProp(section);
  const spec = editor.schema.styleSchema[prop];
  return spec !== undefined && spec.type === prop && spec.propSchema === "string";
}

interface ToolbarColors {
  textColor: string | undefined;
  backgroundColor: string | undefined;
}

function ToolbarColorItems({ colors }: { colors: ToolbarColors }) {
  const editor = useBlockNoteEditor();
  const menu = useColorMenu()!;

  const sectionProps = (section: ColorSection, current: string | undefined): ColorSectionProps | undefined => {
    if (current === undefined) return undefined;
    return {
      color: current,
      setColor: (c) => {
        applyColor(editor, section, { kind: "inline" }, c);
        // Return focus to the editor only after the menu closed and the toolbar's focus trap let go.
        setTimeout(() => editor.focus());
      },
      onCustom: (e: MouseEvent) =>
        menu.openPanel({
          section,
          target: { kind: "inline" },
          current,
          byKeyboard: e.detail === 0,
          returnTo: `tb-${section}`,
        }),
    };
  };

  return (
    <KnotebookColorPicker
      returnPrefix="tb"
      text={sectionProps("text", colors.textColor)}
      background={sectionProps("background", colors.backgroundColor)}
    />
  );
}

/** Shown under the same conditions as the native button (hidden when the editor is read-only, none of the selected blocks (or the caret block) has inline content, or the schema has no colour style). */
export function KnotebookColorStyleButton() {
  const Components = useComponentsContext()!;
  const dict = useDictionary();
  const editor = useBlockNoteEditor();

  const colors = useEditorState({
    editor,
    selector: ({ editor: current }): ToolbarColors | undefined => {
      if (!current.isEditable) return undefined;
      const blocks = current.getSelection()?.blocks ?? [current.getTextCursorPosition().block];
      if (!blocks.some((b) => b.content !== undefined)) return undefined;
      const text = hasColorStyle(current, "text");
      const background = hasColorStyle(current, "background");
      if (!text && !background) return undefined;
      const styles = current.getActiveStyles() as { textColor?: string; backgroundColor?: string };
      return {
        textColor: text ? styles.textColor || "default" : undefined,
        backgroundColor: background ? styles.backgroundColor || "default" : undefined,
      };
    },
  });

  if (colors === undefined) return null;

  return (
    <Components.Generic.Menu.Root>
      <Components.Generic.Menu.Trigger>
        <Components.FormattingToolbar.Button
          className="bn-button"
          data-test="colors"
          label={dict.formatting_toolbar.colors.tooltip}
          mainTooltip={dict.formatting_toolbar.colors.tooltip}
          icon={
            <span
              className="bn-color-icon pointer-events-none h-5 w-5 text-[15px] leading-5"
              data-text-color={colors.textColor}
              data-background-color={colors.backgroundColor}
            >
              A
            </span>
          }
        />
      </Components.Generic.Menu.Trigger>
      <Components.Generic.Menu.Dropdown className="bn-menu-dropdown bn-color-picker-dropdown">
        {/* pinFocus: the toolbar's focus trap steals focus on repaint; drag/table handle menus have none */}
        <ColorMenuBody pinFocus>
          <ToolbarColorItems colors={colors} />
        </ColorMenuBody>
      </Components.Generic.Menu.Dropdown>
    </Components.Generic.Menu.Root>
  );
}
