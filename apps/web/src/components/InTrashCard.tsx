import { useTranslation } from "react-i18next";
import { useRestoreTrash } from "@/api/trash";
import { Button } from "@/components/ui/button";
import { Trash } from "@/components/ui/icons";
import { RotateCcw } from "@/components/ui/icons-extra";
import { toast } from "@/components/ui/toast";
import { toastTrashFailure } from "@/components/sidebar/trash-dialogs";
import { useSidebarTabActions } from "@/lib/sidebar-tab";
import { trashResultMessage } from "@/lib/trash-display";

/** Must render inside AppShell children (uses the actions context `showTab`). Only people with trash permission get `in_trash`. */
export function InTrashCard({ noteId, onRestored }: { noteId: string; onRestored: () => void }) {
  const { t } = useTranslation();
  const { showTab } = useSidebarTabActions();
  const restore = useRestoreTrash();

  const handleRestore = async () => {
    try {
      const result = await restore.mutateAsync([noteId]);
      if (!result.restored.some((note) => note.id === noteId)) {
        toast({ title: trashResultMessage("restore", 0, result.skipped.length, t), variant: "destructive" });
      }
      onRestored();
    } catch (err) {
      toastTrashFailure("restore", err, t);
    }
  };

  return (
    <div className="space-y-3 p-6">
      <h2 className="text-base font-semibold">{t("trash.inTrashTitle")}</h2>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={restore.isPending} onClick={() => void handleRestore()}>
          <RotateCcw aria-hidden="true" className="h-4 w-4" />
          {t("trash.restore")}
        </Button>
        <Button type="button" variant="outline" onClick={() => showTab("trash")}>
          <Trash aria-hidden="true" className="h-4 w-4" />
          {t("trash.goToTrash")}
        </Button>
      </div>
    </div>
  );
}
