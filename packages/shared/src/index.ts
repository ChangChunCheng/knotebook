export { YDOC_FRAGMENT } from "./ydoc.js";
import type { ProviderIconDto, ProviderIconKind } from "./provider-icon.js";
import type { AiActionKind } from "./ai.js";
import { UPLOAD_MAX_BYTES_DEFAULT } from "./site-limits.js";
import type { AvatarRef, UserAvatarDto } from "./avatar.js";

export const SESSION_COOKIE = "knotebook_session";

/** Scoped to /api/auth/oidc (server OIDC_STATE_COOKIE_PATH); lifetime is the server's OIDC_STATE_TTL_SECONDS. */
export const OIDC_STATE_COOKIE = "knotebook_oidc";

export type Role = "owner" | "editor" | "viewer" | "none";

export interface ApiError {
  error: { code: string; message: string };
}

export interface UserDto {
  id: string;
  email: string;
  /** Renaming breaks old /n/<handle>/… URLs and frees the old handle for anyone to claim. */
  handle: string;
  displayName: string;
  isAdmin: boolean;
  /** Legacy: nothing sets it any more; only old admin-created accounts that never changed their password still carry it. Web's ChangePasswordGate redirects to /change-password on it. */
  mustChangePassword: boolean;
  hasPassword: boolean;
  /** Personal setting; the effective value also needs the site-wide switch. */
  autoVersions: boolean;
  /** Build the URL with avatarUrl only. */
  avatar: UserAvatarDto | null;
}

export type AdminInviteStatus = "pending" | "used" | "revoked" | "expired";

/** No token or hash: the token appears only once, in the create response. */
export interface AdminInviteDto {
  id: string;
  label: string | null;
  /** Computed in SQL with now(): used > revoked > expired (expires_at <= now()) > pending; ignores the password-login switch. */
  status: AdminInviteStatus;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  createdBy: { id: string; email: string } | null;
  usedBy: { id: string; email: string } | null;
}

/** Same number as apps/server/src/auth/constants.ts; this copy lets web forms validate first. */
export const MIN_PASSWORD_LENGTH = 12;
/** Email length in JS `.length`, matching SSO's 254 (server MAX_EMAIL_CLAIM_LENGTH); display name in code points. Web prechecks, the server enforces. */
export const MAX_REGISTER_EMAIL_LENGTH = 254;
export const MAX_REGISTER_DISPLAY_NAME_LENGTH = 100;
/** Code points; same as DB `one_time_links_label_chk`. */
export const MAX_INVITE_LABEL_LENGTH = 100;

/** Unauthenticated. `passwordLogin.enabled` is the effective value (DB OR env), without revealing whether env forces it. */
export interface AuthConfigDto {
  providers: AuthProviderPublicDto[];
  registration: {
    /** Password self-registration only; it also needs `passwordLogin.enabled`. false when the site_settings row is missing. */
    enabled: boolean;
    /** Enabled providers with auto-create on: a subset of `providers`, in display order; [] when the site_settings row is missing. */
    providerIds: string[];
  };
  passwordLogin: { enabled: boolean };
  autoVersionsEnabled: boolean;
  /** Bytes of Yjs state (server NOTE_MAX_BYTES). Web checks it before paste, drop and AI apply (the server doesn't check browser collab updates).
   * Always sent; optional only for test doubles and older servers (absent = no check). */
  noteMaxBytes?: number;
  /** Per image file, bytes; admin-adjustable. Absent (test doubles, older servers) means no client-side precheck. */
  maxUploadBytes?: number;
}

/** Exposes only id, display name and icon; issuer, client id and other provider settings never leave the server. */
export interface AuthProviderPublicDto {
  id: string;
  /** Admin-entered: web must render it only as React text (`escapeValue: false`). */
  displayName: string;
  /** Already resolved by resolveProviderIcon (null = no icon); web must not resolve it again. */
  icon: ProviderIconDto;
}

export interface PendingLinkDto {
  /** Send back unchanged; if another tab replaced the pending link, the server returns 409 `oidc_link_expired`. */
  pendingId: string;
  email: string;
  /** null if the provider was deleted; identities aren't tied to providers. */
  providerDisplayName: string | null;
  methods: { password: boolean; providers: AuthProviderPublicDto[] };
}

/** The server reads `next` from the pending cookie and filters it through `safeNextPath` (defaults to "/"); web uses it instead of the URL parameter. */
export interface PendingLinkConfirmDto {
  user: UserDto;
  next: string;
}

export interface OidcRedirectDto {
  url: string;
}

