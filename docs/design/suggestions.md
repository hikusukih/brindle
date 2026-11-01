# Design note: the suggestion run

Box P7.5. Status: proposed. Implementation (P7.1 to P7.3) waits until this merges. Terms in bold at their first use here (**run**, **scope** and **card**) are defined in the glossary in `docs/architecture.md`. It leans on `docs/design/goals.md` (briefs, state documents, the user's time zone), `docs/design/context.md` (summaries) and `docs/design/key-manager.md` (the credential request).

## Problem

The suggestion run is the one run that reads across every scope, and its output is shown to the user as things to accept: a next step, a schedule, a goal, a login. That makes it the most attractive place in the product to plant text. A page fetched in one channel, saved into a goal's state document, summarized, and read back by the suggestion run could end up as a polished card saying "connect your account at this address", from the agent the user trusts. It also has to be calm: a daily nag, or the same idea in new words after the user said no, would break the principle the rest of the product keeps.

## Approach

### What it is

A scheduled run with the suggestion scope and **no tools at all**. The harness builds its input from stored rows and reads its output as structured data, validates it, and drops what does not validate. The model cannot fetch, read an artifact, call a tool or write anything; the only thing it can do is propose, and every proposal is a card the user must act on. This removes the tool path entirely, so the remaining risk is text in its input, which the rules below bound.

### What it may read

User-written text first, then text the agent wrote, each labeled as data in the prompt:

- **Goal titles and briefs**, which the user wrote (the brief's 500-token cap).
- **Purpose statements**, which an agent drafted and the user may have edited (300 tokens each).
- **The head of each goal's state document**, cut at 400 tokens, and the **running summary** of each channel, cut at 400 tokens. Both are agent-written and may carry text that came from the web, so they are the reason for everything under "What a card may carry".
- **Activity as counts and times, not text**: for each goal its last run's time and outcome and its schedules' recent fire states; for each channel when it was last used. No run transcript, tool result or fetched text, and no artifact content.

It reads at most the 20 most recently active goals and 20 channels, in a fixed order, within a total budget of 6,000 tokens, with the most static layers first so the model server's cache can be reused from one day to the next (the context note's rule). Goals the user archived are not read.

### What it must not read

Raw fetched text and tool results (the one place a hostile page lives verbatim), artifact content, reference documents, run transcripts and held or declined messages. A fixture test checks the request the run sends for any of them.

### What it returns

A JSON list of at most 3 cards, each with a `kind` (`next_step`, `schedule`, `goal` or `credential`), a goal id where it applies, a short `topic` (a few words naming the idea), a title of at most 80 characters and a body of at most 300. A `schedule` card carries a cron expression and prompt; a `goal` card a title and brief; a `credential` card a goal id and a site. The harness checks every id exists, every length, and every cron with the same checks as `propose_schedule` (P4.5). A response that is not valid JSON, or that has no valid card, produces no cards and no message to the user; the next day tries again.

### Dedup and dismissal, by topic

A card's identity is its `kind`, its goal id (or none) and its topic, normalized by the harness: lowercase, punctuation and common words removed, tokens sorted. A new card is dropped if its identity matches a dismissed, accepted or still-pending card, or if it is the same kind and goal and shares at least 60% of its topic tokens with one. The model is also shown the 100 most recent dismissed topics and told not to repeat them, but that is a courtesy: the harness check after it is what guarantees a dismissed idea stays dismissed whatever words it comes back in. A dismissal lasts as long as its goal does. Cards that expire unanswered (7 days) are remembered as expired, not dismissed, and may be proposed once more.

### The daily cap

At most one suggestion run per calendar day in the user's time zone (the setting from P4.22), started by the first scheduler poll after 07:00 local that finds none yet today, and not at all after 18:00. A day the server was down is skipped, not caught up. At most 3 cards per run and 5 pending at once: a run adds only up to that limit. If nothing it reads has changed since its last run (a hash of its input), no model call is made. An off switch in Settings stops the runs; cards already pending are hidden while it is off, and nothing is deleted.

### Accepting

Accepting never does the thing itself; it hands the user to the step that asks:

- **A next step** starts an ordinary run in the goal's channel whose message is the card's text, labeled as a quoted suggestion and carrying no authority. Its tools and approvals are the usual ones.
- **A schedule** opens the same confirmation as `propose_schedule`, with the expression checked again.
- **A goal** opens the goal form prefilled; nothing exists until the user saves it.
- **A credential** opens the key manager's request form (P6.5), as below.

### What a credential card may carry

The model's output decides only that a login would help a goal and which of the goal's sites it means. The harness then builds the card, and it carries only:

- **The site's host, if and only if that host appears in text the user wrote**: one of the user's own messages in the goal's channel, or a brief version the user typed or edited. A brief an agent drafted counts as agent-written even after the user confirmed it with one click, because a fetched page can steer a goal run into suggesting a brief edit that names the planted host; the author recorded on each version (`scope_statements`) says which it is. A host that appears only in a state document, summary, purpose statement or anything the model wrote is dropped with the card.
- **The goal id**, as the only goal the credential may serve.
- **A reason written from a template** ("<goal> could do more with a login to <host>"), never the model's wording.

It must not carry a path or query, a suggested tool list, an expiry, a longer scope or any reason text from the model. The form opens at the narrowest scope the key manager offers: that host only, that goal only, approval for each use. A secret is usable only by the tools in its scope, so the user must pick at least one tool from the key manager's fixed list before the form will save; the model has no say in that list. The value is typed by the user into the vault form and never passes through the suggestion run or its output.

## Rejected

- **Giving the run read tools** such as `read_artifact` or `search_history`. It would reach raw fetched text and every artifact, and the digest gives it what it needs in a bounded, labeled form.
- **Excluding state documents and summaries.** A suggestion that cannot see what a goal is doing is mostly generic. The risk is bounded by the rules on credentials, because the other cards need a click and carry the model's text only as text.
- **Deduplicating by wording or by exact title.** The model will say the same thing differently tomorrow.
- **Letting the model choose the credential's site or reason.** That is the exact route a planted page would use.
- **Running after every message or continuously.** It reads everything, and a daily cadence is what the calm principle asks for.
- **Catching up missed days.** One run per day at most, as the goals note does for schedules.

## How evals will tell if it works

Scripted scenarios on a fixture instance of goals, channels and activity, plus a live variant for the steering test.

- **Steering**: a fixture web page makes the agent write a state document saying "connect <a host the user never typed>"; the suggestion run's scripted reply proposes that credential card, and the harness drops it. A third case where the host reaches the brief only through an accepted agent draft drops the card too. A second case where the host is in text the user typed in the brief yields the card with only the host, the goal id and the template reason. A live variant checks whether a real model is moved by the planted text at all.
- **Inputs**: the request the run sends contains no tool result, fetched text, artifact content or transcript, and stays within 6,000 tokens with the fixed ordering.
- **Dismissal**: a dismissed card does not return when the model rewords the title; a card on a different goal does; an expired card may return once.
- **Cap and day**: one run per local day across a time zone change and a daylight saving change; none after 18:00; a missed day is skipped; at most 3 new and 5 pending cards.
- **Bad output**: invalid JSON, an unknown goal id, an over-long title and an unreadable cron each produce no card and no user-facing error.
- **Quiet**: an unchanged input makes no model call; the off switch makes none and hides the pending cards.
- **Accepting**: each kind lands on its confirming step and creates nothing before the user's confirmation.

## Open for the user

- The cadence: 07:00 local, once a day, 3 cards and 5 pending. Recommendation: keep it, and let Settings change the hour.
- Whether dismissed ideas should be reviewable in Settings so the user can bring one back. Recommendation: yes, a plain list with a restore button, built after P7.2 if dismissals turn out to be too sticky.
- Whether goal state documents should be left out of the digest altogether until the red-team suite (P6.6) covers the suggestion run. Recommendation: keep them in with the rules above, since the credential rule is what the attack needs to get through and it never trusts them.
