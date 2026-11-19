import type { Location, NavigateOptions, To } from "react-router";
import { hashForSlide } from "./present-url";

/**
 * `latest` comes from a ref updated every render, not the effect closure's location (which would write the old pathname
 * back after a rename convergence). If the history key differs from the rendered one a navigation is in flight and the
 * write is deferred to the next render (same guard as NotePage's convergence effect). Only the hash changes, so the
 * convergence effect and AppShell's drawer effect (both look at pathname) return early.
 */
export interface HashWriterDeps {
  latest: () => Location;
  currentKey: () => string;
  historyKey: () => string | undefined;
  navigate: (to: To, options: NavigateOptions) => void;
}

export interface HashWriter {
  request(id: string): void;
  flush(): void;
}

export function createHashWriter(deps: HashWriterDeps): HashWriter {
  let pending: string | null = null;

  const tryWrite = () => {
    if (pending === null) return;
    const latest = deps.latest();
    const hash = hashForSlide(pending);
    if (latest.hash === hash) {
      pending = null;
      return;
    }
    const historyKey = deps.historyKey();
    if (historyKey !== undefined && historyKey !== deps.currentKey()) return;
    pending = null;
    deps.navigate({ pathname: latest.pathname, search: latest.search, hash }, { replace: true, state: latest.state });
  };

  return {
    request(id) {
      pending = id;
      tryWrite();
    },
    flush: tryWrite,
  };
}
