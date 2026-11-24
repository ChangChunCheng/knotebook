import { BlockNoteEditor, type Block } from "@blocknote/core";
import { DEFAULT_KNOWLEDGE_FIELD_VIEW, blocksToNoteMarkdown, createHeadlessNoteSchema, wikilinksToLinks } from "@knotebook/shared";

// Same headless schema and blocksToNoteMarkdown as the server read path. Created once, never mounted.
let serializer: ReturnType<typeof createSerializer> | null = null;
function createSerializer() {
  return BlockNoteEditor.create({ schema: createHeadlessNoteSchema(window.location.href) });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple, repo convention
export function aiMarkdownOf(blocks: readonly Block<any, any, any>[], titleOf: (id: string) => string | undefined, opts?: { knowledge?: boolean }): string {
  serializer ??= createSerializer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- page editor and headless schema share config but differ in generics
  return blocksToNoteMarkdown(serializer, wikilinksToLinks(blocks, titleOf) as any, opts?.knowledge === true ? { knowledge: { fields: DEFAULT_KNOWLEDGE_FIELD_VIEW } } : {});
}
