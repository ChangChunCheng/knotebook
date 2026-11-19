/** Captured when the dialog opens: the row unmounts after removal, so its neighbors can no longer be found. */
export interface RemoveContext {
  trigger: HTMLElement | null;
  instance: Element | null;
  nextId: string | null;
  prevId: string | null;
}

function noteIdOf(el: Element | null): string | null {
  return el !== null && el.getAttribute("data-node-kind") === "note" ? el.getAttribute("data-node-id") : null;
}

export function captureRemoveContext(trigger: HTMLElement | null): RemoveContext {
  const row = trigger?.closest('[data-node-kind="note"]') ?? null;
  return {
    trigger,
    instance: trigger?.closest("[data-sidebar-instance]") ?? null,
    nextId: noteIdOf(row?.nextElementSibling ?? null),
    prevId: noteIdOf(row?.previousElementSibling ?? null),
  };
}

export function focusAfterRemove({ trigger, instance, nextId, prevId }: RemoveContext): void {
  if (trigger !== null && trigger.isConnected) {
    trigger.focus();
    return;
  }
  const root: ParentNode = instance ?? document;
  const rows = Array.from(root.querySelectorAll('[data-node-kind="note"]'));
  for (const id of [nextId, prevId]) {
    if (id === null) continue;
    const link = rows.find((row) => row.getAttribute("data-node-id") === id)?.querySelector("a");
    if (link) {
      link.focus();
      return;
    }
  }
  root.querySelector<HTMLElement>('[role="tabpanel"]')?.focus();
}

/**
 * Waits a macrotask: TanStack Query notifies observers via setTimeout(0) before mutateAsync
 * resolves and React re-renders in a microtask, so the row is unmounted by then.
 */
export function focusAfterRemoveLater(ctx: RemoveContext): void {
  window.setTimeout(() => focusAfterRemove(ctx), 0);
}
