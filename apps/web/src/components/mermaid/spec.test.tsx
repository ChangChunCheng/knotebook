import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { BlockNoteEditor } from "@blocknote/core";
import { noteSchema } from "@/collab/schema";
import { MERMAID_LANGUAGE, MermaidExternalHTML, commitCode, mermaidBlockConfig } from "./spec";

describe("mermaidBlockConfig", () => {
  it("type and content shape are fixed (the schema mount side depends on these two values)", () => {
    expect(mermaidBlockConfig.type).toBe("mermaid");
    // content:"none" => this block has no BlockNote-managed inline content, and the whole source lives in the `code` prop.
    // Changing it to "inline" would make all existing documents' content unreadable.
    expect(mermaidBlockConfig.content).toBe("none");
  });

  it("the code prop defaults to an empty string (the empty block created by /mermaid takes this path)", () => {
    expect(mermaidBlockConfig.propSchema.code.default).toBe("");
  });
});

describe("MermaidExternalHTML - export", () => {
  it("outputs the shape of a ```mermaid code block, not an SVG", () => {
    // Pasted into GitHub/Obsidian and other places that support mermaid it is drawn automatically; elsewhere at least the source is visible.
    // Choosing the source rather than an SVG also avoids the whole class of problem where an exported SVG carries external resources (same motivation as the guard in #43).
    const { container } = render(<MermaidExternalHTML code="graph TD; A-->B;" />);
    const code = container.querySelector("pre > code");
    expect(code).not.toBeNull();
    expect(code?.getAttribute("class")).toBe(`language-${MERMAID_LANGUAGE}`);
    expect(code?.textContent).toBe("graph TD; A-->B;");
  });

  it("HTML in the source is output as text and does not become real nodes", () => {
    const { container } = render(<MermaidExternalHTML code={'graph TD; A["<img src=x onerror=1>"]-->B;'} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("pre > code")?.textContent).toContain("<img src=x onerror=1>");
  });

  it("an empty source also outputs a valid structure (no half-formed HTML)", () => {
    const { container } = render(<MermaidExternalHTML code="" />);
    expect(container.querySelector("pre > code")).not.toBeNull();
  });
});

describe("paste (HTML path): where it really lands", () => {
  it("<pre><code class=\"language-mermaid\"> parses into a codeBlock after BlockNote parsing, not a mermaid block", async () => {
    // This pins why this spec has no `parse` rule: BlockNote's built-in codeBlock `pre` rule has higher priority, so a custom `parse` is never called.
    // Both the HTML and markdown paste paths first become a codeBlock, then `collab/mermaid-paste.ts` converts it to a diagram at the block level.
    // If BlockNote changes the priority one day and this goes red, that is the time to consider adding a `parse` rule back.
    const editor = BlockNoteEditor.create({ schema: noteSchema });
    const blocks = await editor.tryParseHTMLToBlocks('<pre><code class="language-mermaid">graph TD; A--&gt;B;</code></pre>');

    expect(blocks[0]?.type).toBe("codeBlock");
    expect((blocks[0] as { props: { language?: string } }).props.language).toBe(MERMAID_LANGUAGE);
  });
});

describe("commitCode - writing the source back", () => {
  it("normally writes straight back to the code prop", () => {
    const updateBlock = vi.fn();
    const block = { id: "b1" } as never;
    commitCode({ updateBlock } as never, block, "graph TD; A-->B;");
    expect(updateBlock).toHaveBeenCalledWith(block, { props: { code: "graph TD; A-->B;" } });
  });

  it("a block already deleted remotely must not throw outward (a real situation under collaboration)", () => {
    // `updateBlock` throws `Block with ID ... not found` for a nonexistent block. An exception thrown out of a React event handler
    // means, to the user, that the source they just typed silently vanished.
    const updateBlock = vi.fn(() => {
      throw new Error("Block with ID b1 not found");
    });
    expect(() => commitCode({ updateBlock } as never, { id: "b1" } as never, "graph TD;")).not.toThrow();
  });
});
