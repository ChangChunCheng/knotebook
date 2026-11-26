import { useEffect, useRef, useState, type JSX } from "react";
import { createReactBlockSpec, type ReactCustomBlockRenderProps } from "@blocknote/react";
import { MERMAID_LANGUAGE, mermaidBlockConfig } from "@knotebook/shared";
import { useTheme } from "@/theme";
import { consumeMermaidEdit, peekMermaidEdit } from "./auto-edit";
import { MermaidView } from "./MermaidView";

// These live in `@knotebook/shared` (`note-schema-config.ts`) so the server's headless schema shares them. They are
// imported above because a bare `export { … } from …` creates no local binding, and re-exported so existing consumers
// (`spec.test.tsx`) keep importing from `./spec`.
export { MERMAID_LANGUAGE, mermaidBlockConfig };

/**
 * Exports a ```mermaid code block, not rendered SVG: it renders on GitHub/Obsidian, elsewhere the source is still
 * visible and editable, SVG is long and uneditable, and it avoids exported SVGs carrying external resources (why
 * file blocks use `withGuardedExternalHTML`, #43). `{code}` as a JSX child is escaped by React, so markup in the
 * source stays text.
 */
export function MermaidExternalHTML({ code }: { code: string }): JSX.Element {
  return (
    <pre>
      <code className={`language-${MERMAID_LANGUAGE}`}>{code}</code>
    </pre>
  );
}

/**
 * Deliberately no `parse` rule: BlockNote's built-in codeBlock `pre` rule has higher priority, so such a
 * rule is never called: HTML paste always becomes `codeBlock(language="mermaid")` first. `collab/mermaid-paste.ts`
 * does the conversion for HTML and markdown paste. Before adding a `parse` rule, prove with an
 * `editor.tryParseHTMLToBlocks(...)` test that it is called (`spec.test.tsx` pins the opposite); tests that call
 * the exported function directly bypass BlockNote and pass falsely.
 */

type MermaidRenderProps = ReactCustomBlockRenderProps<typeof mermaidBlockConfig>;

/**
 * `updateBlock` throws (`Block with ID … not found`) if a remote peer deleted the block while its source is open and
 * Esc/blur commits; swallowed because there is nowhere left to write (thrown from a React event handler, the user's
 * edit would just vanish silently). Same handling as `collab/mermaid-paste.ts` for `replaceBlocks`.
 */
export function commitCode(editor: MermaidRenderProps["editor"], block: MermaidRenderProps["block"], code: string): void {
  try {
    editor.updateBlock(block, { props: { code } });
  } catch {
    /* block deleted remotely */
  }
}

/** `useTheme()` is read here because BlockNote calls render, leaving no way to pass props; `ThemeProvider` is at the app root. */
function MermaidBlock({ block, editor }: MermaidRenderProps): JSX.Element {
  const { resolvedTheme } = useTheme();
  const [initiallyEditing] = useState(() => peekMermaidEdit(block.id));
  useEffect(() => consumeMermaidEdit(block.id), [block.id]);
  // Only the editor that opened by itself hands focus back: the textarea took it from the note, and Esc would otherwise leave it on the page body.
  const returnFocus = useRef(initiallyEditing);
  return (
    <MermaidView
      code={block.props.code}
      editable={editor.isEditable}
      initiallyEditing={initiallyEditing}
      onClose={(viaEscape) => {
        const handBack = returnFocus.current && viaEscape;
        returnFocus.current = false;
        if (handBack) editor.focus();
      }}
      theme={resolvedTheme}
      onChange={(code) => commitCode(editor, block, code)}
    />
  );
}

/**
 * Factory, unlike `createReactInlineContentSpec` (which returns the spec): call it when registering in
 * `collab/schema.ts` (`mermaid: mermaidSpec()`). Without the call the type looks similar but it isn't a block spec at runtime.
 */
export const mermaidSpec = createReactBlockSpec(mermaidBlockConfig, {
  render: MermaidBlock,
  toExternalHTML: ({ block }: MermaidRenderProps) => <MermaidExternalHTML code={block.props.code} />,
});