export interface NoteDto {
  id: string;
  title: string;
  /** Exactly one of `owner_id`/`group_id` is non-null (DB `notes_owner_xor_group_chk`). */
  ownerId: string | null;
  /** Always `"editor"` or `"viewer"` for group notes, never `"owner"`. */
  role: Role;
  createdAt: string;
  updatedAt: string;
  slug: string;
  /** Always the owner's, even in an editor's PATCH response. */
  ownerHandle: string | null;
  /** Duplicates `group?.id` so `canonicalNotePath(note)` can build both URL forms. */
  groupId: string | null;
  /** false: slug follows title changes; true: title changes leave it. */
  slugIsCustom: boolean;
  /** Redirect source for by-path misses; one level only, recorded only for custom slug changes. */
  prevSlug: string | null;
  lastEdited: LastEditedDto | null;
  group: NoteGroupDto | null;
  /** Web must use this, not `role === "owner"`. */
  permissions: NotePermissions;
  /** For notes shared with the caller, the caller's own placement; the owner's folder is never exposed. null = root. */
  folderId: string | null;
  /** Yjs state plus attachments, bytes; sort key only, sent only by GET /api/notes. */
  sizeBytes?: number;
}

export interface NotePermissions {
  read: boolean;
  edit: boolean;
  delete: boolean;
  manageShares: boolean;
  managePublicLink: boolean;
  changeSlug: boolean;
  moveToGroup: boolean;
}

// Fingerprints are an optimistic-concurrency check, not a security boundary, and only the server computes them.
// blockIds are server-internal and deliberately not on these DTOs.
export interface NoteOutlineEntry {
  /** TOP_SECTION_ID ("_top") for the first section, else the heading block's id. */
  sectionId: string;
  level: number;
  heading: string;
  chars: number;
  fingerprint: string;
}
/** `byHandle` is the editor's handle, not the owner's; a non-null `agentLabel` means it was written through a token. */
export interface LastEditedDto {
  at: string;
  byHandle: string;
  agentLabel: string | null;
}
export interface NoteContentDto {
  markdown: string;
  fingerprint: string;
  outline: NoteOutlineEntry[];
  lastEdited: LastEditedDto | null;
}
export interface NoteSectionDto {
  section: Omit<NoteOutlineEntry, "sectionId"> & { id: string; markdown: string };
  lastEdited: LastEditedDto | null;
}

/** No `revert`: that op is only produced by `POST …/edits/:editId/revert`. */
export type EditOp = "replace_all" | "replace_section" | "insert_after" | "append" | "delete_section";
/** `fingerprint`/`outline` describe the merged note, so they can serve as the next `if_match` without a re-read. */
export interface NoteEditResultDto {
  editId: string;
  fingerprint: string;
  outline: NoteOutlineEntry[];
  /** [[…]] links in this write that matched no unique note and stayed plain text. */
  unboundWikilinks: number;
}

/** The server keeps at most this many AI edit rows per note; web help text quotes it. */
export const AI_EDITS_RETENTION = 100;

// `revertable` is false for revert rows (never revertable), already-reverted rows, a target whose fingerprint no longer
// matches, a `delete_section` whose anchor block is gone, and once a deleted section has been restored (its
// `before_blocks` are back at top level): revert takes no `if_match`, so that last case is its idempotency guard.
export interface NoteEditDto {
  id: string;
  /** file_sync = one row per changed region of a file write-back; web shows op literals untranslated. */
  op: EditOp | "revert" | "file_sync";
  sectionId: string | null;
  /** "" if the section is gone (deleted or renamed). */
  heading: string;
  byHandle: string;
  /** null for cookie writes. */
  agentLabel: string | null;
  /** The writer's current avatar (token rows too); null if none, or the display image isn't generated yet. */
  avatar: AvatarRef | null;
  createdAt: string;
  revertedAt: string | null;
  revertOf: string | null;
  revertable: boolean;
}

// Kept separate from Role: note_shares_role_chk allows only editor/viewer ('none' is only resolveRole's sentinel).
export type ShareRole = "editor" | "viewer";

export interface GroupRolePermissions {
  read: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
  managePublicLink: boolean;
  manageMembers: boolean;
  manageGroup: boolean;
}

export type BuiltinGroupRole = "admin" | "member";

export interface GroupRoleDto {
  id: string;
  builtin: BuiltinGroupRole | null;
  /** null for built-in roles (DB group_roles_name_chk). */
  name: string | null;
  permissions: GroupRolePermissions;
  memberCount: number;
}

/** `myRole` is null only for a non-member site admin (only in the PATCH /api/groups/:id response). Web must use the `canManage*` flags, which include site admins. */
export interface GroupDto {
  id: string;
  name: string;
  myRole: GroupRoleDto | null;
  canManageMembers: boolean;
  canManageGroup: boolean;
  createdAt: string;
  autoVersions: boolean;
}

/** `transferTo` must hold the built-in admin role. */
export type DeleteGroupBody = { mode: "transfer"; transferTo: string } | { mode: "delete" };

export interface GroupMemberDto {
  userId: string;
  email: string;
  displayName: string;
  roleId: string;
  builtin: BuiltinGroupRole | null;
  avatar: AvatarRef | null;
}

