/**
 * Login never waits on this; any failure only means no avatar (download, decode or quota can fail). One job per (user, identity) at a time
 * (in-process dedupe, later duplicates are skipped); `last_picture_url` is recorded before the dedupe check. A full personal space stops
 * the job. The file is written as `.tmp`, then renamed; the transaction re-checks the dismissed URL, so one deleted during the download
 * isn't restored. The user may unlink before or after the download: the identity row is re-read in the transaction (`unlinked`),
 * leaving no candidate or file. After commit the files no longer needed are removed (the replaced original, or the new file when the
 * bytes are identical); on any failure the new file is removed. Logs carry only `{ userId, identityId, reason }`: the picture URL
 * may carry a token, and neither it nor underlying error messages go to logs or return values; DB errors keep only `name` and SQLSTATE
 * (the raw error has SQL params).
 */
import { createHash, randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import type { UserGate } from "../auth/session.js";
import type { Db } from "../db/index.js";
import { pgErrorSummary } from "../db/pg-errors.js";
import { userAvatars, userIdentities } from "../db/schema.js";
import { StorageQuotaExceeded } from "../storage/tx/quota.js";
import { isSpaceFull, readSpaceUsage } from "../storage/usage.js";
import { uploadFilePath } from "../uploads/service.js";
import { fetchOidcAvatar, PRODUCTION_AVATAR_FETCH_POLICY, type AvatarFetchFailure, type AvatarFetchPolicy } from "./oidc-fetch.js";
import { AvatarIdentityGone, replaceOidcAvatarInTx, type AvatarTestHooks, type ReplaceOidcAvatarResult } from "./tx/avatars.js";

export type OidcAvatarJobReason =
  | AvatarFetchFailure
  | "no_identity"
  | "no_picture"
  | "same_url"
  | "dismissed"
  | "in_flight"
  | "quota"
  | "unlinked"
  | "error";

export interface OidcAvatarJobResult {
  userId: string;
  identityId: string | null;
  outcome: ReplaceOidcAvatarResult["outcome"] | "skipped" | "failed";
  reason?: OidcAvatarJobReason;
}

export interface OidcAvatarJobHooks {
  onSettled?: (result: OidcAvatarJobResult) => void;
}

export interface OidcAvatarJobDeps {
  db: Db;
  gate: Pick<UserGate, "invalidate">;
  uploadsDir: string;
  storageLockTimeoutMs: number;
  avatarFetchPolicy?: AvatarFetchPolicy;
  avatarJobHooks?: OidcAvatarJobHooks;
  avatarTestHooks?: AvatarTestHooks;
  log: { info(obj: object, msg: string): void };
}

export interface OidcAvatarJobArgs {
  userId: string;
  issuer: string;
  sub: string;
  /** Already through `parsePictureClaim`; null when absent. */
  picture: string | null;
}

const inFlight = new Map<string, Promise<OidcAvatarJobResult>>();

export function scheduleOidcAvatarJob(deps: OidcAvatarJobDeps, args: OidcAvatarJobArgs): void {
  setImmediate(() => {
    runOidcAvatarJob(deps, args).catch(() => {
      // Failures are already collected into results and logged inside; this only stops a throwing test hook such as `onSettled`.
    });
  });
}

export async function runOidcAvatarJob(deps: OidcAvatarJobDeps, args: OidcAvatarJobArgs): Promise<OidcAvatarJobResult> {
  let identityId: string | null = null;
  let result: OidcAvatarJobResult;
  try {
    const [identity] = await deps.db
      .select({ id: userIdentities.id, pictureDismissedUrl: userIdentities.pictureDismissedUrl })
      .from(userIdentities)
      .where(and(eq(userIdentities.issuer, args.issuer), eq(userIdentities.sub, args.sub), eq(userIdentities.userId, args.userId)));
    if (identity === undefined) {
      result = { userId: args.userId, identityId: null, outcome: "skipped", reason: "no_identity" };
    } else {
      identityId = identity.id;
      await deps.db
        .update(userIdentities)
        .set({ lastPictureUrl: args.picture })
        .where(and(eq(userIdentities.id, identity.id), eq(userIdentities.userId, args.userId)));
      const key = `${args.userId}:${identity.id}`;
      if (inFlight.has(key)) {
        result = { userId: args.userId, identityId, outcome: "skipped", reason: "in_flight" };
      } else {
        // No await between `has` and `set`, so a later call always sees this entry.
        const running = processJob(deps, args, identity.id, identity.pictureDismissedUrl);
        inFlight.set(key, running);
        try {
          result = await running;
        } finally {
          inFlight.delete(key);
        }
      }
    }
  } catch (err) {
    result = fail(deps, args.userId, identityId, "error", err);
  }
  deps.avatarJobHooks?.onSettled?.(result);
  return result;
}

function fail(deps: OidcAvatarJobDeps, userId: string, identityId: string | null, reason: OidcAvatarJobReason, err?: unknown): OidcAvatarJobResult {
  const extra = reason === "error" ? { name: err instanceof Error ? err.name : typeof err, code: pgErrorSummary(err).code } : {};
  deps.log.info({ userId, identityId, reason, ...extra }, "頭貼背景工作沒有完成");
  return { userId, identityId, outcome: "failed", reason };
}

async function processJob(deps: OidcAvatarJobDeps, args: OidcAvatarJobArgs, identityId: string, dismissedUrl: string | null): Promise<OidcAvatarJobResult> {
  const { userId, picture } = args;
  const skipped = (reason: OidcAvatarJobReason): OidcAvatarJobResult => ({ userId, identityId, outcome: "skipped", reason });
  if (picture === null) return skipped("no_picture");

  const [candidate] = await deps.db
    .select({ id: userAvatars.id, oidcPictureUrl: userAvatars.oidcPictureUrl })
    .from(userAvatars)
    .where(and(eq(userAvatars.identityId, identityId), eq(userAvatars.userId, userId)));
  if (candidate !== undefined && candidate.oidcPictureUrl === picture) return skipped("same_url");
  if (candidate === undefined && picture === dismissedUrl) return skipped("dismissed");

  if (isSpaceFull(await readSpaceUsage(deps.db, { kind: "user", id: userId }))) return fail(deps, userId, identityId, "quota");

  const fetched = await fetchOidcAvatar(picture, { issuer: args.issuer, policy: deps.avatarFetchPolicy ?? PRODUCTION_AVATAR_FETCH_POLICY });
  if (!fetched.ok) return fail(deps, userId, identityId, fetched.reason);

  const originalFile = randomUUID();
  const finalPath = uploadFilePath(deps.uploadsDir, originalFile);
  const tempPath = `${finalPath}.tmp`;
  const removeNewFile = async (): Promise<void> => {
    await unlink(tempPath).catch(() => {});
    await unlink(finalPath).catch(() => {});
  };
  try {
    await writeFile(tempPath, fetched.bytes);
    await rename(tempPath, finalPath);
  } catch (err) {
    await removeNewFile();
    return fail(deps, userId, identityId, "error", err);
  }

  let outcome: ReplaceOidcAvatarResult;
  try {
    const input = {
      userId,
      identityId,
      oidcPictureUrl: picture,
      originalFile,
      originalSha256: createHash("sha256").update(fetched.bytes).digest(),
      originalMime: fetched.mime,
      originalSize: fetched.bytes.length,
      lockTimeoutMs: deps.storageLockTimeoutMs,
    };
    outcome = await deps.db.transaction(tx => replaceOidcAvatarInTx(tx, input, deps.avatarTestHooks));
  } catch (err) {
    await removeNewFile();
    if (err instanceof AvatarIdentityGone) return fail(deps, userId, identityId, "unlinked");
    if (err instanceof StorageQuotaExceeded) return fail(deps, userId, identityId, "quota");
    return fail(deps, userId, identityId, "error", err);
  }

  if (outcome.outcome === "dismissed") {
    await removeNewFile();
    return skipped("dismissed");
  }
  if (outcome.outcome === "same_bytes") await removeNewFile();
  else if (outcome.outcome === "replaced") await unlink(uploadFilePath(deps.uploadsDir, outcome.oldFile)).catch(() => {});
  if (outcome.outcome !== "same_bytes") deps.gate.invalidate(userId);
  return { userId, identityId, outcome: outcome.outcome };
}
