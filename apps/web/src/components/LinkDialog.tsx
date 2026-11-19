import { useEffect, useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { resolveTrailingMarkdownLink } from "@/collab/markdown-link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export interface LinkDialogProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor has three generic parameters; repo convention is any (as in wikilink/menu.ts)
  editor: any;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (value: { text: string; href: string }) => void;
  initialText?: string;
  initialUrl?: string;
}

/**
 * Validation goes through `resolveTrailingMarkdownLink` by building `[x](url)` with a placeholder text, so the user text never needs markdown escaping; hence `editor` is required.
 * Does not call `editor.createLink` itself: `NoteEditor` restores the selection first and owns the open state.
 * Empty display text falls back to `href`: `createLink(href, "")` takes `addMark(r, i)`, and the `/` menu selection is collapsed, so it would silently do nothing.
 * No `DialogDescription` (inputs are the content); `aria-describedby={undefined}` avoids a dangling target.
 * Focus restore must use `onCloseAutoFocus` + `preventDefault()`: a synchronous `editor.focus()` is overridden by FocusScope (pinned in LinkDialog.test.tsx).
 */
export function LinkDialog({ editor, open, onOpenChange, onSubmit, initialText = "", initialUrl = "" }: LinkDialogProps) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  // unique id so two instances do not clash
  const textId = useId();
  const urlId = useId();
  const urlErrorId = useId();

  useEffect(() => {
    if (open) {
      setText(initialText);
      setUrl(initialUrl);
      setError(null);
    }
    // Prefill is read only at the moment of opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmedUrl = url.trim();
    const hit = resolveTrailingMarkdownLink(editor, `[x](${trimmedUrl})`);
    // `resolveTrailingMarkdownLink` matches the tail, so a URL hiding `)` plus `[y](real` would resolve to a different href than typed; compare back.
    if (!hit || hit.href !== trimmedUrl) {
      setError(t("note.link.invalidUrl"));
      return;
    }
    onSubmit({ text: text.trim() || hit.href, href: hit.href });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        dismissOnOutside={false}
        className="max-w-md"
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          editor.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("note.link.dialogTitle")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor={textId} className="text-sm font-medium">
              {t("note.link.textLabel")}
            </label>
            <Input id={textId} value={text} onChange={(event) => setText(event.target.value)} />
          </div>
          <div className="space-y-1">
            <label htmlFor={urlId} className="text-sm font-medium">
              {t("note.link.urlLabel")}
            </label>
            <Input
              id={urlId}
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setError(null);
              }}
              aria-describedby={error ? urlErrorId : undefined}
            />
            {error && (
              <p id={urlErrorId} role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("home.cancel")}
            </Button>
            <Button type="submit" variant="brandDeep">{t("note.link.insert")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
