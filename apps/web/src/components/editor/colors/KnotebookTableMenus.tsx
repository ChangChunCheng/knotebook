import type { FC, MouseEvent } from "react";
import { mapTableCell } from "@blocknote/core";
import { TableHandlesExtension } from "@blocknote/core/extensions";
import {
  AddButton,
  DeleteButton,
  TableCellButton,
  TableHandle,
  useBlockNoteEditor,
  useComponentsContext,
  useDictionary,
  useExtension,
  useExtensionState,
  type TableCellButtonProps,
  type TableHandleProps,
} from "@blocknote/react";
import { applyColor } from "./apply-color";
import { ColorMenuBody, useColorMenu } from "./ColorMenuBody";
import { KnotebookColorPicker, type ColorSectionProps } from "./KnotebookColorPicker";
import { sectionProp, type ColorSection, type ColorTarget } from "./types";

/** Item to refocus on return from the panel; cell and row/column menus never open together, so they share one value. */
const RETURN_KEY = "tbl-colors";

type TableTarget = Extract<ColorTarget, { kind: "cell" | "rowcol" }>;

function useTableHandlesState() {
  return useExtensionState(TableHandlesExtension, {
    selector: (s) => ({ block: s?.block, rowIndex: s?.rowIndex, colIndex: s?.colIndex }),
  });
}

/** `target` carries only the block id and indices: the latest table is read on apply, so words others changed while the panel is open aren't overwritten. */
function TableColorsItem({ target, current }: { target: TableTarget; current: (section: ColorSection) => string }) {
  const Components = useComponentsContext()!;
  const dict = useDictionary();
  const editor = useBlockNoteEditor();
  const menu = useColorMenu()!;
  const { cellTextColor, cellBackgroundColor } = editor.settings.tables;
  if (!cellTextColor && !cellBackgroundColor) return null;

  const sectionProps = (section: ColorSection): ColorSectionProps => {
    const color = current(section);
    return {
      color,
      setColor: (c) => applyColor(editor, section, target, c),
      onCustom: (e: MouseEvent) =>
        menu.openPanel({ section, target, current: color, byKeyboard: e.detail === 0, returnTo: RETURN_KEY }),
    };
  };

  return (
    <Components.Generic.Menu.Root position="right" sub>
      <Components.Generic.Menu.Trigger sub>
        <Components.Generic.Menu.Item className="bn-menu-item" subTrigger data-kb-color-return={RETURN_KEY}>
          {dict.drag_handle.colors_menuitem}
        </Components.Generic.Menu.Item>
      </Components.Generic.Menu.Trigger>
      <Components.Generic.Menu.Dropdown sub className="bn-menu-dropdown bn-color-picker-dropdown">
        <KnotebookColorPicker
          returnPrefix="tbl"
          text={cellTextColor ? sectionProps("text") : undefined}
          background={cellBackgroundColor ? sectionProps("background") : undefined}
        />
      </Components.Generic.Menu.Dropdown>
    </Components.Generic.Menu.Root>
  );
}

function TableCellColorsItem() {
  const { block, rowIndex, colIndex } = useTableHandlesState();
  if (block === undefined || rowIndex === undefined || colIndex === undefined) return null;
  const cell = block.content.rows[rowIndex]?.cells[colIndex];
  if (!cell) return null;
  const props = mapTableCell(cell).props as Record<string, unknown>;
  return (
    <TableColorsItem
      target={{ kind: "cell", blockId: block.id, rowIndex, colIndex }}
      current={(section) => String(props[sectionProp(section)] ?? "default")}
    />
  );
}

/** Current colour is the first cell's only if every cell in the row/column matches; otherwise "automatic". */
function TableRowColColorsItem({ orientation }: { orientation: "row" | "column" }) {
  const tableHandles = useExtension(TableHandlesExtension);
  const { block, rowIndex, colIndex } = useTableHandlesState();
  const index = orientation === "row" ? rowIndex : colIndex;
  if (block === undefined || index === undefined) return null;
  const cells = orientation === "row" ? tableHandles.getCellsAtRowHandle(block, index) : tableHandles.getCellsAtColumnHandle(block, index);
  if (cells.length === 0) return null;
  const values = (section: ColorSection) =>
    cells.map(({ cell }) => String((mapTableCell(cell).props as Record<string, unknown>)[sectionProp(section)] ?? "default"));
  return (
    <TableColorsItem
      target={{ kind: "rowcol", blockId: block.id, orientation, index }}
      current={(section) => {
        const [first, ...rest] = values(section);
        return rest.every((v) => v === first) ? first! : "default";
      }}
    />
  );
}

/** No header toggle: the editor doesn't enable `headers`. className matches BlockNote's own row/column menu. */
export function KnotebookTableHandleMenu({ orientation }: { orientation: "row" | "column" }) {
  const Components = useComponentsContext()!;
  return (
    <Components.Generic.Menu.Dropdown className="bn-table-handle-menu">
      <ColorMenuBody>
        <DeleteButton orientation={orientation} />
        {orientation === "row" ? (
          <>
            <AddButton orientation="row" side="above" />
            <AddButton orientation="row" side="below" />
          </>
        ) : (
          <>
            <AddButton orientation="column" side="left" />
            <AddButton orientation="column" side="right" />
          </>
        )}
        <TableRowColColorsItem orientation={orientation} />
      </ColorMenuBody>
    </Components.Generic.Menu.Dropdown>
  );
}

/** Colour item only (cell splitting is off). className matches BlockNote's own cell menu. */
export function KnotebookTableCellMenu() {
  const Components = useComponentsContext()!;
  return (
    <Components.Generic.Menu.Dropdown className="bn-menu-dropdown bn-table-handle-menu">
      <ColorMenuBody>
        <TableCellColorsItem />
      </ColorMenuBody>
    </Components.Generic.Menu.Dropdown>
  );
}

// `TableHandle`'s `tableHandleMenu` is typed as a prop-less FC but receives `orientation` at runtime.
const tableHandleMenu = KnotebookTableHandleMenu as FC;

/** Module-level components (stable identity): BlockNote's row/column and cell handles with their menu replaced by `KnotebookTableHandleMenu` / `KnotebookTableCellMenu`. */
export function KnotebookTableHandle(props: TableHandleProps) {
  return <TableHandle {...props} tableHandleMenu={tableHandleMenu} />;
}

export function KnotebookTableCellButton(props: TableCellButtonProps) {
  return <TableCellButton {...props} tableCellMenu={KnotebookTableCellMenu} />;
}
