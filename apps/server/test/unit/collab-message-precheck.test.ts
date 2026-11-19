import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AWARENESS_MESSAGE_MAX_BYTES, BOGUS_MESSAGE_LIMIT, classifyClientMessage } from "../../src/collab/server.js";

/** Hand-builds a wire message: varString(docName) + varUint(type) [+ varUint(subtype)].
 * Deliberately avoids lib0 so the test's view of the wire format is independent of the helpers the implementation shares. */
function frame(docName: string, type: number, subtype?: number): Uint8Array {
  const name = new TextEncoder().encode(docName);
  if (name.length >= 128) throw new Error("測試用 docName 請短於 128 bytes（單一 varint byte）");
  if (type >= 128 || (subtype !== undefined && subtype >= 128)) throw new Error("測試用 type/subtype 請 <128");
  const bytes = [name.length, ...name, type];
  if (subtype !== undefined) bytes.push(subtype);
  return new Uint8Array(bytes);
}

const NOTE = "11111111-1111-1111-1111-111111111111";

describe("classifyClientMessage (issue #50 message pre-check)", () => {
  it("types MessageReceiver has a handler for (0/1/3/4/5/7 + Auth+Token + BroadcastStateless(6)) -> ok", () => {
    // The allowlist is the set of cases the 4.5.0 switch actually has, not the MessageType enum range (the enum spans 0..10, but
    // 8/9/10 have no case and fall into the console.error default). 6 is allowed for a different reason: if a client sends it
    // Hocuspocus throws and closes the connection itself, so it limits itself.
    for (const type of [0, 1, 3, 4, 5, 6, 7]) {
      expect(classifyClientMessage(frame(NOTE, type)).verdict).toBe("ok");
    }
    expect(classifyClientMessage(frame(NOTE, 2, 0)).verdict).toBe("ok"); // Auth + Token
  });

  it("enum names without a switch case, SyncStatus(8)/Ping(9)/Pong(10) -> bogus (the hole in #50)", () => {
    for (const type of [8, 9, 10]) {
      const check = classifyClientMessage(frame(NOTE, type));
      expect(check.verdict).toBe("bogus");
      expect(check.type).toBe(type);
    }
  });

  it("unknown type -> bogus, with type and a docName prefix (truncated to 64)", () => {
    const check = classifyClientMessage(frame(NOTE, 42));
    expect(check.verdict).toBe("bogus");
    expect(check.type).toBe(42);
    expect(check.docNamePrefix).toBe(NOTE);

    const longName = "x".repeat(100);
    const longCheck = classifyClientMessage(frame(longName, 42));
    expect(longCheck.docNamePrefix).toBe("x".repeat(64));
  });

  it("bare Pong frame ([10], no documentName prefix; the provider sends it only in reply to a server Ping) -> malformed, passed through", () => {
    // The 4.5.0 server never pings, so no legitimate client sends this today; Hocuspocus throws on it and closes the connection.
    // Upgrading to a server version that pings makes this the reminder to revisit classifyClientMessage.
    expect(classifyClientMessage(new Uint8Array([10])).verdict).toBe("malformed");
  });

  it("Auth with a non-Token subtype (PermissionDenied/Authenticated go server->client) -> bogus", () => {
    expect(classifyClientMessage(frame(NOTE, 2, 1)).verdict).toBe("bogus");
    expect(classifyClientMessage(frame(NOTE, 2, 2)).verdict).toBe("bogus");
  });

  it("malformed message -> malformed (passed on to Hocuspocus, which throws and closes the connection itself)", () => {
    expect(classifyClientMessage(new Uint8Array([])).verdict).toBe("malformed");
    // Claims a name of 100 bytes but the message is only 3 bytes.
    expect(classifyClientMessage(new Uint8Array([100, 1, 2])).verdict).toBe("malformed");
    // A run of varint continuation bytes (every byte has the continuation bit): must not loop forever or be accepted.
    expect(classifyClientMessage(new Uint8Array(20).fill(0xff)).verdict).toBe("malformed");
    // Has a name, no type.
    expect(classifyClientMessage(new Uint8Array([1, 65])).verdict).toBe("malformed");
    // Auth has a type but no subtype.
    expect(classifyClientMessage(frame(NOTE, 2)).verdict).toBe("malformed");
  });

  it("awareness (type 1) message: exactly AWARENESS_MESSAGE_MAX_BYTES -> ok; one byte more -> bogus (#312)", () => {
    // The classifier reads only the header and the total length, so zero-padding after the type byte is enough.
    const sized = (type: number, total: number): Uint8Array => {
      const out = new Uint8Array(total);
      out.set(frame(NOTE, type));
      return out;
    };
    expect(classifyClientMessage(sized(1, AWARENESS_MESSAGE_MAX_BYTES)).verdict).toBe("ok");
    const over = classifyClientMessage(sized(1, AWARENESS_MESSAGE_MAX_BYTES + 1));
    expect(over.verdict).toBe("bogus");
    expect(over.type).toBe(1);
    expect(over.docNamePrefix).toBe(NOTE);
    // Awareness only: document updates (type 0) are not subject to this limit.
    expect(classifyClientMessage(sized(0, AWARENESS_MESSAGE_MAX_BYTES + 1)).verdict).toBe("ok");
  });

  it("limit constant sanity: greater than 1 (rolling-upgrade grace) and finite", () => {
    expect(BOGUS_MESSAGE_LIMIT).toBeGreaterThan(1);
    expect(BOGUS_MESSAGE_LIMIT).toBeLessThanOrEqual(100);
  });

  it("@hocuspocus/server version is on the audited list: upgrading must come back to re-check MessageReceiver's switch", () => {
    // The allowlist "0/1/3/4/5/6/7 + Auth/Token" comes from auditing the dist switch case by case for a specific version (4.5.0 audited
    // for issue #50; 4.6.0 compared byte-identical). The dependency is a ^4.5 caret, so an upgrade is picked up silently; this test forces a
    // re-audit: if a new version adds a handler (e.g. starts replying with Ping), both the allowlist and the bare-Pong malformed handling need another look.
    const pkg = JSON.parse(
      readFileSync(new URL("../../node_modules/@hocuspocus/server/package.json", import.meta.url), "utf8")
    ) as { version: string };
    expect(["4.5.0", "4.6.0"]).toContain(pkg.version);
  });
});
