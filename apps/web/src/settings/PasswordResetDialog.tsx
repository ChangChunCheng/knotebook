import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ApiFail } from "@/api/client";
import { useAuthConfig } from "@/api/authConfig";
import { useCancelPasswordReset, useCreatePasswordReset, type AdminUserDto } from "@/api/admin";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { KeyRound } from "@/components/ui/icons-extra";
import { RowIconButton } from "@/components/ui/row-icon-button";
import { Select } from "@/components/ui/select";
import { OneTimeLinkResult } from "./OneTimeLinkResult";
import "@/i18n/management-strings";

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => i + 1);

interface Created {
  token: string;
  expiresAt: string;
}

/** `useAuthConfig()` is called only here: Radix unmounts on close, so table rows don't each fetch `/api/auth/config`. */
function PasswordResetDialogBody({
  row,
  hours,
  setHours,
  created,
  generation,
  onCreated,
  onFail,
  onError,
}: {
  row: AdminUserDto;
  hours: number;
  setHours: (hours: number) => void;
  created: Created | null;
  /** Open generation at send time; the callbacks carry it back so the parent drops results from a previous open. */
  generation: () => number;
  onCreated: (generation: number, created: Created) => void;
  onFail: (generation: number, message: string) => void;
  onError: (message: string | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const authConfig = useAuthConfig();
  const create = useCreatePasswordReset();
  const cancel = useCancelPasswordReset();
  const passwordLoginOff = authConfig.data?.passwordLogin.enabled === false;

  if (created !== null) {
    return (
      <OneTimeLinkResult
        title={t("admin.passwordReset.createdTitle")}
        url={`${window.location.origin}/reset-password#token=${created.token}`}
        expiresAt={created.expiresAt}
      />
    );
  }

  const pendingWhen =
    row.passwordResetExpiresAt === null
      ? null
      : new Date(row.passwordResetExpiresAt).toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "short" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    onError(null);
    const gen = generation();
    try {
      onCreated(gen, await create.mutateAsync({ userId: row.id, expiresInHours: hours }));
    } catch (err) {
      onFail(gen, errorMessage(t, err));
    }
  }

  async function handleCancel(): Promise<void> {
    onError(null);
    const gen = generation();
    try {
      await cancel.mutateAsync(row.id);
    } catch (err) {
      onFail(gen, errorMessage(t, err));
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
      <DialogHeader>
        <DialogTitle>{t("admin.passwordReset.title")}</DialogTitle>
        <DialogDescription>{t("admin.passwordReset.description", { email: row.email })}</DialogDescription>
      </DialogHeader>
      {passwordLoginOff && <p className="text-sm text-muted-foreground">{t("admin.passwordReset.passwordLoginOff")}</p>}
      {pendingWhen !== null && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-muted-foreground">
            {t(passwordLoginOff ? "admin.passwordReset.pendingSuspended" : "admin.passwordReset.pending", { when: pendingWhen })}
          </p>
          <Button type="button" variant="outline" size="sm" disabled={cancel.isPending || create.isPending} onClick={() => void handleCancel()}>
            {t("admin.passwordReset.cancelPending")}
          </Button>
        </div>
      )}
      <div className="space-y-1">
        <label htmlFor="admin-password-reset-hours" className="text-sm font-medium">
          {t("admin.passwordReset.expiresField")}
        </label>
        <div>
          <Select
            variant="field"
            id="admin-password-reset-hours"
            className="w-fit"
            value={String(hours)}
            onValueChange={(v) => setHours(Number(v))}
            options={HOUR_OPTIONS.map((n) => ({ value: String(n), label: t("admin.passwordReset.hours", { count: n }) }))}
          />
        </div>
      </div>
      <DialogFooter>
        <Button type="submit" variant="brandDeep" disabled={passwordLoginOff || create.isPending || cancel.isPending}>
          {create.isPending ? t("admin.passwordReset.submitting") : t("admin.passwordReset.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Local state resets on close: the generated plaintext link lives only in this state and the result DOM. A failed request closes the dialog and reports via onError. */
export function PasswordResetAction({ row, onError }: { row: AdminUserDto; onError: (message: string | null) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState(1);
  const [created, setCreated] = useState<Created | null>(null);
  // generationRef bumps on each open; openGenerationRef is null while closed. A response arriving after close is dropped (no
  // plaintext kept in memory), and a result from a previous open never touches a reopened dialog.
  const generationRef = useRef(0);
  const openGenerationRef = useRef<number | null>(null);

  if (!row.hasPassword) return null;

  function reset(): void {
    setHours(1);
    setCreated(null);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) generationRef.current += 1;
        openGenerationRef.current = next ? generationRef.current : null;
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <RowIconButton
          label={t("admin.passwordReset.actionLabel", { email: row.email })}
          icon={<KeyRound className="h-4 w-4" />}
          softDisabled={row.disabledAt !== null}
          softDisabledReason={t("errors.user_disabled")}
        />
      </DialogTrigger>
      <DialogContent dismissOnOutside={false}>
        <PasswordResetDialogBody
          row={row}
          hours={hours}
          setHours={setHours}
          created={created}
          generation={() => generationRef.current}
          onCreated={(gen, next) => {
            if (openGenerationRef.current === gen) setCreated(next);
          }}
          onFail={(gen, message) => {
            if (openGenerationRef.current !== null && openGenerationRef.current !== gen) return;
            openGenerationRef.current = null;
            setOpen(false);
            reset();
            onError(message);
          }}
          onError={onError}
        />
      </DialogContent>
    </Dialog>
  );
}
