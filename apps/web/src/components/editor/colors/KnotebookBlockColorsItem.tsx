import type { MouseEvent, ReactNode } from "react";
import { blockHasType, editorHasBlockWithType } from "@blocknote/core";
import { SideMenuExtension } from "@blocknote/core/extensions";
import { useBlockNoteEditor, useComponentsContext, useExtensionState } from "@blocknote/react";
import { applyColor } from "./apply-color";
import { useColorMenu } from "./ColorMenuBody";
import { KnotebookColorPicker, type ColorSectionProps } from "./KnotebookColorPicker";
import { sectionProp, type ColorSection } from "./types";

const RETURN_KEY = "dh-colors";

/** A section shows only when the editor schema gives the block that string prop (same check as upstream); neither → item hidden (e.g. codeBlock). Must be inside `ColorMenuBody`. */
export function KnotebookBlockColorsItem({ children }: { children: ReactNode }) {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor();
  const menu = useColorMenu()!;
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });

  if (block === undefined) return null;

  const has = (section: ColorSection) => {
    const want = { [sectionProp(section)]: "string" } as const;
    return blockHasType(block, editor, block.type, want) && editorHasBlockWithType(editor, block.type, want);
  };
  const textOk = has("text");
  const bgOk = has("background");
  if (!textOk && !bgOk) return null;

  const target = { kind: "block", blockId: block.id } as const;
  const sectionProps = (section: ColorSection): ColorSectionProps => {
    const current = String((block.props as Record<string, unknown>)[sectionProp(section)] ?? "default");
    return {
      color: current,
      setColor: (c) => applyColor(editor, section, target, c),
      onCustom: (e: MouseEvent) =>
        menu.openPanel({ section, target, current, byKeyboard: e.detail === 0, returnTo: RETURN_KEY }),
    };
  };

  return (
    <Components.Generic.Menu.Root position="right" sub>
      <Components.Generic.Menu.Trigger sub>
        <Components.Generic.Menu.Item className="bn-menu-item" subTrigger data-kb-color-return={RETURN_KEY}>
          {children}
        </Components.Generic.Menu.Item>
      </Components.Generic.Menu.Trigger>
      <Components.Generic.Menu.Dropdown sub className="bn-menu-dropdown bn-color-picker-dropdown">
        <KnotebookColorPicker
          returnPrefix="dh"
          text={textOk ? sectionProps("text") : undefined}
          background={bgOk ? sectionProps("background") : undefined}
        />
      </Components.Generic.Menu.Dropdown>
    </Components.Generic.Menu.Root>
  );
}
