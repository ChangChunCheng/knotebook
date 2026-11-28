import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { canonicalNotePath, type NoteDto } from "@knotebook/shared";
import { InTrashCard } from "@/components/InTrashCard";
import { toast } from "@/components/ui/toast";
import { useActiveNote } from "@/lib/active-note";

/** Lazy route page for `/trash/:id`: read-only preview of a trashed note opened from the Trash sidebar tab. */
export default function TrashPreviewPage() {
  const { id = "" } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { setActiveNoteId, clearActiveNoteId } = useActiveNote();

  useEffect(() => {
    if (!id) return;
    setActiveNoteId(id);
    return () => clearActiveNoteId(id);
  }, [id, setActiveNoteId, clearActiveNoteId]);

  const handleRestored = useCallback(
    (restored: NoteDto | null) => {
      if (restored !== null) {
        void navigate(canonicalNotePath(restored), { replace: true });
      } else {
        void navigate("/", { replace: true });
      }
    },
    [navigate],
  );

  const handlePurged = useCallback(() => {
    void navigate("/", { replace: true });
  }, [navigate]);

  const handleNotFound = useCallback(
    ({ afterLoad }: { afterLoad: boolean }) => {
      if (!afterLoad) {
        toast({ title: t("note.linkInvalid"), variant: "destructive" });
      }
      void navigate("/", { replace: true });
    },
    [navigate, t],
  );

  return (
    <InTrashCard
      noteId={id}
      showGoToTrash={false}
      onRestored={handleRestored}
      onPurged={handlePurged}
      onNotFound={handleNotFound}
    />
  );
}
