import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { AdminAuthProbeResultDto, AdminAuthProviderDto, AuthProviderTemplate } from "@knotebook/shared";
import { useCreateAuthProvider, useDiscoverAuthProvider, usePatchAuthProvider, type PatchAuthProviderBody } from "@/api/adminAuth";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Pencil } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { RowIconButton } from "@/components/ui/row-icon-button";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
import { authErrorMessage } from "./auth-error-message";
import "@/i18n/management-strings";

/** Templates prefill only the issuer and display name (GitLab's can be changed to a self-hosted URL). No Microsoft template. */
const TEMPLATE_DEFAULTS: Record<AuthProviderTemplate, { displayName: string; issuerUrl: string }> = {
  gitlab: { displayName: "GitLab", issuerUrl: "https://gitlab.com" },
  google: { displayName: "Google", issuerUrl: "https://accounts.google.com" },
  oidc: { displayName: "", issuerUrl: "" },
};

/**
 * Mirrors the server's `apps/server/src/auth/admin-provider-input.ts` check by check: the web blocks first with errors next
 * to the field; the server stays authoritative. Lengths count code points (`[...s].length`, like the server and the
 * database's `char_length`), not `<input maxLength>` (UTF-16, so an emoji counts twice). The issuer scheme check is
 * case-sensitive (`HTTPS://` is rejected) and can't use `new URL`, which normalizes case. Checks return an i18n key
 * (`admin.auth.validation.*`) or null.
 */
const UNSTORABLE = /[\0]|\p{Surrogate}/u;
const ISSUER_SCHEME = /^https?:\/\//;
const MAX_DISPLAY_NAME_LENGTH = 40;
const MAX_ISSUER_LENGTH = 512;
const MAX_CLIENT_ID_LENGTH = 512;
const MAX_CLIENT_SECRET_LENGTH = 4096;
const MAX_SORT_ORDER = 100_000;
const codePoints = (s: string): number => [...s].length;

type FieldErrors = Partial<Record<"displayName" | "issuerUrl" | "clientId" | "clientSecret" | "sortOrder", string>>;

function checkDisplayName(raw: string): string | null {
  const s = raw.trim();
  if (UNSTORABLE.test(s)) return "unstorable";
  if (codePoints(s) === 0) return "displayNameRequired";
  if (codePoints(s) > MAX_DISPLAY_NAME_LENGTH) return "displayNameTooLong";
  return null;
}

function checkIssuerUrl(raw: string): string | null {
  const s = raw.trim();
  if (UNSTORABLE.test(s)) return "unstorable";
  if (!ISSUER_SCHEME.test(s)) return "issuerScheme";
  if (s.length > MAX_ISSUER_LENGTH) return "issuerTooLong";
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return "issuerInvalid";
  }
  if (url.username !== "" || url.password !== "") return "issuerCredentials";
  return null;
}

/** `allowEmpty`: on create, or when editing a provider with no client ID yet, blank means "not filled", not an error. */
function checkClientId(raw: string, allowEmpty: boolean): string | null {
  const s = raw.trim();
  if (allowEmpty && s === "") return null;
  if (UNSTORABLE.test(s)) return "unstorable";
  if (codePoints(s) === 0) return "clientIdRequired";
  if (codePoints(s) > MAX_CLIENT_ID_LENGTH) return "clientIdTooLong";
  return null;
}

/**
 * The secret is sent verbatim (not trimmed); empty means omitted (create: add it later via edit; edit: unchanged).
 * Whitespace-only is an error rather than silently dropped.
 */
function checkClientSecret(s: string): string | null {
  if (s === "") return null;
  if (UNSTORABLE.test(s)) return "unstorable";
  if (s.trim().length === 0) return "secretBlank";
  if (s.length > MAX_CLIENT_SECRET_LENGTH) return "secretTooLong";
  return null;
}

function collectErrors(checks: Array<[keyof FieldErrors, string | null]>): FieldErrors {
  const errors: FieldErrors = {};
  for (const [field, key] of checks) if (key !== null) errors[field] = key;
  return errors;
}

