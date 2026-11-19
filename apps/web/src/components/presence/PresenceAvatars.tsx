import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { Awareness } from "y-protocols/awareness";
import type { CursorScroller } from "@/collab/cursor-scroll";
import { Avatar } from "@/components/Avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { createLongPress } from "@/lib/long-press";
import { cn } from "@/lib/utils";
import { hasVisibleText, presenceLayout, type PresenceKey, type PresencePerson } from "./people";
import { usePresencePeople } from "./usePresencePeople";

export interface PresenceAvatarsProps {
  provider: { awareness?: Awareness | null } | null;
  /** `state.phase === "connected"`. */
  connected: boolean;
  myUserId: string;
  scrollerRef: { readonly current: CursorScroller | null };
}

type Opener = PresenceKey | "more";

/**
 * Three forms (the header is a container):
 * - viewport `< 640` (`max-sm`): compact, no avatars, one "+N" (N = everyone else);
 * - viewport `>= 640` and header container `< 43.5rem`: narrow, at most 2 slots;
 * - otherwise: wide, at most 5 slots.
 * Hidden via `display:none` (not left out of the DOM), so up to three "+N" buttons exist at once, each with its own classes.
 */
/** Wide only: hidden when the viewport is `< 640` or the header container `< 43.5rem` (same threshold as the header's width toggle). */
const WIDE_ONLY = "max-sm:hidden @max-[43.5rem]:hidden";
/** Narrow only: hidden at phone width, and at viewport `>= 640` when the header container is `>= 43.5rem`. */
const NARROW_ONLY = "max-sm:hidden sm:@min-[43.5rem]:hidden";
const COMPACT_ONLY = "sm:hidden";
/** Avatars always hide at phone width (only the compact +N remains); those the narrow form keeps aren't hidden at 640 and up. */
const PHONE_HIDDEN = "max-sm:hidden";
/**
 * The hit area grows via `::before` without changing layout: 32×32 px by default, 36×44 px on touch (`pointer-coarse`); the
 * focused/hovered one rises so its focus ring isn't covered by the next. With 24 px avatars overlapping by `-ms-1.5` (6 px),
 * the next one's `::before` may extend at most 6 px left, or it covers the previous avatar's center (Playwright `hover()`
 * gets intercepted and hangs; touch hits the neighbour) (#335). So x and y grow separately: x is limited by the overlap
 * (4 px default, 6 px touch); y has no neighbours, so touch gets 10 px to keep a 44 px touch height.
 */
const HIT_BASE =
  "relative inline-flex rounded-full outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 " +
  "hover:z-10 before:absolute before:content-['']";
const HIT = `${HIT_BASE} before:-inset-x-1 before:-inset-y-1 pointer-coarse:before:-inset-x-1.5 pointer-coarse:before:-inset-y-2.5`;
/** Compact +N: 32×28 visual, 40×44 hit area; at phone width it is the only visible button in the row, so no neighbour to avoid. */
const HIT_COMPACT = `${HIT_BASE} before:-inset-x-1 before:-inset-y-2`;

/** `display:none` variants make `focus()` fail silently, so return focus to a visible target. */
function focusable(el: HTMLElement | null | undefined): el is HTMLElement {
  return !!el && el.isConnected && getComputedStyle(el).display !== "none";
}

/** User-entered strings (names, token labels) are isolated in `<bdi>` and truncated; the rest of the translation template stays as is. */
const SLOT_OPEN = String.fromCharCode(0xe000);
const SLOT_CLOSE = String.fromCharCode(0xe001);
const slot = (i: number) => `${SLOT_OPEN}${i}${SLOT_CLOSE}`;
const SLOT_RE = new RegExp(`${SLOT_OPEN}(\\d)${SLOT_CLOSE}`);

function isolated(template: string, values: readonly string[]): ReactNode {
  const parts = template.split(SLOT_RE);
  return (
    <span className="flex min-w-0 max-w-full">
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <bdi key={i} className="min-w-0 truncate">
            {values[Number(part)]}
          </bdi>
        ) : part === "" ? null : (
          <span key={i} className="shrink-0 whitespace-pre">
            {part}
          </span>
        ),
      )}
    </span>
  );
}

/** `?` (as in the initial circle) when the name has no visible characters, so the label doesn't start with ", viewer". */
function shownName(p: Extract<PresencePerson, { kind: "user" }>): string {
  return hasVisibleText(p.name) ? p.name : "?";
}

function ariaLabel(t: TFunction, p: PresencePerson): string {
  if (p.kind === "agent") {
    return t(p.hasCursor ? "note.presence.agentCursor" : "note.presence.agentNoCursor", { handle: p.handle, label: p.label });
  }
  const name = shownName(p);
  if (p.role === null) return t(p.hasCursor ? "note.presence.avatarNameCursor" : "note.presence.avatarNameNoCursor", { name });
  return t(p.hasCursor ? "note.presence.avatarCursor" : "note.presence.avatarNoCursor", { name, role: t(`roles.${p.role}`) });
}

