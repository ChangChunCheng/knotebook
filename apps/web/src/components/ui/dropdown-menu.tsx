import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type ReactNode,
} from "react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { Check, ChevronRight } from "./icons";
import { SheetViewportVars } from "./sheet-viewport";
import { useIsPhone } from "@/lib/layout-tiers";
import { cn } from "@/lib/utils";

/**
 * 手機 sheet 形（`DropdownMenuContent` 帶 `phoneSheet`、視窗比 640 窄）的選單內容裡為 true，其餘 false。
 * 選單項依它換成 48px 高、16px 字的列；子選單依它改成「換掉整個 sheet 內容、最上面一列返回」（見 `DropdownMenuMainLevel`）。
 */
const MenuSheetContext = createContext(false);

/** 目前是否在手機 sheet 形的選單內容裡（只在 `DropdownMenuContent` 的子孫裡有意義）。 */
export function useMenuSheet(): boolean {
  return useContext(MenuSheetContext);
}

/** sheet 裡一列：至少 48px 高、16px 字；粗指標原本的 `py-2.5` 一併換掉（高度改由 `min-h-12` 撐）。 */
const SHEET_ROW = "min-h-12 py-2 pointer-coarse:py-2 text-base";

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;
export const DropdownMenuPortal = DropdownMenuPrimitive.Portal;
export const DropdownMenuSub = DropdownMenuPrimitive.Sub;
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;
export const DropdownMenuItemIndicator = DropdownMenuPrimitive.ItemIndicator;

export const DropdownMenuSubTrigger = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.SubTrigger>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger>
>(({ className, children, ...props }, ref) => {
  const sheet = useMenuSheet();
  return (
    <DropdownMenuPrimitive.SubTrigger
      ref={ref}
      className={cn(
        "flex cursor-default select-none items-center rounded-sm px-2 py-1.5 pointer-coarse:py-2.5 text-sm outline-none " +
          "focus:bg-accent data-[state=open]:bg-accent",
        className,
        sheet && SHEET_ROW,
      )}
      {...props}
    >
      {children}
      <ChevronRight aria-hidden="true" className="ml-auto h-4 w-4 shrink-0" />
    </DropdownMenuPrimitive.SubTrigger>
  );
});
DropdownMenuSubTrigger.displayName = DropdownMenuPrimitive.SubTrigger.displayName;

