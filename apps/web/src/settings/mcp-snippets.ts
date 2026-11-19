/**
 * Snippets for connecting Claude over MCP (#247): two PAT, two OAuth. Pure functions of the site origin; the token is always the
 * `<YOUR_TOKEN>` placeholder, never a real value. OAuth snippets show on https only (`oauthAvailable`, #159).
 * User-facing docs: connect for real before editing, and keep docs/mcp.md's How to connect in sync.
 */

export const TOKEN_PLACEHOLDER = "<YOUR_TOKEN>";

export function mcpEndpoint(origin: string): string {
  return `${origin}/api/mcp`;
}

/** PAT as a static Bearer header. `-s user` makes it work in any directory: the default local scope only applies in the directory the command ran in (docs/mcp.md). */
export function buildClaudeCodeSnippet(origin: string): string {
  return `claude mcp add -s user --transport http knotebook ${mcpEndpoint(origin)} --header "Authorization: Bearer ${TOKEN_PLACEHOLDER}"`;
}

/**
 * Header via mcp-remote. The header value goes through `env`, with `Authorization:${AUTH_HEADER}` in args: per the mcp-remote README, clients
 * such as Claude Desktop (Windows) don't escape spaces in args when calling npx, so `Bearer <token>` would split. `http://` sites add
 * `--allow-http` (mcp-remote requires an explicit opt-in for non-https endpoints).
 * Emits only the `"knotebook"` entry so users add it under their existing `mcpServers` instead of pasting a second `mcpServers`.
 */
export function buildDesktopSnippet(origin: string): string {
  const args = ["-y", "mcp-remote", mcpEndpoint(origin), "--header", "Authorization:${AUTH_HEADER}"];
  if (origin.startsWith("http:")) args.push("--allow-http");
  const entry = { command: "npx", args, env: { AUTH_HEADER: `Bearer ${TOKEN_PLACEHOLDER}` } };
  return `"knotebook": ${JSON.stringify(entry, null, 2)}`;
}

/** The client refuses to send the token exchange to non-https servers (#159). */
export function oauthAvailable(origin: string): boolean {
  return origin.startsWith("https:");
}

/** `-t http` is required: without a transport the client assumes stdio. Then choose Authenticate in Claude Code's /mcp. */
export function buildClaudeCodeOauthSnippet(origin: string): string {
  return `claude mcp add -s user -t http knotebook ${mcpEndpoint(origin)}`;
}

/** Windows form: `cmd /c npx` wraps mcp-remote; no env, header or `--allow-http`. Also emits only the `"knotebook"` entry. */
export function buildDesktopOauthSnippet(origin: string): string {
  const entry = { command: "cmd", args: ["/c", "npx", "-y", "mcp-remote", mcpEndpoint(origin)] };
  return `"knotebook": ${JSON.stringify(entry, null, 2)}`;
}
