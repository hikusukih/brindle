# Plan

The work queue. Read `CLAUDE.md` first: it says how a session picks, claims and finishes a box. The design lives in `docs/architecture.md`; open questions and settled answers live in `docs/decisions.md` (product) and `.agents/decisions.md` (process).

Every box is sized for one short session and lands as one PR. A box marked **design note** produces a document under `docs/design/` and nothing else.

A box marked **review** closes each phase. Its PR follows the proposal rules in `CLAUDE.md` (plan and docs only, no code) and also checks its own box, unless a box it should wait on turns out unfinished (see _needs every box in this phase_ below). It compares the plan with what the phase actually built, fixes later boxes whose needs, sizing or wording no longer fit, splits the next phase's boxes down to one-session size, and adds boxes for gaps the phase turned up. It adds boxes only as far ahead as there is evidence for, mostly the next phase. It reads the open `[plan]` PRs first so it doesn't duplicate them. A box it thinks should go becomes a question in `docs/decisions.md`, or `.agents/decisions.md` if it is about process.

A review also sweeps the phase for loose ends: work that was deferred, mentioned once and dropped, or otherwise abandoned. It reads every PR, merged or closed, that is a box in the phase or a proposal that touched one, with all its comments, reviews and replies, and the PR descriptions' left-to-do and proposal lists. It looks for findings marked not blocking or left for later, replies that chose not to fix something, proposals listed but never filed, questions to the user with no answer, and ideas raised once and never picked up. The reading can be handed to a subagent, but the review checks each item against `main` (the code, the plan, the decisions files and the open `[plan]` PRs) before acting on it. An item that is done, covered by a box or an open proposal, or no longer applies is dropped. One that still applies is fixed in the review PR when it is a change to the plan, or becomes a question with a recommendation in a decisions file when it needs the user. The review PR's description ends with a **Loose ends** list: each item with a link to where it was raised and what became of it (fixed, raised, or dropped and why), with the items raised to the user first.

## Layout

There is no index: the folders are the plan. One box per file, so PRs that add, reword or check different boxes never touch the same file.

- Each phase is a folder named for its number and title, such as `P2-real-models-tools-and-artifacts/`. The boxes that close the whole project are in `A-the-whole-thing/`, which comes after every numbered phase.
- The folder sets a box's phase, not its ID. Moving a box to another phase is a `git mv` of its file into that phase's folder; the ID stays.
- Each box is a file in its phase folder named for its ID and a few words, such as `P2.4-artifacts-storage-and-tool.md`. The words are only a hint: a reword doesn't rename the file, and the ID is what counts.
- A box's file holds one line: the ID in bold, the box's text, and its needs at the end.
- Checking a box means moving its file into the phase's `done/` folder (`git mv`), in the box's own PR. A file in `done/` is checked; any other box is unchecked. So the open boxes of a phase are the files directly in its folder.
- To read the open boxes in the plan's order: `for d in $(ls -d .agents/plan/P*/ | sort -V) .agents/plan/A*/; do (cd "$d" && ls *.md 2>/dev/null | sort -t- -k1,1V | xargs -r cat); done`. It sorts on the ID alone, since `sort -V` on whole names puts P2.4a before P2.4. Use `cd "$d"done` for the checked ones.

## Box IDs and needs

- Every box has an ID such as **P1.2**. An ID never changes and is never reused, even if the box is reworded, moved or split. A box added later takes the next unused number in its phase.
- Order: among free boxes, take the one in the lowest phase folder (numbered phases in order, then `A-the-whole-thing/`), then the lowest ID within it. IDs compare by number, and a suffixed ID comes right after its base: P2.4, P2.4a, P2.4b, P2.5, P2.10. A box that should wait for another says so in its needs; nothing else orders the queue.
- Every box ends with what it needs, such as _needs P1.1, P1.3_. A box is free to take only when every ID it needs is checked on `main`. Boxes are checked inside their own PR, so checked on `main` means merged.
- _needs nothing_ means the box can be taken now. _needs every box in a numbered phase_ means every box in every `P<n>-` folder.
- _needs every box in this phase_ is how a **review** box states its needs. It means every other box in the same phase folder, plus every box elsewhere marked _reviewed with_ that review, with two exceptions that keep every box reviewed somewhere:
  - A box that waits on an unsettled decision, directly or through its needs, is outside its review until the decision is settled; it needs no marker. If its review is already checked by then, the PR that settles the decision marks the box _reviewed with_ the next unchecked review in a later phase, or, if none is left, adds a review box for it.
  - A box that needs an unchecked box in a later phase, directly or through its needs, ends its needs with the later review that takes it instead, such as _needs P3.1; reviewed with P3.6_.
  - Nothing else keeps a box out of its review: a box that is slow or blocked for a long time still holds the review up. So adding a box to a phase never edits the review's file.
  - When a review is worked, it checks each box in its phase marked _reviewed with_ a later review still needs an unchecked box in a later phase, and each box left out by a decision is still waiting on an open one; it says what it found in its PR. A _reviewed with_ marker that no longer fits comes off if the box is unclaimed, and the review then waits on that box like any other; if the box is claimed, the review adds the box's ID to its own needs instead, such as _needs every box in this phase, and P2.11_. Either way, if that box is still unchecked, the review leaves its own box unchecked until that box is done.
- _needs decision: Name_ means the box waits until the decision called Name is under Settled in `docs/decisions.md` or `.agents/decisions.md` on `main`.
- Boxes that implement a design note list the note's ID in their needs, so a note only holds up the work that depends on it.