export interface NoteGroupDto {
  id: string;
  name: string;
}

export interface ShareDto {
  userId: string;
  email: string;
  displayName: string;
  role: ShareRole;
  avatar: AvatarRef | null;
}

/** Only people whose emails the caller can already see (group co-members, users the caller shared notes with); not a site directory. Excludes the caller and disabled accounts. */
export interface UserSuggestionDto {
  userId: string;
  email: string;
  displayName: string;
  avatar: AvatarRef | null;
}

export interface UserSuggestResponse {
  users: UserSuggestionDto[];
}

/** Trimmed length bounds (inclusive); web uses the same numbers to decide when to send a request. */
export const USER_SUGGEST_MIN_QUERY = 2;
export const USER_SUGGEST_MAX_QUERY = 100;
export const USER_SUGGEST_MAX_RESULTS = 8;

/** Query length in UTF-16 code units after trim (what zod `.max` counts); web uses these to decide when to send. */
export const SEARCH_QUERY_MAX = 200;
export const SEARCH_LIMIT_DEFAULT = 20;
export const SEARCH_LIMIT_MAX = 50;

/** `sectionId` becomes the `#b-<sectionId>` anchor (except `_top`). */
export interface NoteSearchMatchDto {
  sectionId: string;
  heading: string;
  snippet: string;
}

export interface NoteSearchHitDto {
  note: NoteDto;
  matchedOn: "title" | "body" | "both";
  matches: NoteSearchMatchDto[];
}

export interface NoteSearchResultDto {
  hits: NoteSearchHitDto[];
  nextCursor: string | null;
}

export interface BacklinkDto {
  id: string;
  title: string;
  slug: string;
  ownerHandle: string | null;
  groupId: string | null;
}

/** Bytes. From the standalone default, not `SITE_LIMITS`: reading the registry at module top level defeats tree-shaking. */
export const MAX_UPLOAD_BYTES: number = UPLOAD_MAX_BYTES_DEFAULT;

/** Counted after dedupe and self-link filtering. */
export const MAX_LINK_TARGETS = 1000;

export const MAX_BACKLINKS = 200;

/** Must stay well below `ONLINE_WINDOW_MS`, so continuously active users always show as online. */
export const LAST_ACTIVE_WRITE_INTERVAL_MS = 60 * 1000;

export const ONLINE_WINDOW_MS = 5 * 60 * 1000;

export const ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "not_found",
  "invalid_body",
  "bad_request",
  "internal",
  "unsupported_media_type",
  "server_busy",
  "too_many_attempts",
  "too_many_requests",
  "password_too_short",
  "invalid_credentials",
  "account_disabled",
  "email_taken",
  "user_not_found",
  "cannot_disable_self",
  // Not `last_admin`: that is the group code, and web maps messages by code (`errors.<code>`).
  "cannot_demote_self",
  "last_site_admin",
  "cannot_share_with_self",
  "share_not_found",
  "slug_taken",
  "handle_taken",
  "public_slug_taken",
  "not_loaded",
  "file_too_large",
  "ai_not_configured",
  "provider_unavailable",
  "upstream_error",
  "builtin_action",
  "model_taken",
  "oidc_unavailable",
  "oidc_state_mismatch",
  "oidc_exchange_failed",
  "oidc_email_missing",
  "oidc_conflict",
  // `insufficient_scope` (403) is kept apart from the invalid-token 401, which counts toward the Bearer limiter.
  // `token_not_found` also covers other users' tokens, so it can't be used to enumerate them.
  "insufficient_scope",
  "token_limit",
  "token_not_found",
  "oauth_request_invalid",
  // Separate from `not_found`: a missing section means re-read the outline, a missing note means stop.
  "section_not_found",
  "fingerprint_mismatch",
  // unsupported_*: the whole write is rejected, never silently stripped.
  "unsupported_block",
  "unsupported_color",
  "unsupported_columns",
  "unsupported_size",
  "empty_content",
  "empty_section",
  "too_many_blocks",
  // The generic 413 for a body over `bodyLimit` (app.ts clientErrorCode); uploads send `file_too_large` themselves.
  "content_too_large",
  // Over 3,000 notes (TRANSFER_EXPORT_MAX_NOTES); sent before streaming starts.
  "too_many_notes",
  "not_mergeable",
  "base_unavailable",
  // `already_reverted` needs no retry; `stale` means re-read the content before deciding.
  "already_reverted",
  "stale",
  "last_admin",
  "already_member",
  // Same response for missing, not-a-member and just-deleted groups.
  "group_not_found",
  "note_in_group",
  "invalid_name",
  "conflict",
  // `group_not_empty` is only a defensive branch now (group deletion always takes a mode).
  "group_not_empty",
  "role_not_found",
  "builtin_role",
  "role_name_taken",
  "not_admin",
  "registration_disabled",
  "oidc_link_expired",
  "oidc_link_proof_mismatch",
  "oidc_link_no_proof_method",
  // IdP email > 254 or sub > 255.
  "oidc_claim_too_long",
  "identity_taken",
  "identity_already_linked",
  "provider_not_found",
  "provider_enabled",
  "provider_secret_missing",
  "provider_client_id_missing",
  "oidc_discovery_failed",
  "password_login_disabled",
  "sso_provider_required",
  "admin_sso_link_required",
  "password_already_set",
  "last_login_method",
  "oidc_link_session_mismatch",
  "base_url_has_credentials",
  "storage_quota_exceeded",
  "storage_plan_in_use",
  "storage_plan_is_default",
  "storage_plan_name_taken",
  "storage_plan_not_found",
  "avatar_outdated",
  // Omits the URL and the underlying error.
  "avatar_fetch_failed",
  "version_is_base",
  "version_unsaved_changes",
  "version_mismatch",
  "instruct_preview_only",
  "user_disabled",
  "password_not_set",
  // `reset_link_invalid` and `invite_invalid`: one code for every invalid state, so the reason isn't revealed.
  "reset_link_invalid",
  "invite_invalid",
  "invite_used",
  "invite_not_found",
  // `in_trash` only for callers with trash access (others still get `not_found`); the body adds a top-level `noteId`.
  "in_trash",
  "folder_not_found",
  "folder_name_taken",
  "folder_too_deep",
  "folder_cycle",
  "folder_limit",
  "folder_cross_space",
  "folder_delete_blocked",
  "folder_not_empty",
  // Reading a note timed out or ran out of memory in the parse worker; retrying won't help. Same name as the MCP tool error.
  "too_complex",
  // Only when the edit leaves the note over NOTE_MAX_BYTES and larger than before; details carry `limitBytes`. Same name
  // as the MCP tool error.
  "note_too_large",
  "limit_locked_by_env",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const AI_SSE_EVENTS = { delta: "delta", done: "done", error: "error" } as const;