function tipTitle(t: TFunction, p: PresencePerson): ReactNode {
  if (p.kind === "agent") return isolated(t("note.presence.tipAgent", { handle: slot(0), label: slot(1) }), [p.handle, p.label]);
  const name = shownName(p);
  if (p.role === null) return isolated(slot(0), [name]);
  return isolated(t("note.presence.tipRole", { name: slot(0), role: t(`roles.${p.role}`) }), [name]);
}

function tipHint(t: TFunction, p: PresencePerson): string {
  if (!p.hasCursor) return t("note.presence.hintNoCursor");
  return t(p.kind === "agent" ? "note.presence.hintCursorAgent" : "note.presence.hintCursor");
}

function rowName(p: PresencePerson): string {
  return p.kind === "agent" ? `${p.handle} (${p.label})` : shownName(p);
}

function rowRole(t: TFunction, p: PresencePerson): string {
  if (p.kind === "agent") return t("note.presence.agent");
  return p.role === null ? "" : t(`roles.${p.role}`);
}

function PersonAvatar({ person, size, offsetColor }: { person: PresencePerson; size: number; offsetColor?: string }) {
  return person.kind === "agent" ? (
    <Avatar name={person.handle} avatar={null} size={size} ringColor={person.color} offsetColor={offsetColor} kind="agent" />
  ) : (
    <Avatar name={person.name} avatar={person.avatar} size={size} ringColor={person.color} offsetColor={offsetColor} />
  );
}

interface PersonButtonProps {
  person: PresencePerson;
  className: string;
  suppressed: boolean;
  onUnsuppress: () => void;
  onScroll: () => void;
  onLongPress: (el: HTMLElement | null) => void;
}

function PersonButton({ person, className, suppressed, onUnsuppress, onScroll, onLongPress }: PersonButtonProps) {
  const { t } = useTranslation();
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Controlled: Radix's open/close intent is still taken; suppression only masks the display.
  const [tipOpen, setTipOpen] = useState(false);
  const longPressRef = useRef(onLongPress);
  longPressRef.current = onLongPress;
  const [press] = useState(() => createLongPress(() => longPressRef.current(buttonRef.current)));
  useEffect(() => () => press.dispose(), [press]);

  return (
    <Tooltip open={tipOpen && !suppressed} onOpenChange={setTipOpen}>
      <TooltipTrigger asChild aria-describedby={undefined}>
        <button
          ref={buttonRef}
          data-person-key={person.key}
          type="button"
          aria-label={ariaLabel(t, person)}
          className={cn(HIT, className)}
          onClick={() => {
            if (press.consumeClick()) return;
            onScroll();
          }}
          onPointerDown={(e) => {
            // While suppressed, Radix doesn't call onClose (`open` is already false), so close tipOpen here.
            onUnsuppress();
            setTipOpen(false);
            press.down(e);
          }}
          onPointerMove={(e) => press.move(e)}
          onPointerUp={() => press.end()}
          onPointerCancel={() => press.end()}
          onContextMenu={(e) => {
            if (press.contextMenu()) e.preventDefault();
          }}
          onKeyDown={onUnsuppress}
          onBlur={() => {
            // Same: Radix's blur close doesn't call onOpenChange while suppressed.
            onUnsuppress();
            setTipOpen(false);
          }}
        >
          <PersonAvatar person={person} size={24} />
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <div>{tipTitle(t, person)}</div>
        <div className="text-muted-foreground">{tipHint(t, person)}</div>
      </TooltipContent>
    </Tooltip>
  );
}

function MoreButton({
  count,
  expanded,
  className,
  compact = false,
  onOpen,
}: {
  count: number;
  expanded: boolean;
  className: string;
  compact?: boolean;
  onOpen: (el: HTMLElement) => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-label={t("note.presence.more", { count })}
      aria-haspopup="menu"
      aria-expanded={expanded}
      className={cn(
        compact ? `${HIT_COMPACT} h-7 w-8 max-sm:ms-0!` : `${HIT} h-6 w-6`,
        "items-center justify-center bg-muted text-xs font-semibold text-foreground",
        className,
      )}
      onClick={(e) => onOpen(e.currentTarget)}
    >
      +{count}
    </button>
  );
}

/**
 * Header avatar row (#293). Renders nothing when only I am present or not connected. No `aria-live`.
 * The menu Trigger is a hidden sibling wrapping no avatar; the menu opens only via +N and long press (controlled `open`).
 */
