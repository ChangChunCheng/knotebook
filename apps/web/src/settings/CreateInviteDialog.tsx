import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { MAX_INVITE_LABEL_LENGTH } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useAuthConfig } from "@/api/authConfig";
import { useCreateInvite } from "@/api/admin";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { OneTimeLinkResult } from "./OneTimeLinkResult";
import "@/i18n/management-strings";

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

const DAY_OPTIONS = [1, 2, 3, 4, 5, 6, 7];

interface Created {
  token: string;
  expiresAt: string;
}

/**
 * Dialog content: `useAuthConfig()` and `useCreateInvite()` live here because Radix unmounts it on close, so the header trigger doesn't fetch
 * `/api/auth/config` on first render and a reopen doesn't inherit the previous pending state.
 */
function CreateInviteDialogBody({
  days,
  setDays,
  label,
  setLabel,
  labelError,
  setLabelError,
  error,
  setError,
  created,
  generation,
  onCreated,
  onFail,
}: {
  days: number;
  setDays: (days: number) => void;
  label: string;
  setLabel: (label: string) => void;
  labelError: boolean;
  setLabelError: (labelError: boolean) => void;
  error: string | null;
  setError: (error: string | null) => void;
  created: Created | null;
  /** Open generation at submit time; the callback returns it so the previous open's result is dropped. */
  generation: () => number;
  onCreated: (generation: number, created: Created) => void;
  onFail: (generation: number, message: string) => void;
}) {
  const { t } = useTranslation();
  const authConfig = useAuthConfig();
  const create = useCreateInvite();
  const passwordLoginOff = authConfig.data?.passwordLogin.enabled === false;

  if (created !== null) {
    return (
      <OneTimeLinkResult
        title={t("admin.invites.createdTitle")}
        url={`${window.location.origin}/register#invite=${created.token}`}
        expiresAt={created.expiresAt}
      />
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    if ([...label.trim()].length > MAX_INVITE_LABEL_LENGTH) {
      setLabelError(true);
      return;
    }
    setLabelError(false);
    const gen = generation();
    try {
      // The server trims and stores an empty label as NULL; whitespace-only is sent as "".
      const res = await create.mutateAsync({ expiresInDays: days, label: label.trim() === "" ? "" : label });
      onCreated(gen, { token: res.token, expiresAt: res.invite.expiresAt });
    } catch (err) {
      onFail(gen, errorMessage(t, err));
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
      <DialogHeader>
        <DialogTitle>{t("admin.invites.createTitle")}</DialogTitle>
        <DialogDescription>{t("admin.invites.createDescription")}</DialogDescription>
      </DialogHeader>
      {passwordLoginOff && <p className="text-sm text-muted-foreground">{t("admin.invites.passwordLoginOff")}</p>}
      <div className="space-y-1">
        <label htmlFor="admin-invite-days" className="text-sm font-medium">
          {t("admin.invites.expiresField")}
        </label>
        <div>
          <Select
            variant="field"
            id="admin-invite-days"
            className="w-fit"
            value={String(days)}
            onValueChange={(v) => setDays(Number(v))}
            options={DAY_OPTIONS.map((n) => ({ value: String(n), label: t("admin.invites.days", { count: n }) }))}
          />
        </div>
      </div>
      <div className="space-y-1">
        <label htmlFor="admin-invite-label" className="text-sm font-medium">
          {t("admin.invites.labelField")}
        </label>
        <Input
          id="admin-invite-label"
          autoComplete="off"
          aria-describedby="admin-invite-label-hint"
          value={label}
          onChange={(event) => {
            setLabel(event.target.value);
            setLabelError(false);
          }}
        />
        <p id="admin-invite-label-hint" className="text-xs text-muted-foreground">
          {t("admin.invites.labelHint")}
        </p>
        {labelError && (
          <p role="alert" className="text-sm text-destructive">
            {t("admin.invites.labelTooLong")}
          </p>
        )}
      </div>
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="submit" variant="brandDeep" disabled={passwordLoginOff || create.isPending}>
          {create.isPending ? t("admin.invites.submitting") : t("admin.invites.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * State resets on close: the plaintext token lives only in this state and the result DOM. A response arriving after the
 * dialog closed (or closed and reopened) is dropped by generation, so neither the plaintext nor a stale error comes back
 * (like `PasswordResetAction`).
 */
export function CreateInviteDialog() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState(3);
  const [label, setLabel] = useState("");
  const [labelError, setLabelError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  // Bumped on every open/close; recorded at submit, and a response with a different value is dropped.
  const generationRef = useRef(0);

  function reset(): void {
    setDays(3);
    setLabel("");
    setLabelError(false);
    setError(null);
    setCreated(null);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        generationRef.current += 1;
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          {t("admin.invites.create")}
        </Button>
      </DialogTrigger>
      <DialogContent dismissOnOutside={false}>
        <CreateInviteDialogBody
          days={days}
          setDays={setDays}
          label={label}
          setLabel={setLabel}
          labelError={labelError}
          setLabelError={setLabelError}
          error={error}
          setError={setError}
          created={created}
          generation={() => generationRef.current}
          onCreated={(gen, next) => {
            if (generationRef.current === gen) setCreated(next);
          }}
          onFail={(gen, message) => {
            if (generationRef.current === gen) setError(message);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
