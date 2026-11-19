import { useEffect, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { enqueueFill, getQuotaFailed, subscribeFiller, type FillTarget } from "./display-filler";
import { configureForClient } from "./filler-runtime";

/** Settings page only (a lazy chunk); the main bundle must not import it. */
export function useFillPending(targets: readonly FillTarget[]): void {
  const queryClient = useQueryClient();
  configureForClient(queryClient);
  const signature = targets.map(target => `${target.id}:${target.v}`).join(",");
  useEffect(() => {
    for (const target of signature === "" ? [] : signature.split(",")) {
      const separator = target.lastIndexOf(":");
      enqueueFill({ id: target.slice(0, separator), v: Number(target.slice(separator + 1)) });
    }
  }, [signature]);
}

export function useQuotaFailed(): ReadonlyMap<string, FillTarget> {
  return useSyncExternalStore(subscribeFiller, getQuotaFailed);
}
