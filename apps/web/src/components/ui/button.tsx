import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Default height is 32px (h-8) for `Button` (`icon`/`sm`/`default`), `Input` and the `field` Select, so controls in one row are equal height; change one and change all three. `SIDEBAR_ROW_HEIGHT` in `ui/rows.ts` is the sidebar row height (guarded separately), not part of this set. (36px everywhere felt heavy; 36px inputs with 32px buttons looked visibly unequal.)
 *
 * Exception 1: 24px buttons in the sidebar, icon buttons (`h-6 w-6` overrides `icon`'s `h-8 w-8`) and `sm` text buttons at `h-6` in the same header rows (Empty, Select all / Deselect all, Done): sidebar rows and header actions (NoteList, GroupMenu `size="sidebar"`, NoteMenu `SidebarNoteMenu`, TrashPanel, SelectHeader, wide select toolbars, search clear ✕). They never share a row with 32px controls (the search ✕ sits inside the input).
 * Row ⋮/+ buttons share `hoverReveal` from `ui/reveal.ts`; the ⋮ stays while its menu is open. On touch the visual size is unchanged and `ROW_ICON_HIT` in `ui/hit-area.ts` extends the hit area to 44px. Exceptions don't spread: icon buttons outside the sidebar, or in a row with other controls, use `icon` (32px).
 *
 * Exception 2: unauthenticated/account card pages use `size="lg"` (44px, `h-11`), inputs raised with `className="h-11"`: LoginPage, RegisterPage, ResetPasswordPage, LinkAccountPage, ChangePasswordPage (its form is 44px only with `tone="page"`), AuthorizePage.
 * Same card pages keep one size across navigation, and the login page is passed through daily for a single button (touch target). Same size on desktop and phone; `lg` text is 16px, deliberately one step above the 14px labels.
 * `ui/button.lg-scope.guard.test.ts` pins the page list (`LG_SIZE`) and blocks any other `"lg"` literal (`LG_LITERAL`; `ChangePasswordForm.tsx` writes `lg` conditionally by tone, so it is only in that guard's allow list). Checkboxes and checkbox rows (the scope boxes on the authorize page) are not enlarged. To widen, edit this comment and then the guard.
 *
 * Sizes differ only in padding and font size (not height, except `lg`): `icon` icon-only (accessible name via `aria-label`), `sm` row actions and dense places, `default` everything else. Size must not encode severity (error screens used to: full-page reload one size, local retry another, an unwritten rule).
 *
 * Variants follow importance on the screen, not danger:
 * - `default` (solid): the single most important action per SCREEN, not per form (the share panel's three small forms would give three black buttons). With no single lead, no solid button.
 * - `outline`: real in-panel actions; hover/active fill `brand-deep`.
 * - `ghost`: row actions (always icon-form) and text actions meant to recede (Ignore, Log out on the forced password-change page); otherwise only where a row exists to attach to (stand-alone peers use `outline`: ghost has no border or fill and doesn't look like a button).
 *   Deliberate stand-alone exceptions: the wide select toolbars (attached to the header row, each with `title` and `aria-label`), the phone FABs (`sidebar/PhoneListFabs.tsx`, whose class overrides ghost entirely), and the red delete buttons beside peers (TrashFooter permanent delete, SelectActionBar delete, last tour step [Delete]):
 *   `ghost` + `border border-input` + red text, because `outline`'s hover fills `brand-deep`, wrong under red text. Don't "fix" them back to `outline`.
 * - When one row holds two actions, the primary is `outline` and the restore-type/secondary one (clear, back to the automatic URL, regenerate) is `ghost`, so the two can be told apart.
 * - `destructive`: only the submit button of a confirm dialog. `brand`: tint (no border) for signature entry points.
 * - `brandSolid` (`--brand`) for the page-level single action, `brandDeep` for the single action inside a modal or panel; the two never appear on one screen. Exception: the management panels' right card has no solid button (guard `components/management/panel-no-solid-buttons.test.tsx`); dialogs opened from them still use `brandDeep`.
 * - Contrast: `brandSolid` light 4.53–4.77 (white text), dark 5.75–7.78 (near-black text); `brandDeep` light 6.36–6.71, dark 6.69–8.96. Re-measure after changing any swatch lightness: `brandSolid` light is only 0.03 above the AA 4.5 threshold. `outline` pressed in dark mode is 4.43–5.83 (rose 4.43, below AA); light is 8.64–9.04. Measured oklch → sRGB → WCAG relative luminance.
 * - Don't add `secondary` back: `--secondary` is nearly the panel background in light and equals `--accent` (ghost hover) in dark, so it can't be told from hover. Deleting it is the guard: any use is a type error.
 * Dangerous row actions are always a red trash icon button (`text-destructive`, hover `bg-destructive/10`), including ones that open a confirm dialog: a red text button per row shouts.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium " +
    "transition-colors disabled:pointer-events-none disabled:opacity-50 " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        // bg-transparent, not bg-background: `--background` is the page-bottom colour (#0e1013 in dark, darker than dialogs and cards), which would draw a black button on lighter surfaces. Hover fills `brand-deep`.
        // Pressed mixes 15% black via color-mix: `active:bg-brand-deep/85` mixes in transparency and gets lighter over a card. Tailwind 4.3.3's output has an `@supports (color: color-mix(…))` branch that falls back to flat `--brand-deep`.
        outline:
          "border border-input bg-transparent hover:bg-brand-deep hover:text-brand-fg hover:border-transparent " +
          "active:[background:color-mix(in_oklch,var(--brand-deep)_85%,black)]",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        brand: "bg-brand-soft text-brand-on-soft hover:bg-brand-soft-strong",
        brandSolid: "bg-brand text-brand-fg hover:bg-brand/90",
        brandDeep: "bg-brand-deep text-brand-fg hover:bg-brand-deep/90",
      },
      size: {
        default: "h-8 px-4",
        sm: "h-8 rounded-md px-3 text-xs",
        icon: "h-8 w-8",
        lg: "h-11 px-6 text-base",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot.Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

export { buttonVariants };
