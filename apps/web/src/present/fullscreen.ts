/**
 * Must **not** import reveal (entry side). Handles only fullscreen we requested ourselves (owned / pending / exitWanted):
 * an exit wanted while pending is performed by whichever comes first, the resolve or fullscreenchange.
 * Explicit leaves call exitOwnedFullscreen() directly; unmount-style leaves (shell, NotePage / PublicNotePage unmount) go
 * through exitFullscreenIfLeftPresentation() in present-url.ts.
 */
let owned = false;
let pending: Promise<void> | null = null;
let exitWanted = false;
let lastExitAt = 0;

function safeExit() {
  // A rejection of exitFullscreen() is swallowed so no unhandled rejection is left.
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

export function enterPresentationFullscreen(): void { // called synchronously inside a user event handler
  if (!document.fullscreenEnabled || document.fullscreenElement || pending) return;
  owned = true; exitWanted = false;
  pending = document.documentElement.requestFullscreen()
    .then(() => { if (exitWanted && document.fullscreenElement === document.documentElement) { exitWanted = false; safeExit(); } })
    .catch(() => { owned = false; exitWanted = false; })
    .finally(() => { pending = null; });
}

export function exitOwnedFullscreen(): void {
  if (pending) { exitWanted = true; return; } // whichever comes first, resolve or fullscreenchange, does the exit
  if (owned && document.fullscreenElement === document.documentElement) safeExit();
  owned = false;
}

const subscribers = new Set<() => void>();

document.addEventListener("fullscreenchange", () => { // attached once at module load
  if (document.fullscreenElement) {
    if (document.fullscreenElement === document.documentElement && exitWanted) { exitWanted = false; safeExit(); }
  } else {
    owned = false; exitWanted = false; lastExitAt = performance.now(); // used by Esc's 300 ms guard against exiting twice
  }
  for (const cb of subscribers) cb(); // notify only after the state is updated
});

export function isOwnedFullscreen(): boolean {
  return owned && document.fullscreenElement === document.documentElement;
}
/** For Esc's 300 ms guard against exiting twice. */
export function msSinceFullscreenExit(): number {
  return lastExitAt === 0 ? Infinity : performance.now() - lastExitAt;
}
export function subscribeFullscreen(cb: () => void): () => void {
  subscribers.add(cb);
  return () => { subscribers.delete(cb); };
}
