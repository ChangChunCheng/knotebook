import { useMemo } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { useEditorState } from "@blocknote/react";
import { applyBlockType, blockTypeItemsFor, currentBlockTypeIndex, targetBlocks, type BlockTypeItem } from "@/components/editor/block-type-items";
import { linkAtSelection } from "@/components/editor/link-at-selection";
import { Link } from "@/components/ui/icons";
import { AlignIcon, CodeIcon, IndentIcon } from "@/components/ui/icons-extra";
import { BlockNoteScope } from "./BlockNoteScope";
import { MobileToolbarButton } from "./MobileToolbarButton";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor generic triple (repo convention)
export type MobileToolbarEditor = BlockNoteEditor<any, any, any>;

/** In colour mode the toolbar content is still the format row (colour button pressed); the panel is drawn below the pill (`ColorPanel`). */
export type MobileToolbarMode = "main" | "format" | "color" | "blockType";

export interface ModeRowProps {
  editor: MobileToolbarEditor;
  mode: MobileToolbarMode;
  setMode(mode: MobileToolbarMode): void;
  onCreateLink?(): void;
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

/** Alignment is three buttons, not one that cycles: the current state is visible and one tap reaches it; the row scrolls anyway. */
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
          {/* Same icon as the desktop colour button */}
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

export function useBlockTypeState(editor: MobileToolbarEditor): { items: BlockTypeItem[]; selected: number } {
  const items = useMemo(() => blockTypeItemsFor(editor), [editor]);
  const selected = useEditorState({ editor, selector: ({ editor: current }) => (current ? currentBlockTypeIndex(current, items) : -1) });
  return { items, selected };
}

export function BlockTypeRow({ editor }: ModeRowProps) {
  const { items, selected } = useBlockTypeState(editor);

  function apply(index: number): void {
    applyBlockType(editor, items[index]!, items);
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
