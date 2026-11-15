import { useMemo } from "react";
import { editorHasBlockWithType } from "@blocknote/core";
import type { BlockNoteEditor } from "@blocknote/core";
import { blockTypeSelectItems, useEditorState } from "@blocknote/react";
import { linkAtSelection } from "@/components/editor/link-at-selection";
import { Link } from "@/components/ui/icons";
import { AlignIcon, CodeIcon, IndentIcon } from "@/components/ui/icons-extra";
import { BlockNoteScope } from "./BlockNoteScope";
import { MobileToolbarButton } from "./MobileToolbarButton";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any
export type MobileToolbarEditor = BlockNoteEditor<any, any, any>;

/**
 * 手機編輯工具列的模式：主列、格式（Aa）、顏色（格式列裡的顏色鈕）、區塊類型（¶）。
 * 非主列的模式由 `MobileEditToolbar` 在最前面放「返回」，其後渲染這裡對應的內容；
 * 內容元件只管自己的按鈕（用 `MobileToolbarButton`，按下不搶焦點）。
 * 顏色模式的工具列內容仍是格式列（顏色鈕呈按下），色盤另外畫在膠囊下方（`ColorPanel`）。
 */
export type MobileToolbarMode = "main" | "format" | "color" | "blockType";

export interface ModeRowProps {
  editor: MobileToolbarEditor;
  /** 目前的模式。 */
  mode: MobileToolbarMode;
  /** 切到別的模式（例如格式列的顏色鈕切到 `"color"`）；回主列用 `"main"`。 */
  setMode(mode: MobileToolbarMode): void;
  /** 連結鈕：開建立連結的對話框（與 `/` 選單的連結同一個）。 */
  onCreateLink?(): void;
}

/** 選取所在的區塊；沒有選取時是游標所在的區塊（與 BlockNote 格式工具列同一個規則）。 */
function targetBlocks(editor: MobileToolbarEditor) {
  return editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block];
}

const STYLE_BUTTONS = ["bold", "italic", "underline", "strike", "code"] as const;
type StyleName = (typeof STYLE_BUTTONS)[number];

function StyleGlyph({ style }: { style: StyleName }) {
  if (style === "code") return <CodeIcon aria-hidden="true" className="h-5 w-5" />;
  const look = { bold: "font-bold", italic: "italic", underline: "underline", strike: "line-through" }[style];
  const letter = { bold: "B", italic: "I", underline: "U", strike: "S" }[style];
  return (
    <span aria-hidden="true" className={`text-base ${look}`}>
      {letter}
    </span>
  );
}

const ALIGNMENTS = ["left", "center", "right"] as const;

/**
 * 格式列：粗體、斜體、底線、刪除線、行內程式碼、連結、對齊（靠左／置中／靠右三顆分開）、縮排與取消縮排、顏色鈕。
 * 按下狀態一律跟著選取實際的樣式。
 * 對齊做成三顆而不是循環一顆：一眼看得出現在是哪一種，點一下就到，不必先猜按幾次；列本來就能橫捲，多兩格沒有代價。
 */
export function FormatRow({ editor, mode, setMode, onCreateLink }: ModeRowProps) {
  const f = editor.dictionary.formatting_toolbar;
  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const styles = (current?.getActiveStyles() ?? {}) as Record<string, unknown>;
      const first = current ? targetBlocks(current)[0] : undefined;
      return {
        styles: Object.fromEntries(STYLE_BUTTONS.map((style) => [style, styles[style] === true])) as Record<StyleName, boolean>,
        link: linkAtSelection(current) !== undefined,
        align: first && "textAlignment" in first.props ? String(first.props.textAlignment) : "",
        canNest: current?.canNestBlock() === true,
        canUnnest: current?.canUnnestBlock() === true,
        textColor: String(styles.textColor || "default"),
        backgroundColor: String(styles.backgroundColor || "default"),
      };
    },
  });

  function setAlignment(textAlignment: (typeof ALIGNMENTS)[number]): void {
    editor.transact(() => {
      for (const block of targetBlocks(editor)) {
        if ("textAlignment" in block.props) editor.updateBlock(block, { props: { textAlignment } });
      }
    });
  }

  return (
    <>
      {STYLE_BUTTONS.map((style) => (
        <MobileToolbarButton key={style} label={f[style].tooltip} pressed={active.styles[style]} onClick={() => editor.toggleStyles({ [style]: true })}>
          <StyleGlyph style={style} />
        </MobileToolbarButton>
      ))}
      <MobileToolbarButton label={f.link.tooltip} pressed={active.link} disabled={onCreateLink === undefined} onClick={() => onCreateLink?.()}>
        <Link aria-hidden="true" className="h-5 w-5" />
      </MobileToolbarButton>
      {ALIGNMENTS.map((align) => (
        <MobileToolbarButton
          key={align}
          label={f[`align_${align}`].tooltip}
          pressed={active.align === align}
          disabled={active.align === ""}
          onClick={() => setAlignment(align)}
        >
          <AlignIcon align={align} aria-hidden="true" className="h-5 w-5" />
        </MobileToolbarButton>
      ))}
      <MobileToolbarButton label={f.nest.tooltip} disabled={!active.canNest} onClick={() => editor.nestBlock()}>
        <IndentIcon direction="in" aria-hidden="true" className="h-5 w-5" />
      </MobileToolbarButton>
      <MobileToolbarButton label={f.unnest.tooltip} disabled={!active.canUnnest} onClick={() => editor.unnestBlock()}>
        <IndentIcon direction="out" aria-hidden="true" className="h-5 w-5" />
      </MobileToolbarButton>
      <MobileToolbarButton label={f.colors.tooltip} pressed={mode === "color"} onClick={() => setMode(mode === "color" ? "format" : "color")}>
        <BlockNoteScope>
          {/* 與桌機格式工具列的顏色鈕同一個圖示：字色是目前文字色，後面的方塊是目前背景色 */}
          <span
            className="bn-color-icon pointer-events-none h-6 w-6 text-[15px] leading-6"
            data-text-color={active.textColor}
            data-background-color={active.backgroundColor}
          >
            A
          </span>
        </BlockNoteScope>
      </MobileToolbarButton>
    </>
  );
}

