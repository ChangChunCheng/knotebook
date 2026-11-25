# Knowledge info

A heading can carry a few facts about what it says: when to read it, a one-line conclusion, what the conclusion rests on, when someone last checked it, and whether it still holds. A heading with these facts is a piece of *knowledge*. In the text it adds one small icon after the heading, so a note reads the same as before; the facts are one hover or tap away. A note without knowledge info looks and behaves exactly as it did.

Only a heading at the top level of the note can carry it. A heading inside a column, a list or a quote can't. Known limits are in [Known limitations](./known-limitations/knowledge.md).

## The fields

Every piece of knowledge has a **Status**:

| Status | Meaning |
|---|---|
| **Verified** | Someone checked it and it holds. |
| **Needs review** | It should be checked. New knowledge starts with this status. |
| **Outdated** | It no longer holds. |

Then come the fields the site has turned on (see [Choosing the fields](#choosing-the-fields)), in this order. All five are on unless a site admin turned some off, and every field is optional:

| Field | What it holds |
|---|---|
| **When to read** | When someone should read this part, up to 200 characters. |
| **Conclusion** | The point of the section in one line, up to 300 characters. |
| **Basis** | What the conclusion rests on: **Tested**, **Documentation** or **Inferred**, unless the site renamed, added or hid options; or nothing. |
| **Last verified** | A date, or empty. It may be any valid date, including one in the future. |
| **Replaced by** | Only for **Outdated**: the knowledge heading that took its place, in this note or in another note you can see. The list offers this note's knowledge headings first, the outdated ones included; type to search the knowledge in your other notes as well (see [Replacing with knowledge in another note](#replacing-with-knowledge-in-another-note)). |

After the built-in fields come the custom fields a site admin added, in the order the admin set (see [Custom fields](#custom-fields)). Each has a name of the admin's choosing and one of five types:

| Type | What it holds |
|---|---|
| **Text** | One line, up to 300 characters. |
| **Single choice** | One of the options the admin set up for it, or nothing. |
| **Date** | A date. |
| **Link** | A web address starting with `http://` or `https://`, or a path on this site starting with `/`, up to 2,048 characters and without spaces. |
| **Person** | Someone you can name: yourself, the members of your groups, or the people you have shared one of your notes with. A disabled account can't be picked. |

A status alone is enough to save: knowledge doesn't need any field filled in. To take the info off a heading, use **Remove knowledge info** at the top right of the form. Emptying every field of existing knowledge and saving it as **Needs review** doesn't remove it either: the form asks you to fill in a field, so a slip doesn't leave an empty entry behind.

Knowledge saved by version 0.18 or earlier has no stored status unless it was marked **Needs review** or **Outdated**. It reads as **Verified** when it has a last verified date and as **Needs review** when it doesn't, and so does knowledge an agent writes without a status (see [AI editing](./ai-editing.md#knowledge-info)). Changing it in the form stores the status the form shows.

## The icon

The icon sits after the end of the heading's last line. It is faded until you point at it or move the keyboard focus to it, and always faded on a screen that has no pointer to hover with. Its name, which screen readers read, is **Knowledge info:** followed by the state. The first row that applies decides it:

| Icon | State | When |
|---|---|---|
| Red circle with a slash | **Outdated** | The heading is outdated, or a knowledge heading above it is. |
| Amber circle with an exclamation mark | **Needs review** | The status is **Needs review**. |
| Green circle with a check | **Verified** | The status is **Verified**. |

An outdated heading, and every knowledge heading under it, is dimmed and struck through, so what is out of date can be skipped at a glance. "Under" means below it and before the next heading of the same or a higher level (an H3 is under the H2 above it, until the next H2 or H1). A knowledge heading belongs to the nearest knowledge heading it is under, and its card says **Part of:** and links to it.

## The card

Point at the icon (or tap it on a phone) to see a card with the fields the site has turned on, a banner when the state needs one (needs review, outdated and what replaced it, or outdated because of a heading above) and, for a heading that has knowledge headings under it, how many there are and how many are verified, need review and are outdated. Custom fields come after the built-in ones. A field that is on but empty reads **Not filled**; a basis or single-choice option the site has hidden since it was chosen reads as its name followed by **(turned off)**. A person reads as their name, also after they left the group or their account was disabled, and as **Unknown member** when the stored value matches no account (only an edit made straight through the collaboration editor can store one). A link opens in a new tab, or in this one for a path on this site; a value stored some other way that isn't such an address is shown as plain text. The banner names the replacement only while **Replaced by** is on, and the last verified date only while **Last verified** is on. **Part of:** and the names in the banners jump to that heading, in another note too (see [Replacing with knowledge in another note](#replacing-with-knowledge-in-another-note)). Anyone who can read the note sees the card; only people who can edit it see **Edit**.

On a phone the card opens from the bottom, with **Mark as verified** (sets the status to **Verified** and, while **Last verified** is on, the last verified date to today) and **Edit**. Both are shown only to people who can edit the note. **Mark as verified** is left out for a heading whose own status is **Outdated**; a heading that only shows as outdated because one above it is still has it.

## Adding and editing

There are three ways in, for someone who can edit the note:

- Type `/info` in the heading (or choose **Knowledge info** in the `/` menu) and press Enter.
- Open the heading's drag handle menu and choose **Knowledge info…** (**Edit knowledge info…** once it has some). A phone has no drag handle.
- Click the icon. On a screen wide enough not to be a phone (640 px or more), with a mouse and the right to edit, the form opens straight away and the card comes from pointing; at phone width, or without the right to edit, the icon opens the card (on a phone, the bottom sheet); on a touch screen, tap the icon for the card and then **Edit**.

The form shows the status first, then the fields the site has turned on, the custom ones last. A **Person** field lists **Me** first; type two or more characters of a name or email to find the others you can name. A person someone else picked stays as it is until you pick another one or clear it with the **×** button, even when you couldn't pick them yourself. Picking **Verified** fills in today's date as the last verified date when that field is on; you can change it. **Today** next to the date fills in today's date without changing the status. **Replaced by** appears once the status is **Outdated**, and can be left empty. The form closes with **Save**, **Cancel** or **Esc**; closing it with unsaved changes drops them. Saving is one change, so **Undo** takes the whole edit back. Saving never empties a field the site has turned off: its value stays in the note, unseen, and shows again if the field is turned back on. If someone else turns the heading into a paragraph, deletes it or moves it into a column while your form is open, the form closes with a notice and nothing is written.

Pressing Enter at the very start of a knowledge heading that has text adds an empty paragraph above it, so the heading keeps its info. Pasting or copying a knowledge heading within a note gives the new copy its own id; it doesn't take over the one it was copied from.

## Replacing with knowledge in another note

In the form, **Replaced by** lists this note's knowledge under **This note**. Once you type something and pause for a moment, the knowledge in your other notes that matches appears under **Other notes**: it matches the heading, the title of the note, and when to read and the conclusion while the site has those fields on, ignoring case, and shows at most 20 results. Only notes you can see are searched, and notes in the trash aren't. A heading can't be marked as replaced by itself. If the search fails the form says so and **This note** keeps working; if you search too often it asks you to wait a minute.

The search draws on the same per-minute budget as the sidebar's text search and the `search_notes` tool (60 searches a minute per person by default, see [API](./api.md)), and the more knowledge you can see, the longer it takes.

The card, the phone sheet and the index then show that heading's name, and a click opens that note at that heading. The name follows the other note: rename the heading and the card shows the new name within a minute, or when you reload. If the other note has been deleted or is in the trash, or you can't see it, the card says **knowledge in another note** without a name or a link, and that text is the same whichever it is, so it doesn't tell you whether the note exists. A replacement in the same note that has been removed reads **knowledge that no longer exists**. A version preview doesn't look other notes up: there it always says **knowledge in another note**.

## The index

An index lists the knowledge in a folder, in your own notes or in a group, one row for each piece, so you can see when to read what without opening the notes. It is built from the knowledge info in the notes and is read-only.

**Opening it.** A folder row, a group row and the **My notes** tab's title row show an index button when you point at them (on a touch screen it is always there), and the `⋮` menu of a folder or a group has **Open index**. They are there only for a folder, group or space that holds knowledge; a folder's index includes the knowledge in its subfolders. When you add the first knowledge to a folder, the button shows once the sidebar's note list has refreshed, for example after reloading the page. The addresses are `/knowledge/me`, `/knowledge/g/<group id>` and `/knowledge/f/<folder id>`.

**Who can open it.** Your own notes' index and your own folders' indexes are yours. A group's index, and the index of a folder in it, is for the members whose role can read the group's notes. Everyone else, including someone who has only been shared a note in that folder or group, gets **Index not found**, which reads the same whether or not the folder or group exists. **Shared with me** and its folders have no index, and a note shared with you is in no index.

**What it lists.** The knowledge in the notes you can see in that space or folder, not the ones in the trash. A note appears a few seconds after it is saved. Each row shows the status icon, **when to read → conclusion** (the heading when both are empty or the site has turned both off), and the note's title and the heading; a click opens the note at that heading. A heading with nothing in the row's first field (when to read, or the conclusion while when to read is off) is nested under the knowledge it belongs to, which carries a count of what is under it; with both fields off, every piece of knowledge has a row of its own. Custom fields aren't shown in the index and can't be filtered by. Knowledge that needs review is amber. Outdated knowledge is faded and goes last in its section, with **→ replaced by** and the replacement's name, a link when you can see it.

**Sections.** By default the rows are grouped by folder: first the notes directly in the space or folder, then one section for each subfolder. **Group by Tag** (offered when the notes in the index have tags) makes one section for each tag, with a note under each of its tags and the rest under **No tag**.

**Filters.** **Tags** keeps the notes that have every tag you tick, **Status** keeps knowledge that is **Verified**, **Needs review** or **Outdated**, and **Basis** keeps one basis, or the knowledge with none (**Not filled**). **Basis** lists the site's options in the site's order, and isn't shown while the site has the basis field off. **Clear filters** resets them. The filters and the grouping are in the address, so a reload or a shared link keeps them; changing them doesn't add a step to the browser's history, so **Back** returns to the page before the index.

After an upgrade, older notes are indexed in the background and the page says so while that goes on. The limits of the index are in [Known limitations](./known-limitations/knowledge.md).

## Choosing the fields

A site admin chooses the fields under **Site admin → Knowledge fields**. The settings apply to every space: your own notes and every group use the site's.

- **Status** is always on.
- Each built-in field (**When to read**, **Conclusion**, **Basis**, **Last verified**, **Replaced by**) has a switch. A field that is off isn't in the form, on the card, in the index or in the Markdown that agents and the editor's AI actions read. Its values stay in the notes: turning the field back on shows them again. An agent that writes a field that is off has that line left out and listed in its reply (see [AI editing](./ai-editing.md#knowledge-info)).
- **Basis** options can be renamed (a built-in option with a blank name keeps its default name), hidden with their **Show** switch, moved up and down, and added, up to 30 options. A new option needs a name and a key: the key is made from the name and can be edited until you save, and is lowercase letters, digits and hyphens, at most 64 characters; `tested`, `docs`, `inferred` and `unconfirmed` are reserved. A key can't be changed after saving, and options can't be deleted, only hidden. Knowledge that has a hidden option keeps it: the card shows the option's name followed by **(turned off)**, and the form keeps it until you choose another basis, but no longer offers it.
- Markdown and the API write a basis or a single choice by its option key, not its name, and a person by their handle, so renaming an option changes nothing in what agents read or write.

### Custom fields

**Add custom field** opens a small form: a **Name** (up to 60 characters), a **Type** (see [The fields](#the-fields)) and a **Key**, which is made from the name and can be edited until you save: lowercase letters, digits and hyphens, at most 64 characters, starting with a letter or digit, and different from every other custom field's key, turned-off ones included. A **Single choice** field needs at least one option, and its options are edited like those of **Basis** (up to 30), with no reserved keys. **Add field** puts it in the list, and **Save** creates it.

- A custom field can be renamed, moved up and down, and turned off and on with its **Show** switch. Its key and its type can't be changed after saving.
- A custom field can't be deleted, and its key is never used again: turning it off hides it everywhere, as for a built-in field, and keeps its values in the notes.
- Up to 20 custom fields can be on at once, and up to 100 can exist, turned-off ones included. While 20 are on, a new field starts off, and a field that is off can't be turned on until another one is turned off.
- Agents read and write a custom field as an `x-<key>:` line in the knowledge comment (see [AI editing](./ai-editing.md#knowledge-info)), so its key is what a script or an agent uses.

**Save** applies the changes in one go and **Discard changes** drops them. A save writes the whole page as you see it, so when two admins edit the settings at once, the later save wins, with one exception: if the other admin added an option or a custom field in the meantime, your save is refused, and the page loads the latest settings and asks you to make your changes again. Any other change the other admin saved meanwhile is overwritten without a warning (see [Known limitations](./known-limitations/knowledge.md)). A page that is already open keeps the settings it loaded until it fetches them again: when its window comes back into focus, or its connection comes back, at least a minute after it last loaded them, when you open a note or an index whose settings it hasn't loaded in the last minute, or when you reload.

## Where it shows and where it doesn't

- **Version history.** Previewing a version shows the icons that version had, and their cards without **Edit**.
- **Public pages and presentations.** A public link shows the note without any knowledge info, and so does the presentation mode (see [Sharing](./sharing.md)). The server removes it before it sends the note.
- **Copying out.** Text copied out as HTML or Markdown leaves the info out.
- **AI agents and downloaded files.** The Markdown that MCP, the API and a downloaded file give an agent has the info, with the status and the fields the site has turned on (a custom field as an `x-<key>:` line): a comment after each knowledge heading, which the agent can keep, change or add when it writes the note back. Reading and writing it is described in [AI editing](./ai-editing.md#knowledge-info); a downloaded file also has a `tags:` line, which an agent can change to set the note's tags (see [Sharing](./sharing.md#tags)). The AI actions in the editor send and check it the same way.