function FieldError({ id, errorKey }: { id: string; errorKey: string | undefined }) {
  const { t } = useTranslation();
  if (errorKey === undefined) return null;
  return (
    <p id={id} className="text-xs text-destructive">
      {errorKey === "sortOrderInvalid" ? t("admin.auth.edit.sortOrderInvalid") : t(`admin.auth.validation.${errorKey}`)}
    </p>
  );
}

function invalidProps(errorId: string, errorKey: string | undefined) {
  return errorKey === undefined ? {} : { "aria-invalid": true as const, "aria-describedby": errorId };
}

type ProbeState = { ok: true; result: AdminAuthProbeResultDto } | { ok: false; message: string } | null;

function ProbeResult({ probe }: { probe: ProbeState }) {
  const { t } = useTranslation();
  if (probe === null) return null;
  if (!probe.ok) {
    return (
      <p role="alert" className="text-xs text-destructive">
        {probe.message}
      </p>
    );
  }
  return (
    <div role="status" className="space-y-1 text-xs">
      <p>{t("admin.auth.create.checkOk", { issuer: probe.result.issuer })}</p>
      {probe.result.warnings.map(warning => (
        <p key={warning} className="text-destructive">
          {t(`admin.auth.warnings.${warning}`)}
        </p>
      ))}
    </div>
  );
}

function SetupSteps({ provider, onDone }: { provider: AdminAuthProviderDto; onDone: () => void }) {
  const { t } = useTranslation();
  const titleRef = useRef<HTMLHeadingElement>(null);
  // The submit button unmounts and focus falls to body; focus the title so screen readers read from the setup step.
  useEffect(() => {
    titleRef.current?.focus();
  }, []);
  function handleCopy(): void {
    void copyText(provider.callbackUrl).then(ok =>
      toast(ok ? { title: t("admin.auth.callbackCopied") } : { title: t("admin.auth.callbackCopyFailed"), variant: "destructive" }),
    );
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle ref={titleRef} tabIndex={-1} className="outline-none">
          {t("admin.auth.steps.title")}
        </DialogTitle>
        <DialogDescription>{t("admin.auth.steps.intro")}</DialogDescription>
      </DialogHeader>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        <li>
          <p>{t("admin.auth.steps.callback")}</p>
          <div className="flex min-w-0 items-center gap-2">
            <code className="min-w-0 break-all text-xs">{provider.callbackUrl}</code>
            <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
              {t("admin.auth.copyCallback")}
            </Button>
          </div>
        </li>
        <li>{t("admin.auth.steps.scopes")}</li>
        <li>{t("admin.auth.steps.client")}</li>
        {provider.clientId === null && <li>{t("admin.auth.steps.clientId")}</li>}
        {!provider.hasSecret && <li>{t("admin.auth.steps.secret")}</li>}
        <li>{t("admin.auth.steps.finish")}</li>
      </ol>
      <DialogFooter>
        <Button type="button" variant="brandDeep" onClick={onDone}>
          {t("admin.auth.steps.done")}
        </Button>
      </DialogFooter>
    </>
  );
}

