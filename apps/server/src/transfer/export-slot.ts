/** One full export at a time per app (one slot per `transferRoutes` instance). `tryAcquire()` returns a release that works only once: a slot-level `release()` called twice would free another holder's slot. */
export class ExportSlot {
  private holder: symbol | null = null;

  get busy(): boolean {
    return this.holder !== null;
  }

  tryAcquire(): (() => void) | null {
    if (this.holder !== null) return null;
    const me = Symbol("export");
    this.holder = me;
    return () => {
      if (this.holder === me) this.holder = null;
    };
  }
}
