/**
  * Lock order: the `users` row (`FOR NO KEY UPDATE`) first, which serializes one person's avatar writes so the later space lock and
  * candidate-row locks can't cycle. Only `tx`, plain data and typed test hooks go in. The caller writes the original file beforehand and
  * unlinks it if this throws. Switching the current avatar is two statements (clear the old flag, set the new one): the partial unique
  * index can't be DEFERRABLE. The OIDC form of `insertAvatarInTx` (input has `identityId`) stores no display image or crop (the user's
  * browser produces them later) and counts only the original; it never changes `avatar_auto` (a login import isn't the user's choice):
  * the candidate becomes current only if `avatar_auto` is true and there is no current avatar. `selectAvatarInTx`/`deleteAvatarInTx`
  * only reduce or keep usage, so they skip `assertSpaceRoomInTx`; `updateAvatarDisplayInTx` passes the size difference (no lock when <= 0).
  */
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { userAvatars, userIdentities, users } from "../../db/schema.js";
import { TxAbort } from "../../http/tx-abort.js";
import { assertSpaceRoomInTx } from "../../storage/tx/quota.js";

/** Same 404 for a missing candidate and someone else's, so other users' candidate ids aren't revealed. */
export class AvatarNotFound extends TxAbort {
  constructor() {
    super(404, "not_found", "No avatar with that id.");
    this.name = "AvatarNotFound";
  }
}

export class AvatarOutdated extends TxAbort {
  constructor() {
    super(409, "avatar_outdated", "This avatar changed since you loaded it. Reload and try again.");
    this.name = "AvatarOutdated";
  }
}

export interface AvatarTestHooks {
  afterUserLock?: () => Promise<void>;
}

export interface InsertAvatarInput {
  userId: string;
  originalFile: string;
  originalSha256: Buffer;
  originalMime: string;
  originalSize: number;
  originalWidth: number;
  originalHeight: number;
  crop: { x: number; y: number; size: number };
  displayData: Buffer;
  displayMime: string;
  lockTimeoutMs: number;
}

export interface OidcAvatarInput {
  userId: string;
  identityId: string;
  oidcPictureUrl: string;
  originalFile: string;
  originalSha256: Buffer;
  originalMime: string;
  originalSize: number;
  lockTimeoutMs: number;
}

export type InsertOidcAvatarInput = OidcAvatarInput;
export type ReplaceOidcAvatarInput = OidcAvatarInput;

const isOidcInput = (input: InsertAvatarInput | InsertOidcAvatarInput): input is InsertOidcAvatarInput => "identityId" in input;

export async function insertAvatarInTx(tx: Tx, input: InsertAvatarInput | InsertOidcAvatarInput, hooks?: AvatarTestHooks): Promise<typeof userAvatars.$inferSelect> {
  const locked = await tx.select({ id: users.id, avatarAuto: users.avatarAuto }).from(users).where(eq(users.id, input.userId)).for("no key update");
  if (locked.length === 0) throw new TxAbort(404, "not_found", "No user with that id.");
  await hooks?.afterUserLock?.();
  const incoming = isOidcInput(input) ? input.originalSize : input.originalSize + input.displayData.length;
  await assertSpaceRoomInTx(tx, { kind: "user", id: input.userId }, incoming, { lockTimeoutMs: input.lockTimeoutMs });
  if (isOidcInput(input)) {
    // The users row lock keeps anyone from inserting a current avatar between this check and the INSERT.
    const [current] = await tx
      .select({ id: userAvatars.id })
      .from(userAvatars)
      .where(and(eq(userAvatars.userId, input.userId), eq(userAvatars.isCurrent, true)))
      .limit(1);
    const [oidcRow] = await tx
      .insert(userAvatars)
      .values({
        userId: input.userId,
        source: "oidc",
        identityId: input.identityId,
        oidcPictureUrl: input.oidcPictureUrl,
        originalFile: input.originalFile,
        originalSha256: input.originalSha256,
        originalMime: input.originalMime,
        originalSize: input.originalSize,
        isCurrent: locked[0]!.avatarAuto && current === undefined,
      })
      .returning();
    return oidcRow!;
  }
  await tx.update(userAvatars).set({ isCurrent: false }).where(and(eq(userAvatars.userId, input.userId), eq(userAvatars.isCurrent, true)));
  const [row] = await tx
    .insert(userAvatars)
    .values({
      userId: input.userId,
      source: "upload",
      originalFile: input.originalFile,
      originalSha256: input.originalSha256,
      originalMime: input.originalMime,
      originalSize: input.originalSize,
      originalWidth: input.originalWidth,
      originalHeight: input.originalHeight,
      cropX: input.crop.x,
      cropY: input.crop.y,
      cropSize: input.crop.size,
      displayData: input.displayData,
      displayMime: input.displayMime,
      displaySize: input.displayData.length,
      isCurrent: true,
    })
    .returning();
  await tx.update(users).set({ avatarAuto: false }).where(eq(users.id, input.userId));
  return row!;
}

