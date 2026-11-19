import { toast } from "@/components/ui/toast";

/** The two entry points pass differently encoded paths; URL normalization makes a non-ASCII slug equal on both. */
export function absoluteUrl(path: string, origin: string = window.location.origin): string {
  return new URL(path, origin).href;
}

export function blockLinkUrl(base: string, blockId: string): string {
  return `${base}#b-${blockId}`;
}

export async function copyBlockLink(url: string, t: (key: string) => string): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
    toast({ title: t("note.blockLink.copied") });
  } catch {
    toast({ title: t("note.blockLink.copyFailed"), variant: "destructive" });
  }
}
