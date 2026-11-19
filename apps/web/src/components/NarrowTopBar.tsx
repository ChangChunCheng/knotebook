import { SidebarDrawerButton } from "@/components/AppShell";
import { BackToListButton } from "@/components/BackToListButton";

/** For cards without their own header (HomePage, fallbacks, NotePage placeholder), so narrow windows always have a way to open the drawer. Not mounted in `AppErrorFallback`: it must have zero context dependency and `SidebarDrawerButton` throws outside AppShell (pinned in ErrorBoundary.test.tsx). */
export function NarrowTopBar() {
  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-2 max-sm:pt-[calc(0.5rem+env(safe-area-inset-top))] xl:hidden">
      {/* one entry per width: back button on phones, sidebar button on the floating tier */}
      <BackToListButton />
      <SidebarDrawerButton />
      <span
        aria-hidden="true"
        className="text-xl font-bold italic text-brand"
        style={{ fontFamily: "'Playfair Display', Georgia, serif" }}
      >
        K
      </span>
      <span className="text-sm font-semibold">Knotebook</span>
    </div>
  );
}