export const DropdownMenuSubContent = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.SubContent>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(({ className, collisionPadding = 8, ...props }, ref) => (
  // 必須 Portal：父層 `DropdownMenuContent` 是 `overflow-hidden`，內嵌渲染會把往右展開的子選單裁掉；
  // Portal 後由 Radix 依視窗碰撞自動翻到左側（collisionPadding 留邊，窄視窗／手機抽屜旁不貼邊）。
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.SubContent
      ref={ref}
      collisionPadding={collisionPadding}
      className={cn(
        "z-50 min-w-32 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md",
        className,
      )}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuSubContent.displayName = DropdownMenuPrimitive.SubContent.displayName;

type MenuContentProps = ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content> & {
  /**
   * 手機（< 640，`useIsPhone()`）改成貼底的 sheet：滿寬、上圓角、底部留 safe area、由下往上升起（`kb-sheet`），背後有淡入淡出的背板，
   * 鍵盤升起時抬到鍵盤上方；列高 48、字 16。640 以上照常是貼著觸發鈕的小選單。
   * 仍是同一個 Radix 選單（role=menu／menuitem、方向鍵、typeahead、Esc、點外面關、焦點回觸發鈕都不變），只換位置與樣式。
   */
  phoneSheet?: boolean;
  /** sheet 形最上面一行的小標題（例如筆記標題）；其他寬度不渲染。 */
  sheetTitle?: ReactNode;
};

const CONTENT_BASE = "z-50 min-w-32 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md";

/**
 * sheet 形的內容。定位靠 `index.css` 的 `.kb-menu-sheet` 規則：Radix 把內容包在一層定位用的 wrapper 裡（行內 transform 貼到觸發鈕旁），
 * 那條規則把 wrapper 改成貼底滿寬、並在它的 `::before` 畫背板。`mb-(--kb-inset)` 把內容抬到鍵盤上方，高度上限跟著看得見的高度。
 * 放在呼叫端 className 之後：呼叫端給小選單的寬高限制（`max-w-…`、`min-w-[trigger 寬]`、`max-h-[可用高度]`）在 sheet 一律被蓋掉。
 */
const SHEET_CONTENT =
  "kb-menu-sheet kb-sheet w-full min-w-0 max-w-none rounded-t-xl rounded-b-none border-x-0 border-b-0 shadow-lg " +
  "px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] mb-(--kb-inset,0px) " +
  "max-h-[calc(var(--kb-visible-h,100dvh)*0.85)] overflow-y-auto";

/**
 * Portal 裡的內容本體：Radix 只在選單開著（與退場動畫期間）掛載它，所以手機判斷的 matchMedia 訂閱只在選單開著時存在，
 * 側欄每一列的 ⋮ 平常不各掛一份。
 */
const MenuContent = forwardRef<ElementRef<typeof DropdownMenuPrimitive.Content>, MenuContentProps>(
  ({ className, sideOffset = 4, phoneSheet = false, sheetTitle, children, ...props }, ref) => {
    const phone = useIsPhone();
    const sheet = phoneSheet && phone;
    const contentRef = useRef<HTMLDivElement | null>(null);
    const setRefs = useCallback(
      (node: HTMLDivElement | null) => {
        contentRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      },
      [ref],
    );
    const showTitle = sheet && sheetTitle !== undefined && sheetTitle !== null && sheetTitle !== "";
    return (
      <DropdownMenuPrimitive.Content
        ref={setRefs}
        sideOffset={sideOffset}
        data-menu-sheet={sheet ? "" : undefined}
        className={cn(CONTENT_BASE, className, sheet && SHEET_CONTENT)}
        {...props}
      >
        <MenuSheetContext.Provider value={sheet}>
          {sheet && <SheetViewportVars target={contentRef} />}
          {showTitle && (
            <>
              <DropdownMenuPrimitive.Label className="truncate px-2 pb-2 pt-1 text-sm font-medium text-muted-foreground">
                {sheetTitle}
              </DropdownMenuPrimitive.Label>
              <DropdownMenuSeparator />
            </>
          )}
          {children}
        </MenuSheetContext.Provider>
      </DropdownMenuPrimitive.Content>
    );
  },
);
MenuContent.displayName = "MenuContent";

export const DropdownMenuContent = forwardRef<ElementRef<typeof DropdownMenuPrimitive.Content>, MenuContentProps>((props, ref) => (
  <DropdownMenuPrimitive.Portal>
    <MenuContent ref={ref} {...props} />
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

/**
 * 主選單那一層的項目。子選單在手機 sheet 裡是「換掉整個內容」：子選單那一組展開（`drilled`）時這裡不渲染，
 * 只剩子選單自己畫的返回列與那一層（例如 `share/GroupTransfer.tsx` 的移動到…／複製到…）。不是 sheet 時一律照常渲染。
 * 用條件渲染而不是藏起來：display:none 的 Radix 項目仍在選單集合裡，typeahead 會停在看不見的項目。
 */
export function DropdownMenuMainLevel({ drilled, children }: { drilled: boolean; children: ReactNode }) {
  const sheet = useMenuSheet();
  return sheet && drilled ? null : <>{children}</>;
}

export const DropdownMenuItem = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Item>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & { inset?: boolean }
>(({ className, inset, ...props }, ref) => {
  const sheet = useMenuSheet();
  return (
    <DropdownMenuPrimitive.Item
      ref={ref}
      className={cn(
        "relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 pointer-coarse:py-2.5 text-sm outline-none " +
          "transition-colors focus:bg-accent focus:text-accent-foreground " +
          "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        inset && "pl-8",
        className,
        sheet && SHEET_ROW,
      )}
      {...props}
    />
  );
});
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

export const DropdownMenuCheckboxItem = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(({ className, children, checked, ...props }, ref) => {
  const sheet = useMenuSheet();
  return (
    <DropdownMenuPrimitive.CheckboxItem
      ref={ref}
      className={cn(
        "relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 pointer-coarse:py-2.5 text-sm outline-none " +
          "transition-colors focus:bg-accent focus:text-accent-foreground " +
          "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
        sheet && SHEET_ROW,
      )}
      checked={checked}
      {...props}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check className="h-4 w-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
});
DropdownMenuCheckboxItem.displayName = DropdownMenuPrimitive.CheckboxItem.displayName;

/**
 * Radix 原生 RadioItem 的最小包裝：只留 `role="menuitemradio"` / `aria-checked`
 * 語意所需的行為 class（cursor/select/outline），**刻意不套用**
 * `DropdownMenuItem`／`DropdownMenuCheckboxItem` 那套 padding/flex/indicator
 * 預設樣式——主題色選擇器把它渲染成 16px 純色圓點，外觀完全交給呼叫端
 * `className`（見 `UserMenu.tsx`）。`aria-checked` 由 Radix 依
 * `DropdownMenuRadioGroup` 的 `value` 與本項的 `value` 是否相等自動算出，不需要
 * 手動傳。
 */
export const DropdownMenuRadioItem = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.RadioItem>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem> & {
    /** 呼叫端把它畫成一般的一列（例如資料夾 ⋮ 的排序）：手機 sheet 裡跟其他項一樣換成 48px 高、16px 字。色點這類不是列的不要傳。 */
    sheetRow?: boolean;
  }
>(({ className, sheetRow = false, ...props }, ref) => {
  const sheet = useMenuSheet();
  return (
    <DropdownMenuPrimitive.RadioItem
      ref={ref}
      className={cn("cursor-default select-none outline-none", className, sheet && sheetRow && SHEET_ROW)}
      {...props}
    />
  );
});
DropdownMenuRadioItem.displayName = DropdownMenuPrimitive.RadioItem.displayName;

export const DropdownMenuLabel = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Label>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> & { inset?: boolean }
>(({ className, inset, ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    ref={ref}
    className={cn("px-2 py-1.5 text-sm font-semibold", inset && "pl-8", className)}
    {...props}
  />
));
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName;

export const DropdownMenuSeparator = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Separator>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => {
  // sheet 的左右內距是 8px（小選單 4px）：分隔線一樣伸到兩側邊緣。
  const sheet = useMenuSheet();
  return <DropdownMenuPrimitive.Separator ref={ref} className={cn("-mx-1 my-1 h-px bg-border", sheet && "-mx-2", className)} {...props} />;
});
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName;
