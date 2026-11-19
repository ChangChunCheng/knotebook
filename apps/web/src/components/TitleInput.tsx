import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import type { NoteDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useUpdateNote } from "@/api/notes";
import { toast } from "@/components/ui/toast";

export const TITLE_DEBOUNCE_MS = 800;

interface TitleInputProps {
  note: NoteDto;
  readOnly: boolean;
  /** True when the URL already moved to another note while this one is still shown: ignore new input so it is not saved into this note. Text typed before that still saves normally (it was typed on this note). */
  isNavigatingAway?: () => boolean;
}

/** The title is not in the Y.Doc (REST last-write-wins). Saved after 800 ms idle or on blur; success writes `["note", id]`. Never writes the URL: NotePage convergence effect does, and it is gated during transitions so an in-flight PATCH cannot set the URL back to the previous note. Empty titles are not sent (server min(1)). */
export function TitleInput({ note, readOnly, isNavigatingAway }: TitleInputProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const updateNote = useUpdateNote();

  const [value, setValue] = useState(note.title);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncedRef = useRef(note.title);

  // Do not overwrite unsaved local edits (value !== syncedRef.current); note switches remount this component (NotePage itself is still reused, not remounted).
  useEffect(() => {
    if (note.title === syncedRef.current) return;
    syncedRef.current = note.title;
    setValue(note.title);
  }, [note.title]);

  // Write back only if the input still holds what was submitted, otherwise the user typed text is wiped; functional update keeps `save` stable.
  const keepIfUnedited = (submitted: string, next: string): void => {
    setValue((prev) => (prev.trim() === submitted ? next : prev));
  };

  const mutate = updateNote.mutateAsync;
  const save = useCallback(
    async (next: string): Promise<void> => {
      const trimmed = next.trim();
      if (trimmed.length === 0 || trimmed === syncedRef.current) return;
      syncedRef.current = trimmed;
      try {
        const updated = await mutate({ id: note.id, title: trimmed });
        syncedRef.current = updated.title;
        keepIfUnedited(trimmed, updated.title);
        queryClient.setQueryData(["note", note.id], updated);
      } catch (err) {
        syncedRef.current = note.title;
        keepIfUnedited(trimmed, note.title);
        const message =
          err instanceof ApiFail ? t(`errors.${err.code}`, { defaultValue: t("errors.fallback") }) : t("errors.fallback");
        toast({ title: message, variant: "destructive" });
      }
    },
    [mutate, note.id, note.title, queryClient, t],
  );

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  // No forced save on unmount: a background PATCH for a page the user left only creates races.
  useEffect(() => clearTimer, []);

  function handleChange(next: string): void {
    if (isNavigatingAway?.()) return; // controlled input: no setValue, so React restores the displayed value
    setValue(next);
    clearTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void save(next);
    }, TITLE_DEBOUNCE_MS);
  }

  function handleBlur(): void {
    clearTimer();
    if (value.trim().length === 0) {
      setValue(syncedRef.current);
      return;
    }
    void save(value);
  }

  if (readOnly) {
    return (
      <h1 className="min-w-16 flex-1 truncate text-xl font-semibold" title={note.title}>
        {note.title}
      </h1>
    );
  }

  return (
    <input
      // NotePage focuses this after restore; use this attribute, not "the first input in the header".
      data-note-title-input=""
      className="min-w-16 flex-1 bg-transparent text-xl font-semibold outline-none placeholder:text-muted-foreground"
      aria-label={t("note.titleLabel")}
      placeholder={t("note.titlePlaceholder")}
      value={value}
      onChange={(event) => handleChange(event.target.value)}
      onBlur={handleBlur}
    />
  );
}
