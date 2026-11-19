/** `origin + pathname`: not the full URL (userinfo/query may carry credentials), not just the host (`http://x` to `https://x`, or `/tenant-a` to `/tenant-b`, would log identically). */
export function safeTarget(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}
