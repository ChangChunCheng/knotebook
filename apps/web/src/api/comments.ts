import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import type { CommentDto, CommentListDto, CommentUnreadCountDto } from "@knotebook/shared";
import { api, ApiFail } from "./client";

export const COMMENTS_PAGE_SIZE = 50;

/** Under `['notes']`, like versions: a move that clears history invalidates `['notes']`, which reloads an open thread. */
export function commentsKey(noteId: string) {
  return ["notes", noteId, "comments"] as const;
}

export function commentListsKey(noteId: string) {
  return [...commentsKey(noteId), "list"] as const;
}

/** `around` null = the newest page. */
export function commentListKey(noteId: string, around: string | null) {
  return [...commentListsKey(noteId), around ?? "newest"] as const;
}

export function commentUnreadKey(noteId: string) {
  return [...commentsKey(noteId), "unread"] as const;
}

export type CommentPageParam =
  | { kind: "newest" }
  | { kind: "around"; commentId: string }
  | { kind: "before"; cursor: string }
  | { kind: "after"; cursor: string };

export type CommentPages = InfiniteData<CommentListDto, CommentPageParam>;

const noteBase = (noteId: string) => `/api/notes/${encodeURIComponent(noteId)}/comments`;
const commentBase = (commentId: string) => `/api/comments/${encodeURIComponent(commentId)}`;

export function fetchCommentPage(noteId: string, param: CommentPageParam, limit = COMMENTS_PAGE_SIZE): Promise<CommentListDto> {
  const params = new URLSearchParams();
  if (param.kind === "around") params.set("around", param.commentId);
  else if (param.kind === "before") params.set("before", param.cursor);
  else if (param.kind === "after") params.set("after", param.cursor);
  params.set("limit", String(limit));
  return api<CommentListDto>(`${noteBase(noteId)}?${params.toString()}`);
}

export function fetchComment(commentId: string): Promise<CommentDto> {
  return api<CommentDto>(commentBase(commentId));
}

export function postComment(
  noteId: string,
  body: { body: string; replyToId?: string | null; anchor?: { blockId: string; quote: string | null } },
): Promise<CommentDto> {
  return api<CommentDto>(noteBase(noteId), { method: "POST", body: JSON.stringify(body) });
}

export function editComment(commentId: string, body: string): Promise<CommentDto> {
  return api<CommentDto>(commentBase(commentId), { method: "PATCH", body: JSON.stringify({ body }) });
}

export function deleteComment(commentId: string): Promise<void> {
  return api<void>(commentBase(commentId), { method: "DELETE" });
}

export function markCommentsRead(noteId: string): Promise<void> {
  return api<void>(`${noteBase(noteId)}/read`, { method: "POST" });
}

export function useCommentList(noteId: string, around: string | null, enabled: boolean) {
  const queryClient = useQueryClient();
  const base = queryClient.getDefaultOptions().queries?.retry ?? 3;
  return useInfiniteQuery({
    queryKey: commentListKey(noteId, around),
    queryFn: ({ pageParam }) => fetchCommentPage(noteId, pageParam),
    initialPageParam: (around === null ? { kind: "newest" } : { kind: "around", commentId: around }) as CommentPageParam,
    getPreviousPageParam: (first): CommentPageParam | undefined => (first.olderCursor === null ? undefined : { kind: "before", cursor: first.olderCursor }),
    getNextPageParam: (last): CommentPageParam | undefined => (last.newerCursor === null ? undefined : { kind: "after", cursor: last.newerCursor }),
    enabled: enabled && noteId.length > 0,
    // A comment that no longer exists stays missing: the panel falls back to the newest page at once instead of after the backoff.
    retry: (count, error) => {
      if (error instanceof ApiFail && error.status === 404) return false;
      if (typeof base === "function") return base(count, error);
      return typeof base === "number" ? count < base : base;
    },
  });
}

