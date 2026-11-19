import { createContext, useContext, useLayoutEffect } from "react";

export const AppShellInertContext = createContext<((inert: boolean) => void) | null>(null);

export function useAppShellInert(inert: boolean): void {
  const setInert = useContext(AppShellInertContext);
  useLayoutEffect(() => {
    if (setInert === null) return;
    setInert(inert);
    return () => setInert(false);
  }, [setInert, inert]);
}
