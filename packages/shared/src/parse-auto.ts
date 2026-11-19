// Shared so the web's memory warning uses the same formula as the server's site-limits/auto.ts.

export const AUTO_PARSE_WORKERS_MAX = 4;

/** Without PARSE_WORKERS, worker memory limits may sum to at most this share of memory (the rest is for the main process, collab and a co-located PostgreSQL). */
export const PARSE_MEMORY_SHARE = 0.5;

/** Leaves one core for the main process (HTTP, collab). */
export function defaultParseWorkers(cpus: number): number {
  return Math.max(1, Math.min(AUTO_PARSE_WORKERS_MAX, cpus - 1));
}

export function memoryParseWorkers(memoryBytes: number, workerMemoryMb: number): number {
  return Math.max(1, Math.floor((memoryBytes * PARSE_MEMORY_SHARE) / (workerMemoryMb * 1024 * 1024)));
}