export interface AiSseErrorPayload {
  code: string;
  message: string;
}

export interface AiActionDto {
  id: string;
  name: string;
  applyMode: "direct" | "preview";
  kind: AiActionKind;
}

export interface AdminAiProviderDto {
  id: string;
  name: string;
  type: "openai_compatible" | "anthropic";
  baseUrl: string;
  enabled: boolean;
  hasKey: boolean;
  degraded: boolean;
  createdAt: string;
}

export interface AdminAiModelDto {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  purpose: "chat";
  isDefault: boolean;
  enabled: boolean;
  createdAt: string;
}

export interface AdminAiActionDto {
  id: string;
  name: string;
  systemPrompt: string;
  userTemplate: string;
  modelId: string | null;
  applyMode: "direct" | "preview";
  sortOrder: number;
  enabled: boolean;
  builtin: boolean;
  kind: AiActionKind;
}

/** Must match DB CHECK `auth_providers_template_chk`. */
export type AuthProviderTemplate = "gitlab" | "google" | "oidc";

/** Never carries the client secret, only `hasSecret`. `displayName` is admin-entered: render it only as React text. */
export interface AdminAuthProviderDto {
  id: string;
  template: AuthProviderTemplate;
  displayName: string;
  issuerUrl: string;
  /** null until filled in; can't be enabled without it (DB auth_providers_enabled_client_id_chk). */
  clientId: string | null;
  hasSecret: boolean;
  enabled: boolean;
  /** Always false for new providers (the create API doesn't accept it); changing the issuer doesn't reset it. */
  autoCreateEnabled: boolean;
  sortOrder: number;
  /** The env-imported provider (keeps the old callback URL /api/auth/oidc/callback). */
  legacyCallback: boolean;
  callbackUrl: string;
  insecureIssuer: boolean;
  /** Discovery has succeeded once; false means impact counts may be inaccurate. */
  issuerResolved: boolean;
  createdAt: string;
  iconKind: ProviderIconKind;
  icon: ProviderIconDto;
}

export interface AdminAuthProviderImpactDto {
  linkedUsers: number;
  /** Linked users with no usable password (none, or password login off in DB) and no identity on another enabled provider. */
  lockedOutUsers: number;
  issuerResolved: boolean;
  /** When the DB password-login value is off, this disable is blocked by the anti-lockout guard (409 `admin_sso_link_required`). */
  actingAdminLockedOut: boolean;
}

export type AdminAuthProbeWarning = "insecure_issuer" | "client_secret_post_not_advertised" | "client_id_missing" | "secret_undecryptable";

export interface AdminAuthProbeResultDto {
  issuer: string;
  warnings: AdminAuthProbeWarning[];
}

export interface IdentityDto {
  id: string;
  issuer: string;
  providers: AuthProviderPublicDto[];
  createdAt: string;
  lastLoginAt: string | null;
  unlinkable: boolean;
}