type BlockTypeItem = ReturnType<typeof blockTypeSelectItems>[number];

/** 桌機區塊類型選單的項目（`blockTypeSelectItems`），再依 schema 過濾；過濾邏輯同桌機的 `BlockTypeSelect`。 */
function blockTypeItemsFor(editor: MobileToolbarEditor): BlockTypeItem[] {
  return blockTypeSelectItems(editor.dictionary).filter((item) =>
    editorHasBlockWithType(
      editor,
      item.type,
      Object.fromEntries(Object.entries(item.props ?? {}).map(([name, value]) => [name, typeof value])) as Record<string, "string" | "number" | "boolean">,
    ),
  );
}

/**
 * 目前區塊對應到哪一項（-1＝沒有任何一項符合，例如表格、程式碼區塊、圖片）。
 * 桌機的 `BlockTypeSelect` 在 -1 時整個選單不出現；手機這邊對應成「¶ 鈕與所有項目停用」，
 * 否則換類型會把表格或程式碼區塊的內容清掉。
 */
function currentBlockTypeIndex(editor: MobileToolbarEditor, items: BlockTypeItem[]): number {
  const first = targetBlocks(editor)[0];
  if (!first) return -1;
  return items.findIndex(
    (item) => item.type === first.type && Object.entries(item.props ?? {}).every(([name, value]) => (first.props as Record<string, unknown>)[name] === value),
  );
}

/** 區塊類型列的項目與目前選到哪一項（-1＝目前區塊不能換類型）。 */
export function useBlockTypeState(editor: MobileToolbarEditor): { items: BlockTypeItem[]; selected: number } {
  const items = useMemo(() => blockTypeItemsFor(editor), [editor]);
  const selected = useEditorState({ editor, selector: ({ editor: current }) => (current ? currentBlockTypeIndex(current, items) : -1) });
  return { items, selected };
}

/**
 * 區塊類型列：與桌機區塊類型選單同一份項目，作用在選取（沒有選取就是游標）所在的區塊；目前的類型呈按下。
 * 目前區塊不在項目裡（表格、程式碼區塊…）時全部停用；多區塊選取時只改本身就是這些類型的區塊
 * （表格、程式碼區塊、圖片不動，不然內容會被清掉）。
 */
export function BlockTypeRow({ editor }: ModeRowProps) {
  const { items, selected } = useBlockTypeState(editor);

  function apply(index: number): void {
    const item = items[index]!;
    editor.transact(() => {
      for (const block of targetBlocks(editor)) {
        if (!items.some((candidate) => candidate.type === block.type)) continue;
        editor.updateBlock(block, { type: item.type as never, props: item.props as never });
      }
    });
  }

  return (
    <>
      {items.map((item, index) => {
        const Icon = item.icon;
        return (
          <MobileToolbarButton key={`${item.type}-${item.name}`} label={item.name} pressed={index === selected} disabled={selected === -1} onClick={() => apply(index)}>
            <span className="relative">
              <Icon size={20} aria-hidden="true" />
              {item.props?.isToggleable === true && (
                <span aria-hidden="true" className="absolute -bottom-1 -right-2 text-[10px] leading-none">
                  ▸
                </span>
              )}
            </span>
          </MobileToolbarButton>
        );
      })}
    </>
  );
}
