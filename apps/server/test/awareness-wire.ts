// #312 integration tests: hand-built client->server awareness messages sent straight over the TestClient's underlying socket,
// bypassing the provider's own Awareness (forged clientID of someone else, any clock, any state).
// Deliberately not encoded with lib0/y-protocols: the test's understanding of the wire format must be independent of the library the implementation shares.
// Format: varString(docName) + varUint(1=Awareness) + varUint8Array(varUint(n) + n × (varUint(clientId) + varUint(clock) + varString(JSON)))
import type { TestClient } from "./helpers.js";

/** lib0 varUint: low bits first, 7 bits per byte, top bit = continuation. Uses division instead of bit operations so values above 2^32 are also correct. */
function varUint(n: number): number[] {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`varUint 只收非負安全整數：${n}`);
  const out: number[] = [];
  let rest = n;
  while (rest > 0x7f) {
    out.push(0x80 | (rest % 0x80));
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
  return out;
}

function varUint8Array(bytes: ArrayLike<number>): number[] {
  return [...varUint(bytes.length), ...Array.from(bytes)];
}

function varString(s: string): number[] {
  return varUint8Array(new TextEncoder().encode(s));
}

export function awarenessFrame(
  docName: string,
  entries: Array<{ clientId: number; clock: number; state: unknown }>
): Uint8Array {
  const update: number[] = [...varUint(entries.length)];
  for (const e of entries) update.push(...varUint(e.clientId), ...varUint(e.clock), ...varString(JSON.stringify(e.state)));
  return new Uint8Array([...varString(docName), ...varUint(1), ...varUint8Array(update)]);
}

/** Sends bytes straight from the client's underlying WebSocket (bypassing the provider's queue and Awareness). */
export function sendRaw(client: TestClient, bytes: Uint8Array): void {
  const ws = client.provider.configuration.websocketProvider.webSocket;
  if (!ws) throw new Error("sendRaw：這個 client 的 socket 尚未連上");
  ws.send(bytes);
}