export function CreateProviderDialog() {
  const { t } = useTranslation();
  const create = useCreateAuthProvider();
  const discover = useDiscoverAuthProvider();
  const [open, setOpen] = useState(false);
  const [template, setTemplate] = useState<AuthProviderTemplate>("gitlab");
  const [displayName, setDisplayName] = useState(TEMPLATE_DEFAULTS.gitlab.displayName);
  const [issuerUrl, setIssuerUrl] = useState(TEMPLATE_DEFAULTS.gitlab.issuerUrl);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [probe, setProbe] = useState<ProbeState>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<AdminAuthProviderDto | null>(null);

  function reset(): void {
    setTemplate("gitlab");
    setDisplayName(TEMPLATE_DEFAULTS.gitlab.displayName);
    setIssuerUrl(TEMPLATE_DEFAULTS.gitlab.issuerUrl);
    setClientId("");
    setClientSecret("");
    setProbe(null);
    setFieldErrors({});
    setError(null);
    setCreated(null);
  }

  /** Every close (cancel, Esc, click outside, done) resets, so the secret never lingers in state until the next open. */
  function handleOpenChange(next: boolean): void {
    setOpen(next);
    if (!next) reset();
  }

  function chooseTemplate(next: AuthProviderTemplate): void {
    setTemplate(next);
    setDisplayName(TEMPLATE_DEFAULTS[next].displayName);
    setIssuerUrl(TEMPLATE_DEFAULTS[next].issuerUrl);
    setProbe(null);
  }

  async function handleCheck(): Promise<void> {
    setProbe(null);
    const issuerError = checkIssuerUrl(issuerUrl);
    setFieldErrors(prev => ({ ...prev, issuerUrl: issuerError ?? undefined }));
    if (issuerError !== null) return;
    try {
      setProbe({ ok: true, result: await discover.mutateAsync(issuerUrl.trim()) });
    } catch (err) {
      setProbe({ ok: false, message: authErrorMessage(t, err) });
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    const errors = collectErrors([
      ["displayName", checkDisplayName(displayName)],
      ["issuerUrl", checkIssuerUrl(issuerUrl)],
      ["clientId", checkClientId(clientId, true)],
      ["clientSecret", checkClientSecret(clientSecret)],
    ]);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    try {
      // The secret goes verbatim: the server doesn't trim it either (it is exactly what the IdP issued).
      setCreated(
        await create.mutateAsync({
          template,
          displayName: displayName.trim(),
          issuerUrl: issuerUrl.trim(),
          ...(clientId.trim() !== "" ? { clientId: clientId.trim() } : {}),
          ...(clientSecret !== "" ? { clientSecret } : {}),
        }),
      );
      setClientSecret("");
    } catch (err) {
      setError(authErrorMessage(t, err));
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          {t("admin.auth.create.button")}
        </Button>
      </DialogTrigger>
      <DialogContent dismissOnOutside={false}>
        {created !== null ? (
          <SetupSteps provider={created} onDone={() => handleOpenChange(false)} />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("admin.auth.create.title")}</DialogTitle>
              <DialogDescription>{t("admin.auth.create.startsOff")}</DialogDescription>
            </DialogHeader>
            <form noValidate onSubmit={event => void handleSubmit(event)} className="space-y-4">
              <div className="space-y-1">
                <label htmlFor="auth-provider-template" className="text-sm font-medium">
                  {t("admin.auth.create.template")}
                </label>
                <Select
                  variant="field"
                  id="auth-provider-template"
                  className="w-full"
                  value={template}
                  onValueChange={next => chooseTemplate(next as AuthProviderTemplate)}
                  options={[
                    { value: "gitlab", label: t("admin.auth.template.gitlab") },
                    { value: "google", label: t("admin.auth.template.google") },
                    { value: "oidc", label: t("admin.auth.template.oidc") },
                  ]}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="auth-provider-display-name" className="text-sm font-medium">
                  {t("admin.auth.create.displayName")}
                </label>
                <Input
                  id="auth-provider-display-name"
                  aria-required
                  value={displayName}
                  onChange={event => setDisplayName(event.target.value)}
                  {...invalidProps("auth-provider-display-name-error", fieldErrors.displayName)}
                />
                <FieldError id="auth-provider-display-name-error" errorKey={fieldErrors.displayName} />
              </div>
              <div className="space-y-1">
                <label htmlFor="auth-provider-issuer" className="text-sm font-medium">
                  {t("admin.auth.create.issuerUrl")}
                </label>
                <div className="flex gap-2">
                  <Input
                    id="auth-provider-issuer"
                    aria-required
                    value={issuerUrl}
                    onChange={event => {
                      setIssuerUrl(event.target.value);
                      setProbe(null);
                    }}
                    {...invalidProps("auth-provider-issuer-error", fieldErrors.issuerUrl)}
                  />
                  <Button type="button" variant="outline" onClick={() => void handleCheck()} disabled={discover.isPending || issuerUrl.trim() === ""}>
                    {discover.isPending ? t("admin.auth.create.checking") : t("admin.auth.create.check")}
                  </Button>
                </div>
                <FieldError id="auth-provider-issuer-error" errorKey={fieldErrors.issuerUrl} />
                <ProbeResult probe={probe} />
              </div>
              <div className="space-y-1">
                <label htmlFor="auth-provider-client-id" className="text-sm font-medium">
                  {t("admin.auth.create.clientId")}
                </label>
                <Input
                  id="auth-provider-client-id"
                  value={clientId}
                  onChange={event => setClientId(event.target.value)}
                  {...invalidProps("auth-provider-client-id-error", fieldErrors.clientId)}
                  aria-describedby={
                    fieldErrors.clientId === undefined
                      ? "auth-provider-client-id-hint"
                      : "auth-provider-client-id-hint auth-provider-client-id-error"
                  }
                />
                <p id="auth-provider-client-id-hint" className="text-xs text-muted-foreground">
                  {t("admin.auth.create.clientIdHint")}
                </p>
                <FieldError id="auth-provider-client-id-error" errorKey={fieldErrors.clientId} />
              </div>
              <div className="space-y-1">
                <label htmlFor="auth-provider-client-secret" className="text-sm font-medium">
                  {t("admin.auth.create.clientSecret")}
                </label>
                <Input
                  id="auth-provider-client-secret"
                  type="password"
                  autoComplete="off"
                  value={clientSecret}
                  onChange={event => setClientSecret(event.target.value)}
                  {...invalidProps("auth-provider-client-secret-error", fieldErrors.clientSecret)}
                />
                <FieldError id="auth-provider-client-secret-error" errorKey={fieldErrors.clientSecret} />
              </div>
              {error !== null && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <DialogFooter>
                <Button type="submit" variant="brandDeep" disabled={create.isPending}>
                  {create.isPending ? t("admin.auth.create.submitting") : t("admin.auth.create.submit")}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Field values when the dialog opened; the PATCH sends only fields that differ from them. */
interface EditBaseline {
  displayName: string;
  issuerUrl: string;
  clientId: string;
  sortOrder: number;
}

const baselineOf = (provider: AdminAuthProviderDto): EditBaseline => ({
  displayName: provider.displayName,
  issuerUrl: provider.issuerUrl,
  clientId: provider.clientId ?? "",
  sortOrder: provider.sortOrder,
});

/**
 * The secret is write-only: the field always starts blank (with `hasSecret`, the placeholder says it is saved and blank
 * keeps it), and the PATCH omits `clientSecret` when blank. The server 400s on "", and "keep" and "clear" are different;
 * clearing isn't offered.
 * Only fields changed since the dialog opened are sent: if another admin just changed the issuer, sending the old issuer
 * would count as an issuer change on the server, reverting theirs, clearing their new secret and disabling the provider.
 * It also avoids from==to audit rows for untouched fields. With no changes, no request is sent and the dialog just closes. Every close clears
 * the secret field.
 * When the issuer changes, auto-create follows the on-screen toggle: if on, a confirm asks (turn off and save / keep on and
 * save / cancel); if off, `false` is sent explicitly (fail-closed). Unchanged issuer: the field isn't sent. The server
 * doesn't force the value.
 */
export function EditProviderDialog({ provider }: { provider: AdminAuthProviderDto }) {
  const { t } = useTranslation();
  const patch = usePatchAuthProvider();
  const [open, setOpen] = useState(false);
  const [baseline, setBaseline] = useState<EditBaseline>(() => baselineOf(provider));
  const [displayName, setDisplayName] = useState(provider.displayName);
  const [issuerUrl, setIssuerUrl] = useState(provider.issuerUrl);
  const [clientId, setClientId] = useState(provider.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [sortOrder, setSortOrder] = useState(String(provider.sortOrder));
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  // Pending body while the issuer-change confirm is open (open = non-null).
  const [confirmBody, setConfirmBody] = useState<PatchAuthProviderBody | null>(null);

  function handleOpenChange(next: boolean): void {
    setOpen(next);
    // Clear the secret on any close so it doesn't linger in state; it also starts empty, so a reopen is always empty.
    if (!next) {
      setClientSecret("");
      setConfirmBody(null);
    }
    if (next) {
      setBaseline(baselineOf(provider));
      setDisplayName(provider.displayName);
      setIssuerUrl(provider.issuerUrl);
      setClientId(provider.clientId ?? "");
      setSortOrder(String(provider.sortOrder));
      setFieldErrors({});
      setError(null);
    }
  }

  // Compare the raw input with the baseline (trim only on submit): an env-imported issuer may carry trailing whitespace,
  // which would send an unchanged issuer and make the server clear the secret and disable the provider.
  const issuerChanged = issuerUrl !== baseline.issuerUrl;
  const secretEntered = clientSecret !== "";
  // An issuer change clears the secret (unless a new one is sent with it) and disables; a disabled provider has nothing to disable.
  const issuerWarning = !issuerChanged
    ? null
    : provider.hasSecret && !secretEntered
      ? provider.enabled
        ? t("admin.auth.edit.issuerChangeClearsSecret")
        : t("admin.auth.edit.issuerChangeClearsSecretOnly")
      : provider.enabled
        ? t("admin.auth.edit.issuerChangeTurnsOff")
        : null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    const orderText = sortOrder.trim();
    const order = Number(orderText);
    const errors = collectErrors([
      ["displayName", checkDisplayName(displayName)],
      // Unchanged issuer isn't validated: data saved before this rule may contain credentials and mustn't block editing other
      // fields (the server also validates only sent fields).
      ["issuerUrl", issuerChanged ? checkIssuerUrl(issuerUrl) : null],
      ["clientId", checkClientId(clientId, baseline.clientId === "")],
      ["clientSecret", checkClientSecret(clientSecret)],
      ["sortOrder", /^\d+$/.test(orderText) && order <= MAX_SORT_ORDER ? null : "sortOrderInvalid"],
    ]);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const body: PatchAuthProviderBody = {};
    if (displayName !== baseline.displayName) body.displayName = displayName.trim();
    if (issuerChanged) body.issuerUrl = issuerUrl.trim();
    // No client ID yet: whitespace-only counts as unfilled and no key is sent (the server 400s on "").
    if (baseline.clientId === "" ? clientId.trim() !== "" : clientId !== baseline.clientId) body.clientId = clientId.trim();
    if (order !== baseline.sortOrder) body.sortOrder = order;
    if (secretEntered) body.clientSecret = clientSecret;
    if (Object.keys(body).length === 0) {
      handleOpenChange(false);
      return;
    }
    if (issuerChanged) {
      if (provider.autoCreateEnabled) {
        setConfirmBody(body);
        return;
      }
      body.autoCreateEnabled = false; // not asked: off (fail-closed)
    }
    await send(body);
  }

  async function send(body: PatchAuthProviderBody): Promise<void> {
    try {
      const wasEnabled = provider.enabled;
      const updated = await patch.mutateAsync({ id: provider.id, body });
      handleOpenChange(false);
      if (wasEnabled && !updated.enabled) toast({ title: t("admin.auth.turnedOff") });
    } catch (err) {
      setError(authErrorMessage(t, err));
    }
  }

  // Errors show in the edit dialog; the disabled save button blocks resending while in flight.
  function confirmAndSend(autoCreateEnabled: boolean): void {
    const body = confirmBody;
    if (body === null) return;
    setConfirmBody(null);
    void send({ ...body, autoCreateEnabled });
  }

  const fieldId = (field: string): string => `auth-provider-edit-${field}-${provider.id}`;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <RowIconButton label={t("admin.auth.edit.button")} icon={<Pencil className="h-4 w-4" />} />
      </DialogTrigger>
      <DialogContent dismissOnOutside={false}>
        <DialogHeader>
          <DialogTitle>{t("admin.auth.edit.title")}</DialogTitle>
          <DialogDescription>{t("admin.auth.edit.description")}</DialogDescription>
        </DialogHeader>
        <form noValidate onSubmit={event => void handleSubmit(event)} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor={fieldId("name")} className="text-sm font-medium">
              {t("admin.auth.create.displayName")}
            </label>
            <Input
              id={fieldId("name")}
              aria-required
              value={displayName}
              onChange={event => setDisplayName(event.target.value)}
              {...invalidProps(fieldId("name-error"), fieldErrors.displayName)}
            />
            <FieldError id={fieldId("name-error")} errorKey={fieldErrors.displayName} />
          </div>
          <div className="space-y-1">
            <label htmlFor={fieldId("issuer")} className="text-sm font-medium">
              {t("admin.auth.create.issuerUrl")}
            </label>
            <Input
              id={fieldId("issuer")}
              aria-required
              value={issuerUrl}
              onChange={event => setIssuerUrl(event.target.value)}
              {...invalidProps(fieldId("issuer-error"), fieldErrors.issuerUrl)}
            />
            <FieldError id={fieldId("issuer-error")} errorKey={fieldErrors.issuerUrl} />
            {issuerWarning !== null && <p className="text-sm text-muted-foreground">{issuerWarning}</p>}
          </div>
          <div className="space-y-1">
            <label htmlFor={fieldId("client-id")} className="text-sm font-medium">
              {t("admin.auth.create.clientId")}
            </label>
            <Input
              id={fieldId("client-id")}
              aria-required={baseline.clientId !== "" ? true : undefined}
              value={clientId}
              onChange={event => setClientId(event.target.value)}
              {...invalidProps(fieldId("client-id-error"), fieldErrors.clientId)}
            />
            <FieldError id={fieldId("client-id-error")} errorKey={fieldErrors.clientId} />
          </div>
          <div className="space-y-1">
            <label htmlFor={fieldId("secret")} className="text-sm font-medium">
              {t("admin.auth.create.clientSecret")}
            </label>
            <Input
              id={fieldId("secret")}
              type="password"
              autoComplete="off"
              placeholder={provider.hasSecret ? t("admin.auth.edit.secretPlaceholderSaved") : undefined}
              value={clientSecret}
              onChange={event => setClientSecret(event.target.value)}
              {...invalidProps(fieldId("secret-error"), fieldErrors.clientSecret)}
            />
            <FieldError id={fieldId("secret-error")} errorKey={fieldErrors.clientSecret} />
          </div>
          <div className="space-y-1">
            <label htmlFor={fieldId("order")} className="text-sm font-medium">
              {t("admin.auth.edit.sortOrder")}
            </label>
            <Input
              id={fieldId("order")}
              inputMode="numeric"
              value={sortOrder}
              onChange={event => setSortOrder(event.target.value)}
              {...invalidProps(fieldId("order-error"), fieldErrors.sortOrder)}
            />
            <FieldError id={fieldId("order-error")} errorKey={fieldErrors.sortOrder} />
          </div>
          {error !== null && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" variant="brandDeep" disabled={patch.isPending}>
              {patch.isPending ? t("admin.auth.edit.saving") : t("admin.auth.edit.save")}
            </Button>
          </DialogFooter>
        </form>
        <Dialog
          open={confirmBody !== null}
          onOpenChange={next => {
            if (!next) setConfirmBody(null);
          }}
        >
          <DialogContent
            onCloseAutoFocus={event => {
              // The confirm has no trigger to restore focus to; focus the edit dialog's Issuer URL field.
              event.preventDefault();
              document.getElementById(fieldId("issuer"))?.focus();
            }}
          >
            <DialogHeader>
              <DialogTitle>{t("admin.auth.edit.autoCreateConfirmTitle")}</DialogTitle>
              <DialogDescription>{t("admin.auth.edit.autoCreateConfirmDescription", { name: provider.displayName })}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">{t("admin.auth.cancel")}</Button>
              </DialogClose>
              <Button type="button" variant="outline" onClick={() => confirmAndSend(true)}>
                {t("admin.auth.edit.autoCreateConfirmKeep")}
              </Button>
              <Button type="button" variant="brandDeep" onClick={() => confirmAndSend(false)}>
                {t("admin.auth.edit.autoCreateConfirmTurnOff")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}