export function PresenceAvatars({ provider, connected, myUserId, scrollerRef }: PresenceAvatarsProps) {
  const { t } = useTranslation();
  const { people, cursorOf } = usePresencePeople(connected ? (provider?.awareness ?? null) : null, myUserId);
  const [menu, setMenu] = useState<Opener | null>(null);
  // Radix calls onCloseAutoFocus in setTimeout(0); reading the ref gives the latest opener.
  const openerRef = useRef<{ opener: Opener; el: HTMLElement | null } | null>(null);
  const [suppressedKey, setSuppressedKey] = useState<PresenceKey | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const visible = connected && people.length > 0;

  useEffect(() => {
    if (!visible) setMenu(null);
  }, [visible]);

  if (!visible) return null;

  const layout = presenceLayout(people.length);
  const title = t("note.presence.menuTitle", { count: people.length });
  const openMenu = (opener: Opener, el: HTMLElement | null) => {
    openerRef.current = { opener, el };
    setMenu(opener);
  };
  const scrollTo = (key: PresenceKey) => {
    const cursor = cursorOf(key);
    if (cursor !== null) scrollerRef.current?.(cursor);
  };
  const unsuppress = () => setSuppressedKey(null);
  // `onOpenAutoFocus` is a private prop of Radix Menu 2.1.24 (untyped on DropdownMenu, forwarded to FocusScope at
  // `react-menu dist/index.mjs:179`, `:266`); long press focusing the row relies on it, and the matching test goes red after a Radix upgrade.
  const openAutoFocus: object = {
    onOpenAutoFocus: (e: Event) => {
      const opener = openerRef.current?.opener;
      if (opener === undefined || opener === "more") return;
      e.preventDefault();
      const rows = (e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("[data-person-key]");
      [...rows].find((row) => row.dataset.personKey === opener)?.focus();
    },
  };

  return (
    <TooltipProvider delayDuration={300}>
      {/* Overlap via `-ms-1.5` on the following button, not `-space-x-1.5`: a hidden +N is often the last DOM child,
          and that would give the last visible avatar −6 px too. The hidden Trigger stays the first child. */}
      <div
        ref={groupRef}
        role="group"
        aria-label={t("note.presence.label")}
        className="relative flex shrink-0 items-center [&>button+button]:-ms-1.5"
      >
        <DropdownMenu
          open={menu !== null}
          onOpenChange={(o) => {
            if (!o) setMenu(null);
          }}
        >
          <DropdownMenuTrigger asChild>
            <span aria-hidden="true" tabIndex={-1} className="pointer-events-none absolute inset-0" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            aria-label={title}
            aria-labelledby={undefined}
            className="max-w-72"
            {...openAutoFocus}
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              const current = openerRef.current;
              openerRef.current = null;
              if (current === null) return;
              // The opener left or is hidden (wide/narrow switch): fall back to the first visible button in the row.
              const buttons = [...(groupRef.current?.querySelectorAll<HTMLElement>("button") ?? [])];
              const target = focusable(current.el) ? current.el : buttons.find(focusable);
              if (!target) return;
              // Opened by long press (touch): suppress the Tooltip of the avatar that actually gets focus.
              const key = target.dataset.personKey as PresenceKey | undefined;
              if (current.opener !== "more" && key) setSuppressedKey(key);
              target.focus({ preventScroll: true });
            }}
          >
            <DropdownMenuLabel>{title}</DropdownMenuLabel>
            {people.map((p) => (
              <DropdownMenuItem
                key={p.key}
                data-person-key={p.key}
                // Not `disabled`: Radix would drop it from arrow-key navigation (and screen-reader traversal) and dim it.
                // `aria-disabled` stays focusable and readable; selecting it neither scrolls nor closes the menu.
                aria-disabled={p.hasCursor ? undefined : true}
                className="gap-2"
                onSelect={(e) => {
                  if (!p.hasCursor) {
                    e.preventDefault();
                    return;
                  }
                  scrollTo(p.key);
                }}
              >
                <PersonAvatar person={p} size={24} offsetColor="var(--color-popover)" />
                <bdi className="min-w-0 flex-1 truncate">{rowName(p)}</bdi>{" "}
                <span className="shrink-0 ps-2 text-xs text-muted-foreground">{rowRole(t, p)}</span>
                {!p.hasCursor && (
                  <>
                    {" "}
                    <span className="shrink-0 text-xs text-muted-foreground">{t("note.presence.rowNoCursor")}</span>
                  </>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {people.slice(0, layout.wide.shown).map((p, i) => (
          <PersonButton
            key={p.key}
            person={p}
            className={i < layout.narrow.shown ? PHONE_HIDDEN : WIDE_ONLY}
            suppressed={suppressedKey === p.key}
            onUnsuppress={unsuppress}
            onScroll={() => scrollTo(p.key)}
            onLongPress={(el) => openMenu(p.key, el)}
          />
        ))}
        {layout.wide.more > 0 && (
          <MoreButton
            count={layout.wide.more}
            expanded={menu === "more"}
            className={WIDE_ONLY}
            onOpen={(el) => openMenu("more", el)}
          />
        )}
        {layout.narrow.more > 0 && (
          <MoreButton
            count={layout.narrow.more}
            expanded={menu === "more"}
            className={NARROW_ONLY}
            onOpen={(el) => openMenu("more", el)}
          />
        )}
        {layout.compact.more > 0 && (
          <MoreButton
            count={layout.compact.more}
            expanded={menu === "more"}
            className={COMPACT_ONLY}
            compact
            onOpen={(el) => openMenu("more", el)}
          />
        )}
      </div>
    </TooltipProvider>
  );
}
