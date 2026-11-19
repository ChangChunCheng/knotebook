import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { PRESENCE_FIELD, type AvatarRef, type Role } from "@knotebook/shared";
import { resetLocalPresenceFieldForTest, useLocalPresenceField } from "./local-field";
import { fakeProvider, type FakeProvider } from "./test-awareness";

// #293: this tab's `knotebook` field; on reconnect (authenticated) it is rewritten with the same value, on disconnect (close) stale remote meta is cleared.

const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const awarenesses: Awareness[] = [];
let now = 1000;

function newAwareness(): Awareness {
  const a = new Awareness(new Y.Doc());
  awarenesses.push(a);
  return a;
}

type Props = {
  provider: { awareness?: Awareness | null } | FakeProvider | null;
  role: Role | null;
  name: string | null;
  avatar: AvatarRef | null;
};

function mount(initial: Props) {
  return renderHook((props: Props) => useLocalPresenceField(props), { initialProps: initial });
}

/** Each remote builds its own Awareness with the clock pushed to 2, producing the update "as received locally". */
function remoteAt2(): { id: number; update: Uint8Array } {
  const r = newAwareness();
  r.setLocalState({ user: { id: `u-${r.clientID}`, name: "R" } });
  r.setLocalState({ user: { id: `u-${r.clientID}`, name: "R2" } });
  expect(r.meta.get(r.clientID)!.clock).toBe(2);
  return { id: r.clientID, update: encodeAwarenessUpdate(r, [r.clientID]) };
}

function field(a: Awareness): unknown {
  return a.getLocalState()?.[PRESENCE_FIELD];
}

function clock(a: Awareness): number {
  return a.meta.get(a.clientID)!.clock;
}

