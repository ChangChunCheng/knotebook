import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { useSidebarTabState } from "@/lib/sidebar-tab";
import { Button } from "@/components/ui/button";
import { Plus } from "@/components/ui/icons";

/** 只有打開垃圾桶 tab 才下載（首包上限）；與 AppShell 的 `TrashPanel` 同一個 chunk（`TrashLazy`）。 */
const TrashFooter = lazy(() => import("@/components/sidebar/TrashLazy").then((m) => ({ default: m.TrashFooter })));

/**
 * 側欄底部（tab 列與 UserMenu 之間）：平常是「新增筆記」；垃圾桶 tab 換成保留天數說明（spec §6.10.1），
 * 垃圾桶選取模式換成動作列（spec §6.10.2），兩者在 `TrashFooter.tsx`。搜尋中一律「新增筆記」（搜尋視圖不是垃圾桶）。
 * ⚠ 本體不呼叫 `useTrash()`（讀碼發現 28）：只有垃圾桶 tab 才渲染的子元件呼叫，其他 tab 不多打 `GET /api/trash`。
 */
export function SidebarFooter({
  searching,
  onCreateNote,
  newNotePending,
}: {
  searching: boolean;
  onCreateNote: () => void;
  newNotePending: boolean;
}) {
  const { t } = useTranslation();
  const { tab } = useSidebarTabState();
  if (tab !== "trash" || searching) {
    return (
      <div className="m-2">
        <Button variant="brand" className="w-full" onClick={() => onCreateNote()} disabled={newNotePending}>
          <Plus aria-hidden="true" className="h-4 w-4" />
          {t("home.newNote")}
        </Button>
      </div>
    );
  }
  // 佔位與保留天數說明「載入中」同高，chunk 到了版面不跳。
  return (
    <Suspense fallback={<div className="h-7" />}>
      <TrashFooter />
    </Suspense>
  );
}
