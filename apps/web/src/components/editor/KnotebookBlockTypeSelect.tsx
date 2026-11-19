import { useMemo } from "react";
import { useBlockNoteEditor, useComponentsContext, useEditorState } from "@blocknote/react";
import { applyBlockType, blockTypeItemsFor, currentBlockTypeIndex } from "./block-type-items";

/**
 * Replaces BlockNote's `BlockTypeSelect` (#464): with a multi-block selection the built-in converts every selected block,
 * including tables and images that aren't menu items, wiping their content. Here only blocks whose type is a menu item change,
 * in one transaction and its own undo step.
 * Items, order, icons and the check rule match the built-in.
 */
export function KnotebookBlockTypeSelect() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor();
  const items = useMemo(() => blockTypeItemsFor(editor), [editor]);
  const selected = useEditorState({
    editor,
    selector: ({ editor: current }) => currentBlockTypeIndex(current, items),
  });

  if (selected === -1 || !editor.isEditable) return null;

  return (
    <Components.FormattingToolbar.Select
      className="bn-select"
      items={items.map((item, index) => {
        const Icon = item.icon;
        return {
          text: item.name,
          icon: <Icon size={16} />,
          onClick: () => {
            editor.focus();
            applyBlockType(editor, item, items);
          },
          isSelected: index === selected,
        };
      })}
    />
  );
}
