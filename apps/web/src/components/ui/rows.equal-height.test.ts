import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { BACKLINKS_SCROLL_ROW, SIDEBAR_ROW_HEIGHT } from "./rows";

/**
 * Equal-height guard (source structure level) for the sidebar account row and the body card's backlinks row (same pattern as
 * `theme.scrollbar-guard.test.ts` / `card.guard.test.ts`).
 *
 * The two rows sit at the bottom edge of their cards, side by side across the card gap, so a height mismatch is visible at a glance, but
 * jsdom applies no CSS and cannot compute real heights: what the unit level can guard is that both take the same constant from
 * `ui/rows.ts` and nobody hard-codes a height.
 *
 * It guards three things:
 *   - the constant literal is not changed (a change means looking at both files below together, not letting them silently grow apart)
 *   - both files import the constant
 *   - neither file hard-codes an `h-<number>` row height (the way to bypass the constant)
 *
 * Not guarded (honest limits):
 *   - changing the constant itself: that changes both sides and they stay equal, a legitimate operation.
 *   - the vertical padding (`p-2` / `py-2`) and the top `border-t` of the two containers: the other half of equal height, guarded by each component's
 *     class assertions (the guard case in `BacklinksSection.test.tsx` asserts the footer's outer `py-2`; since #115 the horizontal padding is the content row's own
 *     `px-5`, and the outer one is asserted not to contain `px-`; on the sidebar side it is the `p-2` container in `AppShell.tsx`).
 *   - an `h-*` added after the constant inside `cn()` (twMerge keeps the later one): a hard-coded value is caught,
 *     but if it happens to equal the constant it cannot be told apart, and is harmless.
 *   - a hard-coded row height paired with a same-valued `w-*` (e.g. `h-9 w-9`) is treated as a square icon and let through:
 *     the price of not flagging avatar / icon sizes.
 */

const ROW_HEIGHT_LITERAL = "h-9";

const CONSUMERS = [
  { label: "側欄帳號列", path: "src/components/UserMenu.tsx" },
  { label: "內文卡 backlinks 列", path: "src/components/BacklinksSection.tsx" },
] as const;

function readSource(relativePath: string): string {
  return readFileSync(`${process.cwd()}/${relativePath}`, "utf8");
}

/** Strip comments so mentions such as `h-9` in comments do not affect the hard-coded-height check. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("sidebar account row and backlinks row have equal height", () => {
  it("the SIDEBAR_ROW_HEIGHT constant literal is fixed", () => {
    expect(SIDEBAR_ROW_HEIGHT).toBe(ROW_HEIGHT_LITERAL);
  });

  it("BACKLINKS_SCROLL_ROW literal is fixed, and the container height = row height + scrollbar height", () => {
    // The literal is pinned: the consumer's assertion is `toHaveClass(...BACKLINKS_SCROLL_ROW.split(" "))` with the expectation derived from the constant, so
    // changing the constant would not turn it red (a tautology); this pin is what gives that check teeth.
    expect(BACKLINKS_SCROLL_ROW).toBe("h-[42px] -mb-1.5 scrollbar-x-thin");

    // The conversion "42 = 36 + 6" is made executable here: the container height derives from the row height,
    // and the negative margin cancels the extra scrollbar height (otherwise it would make that row taller).
    const rowHeightPx = Number(ROW_HEIGHT_LITERAL.replace("h-", "")) * 4;
    const scrollbarPx = 6;
    expect(rowHeightPx).toBe(36);
    expect(BACKLINKS_SCROLL_ROW).toContain(`h-[${rowHeightPx + scrollbarPx}px]`);
    expect(BACKLINKS_SCROLL_ROW).toContain(`-mb-${scrollbarPx / 4}`);
  });

  it("both consumers import and use SIDEBAR_ROW_HEIGHT", () => {
    for (const { label, path } of CONSUMERS) {
      const source = readSource(path);
      expect(source, `${label}（${path}）應 import SIDEBAR_ROW_HEIGHT`).toMatch(
        /import \{[^}]*SIDEBAR_ROW_HEIGHT[^}]*\} from "@\/components\/ui\/rows";/,
      );
      const uses = stripComments(source).match(/SIDEBAR_ROW_HEIGHT/g) ?? [];
      expect(uses.length, `${label} 應在 className 中實際套用 SIDEBAR_ROW_HEIGHT`).toBeGreaterThanOrEqual(2);
    }
  });

  it("neither consumer hard-codes a row-height utility", () => {
    for (const { label, path } of CONSUMERS) {
      const code = stripComments(readSource(path));
      // Catches fixed heights `h-<number>` / `h-[arbitrary]`, including single digits (h-8 / h-9 are the likeliest hard-coded substitute row heights).
      // `(?<![\w-])` excludes the `max-h-*` / `min-h-*` prefixes: `\b` holds between `-` and `h` in `max-h-`,
      // which would misreport a legitimate `max-h-48` as a row height.
      const heights = [...code.matchAll(/(?<![\w-])h-(\d+(?:\.\d+)?|\[[^\]]+\])/g)].map((m) => m[1]);
      // A paired `w-<same value>` means a square (avatar, icon), not a row height, and is excluded; the row height sets only h.
      const hardcoded = heights.filter((value) => {
        const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return !new RegExp(`(?<![\\w-])w-${escaped}(?![\\w.-])`).test(code);
      });
      expect(hardcoded, `${label}（${path}）不得自己寫死列高，改用 SIDEBAR_ROW_HEIGHT`).toEqual([]);
    }
  });
});