/** Enabled providers where the user has no identity with the same issuer yet. */
export interface LinkableProviderDto {
  providerId: string;
  /** Admin-entered: render it only as React text. */
  displayName: string;
  template: AuthProviderTemplate;
  /** Already resolved by resolveProviderIcon (null = no icon); web must not resolve it again. */
  icon: ProviderIconDto;
}

/** Session-only. `passwordLoginEnabled` is the effective value (DB OR env). */
export interface IdentitiesDto {
  identities: IdentityDto[];
  linkable: LinkableProviderDto[];
  hasPassword: boolean;
  passwordLoginEnabled: boolean;
}

/** `passwordLoginEnabled` is the DB value; `passwordLoginForced` is env `PASSWORD_LOGIN_FORCE_ENABLE`. */
export interface AdminAuthSettingsDto {
  registrationEnabled: boolean;
  passwordLoginEnabled: boolean;
  passwordLoginForced: boolean;
  /** Snapshot for the dialog; the PATCH decides. */
  passwordLoginImpact: {
    usersWithoutSso: number;
    actingAdminHasSso: boolean;
    enabledProviders: number;
  };
}

export const COLLAB_CLOSE_REVOKED = "knotebook:revoked";
export const COLLAB_CLOSE_NOTE_DELETED = "knotebook:note-deleted";

/**
 * Reasons sent when onAuthenticate rejects a collab handshake. Unlike `COLLAB_CLOSE_*` (sent after auth), Hocuspocus
 * neither closes nor reconnects here (Hocuspocus 4.5.0), so the client must map them to state events or it stays "connecting" (#6).
 * `note-deleting` and `forbidden` are authorization verdicts. `invalid-token` and `server-error` are not: the client must
 * restart the connection rather than report lost access (#35), and treats unknown or missing reasons the same way
 * (including Hocuspocus's literal "permission-denied" for unexpected errors). State stays "connecting"; a dead session
 * surfaces as a 401 on the token refetch, which logs out.
 * No separate "note not found" reason: it would let any user probe whether a note id exists. Only users who could see
 * the note when it was deleted get `note-deleting`; everyone else gets `forbidden`.
 */
export const COLLAB_REJECT_NOTE_DELETING = "note-deleting";
export const COLLAB_REJECT_INVALID_TOKEN = "invalid-token";
export const COLLAB_REJECT_FORBIDDEN = "forbidden";
export const COLLAB_REJECT_SERVER_ERROR = "server-error";
/** Not an authorization verdict: the client goes read-only (`outdated`), not terminal. Older clients retry it like any unknown reason.
 * Independent of the note, so it reveals nothing about whether the note exists. */
export const COLLAB_REJECT_CLIENT_OUTDATED = "client-outdated";
// The last entry repeats; actual delay is entry × [0.75, 1.25). In shared because the server's `DELETING_GATE_TTL_MS` must
// exceed the maximum, or a reconnecting user who could see a deleted note gets `forbidden` (collab-deleting-gate.test.ts).
export const COLLAB_RESTART_DELAYS_MS = [5_000, 15_000, 60_000] as const;
export const COLLAB_RESTART_JITTER = 0.25;

/** For 5xx, 429 and network errors (401 logs out instead); failing to get a token is not an authorization failure. The deleting-gate TTL and the reverify deadline are sized against this sum. */
export const COLLAB_TOKEN_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000] as const;

// On timeout the server closes with COLLAB_CLOSE_REVOKED: the fail-closed end of the revocation SLA (a revoked share
// loses access within 10 s). Deliberately shorter than the client's worst-case token retry (7.5 s); raising it past that
// eats most of the SLA margin. A client still backing off goes to reconnecting-once and is kicked only by a second hit
// there; otherwise it recovers when the backend does. 5 s leaves room for DB jitter (normal token round trip < 200 ms),
// not for client retry backoff. Pinned by useCollab.test.tsx.
export const COLLAB_REVERIFY_DEADLINE_MS = 5_000;

export const COLLAB_TOKEN_TTL_SECONDS = 120;
export interface CollabTokenClaims {
  noteId: string;
  userId: string;
  role: Role;
  tv: number;
  /** The collab server rechecks this session row on handshake and reverify, so logging out a device closes its connections. */
  sid: string;
  /** Note schema version sent by the client; absent or non-integer means 0. onAuthenticate rejects with client-outdated
   * when it !== NOTE_SCHEMA_VERSION. */
  sv: number;
}

/** Every account write and email comparison must use this, OIDC claims included. */
export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

const SLUG_CHARSET_RE = /^[\p{L}\p{N}-]+$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_SUFFIX_RE = /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESERVED_SLUGS = new Set(["new"]);

/** Must match the DB unique comparison for slugs; validateSlug expects its output. */
export function normalizeSlug(input: string): string {
  return input.normalize("NFC").toLowerCase();
}

