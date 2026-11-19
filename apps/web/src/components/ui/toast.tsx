import { forwardRef, useSyncExternalStore, type ComponentPropsWithoutRef, type ElementRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Toast as ToastPrimitive } from "radix-ui";
import { X } from "./icons";
import { cn } from "@/lib/utils";
import { Button } from "./button";


export type ToastVariant = "default" | "destructive";

export interface ToastItem {
  id: string;
  title?: string;
  description?: string;
  variant?: ToastVariant;
  durationMs?: number;
  action?: { label: string; onClick: () => void; /** For screen-reader users who can't operate the toast; defaults to `label`. */ altText?: string };
}

type Listener = (toasts: ToastItem[]) => void;

let toasts: ToastItem[] = [];
const listeners = new Set<Listener>();

// No `crypto.randomUUID`: it doesn't exist in non-secure contexts (plain-http LAN is a legitimate topology), so every `toast()` would throw a TypeError (jsdom/Node have a polyfill, so tests miss it). The id only needs session-wide uniqueness for dismiss matching: a counter is enough.
let toastIdSeq = 0;

function emit() {
  for (const listener of listeners) listener(toasts);
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ToastItem[] {
  return toasts;
}

export function dismissToast(id: string): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

/** The store is module-level: tests must reset it themselves to avoid cross-test pollution. */
export function dismissAllToasts(): void {
  toasts = [];
  emit();
}

export function toast(item: Omit<ToastItem, "id">): string {
  const id = `toast-${++toastIdSeq}`;
  toasts = [...toasts, { id, durationMs: 5000, ...item }];
  emit();
  return id;
}

export function useToasts(): ToastItem[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// Viewport location. Normally ToastViewport renders where Toaster is (inside `#root`). The narrow-screen sidebar drawer is a modal Radix Dialog: while open `hideOthers` marks everything else aria-hidden and FocusScope traps focus, so a toast left in place (and its "Undo") is unreadable and unreachable.
// So while the drawer is open AppShell registers an empty node inside the drawer content and Toaster portals the viewport into it; when it unmounts the viewport returns. Toast state and timers live in the Radix Toast components under Toaster, so moving the viewport doesn't reset them.
// But moving re-registers every toast as the top DismissableLayer: a toast that predates the drawer swallows the first Esc in it (closes the toast, not the drawer), the same as a toast that appears while the drawer is open.

let viewportHost: HTMLElement | null = null;
const viewportHostListeners = new Set<() => void>();

function subscribeViewportHost(listener: () => void): () => void {
  viewportHostListeners.add(listener);
  return () => viewportHostListeners.delete(listener);
}

function getViewportHost(): HTMLElement | null {
  return viewportHost;
}

function setViewportHost(host: HTMLElement | null): void {
  viewportHost = host;
  for (const listener of viewportHostListeners) listener();
}

/** Callback ref for modal containers (currently the sidebar drawer): on mount moves the toast viewport into the node, on unmount back; on unmount clears only its own registration (leaves it if another container took over). The viewport is `position: fixed`: the container and its ancestors must not have transform/filter/perspective, or fixed resolves against the container and toasts end up inside the drawer's frame. */
export function toastViewportHostRef(host: HTMLElement | null): (() => void) | undefined {
  if (!host) return undefined;
  setViewportHost(host);
  return () => {
    if (viewportHost === host) setViewportHost(null);
  };
}

export const ToastProvider = ToastPrimitive.Provider;

export const ToastViewport = forwardRef<
  ElementRef<typeof ToastPrimitive.Viewport>,
  ComponentPropsWithoutRef<typeof ToastPrimitive.Viewport>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Viewport
    ref={ref}
    className={cn(
      // pointer-events-none: an empty viewport is still a fixed bottom-right hit region that covers the lower edge of the history bubble; toast items carry `pointer-events-auto` themselves.
      "pointer-events-none fixed bottom-0 right-0 z-[100] flex max-h-screen w-full flex-col gap-2 sm:max-w-[420px]",
      // 16px padding, max'd with the safe area on each side (not covered by the notch or Home indicator).
      "pt-[max(1rem,env(safe-area-inset-top))] pr-[max(1rem,env(safe-area-inset-right))] pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))]",
      className,
    )}
    {...props}
  />
));
ToastViewport.displayName = ToastPrimitive.Viewport.displayName;

