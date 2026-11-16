import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { FIELD_ICON_HIT, HEADER_ICON_HIT, ROW_ICON_HIT, ROW_ICON_HIT_BORDERED, ROW_ICON_ROW } from "./hit-area";

/**
 * 觸控點擊範圍的來源層守衛。jsdom 不套 CSS，這裡只守「字面在、被正確的元件用到」；
 * 真的撐到 44px 要在瀏覽器量（e2e 與 build 產物的 CSS grep）。
 */

const root = `${process.cwd()}/src`;

function read(path: string): string {
  return readFileSync(`${root}/${path}`, "utf8").replace(/\r\n/g, "\n");
}

/** 剝掉註解，避免註解裡寫到常數名影響次數。 */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function count(path: string, name: string): number {
  return (code(path).match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;
}

/** class 字串轉成 token 集合，斷言不看順序。 */
function tokens(value: string): Set<string> {
  return new Set(value.split(/\s+/).filter(Boolean));
}

describe("輸入框內圖示鈕的點擊範圍", () => {
  it("FIELD_ICON_HIT：不帶 relative（鈕已是 absolute），只在粗指標撐 44", () => {
    expect(tokens(FIELD_ICON_HIT)).toEqual(
      new Set(["pointer-coarse:after:absolute", "pointer-coarse:after:-inset-2.5", "pointer-coarse:after:content-['']"]),
    );
  });

  it("搜尋框的清除 ✕ 套用它；觸控時右內距縮到 pr-10（點擊範圍左緣 38px，字止於 41px）、Ctrl K 提示隱藏", () => {
    expect(count("components/AppShell.tsx", "FIELD_ICON_HIT")).toBe(2);
    const shell = code("components/AppShell.tsx");
    expect(shell).toContain("pr-11 pointer-coarse:pr-10");
    expect(shell).toMatch(/<kbd[\s\S]*?pointer-coarse:hidden[\s\S]*?<\/kbd>/);
  });
});

describe("觸控點擊範圍常數", () => {
  it("ROW_ICON_HIT：24px 圖示鈕四邊各 10px 擴到 44，只在粗指標生效，帶 row-icon 標記", () => {
    expect(tokens(ROW_ICON_HIT)).toEqual(
      new Set(["row-icon", "relative", "pointer-coarse:after:absolute", "pointer-coarse:after:-inset-2.5", "pointer-coarse:after:content-['']"]),
    );
  });

  it("ROW_ICON_HIT_BORDERED：補回 1px 框線，四邊各 11px，仍帶 row-icon 標記", () => {
    expect(tokens(ROW_ICON_HIT_BORDERED)).toEqual(
      new Set(["row-icon", "relative", "pointer-coarse:after:absolute", "pointer-coarse:after:-inset-[11px]", "pointer-coarse:after:content-['']"]),
    );
  });

  it("有框線的「Done」（outline）用 BORDERED", () => {
    expect(count("components/sidebar/SelectHeader.tsx", "ROW_ICON_HIT_BORDERED")).toBe(2);
    expect(count("components/sidebar/TrashPanel.tsx", "ROW_ICON_HIT_BORDERED")).toBe(2);
  });

  it("ROW_ICON_ROW：只在相鄰兩顆 row-icon 之間加間距", () => {
    expect(tokens(ROW_ICON_ROW)).toEqual(new Set(["pointer-coarse:gap-1", "pointer-coarse:[&>.row-icon:has(+.row-icon)]:me-4"]));
  });

  it("HEADER_ICON_HIT：32px 圖示鈕擴到 40 寬 44 高，只在粗指標生效", () => {
    expect(tokens(HEADER_ICON_HIT)).toEqual(
      new Set([
        "relative",
        "pointer-coarse:after:absolute",
        "pointer-coarse:after:-inset-x-1",
        "pointer-coarse:after:-inset-y-1.5",
        "pointer-coarse:after:content-['']",
      ]),
    );
  });
});

/** 在 components 底下遞迴找 .tsx（非測試）。 */
function sourceFiles(dir = "components"): string[] {
  const out: string[] = [];
  for (const name of readdirSync(`${root}/${dir}`)) {
    const rel = `${dir}/${name}`;
    if (statSync(`${root}/${rel}`).isDirectory()) out.push(...sourceFiles(rel));
    else if (name.endsWith(".tsx") && !name.includes(".test.")) out.push(rel);
  }
  return out;
}

describe("所有 24px 高（h-6／size-6，含文字鈕）的按鈕都有觸控點擊範圍", () => {
  // 沒套 ROW_ICON_HIT 的 `<Button … h-6 …>`（或 `size-6`；class 順序、拆行、寫在 cn(...) 裡都算）只准是下面這些，每筆寫理由；多一顆或少一顆都紅。
  const EXCEPTIONS: Record<string, number> = {
    // 選取模式的寬螢幕（可 hover）工具列：只在滑鼠環境渲染，觸控走窄形底部動作列。
    "components/sidebar/SelectHeader.tsx": 1,
    "components/sidebar/TrashFooter.tsx": 2,
    "components/sidebar/TrashPanel.tsx": 1,
  };

  it("沒有 ROW_ICON_HIT 的 24px 圖示鈕恰好是例外清單", () => {
    const found: Record<string, number> = {};
    for (const path of sourceFiles()) {
      const source = code(path);
      for (const match of source.matchAll(/<Button\b[\s\S]*?(?:<\/Button>|\/>\s*\n)/g)) {
        const block = match[0];
        if (/\bh-6\b|\bsize-6\b/.test(block) && !/\b(?:ROW|FIELD)_ICON_HIT(?:_BORDERED)?\b/.test(block)) found[path] = (found[path] ?? 0) + 1;
      }
    }
    expect(found).toEqual(EXCEPTIONS);
  });

  it("有框線（variant=\"outline\"）的 24px 鈕一定用 ROW_ICON_HIT_BORDERED", () => {
    const wrong: string[] = [];
    for (const path of sourceFiles()) {
      const source = code(path);
      for (const match of source.matchAll(/<Button\b[\s\S]*?(?:<\/Button>|\/>\s*\n)/g)) {
        const block = match[0];
        if (!/\bh-6\b|\bsize-6\b/.test(block) || !/variant="outline"/.test(block)) continue;
        // `\b` 後面接 `_BORDERED` 不算邊界，所以這個正規式只抓沒有框線補償的 ROW_ICON_HIT／FIELD_ICON_HIT。
        if (/\b(?:ROW|FIELD)_ICON_HIT\b/.test(block)) wrong.push(path);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("側欄 24px 圖示鈕套 ROW_ICON_HIT 的次數", () => {
  const SITES: readonly [string, number][] = [
    ["components/NoteList.tsx", 2],
    ["components/NoteMenu.tsx", 1],
    ["components/RowFavoriteStar.tsx", 1],
    ["components/sidebar/FolderMenu.tsx", 1],
    ["components/groups/GroupMenu.tsx", 1],
    ["components/sidebar/TrashPanel.tsx", 5],
    ["components/sidebar/SelectHeader.tsx", 1],
  ];
  it.each(SITES)("%s：import 並套用 %i 次", (path, uses) => {
    expect(read(path)).toMatch(/import \{[^}]*ROW_ICON_HIT[^}]*\} from "@\/components\/ui\/hit-area";/);
    // 一次是 import，其餘是 className 裡的使用。
    expect(count(path, "ROW_ICON_HIT")).toBe(uses + 1);
  });
});

describe("頁首 32px 圖示鈕都套 HEADER_ICON_HIT", () => {
  const SITES: readonly [string, number][] = [
    ["components/NoteMenu.tsx", 1],
    ["components/ShareDialog.tsx", 1],
    ["components/FavoriteToggle.tsx", 1],
    ["components/NoteWidthToggle.tsx", 1],
    ["components/BackToListButton.tsx", 1],
    ["components/AppShell.tsx", 1],
  ];
  it.each(SITES)("%s：import 並套用 %i 次", (path, uses) => {
    expect(read(path)).toMatch(/import \{[^}]*HEADER_ICON_HIT[^}]*\} from "@\/components\/ui\/hit-area";/);
    expect(count(path, "HEADER_ICON_HIT")).toBe(uses + 1);
  });
});

describe("含兩顆以上 24px 圖示鈕的列：容器套 ROW_ICON_ROW（只隔開相鄰圖示鈕）", () => {
  it.each([
    // 群組列、資料夾列、標題列（筆記列只剩一顆 ⋮：星號在觸控裝置不顯示）
    ["components/NoteList.tsx", 3],
    // 垃圾桶列、標題列
    ["components/sidebar/TrashPanel.tsx", 2],
  ] as const)("%s：%i 個容器", (path, rows) => {
    expect(count(path, "ROW_ICON_ROW")).toBe(rows + 1);
  });

  it("沒有人再用整列放大 gap 的做法", () => {
    for (const path of sourceFiles()) expect(code(path), path).not.toContain("pointer-coarse:gap-5");
  });
});

describe("列高只在細指標回 28／36", () => {
  const FILES = [
    "components/NoteList.tsx",
    "components/sidebar/SelectableTree.tsx",
    "components/sidebar/StackPreview.tsx",
    "components/sidebar/SidebarTabList.tsx",
  ];
  it.each(FILES)("%s 沒有 md:h-7／md:h-9", (path) => {
    const source = code(path);
    expect(source).not.toMatch(/\bmd:h-7\b/);
    expect(source).not.toMatch(/\bmd:h-9\b/);
  });
  it("列高字面都換成 pointer-fine（群組列也是 44 起跳）", () => {
    expect(code("components/NoteList.tsx").match(/pointer-fine:h-7/g)).toHaveLength(4);
    expect(code("components/sidebar/SelectableTree.tsx").match(/pointer-fine:h-7/g)).toHaveLength(4);
    expect(code("components/sidebar/StackPreview.tsx").match(/pointer-fine:h-7/g)).toHaveLength(3);
    expect(code("components/sidebar/SidebarTabList.tsx").match(/pointer-fine:h-9/g)).toHaveLength(2);
  });
});

describe("自帶 radio 列樣式的選單：粗指標下列高同 DropdownMenuItem", () => {
  it.each([
    "components/sidebar/FolderMenu.tsx",
    "components/NoteWidthMenuItems.tsx",
    "components/versions/ComparePicker.tsx",
  ])("%s", (path) => {
    expect(code(path)).toContain("py-1.5 pl-8 pr-2 pointer-coarse:py-2.5 text-sm");
  });
});

describe("觸控時多留的內距", () => {
  it("標題列下緣 pb-2.5：讓 24px 鈕的點擊範圍不被下面的清單吃掉", () => {
    expect(code("components/NoteList.tsx").match(/pointer-coarse:pb-2\.5/g)).toHaveLength(1);
    expect(code("components/sidebar/TrashPanel.tsx").match(/pointer-coarse:pb-2\.5/g)).toHaveLength(1);
  });
  it("筆記、資料夾、群組列右緣 pr-0.75（3px）：最右那顆鈕的圖示右緣離清單邊 16px（同左側文字起點），點擊範圍（外撐 10px）又不被捲動容器裁掉", () => {
    const source = code("components/NoteList.tsx");
    expect(source.match(/\bpr-0\.75\b/g)).toHaveLength(3);
    expect(source).not.toContain("pointer-coarse:pr-0.5");
    expect(source.match(/\bpr-2\.75\b/g)).toHaveLength(1);
    expect(code("components/sidebar/TrashPanel.tsx").match(/\bpr-2\.75\b/g)).toHaveLength(1);
  });
});