// Input must already be `normalizeSlug`ed. No `\p{M}` on purpose (e.g. U+0307 from `"İ".toLowerCase()`). `uuid_like` keeps
// slugs distinct from legacy `/notes/<vanity>-<id>` links, which still resolve via `extractRefUuid`.
export function validateSlug(normalized: string): "length" | "charset" | "dash" | "reserved" | "uuid_like" | null {
  const length = Array.from(normalized).length;
  if (length < 1 || length > 100) return "length";
  if (!SLUG_CHARSET_RE.test(normalized)) return "charset";
  if (normalized.startsWith("-") || normalized.endsWith("-") || normalized.includes("--")) return "dash";
  if (RESERVED_SLUGS.has(normalized)) return "reserved";
  if (UUID_RE.test(normalized) || UUID_SUFFIX_RE.test(normalized)) return "uuid_like";
  return null;
}

const HANDLE_CHARSET_RE = /^[a-z0-9-]+$/;

// Maps only ASCII A-Z to a-z, unlike normalizeSlug: handles are URL identities and must be typeable everywhere and safe
// from IDN homographs, so no Unicode lowercasing (U+0307 from "İ") or transliteration; non-ASCII is left for
// validateHandle to reject.
export function normalizeHandle(input: string): string {
  // +32 rather than toLowerCase(), so the no-Unicode-lowercase rule is visible.
  return input.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
}

// No reserved words, unlike validateSlug: handles only appear as the second segment of /n/ and /p/ (shared-handle.test.ts).
// `uuid_like` is unreachable under the 32 limit; kept in case the limit grows.
export function validateHandle(normalized: string): "length" | "charset" | "dash" | "uuid_like" | null {
  // Code points, so long non-ASCII input reports `charset` rather than `length`.
  const length = Array.from(normalized).length;
  if (length < 1 || length > 32) return "length";
  if (!HANDLE_CHARSET_RE.test(normalized)) return "charset";
  if (normalized.startsWith("-") || normalized.endsWith("-") || normalized.includes("--")) return "dash";
  if (UUID_RE.test(normalized)) return "uuid_like";
  return null;
}

// No case folding: callers needing uniqueness apply normalizeSlug. Truncation counts code points (no split surrogate
// pairs), then trims `-` again because the cut may land after one.
export function titleSlug(title: string): string {
  let s = title.normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, "-");
  s = s.replace(/^-+|-+$/g, "");
  const chars = Array.from(s);
  if (chars.length > 60) {
    s = chars.slice(0, 60).join("");
  }
  s = s.replace(/-+$/, "");
  return s;
}

// Valid candidates pass unchanged (accents, CJK kept); the fallback strips diacritics from the whole string. The result is
// always a fixed point of normalizeSlug (needed for unique matching); deduplication is the caller's job.
export function autoSlugFromTitle(title: string): string {
  const candidate = normalizeSlug(titleSlug(title));
  if (validateSlug(candidate) === null) return candidate;
  const stripped = candidate.normalize("NFD").replace(/\p{M}+/gu, "").normalize("NFC");
  if (validateSlug(stripped) === null) return stripped;
  return "untitled";
}

/** Legacy `<vanity>-<uuid>` links must keep resolving. */
export function extractRefUuid(ref: string): string | null {
  if (UUID_RE.test(ref)) return ref.toLowerCase();
  const match = UUID_SUFFIX_RE.exec(ref);
  if (match) return match[0].slice(1).toLowerCase();
  return null;
}

/** No URL encoding: the handle, group uuid and slug charsets can't contain `/ % ? #`; non-ASCII is left to the browser to encode. */
export function canonicalNotePath(note: { ownerHandle: string | null; groupId: string | null; slug: string }): string {
  // `typeof` rather than `!== null`: older objects without `groupId` (undefined) would otherwise give `/g/undefined/…`.
  if (typeof note.groupId === "string") return `/g/${note.groupId}/${note.slug}`;
  if (typeof note.ownerHandle === "string") return `/n/${note.ownerHandle}/${note.slug}`;
  throw new Error("canonicalNotePath: ownerHandle 與 groupId 皆為 null");
}

/** Build /p/ page URLs only here; no encoding, so pass a validated handle/slug. Public API URLs are built in web
 * `lib/public-note-ref.ts`, which encodes raw URL params on purpose. */
export function publicAliasPath(ref: { handle: string; slug: string }): string {
  return `/p/${ref.handle}/${ref.slug}`;
}

// Encoded empty Y.Doc, returned when a note has no stored state: `Y.applyUpdate` throws on a zero-length update.
// A server unit test checks the literal independently, since server and web both import it.
export const EMPTY_YDOC_UPDATE_B64 = "AAA=";

/** `path` is always the alias form; the token form never appears. */
export interface PublicLinkDto {
  id: string;
  title: string;
  path: string;
}

