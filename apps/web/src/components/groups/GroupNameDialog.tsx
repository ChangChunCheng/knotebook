import { useState, type FormEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { GroupDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useCreateGroup, useRenameGroup } from "@/api/groups";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

/**
 * Same cap as server `validateGroupName` (1–80 code points); `maxLength` counts UTF-16 units, so emoji are
 * blocked early (a UX shortcut). The server is authoritative: its 400 `invalid_name` shows in the alert.
 */
export const GROUP_NAME_MAX_LENGTH = 80;

type GroupNameDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after `['groups']`/`['notes']` are invalidated, with the server's GroupDto. */
  onSaved?: (group: GroupDto) => void;
  /** Where focus returns on close (e.g. the group's "+"). A controlled Dialog has no `DialogTrigger`, so Radix doesn't restore focus; done manually here. */
  returnFocusRef?: RefObject<HTMLElement | null>;
} & ({ mode: "create" } | { mode: "rename"; group: GroupDto });

/**
 * Callers must remount on each open (`{open && <GroupNameDialog … open />}`): `useState` reads
 * `props.group.name` only at mount, so a reused dialog would keep the previous input.
 * Errors (400 `invalid_name`, 403, 404…) stay in the dialog as `role="alert"`: no close, no toast.
 */
export function GroupNameDialog(props: GroupNameDialogProps) {
  const { t } = useTranslation();
  const { open, onOpenChange, onSaved, returnFocusRef } = props;
  const createGroup = useCreateGroup();
  const renameGroup = useRenameGroup();
  const [name, setName] = useState(props.mode === "rename" ? props.group.name : "");
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const pending = createGroup.isPending || renameGroup.isPending;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (trimmed.length === 0 || pending) return;
    setError(null);
    try {
      const saved =
        props.mode === "create"
          ? await createGroup.mutateAsync({ name: trimmed })
          : await renameGroup.mutateAsync({ id: props.group.id, name: trimmed });
      onSaved?.(saved);
      onOpenChange(false);
      if (props.mode === "create") setName("");
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  const title = props.mode === "create" ? t("groups.dialog.createTitle") : t("groups.dialog.renameTitle");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        dismissOnOutside={false}
        onCloseAutoFocus={(event) => {
          const target = returnFocusRef?.current;
          if (!target) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className={props.mode === "rename" ? "sr-only" : undefined}>
            {props.mode === "create" ? t("groups.dialog.createDescription") : t("groups.dialog.renameTitle")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="group-name-input" className="text-sm font-medium">
              {t("groups.dialog.nameLabel")}
            </label>
            <Input
              id="group-name-input"
              autoFocus
              maxLength={GROUP_NAME_MAX_LENGTH}
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={error !== null || undefined}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t("home.cancel")}
              </Button>
            </DialogClose>
            <Button type="submit" variant="brandDeep" disabled={trimmed.length === 0 || pending}>
              {props.mode === "create" ? t("groups.dialog.create") : t("groups.dialog.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
