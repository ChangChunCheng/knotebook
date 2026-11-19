import { createContext, useContext } from "react";

/** Context only: components that open the tour (the help dialog) must not drag the tour itself into their chunk. */

export interface TourStartOptions {
  returnTo: string;
  /** A lookup, not the element: the sidebar unmounts on navigation, and on a narrow window the trigger sits in a drawer that has closed. */
  returnFocus: () => Element | null;
}

export interface TourApi {
  start: (options: TourStartOptions) => void;
}

export const TourContext = createContext<TourApi | null>(null);

export function useTour(): TourApi | null {
  return useContext(TourContext);
}