/** Narrow to wide; must match DB `notes_public_width_chk` (note-width-check-sync.test.ts). */
export const NOTE_WIDTHS = ["standard", "wide", "full"] as const;
export type NoteWidth = (typeof NOTE_WIDTHS)[number];

/** Deliberately omits the note's id, token and updatedAt. */
export interface PublicNoteDto {
  title: string;
  ydoc: string;
  links: PublicLinkDto[];
  /** Optional for older servers; web treats absent as "standard". */
  width?: NoteWidth;
}

// A lattice, not a chain: move and delete don't include each other, so compare with narrowerScope/hasScope, never
// `indexOf`. move/delete require write. The DB scope CHECKs and zod enums follow this list (scope-check-sync.test.ts).
// The stored form is five fixed literals in read, write, move, delete order; write always includes read explicitly.
// Add new scopes the same way (split into words, intersect, join in the fixed order).
export const TOKEN_SCOPES = [
  "notes:read",
  "notes:read notes:write",
  "notes:read notes:write notes:move",
  "notes:read notes:write notes:delete",
  "notes:read notes:write notes:move notes:delete",
] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

export type ScopeName = "notes:read" | "notes:write" | "notes:move" | "notes:delete";

/** No move/delete: `bearer.ts` picks its limiter only as write vs other; move and delete are checked at the MCP tool layer. */
export type RequiredScope = "notes:read" | "notes:write";

// Whole space-separated words only (`notes:write-all` must not grant write; tabs don't split, failing closed). Unknown
// values are ignored (RFC 6749 §3.3), so it never returns null; empty gives `notes:read`. move/delete without write give
// `notes:read` rather than granting unrequested write (`notes:read notes:move` isn't a stored form; the DB CHECK rejects it).
// Responses echo this output, never ignored values. Identity on the five stored forms, because bearer.ts and
// api-tokens.ts pass DB values through it.
export function normalizeScope(input: string | null | undefined): TokenScope {
  const parts = (input ?? "").split(" ");
  if (!parts.includes("notes:write")) return "notes:read";
  return [
    "notes:read",
    "notes:write",
    ...(parts.includes("notes:move") ? ["notes:move"] : []),
    ...(parts.includes("notes:delete") ? ["notes:delete"] : []),
  ].join(" ") as TokenScope;
}

/** Values outside the five forms count as `notes:read` (inputs come from a text column cast to TokenScope); don't
 * normalizeScope them, which would widen a bare `notes:write`. */
export function narrowerScope(a: TokenScope, b: TokenScope): TokenScope {
  const canon = (s: TokenScope): TokenScope => ((TOKEN_SCOPES as readonly string[]).includes(s) ? s : "notes:read");
  const pa = new Set(canon(a).split(" "));
  return normalizeScope(
    canon(b)
      .split(" ")
      .filter((p) => pa.has(p))
      .join(" "),
  );
}

// Membership test, not a hard-coded hierarchy (which would miss write in the read+write+move form). This is the final
// authorization check and `stored` is a cast text column, so it doesn't rely on the DB CHECK.
export function hasScope(stored: TokenScope, required: ScopeName): boolean {
  return stored.split(" ").includes(required);
}

/** Idle OAuth apps are cleaned up after this many days; web shows the resulting expiry. */
export const OAUTH_APP_IDLE_DAYS = 30;

export interface ApiTokenDto {
  id: string;
  kind: "pat" | "oauth";
  /** For oauth, the client-claimed name, unverified: the UI must say so. */
  name: string;
  /** Never null: derived from `name` (deriveAgentLabel) when the column is NULL. */
  agentLabel: string;
  scope: TokenScope;
  createdAt: string;
  lastUsedAt: string | null;
  /** null: never expires (the PAT default). For oauth rows, the access token's expiry (~24 h), not the grant's; web doesn't show it. */
  expiresAt: string | null;
  clientId: string | null;
}

/** The only response that ever contains the plaintext token. */
export interface CreatedApiTokenDto extends ApiTokenDto {
  token: string;
}

export interface OauthRequestDto {
  /** Client-claimed, unverified: bidi-isolate when rendering. */
  clientName: string;
  /** Includes the port on purpose, so users see where they'll be sent. */
  redirectHost: string;
  scope: TokenScope;
  scopes: string[];
  /** Always `existingScope !== null`. */
  replacesExisting: boolean;
  /** Load-time snapshot, only for the consent page's default checkboxes; the server grant doesn't depend on it. */
  existingScope: TokenScope | null;
}

// Shared by the server SPA fallback (`http/spa.ts`) and `safeNextPath`; match on segment boundaries via isExcludedPath.
// `/oauth` and `/.well-known` 404s are RFC-shaped JSON, not SPA pages. The list is a closed set (pinned by
// shared-next-path.test.ts); spa.test.ts guards the fallback contract of the first four.
// The consent page `/authorize` is outside `/oauth`, so excluding `/oauth` is safe.
// No normalization: each caller passes what its side routes (spa.ts the raw URL, safeNextPath the parsed pathname);
// `routes/public.ts` token masking relies on `//api/public/…` not matching.
export const EXCLUDED_PREFIXES = ["/api", "/collab", "/healthz", "/assets", "/oauth", "/.well-known"] as const;