export class AvatarIdentityGone extends TxAbort {
  constructor() {
    super(404, "not_found", "That sign-in is no longer linked.");
    this.name = "AvatarIdentityGone";
  }
}

export type ReplaceOidcAvatarResult =
  | { outcome: "inserted" }
  /** `oldFile` is the replaced original; the caller deletes it after commit. */
  | { outcome: "replaced"; oldFile: string }
  /** Same bytes: only the URL was updated; the caller deletes the freshly written file. */
  | { outcome: "same_bytes" }
    /** No candidate existed and the URL was dismissed during the download: nothing inserted, the caller deletes the freshly written file. */
  | { outcome: "dismissed" };

export async function replaceOidcAvatarInTx(tx: Tx, input: ReplaceOidcAvatarInput, hooks?: AvatarTestHooks): Promise<ReplaceOidcAvatarResult> {
  const locked = await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).for("no key update");
  if (locked.length === 0) throw new TxAbort(404, "not_found", "No user with that id.");
  await hooks?.afterUserLock?.();
  // KEY SHARE: an unlink waits for this transaction, and the candidate's FK can't hit a deleted identity.
  const identity = await tx
    .select({ id: userIdentities.id, pictureDismissedUrl: userIdentities.pictureDismissedUrl })
    .from(userIdentities)
    .where(and(eq(userIdentities.id, input.identityId), eq(userIdentities.userId, input.userId)))
    .for("key share");
  if (identity.length === 0) throw new AvatarIdentityGone();
  const [row] = await tx
    .select({ id: userAvatars.id, originalFile: userAvatars.originalFile, originalSize: userAvatars.originalSize, originalSha256: userAvatars.originalSha256, displaySize: userAvatars.displaySize })
    .from(userAvatars)
    .where(and(eq(userAvatars.identityId, input.identityId), eq(userAvatars.userId, input.userId)))
    .for("update");
  if (row === undefined) {
    // The user may have re-fetched and then deleted this picture during the download; the URL is on the identity row, hence the re-read.
    if (identity[0]!.pictureDismissedUrl === input.oidcPictureUrl) return { outcome: "dismissed" };
    await insertAvatarInTx(tx, input);
    return { outcome: "inserted" };
  }
  if (row.originalSha256.equals(input.originalSha256)) {
    await tx
      .update(userAvatars)
      .set({ oidcPictureUrl: input.oidcPictureUrl })
      .where(and(eq(userAvatars.id, row.id), eq(userAvatars.userId, input.userId), eq(userAvatars.identityId, input.identityId)));
    return { outcome: "same_bytes" };
  }
  await assertSpaceRoomInTx(tx, { kind: "user", id: input.userId }, input.originalSize - row.originalSize - row.displaySize, { lockTimeoutMs: input.lockTimeoutMs });
  await tx
    .update(userAvatars)
    .set({
      oidcPictureUrl: input.oidcPictureUrl,
      originalFile: input.originalFile,
      originalSha256: input.originalSha256,
      originalMime: input.originalMime,
      originalSize: input.originalSize,
      originalWidth: null,
      originalHeight: null,
      cropX: null,
      cropY: null,
      cropSize: null,
      displayData: null,
      displayMime: null,
      displaySize: 0,
      version: sql`${userAvatars.version} + 1`,
    })
    .where(and(eq(userAvatars.id, row.id), eq(userAvatars.userId, input.userId), eq(userAvatars.identityId, input.identityId)));
  return { outcome: "replaced", oldFile: row.originalFile };
}

/** Clearing `picture_dismissed_url` first stops the replace below from treating the just-downloaded URL as dismissed; space is checked inside `replaceOidcAvatarInTx`. Same lock order as it: users row, then identity row. */
export async function refreshOidcAvatarInTx(tx: Tx, input: ReplaceOidcAvatarInput, hooks?: AvatarTestHooks): Promise<ReplaceOidcAvatarResult> {
  const locked = await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).for("no key update");
  if (locked.length === 0) throw new TxAbort(404, "not_found", "No user with that id.");
  await tx
    .update(userIdentities)
    .set({ pictureDismissedUrl: null })
    .where(and(eq(userIdentities.id, input.identityId), eq(userIdentities.userId, input.userId)));
  const result = await replaceOidcAvatarInTx(tx, input, hooks);
  const [candidate] = await tx
    .select({ id: userAvatars.id })
    .from(userAvatars)
    .where(and(eq(userAvatars.identityId, input.identityId), eq(userAvatars.userId, input.userId)));
  if (candidate === undefined) throw new TxAbort(409, "server_busy", "The server is busy. Try again in a moment.");
  await tx.update(userAvatars).set({ isCurrent: false }).where(and(eq(userAvatars.userId, input.userId), eq(userAvatars.isCurrent, true)));
  await tx.update(userAvatars).set({ isCurrent: true }).where(and(eq(userAvatars.id, candidate.id), eq(userAvatars.userId, input.userId)));
  await tx.update(users).set({ avatarAuto: false }).where(eq(users.id, input.userId));
  return result;
}