const VARIANT_CLASSES: Record<ToastVariant, string> = {
  default: "border-border bg-popover text-popover-foreground",
  destructive: "border-destructive bg-destructive text-destructive-foreground",
};

export const ToastRoot = forwardRef<
  ElementRef<typeof ToastPrimitive.Root>,
  ComponentPropsWithoutRef<typeof ToastPrimitive.Root> & { variant?: ToastVariant }
>(({ className, variant = "default", ...props }, ref) => (
  <ToastPrimitive.Root
    ref={ref}
    className={cn(
      "pointer-events-auto relative flex w-full items-center justify-between gap-4 overflow-hidden " +
        "rounded-md border p-4 pr-8 shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out " +
        "data-[swipe=end]:animate-out data-[state=closed]:fade-out-80 data-[state=closed]:slide-out-to-right-full " +
        "data-[state=open]:slide-in-from-top-full data-[state=open]:sm:slide-in-from-bottom-full",
      VARIANT_CLASSES[variant],
      className,
    )}
    {...props}
  />
));
ToastRoot.displayName = ToastPrimitive.Root.displayName;

export const ToastTitle = forwardRef<
  ElementRef<typeof ToastPrimitive.Title>,
  ComponentPropsWithoutRef<typeof ToastPrimitive.Title>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Title ref={ref} className={cn("text-sm font-semibold", className)} {...props} />
));
ToastTitle.displayName = ToastPrimitive.Title.displayName;

export const ToastDescription = forwardRef<
  ElementRef<typeof ToastPrimitive.Description>,
  ComponentPropsWithoutRef<typeof ToastPrimitive.Description>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Description ref={ref} className={cn("text-sm opacity-90", className)} {...props} />
));
ToastDescription.displayName = ToastPrimitive.Description.displayName;

export const ToastClose = forwardRef<
  ElementRef<typeof ToastPrimitive.Close>,
  ComponentPropsWithoutRef<typeof ToastPrimitive.Close>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Close
    ref={ref}
    className={cn(
      "absolute right-2 top-2 rounded-md p-1 text-foreground/50 opacity-0 transition-opacity " +
        "hover:text-foreground focus:opacity-100 focus:outline-none group-hover:opacity-100",
      className,
    )}
    toast-close=""
    {...props}
  >
    <X className="h-4 w-4" />
  </ToastPrimitive.Close>
));
ToastClose.displayName = ToastPrimitive.Close.displayName;

export function Toaster(): ReactNode {
  const items = useToasts();
  const host = useSyncExternalStore(subscribeViewportHost, getViewportHost, getViewportHost);
  return (
    <ToastProvider>
      {items.map(({ id, title, description, variant, durationMs, action }) => (
        <ToastRoot
          key={id}
          variant={variant}
          duration={durationMs}
          onOpenChange={(open) => {
            if (!open) dismissToast(id);
          }}
        >
          <div className="grid gap-1">
            {title && <ToastTitle>{title}</ToastTitle>}
            {description && <ToastDescription>{description}</ToastDescription>}
          </div>
          {action && (
            <ToastPrimitive.Action asChild altText={action.altText ?? action.label}>
              <Button type="button" variant="outline" size="sm" onClick={action.onClick}>
                {action.label}
              </Button>
            </ToastPrimitive.Action>
          )}
          <ToastClose />
        </ToastRoot>
      ))}
      {host ? createPortal(<ToastViewport />, host) : <ToastViewport />}
    </ToastProvider>
  );
}
