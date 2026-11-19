import type { QueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import type { NoteDto } from "@knotebook/shared";
import { COLUMN_LIST_TYPE, COLUMN_TYPE } from "@knotebook/shared";
import { api } from "@/api/client";
import { replaceBlocksKeepColumns } from "@/collab/columns/keep-columns";
import "@/i18n/tour-strings";
import type { TourEditor } from "@/lib/tour-bridge";


export async function createSampleNote(queryClient: QueryClient, t: TFunction): Promise<NoteDto> {
  const note = await api<NoteDto>("/api/notes", {
    method: "POST",
    body: JSON.stringify({ title: t("tourGuide.sample.title") }),
  });
  void queryClient.invalidateQueries({ queryKey: ["notes"] });
  return note;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple (repo convention)
type SampleBlock = Record<string, any>;

const text = (value: string) => [{ type: "text" as const, text: value, styles: {} }];

const para = (value: string): SampleBlock => ({ type: "paragraph", content: text(value) });

/** With AI configured (`hasAi`) the second-to-last paragraph is the sentence the AI step selects; otherwise it is omitted. The last paragraph is empty (the cursor target for later steps). */
export function buildSampleBlocks(
  t: TFunction,
  note: Pick<NoteDto, "id" | "title">,
  hasAi: boolean,
): SampleBlock[] {
  const s = (key: string) => t(`tourGuide.sample.${key}`);
  return [
    para(s("intro")),
    { type: "heading", props: { level: 2 }, content: text(s("heading")) },
    { type: "bulletListItem", content: text(s("bullet1")) },
    { type: "bulletListItem", content: text(s("bullet2")) },
    { type: "numberedListItem", content: text(s("number1")) },
    { type: "numberedListItem", content: text(s("number2")) },
    { type: "checkListItem", props: { checked: true }, content: text(s("todoDone")) },
    { type: "checkListItem", props: { checked: false }, content: text(s("todoOpen")) },
    { type: "quote", content: text(s("quote")) },
    { type: "codeBlock", props: { language: "javascript" }, content: text(s("code")) },
    {
      type: "paragraph",
      content: [
        ...text(s("linkBefore")),
        { type: "wikilink", props: { targetNoteId: note.id, snapshotTitle: note.title, label: "", anchorBlockId: "" } },
        ...text(s("linkAfter")),
      ],
    },
    {
      type: COLUMN_LIST_TYPE,
      children: [
        { type: COLUMN_TYPE, props: { width: 1 }, children: [para(s("columnLeft"))] },
        {
          type: COLUMN_TYPE,
          props: { width: 1 },
          children: [{ type: "bulletListItem", content: text(s("columnRight")) }],
        },
      ],
    },
    { type: "mermaid", props: { code: s("mermaidCode") } },
    {
      type: "table",
      content: {
        type: "tableContent",
        rows: [
          { cells: [text(s("tableName")), text(s("tableValue"))] },
          { cells: [text(s("tableRow1Name")), text(s("tableRow1Value"))] },
        ],
      },
    },
    ...(hasAi ? [para(s("aiSentence"))] : []),
    { type: "paragraph" },
  ];
}

type PmDoc = Parameters<Parameters<TourEditor["transact"]>[0]>[0]["doc"];

/** BlockNote's empty doc is doc > blockGroup > blockContainer > paragraph (`descendants` excludes doc itself, hence 3). */
function isSingleEmptyParagraph(doc: PmDoc): boolean {
  if (doc.textContent !== "") return false;
  const kinds: string[] = [];
  doc.descendants((node) => {
    kinds.push(node.type.name);
  });
  return kinds.length === 3 && kinds[1] === "blockContainer" && kinds[2] === "paragraph";
}

/** Emptiness is judged inside the same transaction against its `doc`: computed outside, a keystroke from another tab that syncs later would be overwritten. Written as not undoable: otherwise one extra Ctrl+Z undoes the whole sample. */
export function seedSampleNote(
  editor: TourEditor,
  note: Pick<NoteDto, "id" | "title">,
  t: TFunction,
  hasAi: boolean,
): boolean {
  let written = false;
  editor.transact((tr) => {
    if (!isSingleEmptyParagraph(tr.doc)) return;
    tr.setMeta("addToHistory", false);
    replaceBlocksKeepColumns(
      editor,
      editor.document.map((block) => block.id),
      buildSampleBlocks(t, note, hasAi),
    );
    written = true;
  });
  return written;
}