beforeEach(() => {
  resetLocalPresenceFieldForTest();
  now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => {
  vi.restoreAllMocks();
  awarenesses.splice(0).forEach((a) => a.destroy());
});

describe("useLocalPresenceField", () => {
  it("writes the knotebook field", () => {
    const aw = newAwareness();
    mount({ provider: { awareness: aw }, role: "owner", name: "Ann", avatar: null });
    expect(field(aw)).toEqual({ v: 1, kind: "user", role: "owner", avatar: null, since: 1000 });
  });

  it.each([
    ["role null", { role: null, name: "Ann" }],
    ["role none", { role: "none", name: "Ann" }],
    ["name null", { role: "owner", name: null }],
  ] as const)("%s: no write", (_label, input) => {
    const aw = newAwareness();
    mount({ provider: { awareness: aw }, role: input.role, name: input.name, avatar: null });
    expect(field(aw)).toBeUndefined();
  });

  it("a role change rewrites, since is unchanged", () => {
    const aw = newAwareness();
    const { rerender } = mount({ provider: { awareness: aw }, role: "owner", name: "Ann", avatar: null });
    now = 2000;
    rerender({ provider: { awareness: aw }, role: "viewer", name: "Ann", avatar: null });
    expect(field(aw)).toMatchObject({ role: "viewer", since: 1000 });
  });

  it("an unchanged value is not written (each time a new avatar object with the same content)", () => {
    const aw = newAwareness();
    const provider = { awareness: aw };
    const { rerender } = mount({ provider, role: "owner", name: "Ann", avatar: { id: UUID, v: 1 } });
    const spy = vi.spyOn(aw, "setLocalStateField");
    for (let i = 0; i < 3; i += 1) rerender({ provider, role: "owner", name: "Ann", avatar: { id: UUID, v: 1 } });
    expect(spy).not.toHaveBeenCalled();
    expect(field(aw)).toMatchObject({ avatar: { id: UUID, v: 1 } });
  });

  it("a rename updates since", () => {
    const aw = newAwareness();
    const { rerender } = mount({ provider: { awareness: aw }, role: "owner", name: "Ann", avatar: null });
    now = 3000;
    rerender({ provider: { awareness: aw }, role: "owner", name: "Ann L", avatar: null });
    expect(field(aw)).toMatchObject({ since: 3000 });
  });

  it("switching awareness writes to the new one, since is kept", () => {
    const first = newAwareness();
    const { rerender } = mount({ provider: { awareness: first }, role: "owner", name: "Ann", avatar: null });
    now = 4000;
    const second = newAwareness();
    rerender({ provider: { awareness: second }, role: "owner", name: "Ann", avatar: null });
    expect(field(second)).toEqual({ v: 1, kind: "user", role: "owner", avatar: null, since: 1000 });
  });

  it("unmount and remount (NotePage remount in the same tab): since is still kept", () => {
    const first = newAwareness();
    const { unmount } = mount({ provider: { awareness: first }, role: "owner", name: "Ann", avatar: null });
    unmount();
    now = 5000;
    const second = newAwareness();
    mount({ provider: { awareness: second }, role: "owner", name: "Ann", avatar: null });
    expect(field(second)).toMatchObject({ since: 1000 });
  });

  it("a provider without awareness (the stub shape in NotePage tests): no throw", () => {
    expect(() => mount({ provider: {}, role: "owner", name: "Ann", avatar: null })).not.toThrow();
    expect(() => mount({ provider: null, role: "owner", name: "Ann", avatar: null })).not.toThrow();
  });

  it("deps leave and return to the original value (role owner -> null -> owner on reconnect): no rewrite", () => {
    const aw = newAwareness();
    const provider = { awareness: aw };
    const { rerender } = mount({ provider, role: "owner", name: "Ann", avatar: null });
    const c = clock(aw);
    const spy = vi.spyOn(aw, "setLocalStateField");
    rerender({ provider, role: null, name: "Ann", avatar: null });
    rerender({ provider, role: "owner", name: "Ann", avatar: null });
    expect(spy).not.toHaveBeenCalled();
    expect(clock(aw)).toBe(c);
    expect(field(aw)).toEqual({ v: 1, kind: "user", role: "owner", avatar: null, since: 1000 });
  });

  it("StrictMode mount (effect runs twice) writes once", () => {
    const aw = newAwareness();
    const spy = vi.spyOn(aw, "setLocalStateField");
    renderHook(() => useLocalPresenceField({ provider: { awareness: aw }, role: "owner", name: "Ann", avatar: null }), {
      wrapper: StrictMode,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(field(aw)).toMatchObject({ role: "owner", since: 1000 });
  });

  it("an avatar change updates since", () => {
    const aw = newAwareness();
    const { rerender } = mount({ provider: { awareness: aw }, role: "owner", name: "Ann", avatar: { id: UUID, v: 1 } });
    now = 4000;
    rerender({ provider: { awareness: aw }, role: "owner", name: "Ann", avatar: { id: UUID, v: 2 } });
    expect(field(aw)).toMatchObject({ since: 4000, avatar: { id: UUID, v: 2 } });
  });

  it("authenticated rewrites the same value (clock + 1), also after a rerender without changed props", () => {
    const aw = newAwareness();
    const provider = fakeProvider(aw);
    const props: Props = { provider, role: "owner", name: "Ann", avatar: null };
    const { rerender } = mount(props);
    const before = field(aw);
    const c = clock(aw);
    const spy = vi.spyOn(aw, "setLocalStateField");
    now = 9000;
    act(() => {
      provider.emit("authenticated");
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(clock(aw)).toBe(c + 1);
    expect(field(aw)).toEqual(before);
    expect(field(aw)).toMatchObject({ since: 1000 });
    rerender(props);
    act(() => {
      provider.emit("authenticated");
    });
    expect(clock(aw)).toBe(c + 2);
    expect(field(aw)).toEqual(before);
  });

  it("authenticated does not write when this client has no such field yet", () => {
    const aw = newAwareness();
    const provider = fakeProvider(aw);
    mount({ provider, role: null, name: "Ann", avatar: null });
    const c = clock(aw);
    act(() => {
      provider.emit("authenticated");
    });
    expect(field(aw)).toBeUndefined();
    expect(clock(aw)).toBe(c);
  });

  it("after unmount or switching provider, the old provider's events have no effect", () => {
    const aw = newAwareness();
    const remote = remoteAt2();
    const oldProvider = fakeProvider(aw);
    const { rerender, unmount } = mount({ provider: oldProvider, role: "owner", name: "Ann", avatar: null });
    // Leave a "remote meta with no state": close would delete it if it were still effective
    applyAwarenessUpdate(aw, remote.update, "server");
    removeAwarenessStates(aw, [remote.id], "provider");
    const c = clock(aw);

    const newProvider = fakeProvider(aw);
    rerender({ provider: newProvider, role: "owner", name: "Ann", avatar: null });
    act(() => {
      oldProvider.emit("authenticated");
      oldProvider.emit("close");
    });
    expect(clock(aw)).toBe(c);
    expect(aw.meta.has(remote.id)).toBe(true);

    unmount();
    act(() => {
      newProvider.emit("authenticated");
      newProvider.emit("close");
    });
    expect(clock(aw)).toBe(c);
    expect(aw.meta.has(remote.id)).toBe(true);
  });

  it("close deletes only remote meta other than local that no longer has state; after reconnect the current state with the same clock is accepted", () => {
    const aw = newAwareness();
    const provider = fakeProvider(aw);
    mount({ provider, role: "owner", name: "Ann", avatar: null });
    const r1 = remoteAt2();
    const r2 = remoteAt2();
    applyAwarenessUpdate(aw, r1.update, "server");
    applyAwarenessUpdate(aw, r2.update, "server");
    removeAwarenessStates(aw, [r1.id], "provider");
    act(() => {
      provider.emit("close");
    });
    expect(aw.meta.has(r1.id)).toBe(false);
    expect(aw.meta.has(r2.id)).toBe(true);
    expect(aw.meta.has(aw.clientID)).toBe(true);
    applyAwarenessUpdate(aw, r1.update, "server");
    expect(aw.getStates().has(r1.id)).toBe(true);
  });

  it("contrast: without the hook, current state with the same clock is ignored by the library", () => {
    const aw = newAwareness();
    const r1 = remoteAt2();
    applyAwarenessUpdate(aw, r1.update, "server");
    removeAwarenessStates(aw, [r1.id], "provider");
    applyAwarenessUpdate(aw, r1.update, "server");
    expect(aw.getStates().has(r1.id)).toBe(false);
  });
});