export interface UpdateAvatarDisplayInput {
  userId: string;
  avatarId: string;
  version: number;
  crop: { x: number; y: number; size: number };
  originalWidth: number;
  originalHeight: number;
  displayData: Buffer;
  displayMime: string;
  lockTimeoutMs: number;
}

export async function updateAvatarDisplayInTx(tx: Tx, input: UpdateAvatarDisplayInput, hooks?: AvatarTestHooks): Promise<void> {
  const locked = await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).for("no key update");
  if (locked.length === 0) throw new TxAbort(404, "not_found", "No user with that id.");
  await hooks?.afterUserLock?.();
  const [row] = await tx
    .select({ version: userAvatars.version, displaySize: userAvatars.displaySize })
    .from(userAvatars)
    .where(and(eq(userAvatars.id, input.avatarId), eq(userAvatars.userId, input.userId)))
    .for("update");
  if (row === undefined) throw new AvatarNotFound();
  if (row.version !== input.version) throw new AvatarOutdated();
  await assertSpaceRoomInTx(tx, { kind: "user", id: input.userId }, input.displayData.length - row.displaySize, { lockTimeoutMs: input.lockTimeoutMs });
  await tx
    .update(userAvatars)
    .set({
      cropX: input.crop.x,
      cropY: input.crop.y,
      cropSize: input.crop.size,
      originalWidth: input.originalWidth,
      originalHeight: input.originalHeight,
      displayData: input.displayData,
      displayMime: input.displayMime,
      displaySize: input.displayData.length,
      version: row.version + 1,
    })
    .where(and(eq(userAvatars.id, input.avatarId), eq(userAvatars.userId, input.userId)));
}

export interface SelectAvatarInput {
  userId: string;
  candidateId: string | null;
}

export async function selectAvatarInTx(tx: Tx, input: SelectAvatarInput, hooks?: AvatarTestHooks): Promise<void> {
  const locked = await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).for("no key update");
  if (locked.length === 0) throw new TxAbort(404, "not_found", "No user with that id.");
  await hooks?.afterUserLock?.();
  await tx.update(userAvatars).set({ isCurrent: false }).where(and(eq(userAvatars.userId, input.userId), eq(userAvatars.isCurrent, true)));
  if (input.candidateId !== null) {
    const set = await tx
      .update(userAvatars)
      .set({ isCurrent: true })
      .where(and(eq(userAvatars.id, input.candidateId), eq(userAvatars.userId, input.userId)))
      .returning({ id: userAvatars.id });
    if (set.length === 0) throw new AvatarNotFound();
  }
  await tx.update(users).set({ avatarAuto: false }).where(eq(users.id, input.userId));
}

export interface DeleteAvatarInput {
  userId: string;
  avatarId: string;
}

/** An OIDC candidate's URL is recorded on its identity (so later logins don't re-download it); deleting the current one sets `avatar_auto = false`. */
export async function deleteAvatarInTx(tx: Tx, input: DeleteAvatarInput, hooks?: AvatarTestHooks): Promise<{ originalFile: string }> {
  const locked = await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).for("no key update");
  if (locked.length === 0) throw new TxAbort(404, "not_found", "No user with that id.");
  await hooks?.afterUserLock?.();
  const [row] = await tx
    .delete(userAvatars)
    .where(and(eq(userAvatars.id, input.avatarId), eq(userAvatars.userId, input.userId)))
    .returning({ originalFile: userAvatars.originalFile, isCurrent: userAvatars.isCurrent, identityId: userAvatars.identityId, oidcPictureUrl: userAvatars.oidcPictureUrl });
  if (row === undefined) throw new AvatarNotFound();
  if (row.identityId !== null && row.oidcPictureUrl !== null) {
    await tx
      .update(userIdentities)
      .set({ pictureDismissedUrl: row.oidcPictureUrl })
      .where(and(eq(userIdentities.id, row.identityId), eq(userIdentities.userId, input.userId)));
  }
  if (row.isCurrent) await tx.update(users).set({ avatarAuto: false }).where(eq(users.id, input.userId));
  return { originalFile: row.originalFile };
}
