import { useCallback } from "react";
import { blockHasType } from "@blocknote/core";
import { useBlockNoteEditor, useComponentsContext, useDictionary, useEditorState } from "@blocknote/react";
import { removeBlocksKeepColumns } from "@/collab/columns/keep-columns";
import { Trash } from "@/components/ui/icons";

/**
 * Replaces BlockNote's `FileDeleteButton` (swapped in by `AiToolbar` via key `fileDeleteButton`). Deleting goes through `keep-columns.ts`,
 * so removing an image inside a column doesn't collapse the column. Own `Trash` icon: the native one comes from `react-icons`, unreachable from apps/web.
 */
export function KnotebookFileDeleteButton() {
  const dict = useDictionary();
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor();

  const block = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      if (!current.isEditable) return undefined;
      const selected = current.getSelection()?.blocks || [current.getTextCursorPosition().block];
      if (selected.length !== 1) return undefined;
      const only = selected[0]!;
      if (!blockHasType(only, current, only.type, { url: "string" })) return undefined;
      return only;
    },
  });

  const onClick = useCallback(() => {
    if (block === undefined) return;
    editor.focus();
    removeBlocksKeepColumns(editor, [block.id]);
  }, [block, editor]);

  if (block === undefined) return null;
  const tooltip = dict.formatting_toolbar.file_delete.tooltip[block.type] || dict.formatting_toolbar.file_delete.tooltip["file"];
  return (
    <Components.FormattingToolbar.Button
      className="bn-button"
      data-kb-file-delete=""
      label={tooltip}
      mainTooltip={tooltip}
      icon={<Trash className="h-4 w-4" />}
      onClick={onClick}
    />
  );
}