export function isExcludedPath(pathname: string): boolean {
  return EXCLUDED_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

// Server noindex, log masking and the web install prompt must all use this: the SPA fallback also serves `//p/…` and `/P/…`
// (React Router matches case-insensitively too). Bare /p counts so /p and /p/ behave alike.
export function isPublicSharePath(pathname: string): boolean {
  const p = pathname.replace(/^\/{2,}/, "/").toLowerCase();
  return p === "/p" || p.startsWith("/p/");
}

// Arbitrary but well below practical layer limits (nginx's 8 KB header buffer, old IE's 2083-char URL), so an absurdly long query
// fails at a clear point. Also bounds the OIDC state cookie: a 2048-char next sealed into it is 3049 bytes (3115 with Set-Cookie
// attributes), under 4 KB (reached at 2834 chars), so the server deliberately has no tighter limit (see
// apps/server/src/auth/oidc-state.ts).
export const MAX_NEXT_PATH_LENGTH = 2048;

// Fictional base, never contacted (`.invalid` is reserved by RFC 2606); only used to detect an origin change.
const NEXT_PATH_BASE = "http://knotebook.invalid";

const NEXT_PATH_CHARSET_RE = /^[\u0021-\u007e]+$/;

/**
 * Returns the input unchanged, never a normalized form: `/..//evil` passes, but its parsed pathname `//evil` would
 * redirect off-site as a protocol-relative URL. Returns null without a reason; callers silently fall back to "/".
 * - `typeof` is needed: parsed query strings can be arrays (`?next=/&next=x`).
 * - Length is `.length`, not code points as in validateSlug: it measures the string as a `Location` value, and after the
 *   charset check it is all ASCII, so both counts agree.
 * - The second character can't be `\` either: `\` equals `/` in special schemes, so `/\evil` would parse as an authority.
 * - The second-character check and the origin check are deliberately redundant; no input is stopped by the latter alone.
 *   The try/catch around `new URL` is unreachable too: with a valid base it doesn't throw.
 * - Visible ASCII only, checked before URL parsing (the parser silently drops CR/LF/TAB). The OIDC callback redirects to
 *   `next` unencoded because encoding at the redirect doesn't work (encodeURI double-encodes `%20`, encodeURIComponent
 *   mangles `/ ? #`). Node throws on C0 controls, DEL and header chars above U+00FF at writeHead, which runs after the
 *   handler returns (app.ts has an async onSend) and after the session cookie is set, so routes/oidc.ts's catch misses it
 *   and the user gets a JSON 500 instead of a 302. Callers must therefore pass percent-encoded paths (browser
 *   `location.pathname` already is).
 * - Excluded paths are matched on the parsed pathname, so `/x/../api/notes` is caught.
 * - Pages that only make sense logged out are dead ends after login (`/change-password` is not one: it works when logged
 *   in). Trailing slashes and case are folded first because react-router ignores both (`/login/` and `/LOGIN` render the
 *   login page).
 */
export function safeNextPath(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  if (input.length > MAX_NEXT_PATH_LENGTH) return null;
  if (input[0] !== "/") return null;
  if (input[1] === "/" || input[1] === "\\") return null;
  if (!NEXT_PATH_CHARSET_RE.test(input)) return null;

  let url: URL;
  try {
    url = new URL(input, NEXT_PATH_BASE);
  } catch {
    return null;
  }
  if (url.origin !== NEXT_PATH_BASE) return null;
  if (isExcludedPath(url.pathname)) return null;
  const collapsed = url.pathname.replace(/\/+$/, "").toLowerCase();
  if (collapsed === "/login" || collapsed === "/link-account" || collapsed === "/register" || collapsed === "/reset-password") return null;

  return input;
}

export * from "./note-schema-config.js";
export * from "./columns.js";
export * from "./note-sections.js";
export * from "./note-markdown.js";
export * from "./note-colors.js";
export * from "./note-markdown-read.js";
export * from "./note-sizes.js";
export * from "./note-markdown-write.js";
export * from "./note-markdown-guards.js";
export * from "./site-link.js";
export * from "./note-schema-version.js";
export * from "./group-roles.js";
export * from "./provider-icon.js";
export * from "./agent-label.js";
export * from "./storage.js";
export * from "./versions.js";
export * from "./version-names.js";
export * from "./ai.js";
export * from "./trash.js";
export * from "./folders.js";
export * from "./favorites.js";
export * from "./presence.js";
export * from "./avatar.js";
export * from "./site-limits.js";
export * from "./parse-auto.js";
