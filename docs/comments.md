# Comments

How a note's comments work: who can read and write them, how `@` mentions are recognised, the notifications they send and how long those are kept, and how an AI agent uses them over MCP.

## The thread

Each note has one thread of comments, oldest to newest. A comment can answer another comment on the same note, and it can be about a passage of the note: it then keeps the id of the block the passage is in and, optionally, the quoted text. A comment is a conversation about the note, not part of it: comments are not in the note's content, its versions, its exports or downloaded Markdown files, a copy of the note, or its public page, and writing one doesn't change the note's last-updated time.

- **Who can read and write.** Anyone who can read the note can read its comments and add one, viewers included. With an API token or app credential, reading needs `notes:read` and writing `notes:write`, the same as for the note itself (see [API tokens](./api-tokens.md)). A note in the trash has no readable comments.
- **Length.** A comment has 1 to 4000 characters and can't be only spaces and line breaks; a quoted passage has 1 to 200 characters. Characters are counted as Unicode code points, so an emoji such as 😀 counts as one. Text with a NUL character or an unpaired surrogate is refused.
- **Editing.** Only the comment's author can edit it, and the author is the account: you can edit a comment one of your agents wrote, and your agents can edit yours. Whoever makes the edit counts as its writer: a mention of them isn't notified, and the notifications the edit sends name them as the one who wrote it.
- **Deleting.** The author can delete a comment; so can the owner of a personal note, members whose role in the group can delete notes on a group note, and site admins on notes they can read. Deleting a comment deletes its notifications too.
- **Rate limit.** Posting and editing comments share one budget of 30 per minute per person, in the web app, the API and MCP alike; with a token, each also counts against the token write budget (see [API tokens](./api-tokens.md#errors-and-rate-limits)).

What happens to comments when the note changes hands:

- **Moved into a group.** The comments stay only when the move brings the version history along (**Bring its version history and comments along**, or `keepHistory` / `keep_history`); then everyone in the group can read them. Otherwise they are deleted, with their mentions and notifications (see [Moving or copying a note into a group](./sharing.md#moving-or-copying-a-note-into-a-group)).
- **Its group deleted, with the notes handed to an admin.** The comments stay, unlike the version history. Former members who lose access to the note keep their notifications, without the note's title or the comment's text.
- **Its group deleted with its notes, or the note deleted permanently.** The comments and their notifications are deleted.
- **Moved to the trash.** The comments stay and come back when the note is restored.
- **A person loses access, or their account is disabled.** Their comments stay, under their name.

## Mentions

A mention notifies someone. Write `@handle` for a person, or `@handle/label` for one of that person's agents.

- **Where a mention starts.** The `@` has to be at the start of the text or right after a character that isn't an ASCII letter, digit, `.`, `_` or `-`. So `a@b.com` is not a mention, but `請@bob看` and `（@bob）` are.
- **The handle** is matched without regard to case, and a `-` at its end isn't part of it: `@Bob-` mentions `bob`. **The label** is letters, digits, `.`, `_` and `-`, up to 32 characters; dots at its end are dropped, so `@alice/claude.` at the end of a sentence mentions the agent `claude`.
- **Who can be mentioned.** A mention is resolved when the comment is written, against the people who can read the note at that moment; a disabled account can't be mentioned. Anything that doesn't resolve stays plain text and notifies nobody. A label resolves only if the person set it explicitly as the agent name of one of their tokens or authorized apps that can still be used (an expired token doesn't count); a name derived from a token's name never does (see [API tokens](./api-tokens.md#agent-display-name)). When the label doesn't resolve, `@alice/xyz` mentions `alice` herself, and `/xyz` stays plain text.
- **At most 20** different people and agents are mentioned in one comment; further ones stay plain text.
- **A mention stays with the person.** It is stored with the comment, so it keeps pointing at the same person when they change their handle, and it is shown with their current name and handle. Typing text that looks like a mention into a comment that is already written doesn't create one; editing a comment keeps the mentions whose text you didn't change, so a handle that was given up and taken by someone else doesn't move an old mention to them.

## Notifications

A comment sends notifications to:

- everyone it mentions (a mention of an agent goes to that agent);
- the author of the comment it answers, if they can still read the note — addressed to their agent when an agent wrote that comment — unless the same comment already mentions them.

It never notifies its own writer — the same account with the same agent label — but a person who mentions one of their own agents notifies that agent. Nobody else is notified: the note's owner doesn't hear about every comment. Each comment notifies each person or agent at most once: an edit notifies only those it never notified before, and removing a mention doesn't take back a notification already sent.

A notification addressed to an agent is listed by MCP's `list_notifications` for that agent, and also among the person's own notifications, marked with the agent's label. Your notifications are listed newest first with `GET /api/notifications`; while you can read the note, each shows who wrote the comment, the note's title and the first 120 characters of the comment, and once you can't, only who wrote it, the kind and the time. The unread count is the number of notifications newer than the last time you marked them seen. You can delete one notification, or all of yours — which also deletes those addressed to your agents (see the notification rows in the [API contract summary](./api.md)).

**How long they are kept.** Notifications are deleted 30 days after they were made. A site admin can set another number of days, from 1 to 3650, or keep them for good (`GET` and `PATCH /api/admin/notifications/settings`); the server deletes the ones that are due in a run once an hour.

## Over MCP

An AI agent connected over [MCP](./mcp.md) has three tools:

- [`read_comments`](./mcp.md#read_comments) reads a note's comments, oldest first, from a `since` cursor it got from an earlier call, or one comment by its id. A passage a comment is about comes with the section that holds it now, so the agent can read it with `read_note_section`.
- [`post_comment`](./mcp.md#post_comment) adds a comment, with mentions, as an answer to another comment, or about a section of the note. The comment is posted as the credential's person, under the credential's agent name (over the web app's sign-in session, without one). No tool edits or deletes a comment.
- [`list_notifications`](./mcp.md#list_notifications) lists the notifications addressed to the credential's agent name — or, over a connection made with the web app's sign-in session, those addressed to the person.

Nothing is pushed to an agent: it learns of a new comment or mention only by calling `read_comments` or `list_notifications` again. When they page, both leave out what was written in the last 2 seconds (`read_comments` with a `comment_id` doesn't), so that a comment saved a moment late isn't skipped by a cursor that has already moved past it. The details and their edges are in [Known limitations](./known-limitations/mcp.md).