export function useCommentUnreadCount(noteId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: commentUnreadKey(noteId ?? ""),
    queryFn: () => api<CommentUnreadCountDto>(`${noteBase(noteId!)}/unread-count`),
    enabled: enabled && noteId !== null,
  });
}

function sortKey(c: CommentDto): string {
  return `${c.createdAt}\u0000${c.id}`;
}

function mapLists(queryClient: QueryClient, noteId: string, fn: (data: CommentPages) => CommentPages): void {
  queryClient.setQueriesData<CommentPages>({ queryKey: commentListsKey(noteId) }, (data) => (data === undefined ? data : fn(data)));
}

function mapComments(data: CommentPages, fn: (c: CommentDto) => CommentDto | null): CommentPages {
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      comments: page.comments.flatMap((c) => {
        const next = fn(c);
        return next === null ? [] : [next];
      }),
    })),
  };
}

function contains(data: CommentPages, id: string): boolean {
  return data.pages.some((p) => p.comments.some((c) => c.id === id));
}

/** A new comment belongs at the end only of a range that reaches the newest one. */
export function reachesNewest(data: CommentPages | undefined): boolean {
  const last = data?.pages[data.pages.length - 1];
  return last !== undefined && last.newerCursor === null;
}

export function mergeComment(queryClient: QueryClient, comment: CommentDto, { append }: { append: boolean }): void {
  mapLists(queryClient, comment.noteId, (data) => {
    if (contains(data, comment.id)) return mapComments(data, (c) => (c.id === comment.id ? comment : c));
    if (!append || !reachesNewest(data)) return data;
    const pages = data.pages.slice();
    const last = pages[pages.length - 1]!;
    const comments = [...last.comments, comment].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
    pages[pages.length - 1] = { ...last, comments };
    return { ...data, pages };
  });
}

/** A reply left with `replyToId` but no `replyTo` reads as answering a deleted comment. */
export function removeComment(queryClient: QueryClient, noteId: string, commentId: string): void {
  mapLists(queryClient, noteId, (data) =>
    mapComments(data, (c) => (c.id === commentId ? null : c.replyTo?.id === commentId ? { ...c, replyTo: null } : c)),
  );
}

export type CommentChangeOp = "created" | "edited" | "deleted";

/** Fetches the comment only when a thread is loaded; the unread count is refetched either way. */
export async function applyCommentChange(queryClient: QueryClient, noteId: string, op: CommentChangeOp, commentId: string): Promise<void> {
  void queryClient.invalidateQueries({ queryKey: commentUnreadKey(noteId) });
  const lists = queryClient.getQueriesData<CommentPages>({ queryKey: commentListsKey(noteId) }).filter(([, data]) => data !== undefined);
  if (lists.length === 0) return;
  if (op === "deleted") {
    removeComment(queryClient, noteId, commentId);
    return;
  }
  if (op === "edited" && !lists.some(([, data]) => contains(data!, commentId))) return;
  let comment: CommentDto;
  try {
    comment = await fetchComment(commentId);
  } catch (err) {
    // Deleted again before we asked; anything else waits for the next refetch.
    if (err instanceof ApiFail && err.status === 404) removeComment(queryClient, noteId, commentId);
    return;
  }
  if (comment.noteId !== noteId) return;
  mergeComment(queryClient, comment, { append: op === "created" });
}

export function listHasComment(queryClient: QueryClient, noteId: string, around: string | null, commentId: string): boolean {
  const data = queryClient.getQueryData<CommentPages>(commentListKey(noteId, around));
  return data !== undefined && contains(data, commentId);
}

export function usePostComment(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof postComment>[1]) => postComment(noteId, body),
    onSuccess: (comment) => mergeComment(queryClient, comment, { append: true }),
  });
}

export function useEditComment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ commentId, body }: { commentId: string; body: string }) => editComment(commentId, body),
    onSuccess: (comment) => mergeComment(queryClient, comment, { append: false }),
  });
}

export function useDeleteComment(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (commentId: string) => deleteComment(commentId),
    onSuccess: (_void, commentId) => removeComment(queryClient, noteId, commentId),
  });
}
