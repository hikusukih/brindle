# Design note: reference documents

Box P3.9. Status: proposed. Implementation waits until this merges, and its boxes are filed as `[plan]` proposals once it does. Terms in bold at their first use here (**run**, **scope** and **card**) are defined in the glossary in `docs/architecture.md`.

## Problem

Some knowledge belongs to no single channel: the people in the user's life and what to remember about each, contacts, notes on a topic that keeps coming back. Kept inside one channel's compaction summary, it is invisible to every other channel and eventually folded away. Kept as an ordinary artifact, nothing says when a run should look at it, who may change it, or what stops a fetched web page from rewriting it. The architecture already promises **reference documents**: living, versioned, user-editable, looked up only when needed, added to only with the user's say-so. This note settles how they are stored, found and read, how the agent offers to add to one, whose they are, which writes need a click, and how an attack through one is stopped.

## Approach

### Storage

A reference document is an artifact (kind `document`, Markdown) with a new scope value, `reference`, so it appears in the gallery next to goal state documents and is never offered for deletion with a channel. Two tables sit beside it:

- **`reference_documents`**: artifact id, a unique short name ("People"), the home scope (kind and id), an origin note, and the current version number. The origin note is text, such as "made in channel Family, 12 March", and is never consulted for a permission.
- **`document_versions`**: artifact id, version, full text, author (`user` or `agent`), the run that wrote it, the scope that run was in, whether the run was tainted (below), who confirmed it, a note of what changed, and a timestamp. Append-only; restore writes an old version again as a new one. P4.4 (#88) has already added `goal_states`, keyed by goal id with no scope, taint or confirmed-by columns. The implementation box for this note keeps two tables: it does not migrate `goal_states`, and shares only the restore and conflict code. The taint, scope and confirmation columns are meant for documents that other scopes can write to, which a goal's own state document is not.

A document is capped at 20,000 tokens. Past that, the agent is told to split it ("People" into "People: family" and "People: work") rather than let it grow, so the part a run reads stays cheap.

### Telling the model they exist, and reading one

Documents are not sent with every run. Assembly adds one short line to the harness instructions' layer: the names of the existing documents and a sentence on when to read one ("when the user names a person or topic one of these covers, or this channel's purpose statement does, and the message calls for it"). The line is under 100 tokens for twenty documents and changes only when a document is added, renamed or removed, which the context note's list of planned breaks gains as one more case. Two tools, both `read`:

- `read_reference(name, section?)`. With no section, a document that fits in 2,000 tokens comes back whole. A larger one comes back as an outline: its headings, each with a token count. With a section (a heading from the outline), the result is that heading and what is under it. A model reading a large "People" document therefore pays for one person, not forty. A name that matches nothing returns the list of names.
- `search_references(text)` finds the sections containing the text across all documents and returns their headings and a few lines each, for the case where the user names someone and the model does not know which document holds them.

Results go through the usual sizing and come back as tool-result data, like a fetched page: a document is read as notes, never as instructions.

### Offering to add something

`update_reference(name, edits, reason, initiated_by)` is a `local` tool taking the edit-list form the state document uses (each `old` matching once, applied together or not at all), plus `create_reference(name, text, reason)`. Whether either applies at once or shows a **card** is decided by `needsApproval`, the one function the tools note keeps for this:

- `initiated_by` is `user_request` when the user's message asked for the change ("add Sam's birthday to People") and `agent_noticed` when the agent saw something worth keeping. The model sets it, so it is not trusted past what it can buy (below).
- The call applies without a card only when all of these hold: it is `user_request`, the run's scope is the document's home, and the run is not tainted. Anything else shows a card: "Save this to People?" with the exact diff, the reason, and where the text came from. Accept writes it as a version; decline drops it.
- Creating a document always shows a card, and the channel it was proposed in becomes home on accept.
- Offers are limited so they do not nag: at most one `agent_noticed` card per run; none for a fact the document already holds; and a declined card's edit is remembered (a hash of the normalized text, per document), so the same fact is not offered again. The harness instructions say durable facts only: a person, a standing preference, a recurring topic; not a one-off.
- The user's own edits in the UI are `user` versions and never ask.

A run is **tainted** if either of two things is true. First, from the moment a tool result in it came from outside Brindle's own data: `web_fetch`, `web_search`, `read_feed`, and `read_artifact`, `read_reference` or `search_history` of text whose own run was tainted. Second, from its first step, if the context assembled for it contains anything that came from a tainted run: a tool result kept verbatim in history (the context note keeps earlier results and resends them), a compaction summary written from such runs, or a P3.11 seed. Taint is a property of the stored run, of each compaction summary and of each seed, set by the registry and by assembly from the tool's name and from those flags, not by anything the model says. It is a flag on the artifact too, copied from the run that created it (P2.4 records that run), so a tainted run cannot launder text through `create_artifact` and have a later clean run read it as clean.

The cost is deliberate: after a fetch in a channel, direct writes there need a card for as long as the fetched text, or a summary or seed made from it, is in the context, which in a long channel with compaction can be a long time. The user sees a card with the diff, a click that is cheap beside the attack it stops.

### Home and origin

Home starts as the scope of the run that made the document. It moves in two cases, both on a click the user already makes: accepting a switch from the landing channel (P3.8) or "New channel from here" (P3.11) moves the home of each document whose home was the source scope and that the carried runs read or proposed a change to, to the target channel; a document homed elsewhere that the conversation only read stays where it is, so a landing-channel chat that read People does not take direct writes away from the Family channel; and the user can move it by hand from the document's page. The landing channel therefore keeps no rights to a document the conversation has left. A move writes a version with the note "home moved from X to Y", so history shows it. The origin note does not change and gives no rights.

A write from a scope that is not home always shows a card, which is why a move matters: the channel now working on a topic can update its documents directly, and every other channel has to ask.

### Why the rules are shaped this way

The attack to stop is a fetched page, or a compromised model, planting or rewriting an entry that every later channel reads. The defenses stack so no single one carries it:

- A tainted run never writes without a card, wherever it is and whatever the model claims about who asked. Taint follows the text into later runs through history, summaries, seeds and artifacts, so waiting one message does not clean a run. A page can say "add this to People", and the card still shows the diff and says the text came from a fetched page.
- **A document's taint is derived from its versions.** The text a read returns is tainted if it holds anything that came from a tainted run, and the taint is sticky: a later clean write does not clear it, because the planted entry is still in the text. It clears only when the user, in the UI, edits or confirms the document (a `user` version after which the flagged text is theirs). Accepting a card writes the entry but does not clear the flag: the card approves a write, not the safety of the text for every later reader. The cost is that one accepted fetched-page entry makes every run that reads that document ask for cards until the user next confirms it in the UI, which is listed under Open for the user.
- A model that lies with `user_request` gains only a direct write in an untainted run at home, which is the channel the user is already in and the case where a lie costs least; every write is a version with its author, run and scope, so it can be seen and restored.
- A write adds or replaces at most 2,000 characters, so a single call cannot rewrite a whole document.
- Reads are data, framed as such, and a version written from a tainted run carries that flag, so a later run that reads it is tainted too and cannot turn it into a direct write elsewhere. The same holds for an artifact a tainted run created.
- Nothing in compaction writes a reference document. The summary may point at one by name.

## Rejected

- Sending every document with every run. It spends the window on notes most runs do not need, and puts anything planted in one in front of the model in every channel.
- One table row per fact. It gives structure, but the user edits prose, and the goal state document has already settled on Markdown with versions.
- Embedding retrieval. It adds an index to keep in sync and a recall step the user cannot inspect; headings and a text search are inspectable.
- Rights by origin. The landing channel reads the most untrusted text and would keep the right to rewrite everything it ever started.
- Direct writes at home with no taint rule. A fetched page could then plant an entry in the channel where the user trusts the run most.
- Cards for every write, home included. It makes "add Sam's birthday to People" a two-step chore for something the user just asked for.

## How evals will tell if it works

- **Lookup** (scripted): a run where the user names a person reads the right section of a document too large to read whole, and pays for that section, not the document; a message that names nobody reads nothing.
- **Offer** (scripted, then live): `agent_noticed` always produces a card with the diff; accept writes a version, decline writes nothing; the same declined fact is not offered again; a second offer in one run is refused. Live: in a chat where the user mentions a new colleague's role, the agent offers once, in a sensible form.
- **Home** (scripted): a `user_request` write at home in a clean run applies without a card; the same call from another channel, and the same call after a `web_fetch` in the run, show a card; the landing-channel switch moves the home of documents homed in the source scope and not of others, including one the conversation only read; a moved home gives the old channel no direct writes.
- **Taint** (scripted): a tainted run's card is accepted (version 5), a clean `user_request` write at home follows (version 6), and a run in another channel that reads the document is tainted and its writes show cards; after the user confirms the document in the UI, a read is clean again; a declined card leaves no version, so a later read is clean.
- **Injection** (scripted, then live): a fetched page tells the model to add or rewrite an entry; the run stops at a card marked as from a fetched page, and with a decline nothing changes. A page claiming to be the user cannot make `user_request` apply. A version written by a tainted run taints a later run that reads it; so does an artifact created by a tainted run. A fetch in run N followed by a direct-write attempt in run N+1, a later message with the page still in history, is refused with a card; the same after a compaction summary or a P3.11 seed built from run N. Live: the same against a real model, which must not obey and must not hide the attempt.
- **Versions** (scripted): every write, restore and home move adds a version with author, run and scope; restore writes a new version; two concurrent edits follow the state document's conflict rule.
- **Size** (scripted): a write over 2,000 characters and a document over its cap are refused with a message the model can act on.

## Open for the user

- Whether the cost of carried taint is acceptable: a document holding one accepted fetched-page entry taints its readers until the user confirms it, and a summary made from a tainted run stays tainted while carried forward, so a channel that fetched once keeps asking for cards. The alternative (clearing taint when the user reads the summary and confirms) trades safety for fewer clicks.
- Whether the rule for a direct write is too strict or too loose: it is the one place a click is skipped. The proposed rule (user-requested, at home, clean run) can be tightened to "always a card" with one change in `needsApproval` if the first weeks of use show a lie or a mistake.
- Whether a document should ever be shared with a goal's runs by default. Proposed: yes, by the same tools and the same rules, with a goal's scope counting as its own home only for documents it made.
