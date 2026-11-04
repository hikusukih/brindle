# Design note: goals linked to other channels

Box P4.13. Status: proposed. Implementation (P4.14 and P4.15) waits until this merges. Terms in bold at their first use here (**run**, **scope**, **link**, **card** and **housekeeping call**) are defined in the glossary in `docs/architecture.md`. It builds on `docs/design/goals.md`, which settles the goal, its state document and the scheduler.

## Problem

A goal has one channel, but a goal is rarely discussed in one place. "Prepare for the show" comes up in the Scheduling channel and in My Band, and the user should not have to carry facts to the goal's channel by hand. The opposite risk is real too: if any channel could read or change any goal, a channel that fetched a hostile page could rewrite what every scheduled run trusts. So a link has to be something only the user makes, with a small, visible and reversible set of rights, and a goal must never be left without a channel whatever is archived or deleted around it.

## Approach

### What is stored

- **`goal_channels`**: goal id, channel id, `own` (true for the goal's own channel, which is linked from creation), how the link was made (`creation`, `side_panel`, `channel_header`, `offer` or `draft`), and a timestamp. The primary key is (goal id, channel id). A channel is the own channel of at most one goal (a partial unique index on channel id where `own`), and a goal has exactly one `own` row (a partial unique index on goal id where `own`). `goals.channel_id` from the goals note stays as the fast path to the own channel; the row for it in `goal_channels` is what lets every rule below ask one table.
- A link is created only by a request from the user's own click: in the side panel of either channel, in a channel's header, by accepting a link offer, or by confirming a goal drafted in a conversation (`propose_goal`, P4.9, whose card includes "link this conversation's channel"). No tool, brief, state document or page can create one. There is no tool for linking at all.
- Unlinking is one click from either side. The own channel's row cannot be removed: the endpoint refuses it, and so does a database constraint on `own`.

### What a channel run gets from a linked goal

Only a run in a channel that is linked to the goal, checked on the server from `goal_channels` and the run's channel, never from an id the model supplies:

- **The brief, one line.** Cut at 200 characters, for at most 5 linked goals, in the channel's scope-statement layer under a label naming the goal. This is the whole of what rides along with every request; the state document is not sent.
- **The state document, on request.** `get_goal_state` and `update_goal_state` (the tools of the goals note) take a goal id in a channel run, and the server refuses any id that is not linked to the run's channel. In a goal's own scope they work as before, with the goal found from the scope.
- **Writes go through the state document's existing versioned edits**, with the same exact-string rule, the same conflict handling and the same cap. Each version also records the channel and run that wrote it, and the channel's name as it was, copied so it survives the channel. Every such write shows in the channel's transcript as a line with "Revert", and in the history in the goal's side panel; revert writes the previous text as a new version, one click, with no confirmation card, because it only restores something that was already there. A channel that is not linked can do none of it.
- **The next goal run is told.** When the current state's last writer is a channel run rather than a goal run or the user, the state is labeled in the goal run's context as "last changed from the channel X, run Y" and, as with all state, is data and not instructions. A goal run that finds an unexplained change has something to be careful about.
- **A rate limit.** At most 3 state writes per channel run. A run that tries a fourth is told it has reached the limit. Together with revert and the label, this bounds what a hostile page can do to "a few wrong lines, shown to the user, undone in a click", and the state document cannot change what any tool is allowed to do: approvals, effect levels and the key manager do not read it.

### One run per goal, and the schedule's destination

The one-run-per-goal rule counts goal runs only: scheduled runs and runs the user starts in the goal's own channel. A run in a linked channel does not count and is never held, because it is a channel run that happens to hold a link. The state document's conflict rules already cover a channel run writing alongside a goal run: the later write is tried against the current text, and fails with the current content if the same line moved.

A schedule's destination is the goal's own channel or any linked channel (`destination_channel_id`, null meaning the own channel, so the existing rows need no change). If that channel is unlinked, archived or deleted, the schedule's destination goes back to null, and the goal's own channel gets a line written by the harness, with no model call: "Scheduled runs for <schedule> post here again because <channel> is no longer linked." A scheduled run's output in a linked channel is a goal run posting there; it does not count against that channel's own runs.

### A goal is never without a channel

- The own channel cannot be unlinked, archived or deleted by itself; the controls are not shown and the server refuses the request.
- **Archiving a goal** archives its own channel with it, and restoring the goal restores both. Linked channels are untouched and keep the links, which sit idle while the goal is archived (a channel run cannot write to an archived goal). An archived goal's brief still rides in the linked channels and `get_goal_state` can still read it there, since reading changes nothing and the user may be looking at the goal's history; only writes are refused.
- **Deleting a goal** asks what becomes of its channel: keep it as an ordinary channel, or delete it. Keeping it removes the goal's pinned brief, copies the brief's current version in as the channel's purpose statement with that version's author and confirmed flag, so an agent draft the user confirmed with one click stays marked as the agent's, and leaves its runs. This amends the goals note, which deleted the channel with the goal. All other links to the goal are removed.
- **Any other linked channel** that is archived or deleted is only unlinked; restoring it does not bring the link back, since a link is something the user makes.

### The link offer

When a channel's recent runs keep returning to one goal, an inline card in the channel offers "Link this goal to this channel?" with Link and Not now. It links nothing until accepted.

- **How it decides.** After a run in an unlinked channel, one housekeeping call sees only the channel's purpose statement and the user's last three messages in it, and the titles and one-line briefs of active goals (at most 20). It returns a goal id or none. It reads no state documents, tool results or fetched text. An offer needs the same goal to match in 3 of the channel's last 5 runs.
- **How often.** At most one offer per channel at a time. Not now suppresses that pair until the user links or unlinks it by hand, so a declined offer is never repeated. After any offer, at least 10 runs pass in that channel before another. A goal's own channel and a channel already linked to that goal are never offered. There is a settings switch to turn offers off.

## Rejected

- **Letting the model link a channel.** Even behind a card, a model that proposes links trains the user to click through. Links come from the user's actions and the one offer above.
- **Sending the whole state document to linked channels.** It is up to 3,000 tokens a channel would carry on every run, and most channel runs have nothing to do with it. On request is cheaper and gives a transcript line each time it is used.
- **A card for every channel write.** The write is revertible, local, rate-limited and labeled; a card per write makes linking pointless. The reference documents note confirms more strongly because those are read by every channel; revisit if the user finds this too loose (below).
- **Many-to-one goals, with one channel serving as several goals' own.** It breaks "delete the goal and keep its channel as ordinary".
- **Restoring a link when an archived channel is restored.** The user may have moved on; a silent return of write access is the wrong default.
- **Counting linked-channel runs toward the goal's one run.** It would hold the user's conversations behind a scheduled run in another place.

## How evals will tell if it works

Scripted scenarios, plus unit tests of the table's rules.

- **A linked-channel write is reverted**: a run in a linked channel edits the state, the version records the channel and run, a revert writes the old text as a new version, and the next goal run's context labels the last change as from that channel.
- **An unlinked channel cannot write**: the same call from an unlinked channel is refused whatever goal id the model supplies, and the refusal reads the state of neither.
- **A goal cannot be left without a channel**: archiving, unlinking and deleting every other channel, the own channel's controls and endpoints refused, and a goal delete with "keep" leaves an ordinary channel carrying the brief as its purpose statement.
- **Injection**: a channel run fetches a hostile page and writes it into a linked goal's state. The write is limited to 3 per run, appears with a revert line, is labeled for the next goal run, and the next goal run's attempt to call an `external` tool on the planted text still stops at the approval card with nothing sent if declined. A live variant asks whether the model takes the bait.
- **Destination fallback**: unlinking, archiving and deleting a destination channel each return the schedule to the own channel and leave the harness-written line.
- **The offer**: three matches in five runs produce one card; Not now stops it for that pair; ten runs apart for different goals; a goal's own channel never gets one; the offer call is not given state or tool results (checked on the request it sends).

## Open for the user

- Whether a channel write that follows fetched text in the same run should need a card (as the reference documents note proposes for any write by a run that took in outside text), or whether the limits above are enough. Recommendation: the limits for now, because the state document cannot widen any permission; add the card if the first weeks show channel writes being reverted often.
- Settled by the user: archiving a goal does not ask what becomes of its channel; it always archives the channel with it, and only deleting asks. Archiving is meant to be undone, and an archived goal with a live ordinary channel is the state this note is built to avoid.
