// #312 整合測試用：手工組 client→server 的 awareness 訊息，從 TestClient 的底層 socket 直接送出，
// 繞過 provider 自己的 Awareness（偽造別人的 clientID、任意 clock、任意 state）。
// 刻意不用 lib0／y-protocols 編碼：測試對 wire 格式的理解要獨立於實作共用的函式庫。
// 格式：varString(docName) + varUint(1=Awareness) + varUint8Array(varUint(n) + n × (varUint(clientId) + varUint(clock) + varString(JSON)))
import type { TestClient } from "./helpers.js";

/** lib0 varUint：低位在前、每 byte 7 bits、最高位元＝continuation。用除法不用位元運算，2^32 以上也正確。 */
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

/** 從 client 的底層 WebSocket 直接送出位元組（不經 provider 的佇列與 Awareness）。 */
export function sendRaw(client: TestClient, bytes: Uint8Array): void {
  const ws = client.provider.configuration.websocketProvider.webSocket;
  if (!ws) throw new Error("sendRaw：這個 client 的 socket 尚未連上");
  ws.send(bytes);
}
