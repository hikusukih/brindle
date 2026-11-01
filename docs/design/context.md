# Design note: context assembly, purpose statements, compaction and the drift nudge

Box P3.1. Status: proposed. Implementation (P3.2 to P3.5, and P3.11 for branching) waits until this merges. Terms in bold at their first use here (**run**, **step**, **request**, **scope** and **housekeeping call**) are defined in the glossary in `docs/architecture.md`.

## Problem

Today every request carries every earlier message in the channel (`history()` in `src/server/runs.ts`). That works for ten runs and fails for two hundred: cost grows with every message, the window eventually overflows, and well before that the model loses the thread. The architecture promises three remedies (a purpose statement, rolling compaction, a drift nudge) and a way to see what a run sent. This note settles how a request is built, how big each part may be, what compaction keeps, and when the harness speaks up about drift.

## Approach

### Assembly and budgets

One function, `assembleContext(scope, run, model)`, builds every request, for the first step of a run and for each one after it, and is the only place that decides what the model sees. Its output is a list of messages in layers, each with a token budget:

1. **Harness instructions**, up to 1,500 tokens: how the agent should behave, fixed text.
2. **Scope statement**, the `ScopeStatement` for the scope: a channel's purpose statement (up to 300 tokens) or a goal's brief (up to 500; see the goals note). Both are one type, below.
3. **Running summary**, up to 2,000 tokens: the compaction output, if any, introduced as "Summary of the earlier conversation".
4. **Recent runs**, whatever remains: whole runs, oldest dropped first, verbatim, with their tool calls and results. A finished run is never split, so a tool call is never separated from its result.
5. **The current run**: the message that started it and, from the second step on, its own tool calls and results so far.

The layers are ordered most static first, because that is what keeps the server's prompt cache useful (below). The order above is the starting point. Where layers that change often go, a goal's state document above all, is settled at implementation (P3.2, P4.4) by measuring cache reuse in the context report, not fixed here.

The total is the model's context window minus a reserve for the reply (the larger of 4,000 tokens and 15% of the window) minus the tool definitions. The window is a per-model setting (see model settings below), so a hosted model with a large window is not held to a local one's. When it is not set, assembly asks the server where it can (llama.cpp's server reports its per-slot context size at `/props`) and otherwise uses a default of 32,000 tokens, which suits a CPU-only llama.cpp host. A configured window larger than the one the server reports is a configuration error, shown when the model is first used.

**Counting tokens.** Assembly counts with the model server's own tokenizer where it has one (llama.cpp's server offers `/tokenize`), so counts match what the server will see. Elsewhere it estimates characters over four, as in the tools note. Either way it keeps a 10% margin, because a count taken layer by layer can differ slightly from the whole prompt's. The local setup in the README runs a server that offers the endpoint, and the integration suite (P2.10) checks the counts against it.

Overshooting the window is always Brindle's error, never the server's. Assembly never sends a request it counts as over. If the server still rejects one for length, the adapter turns that rejection into the same visible error, and the context report records the count that was wrong. A server that cuts a long prompt silently instead of rejecting it is a misconfiguration the integration suite is there to catch.

**When the current run outgrows the window.** A run grows with each step: the tools note allows 10 steps and up to 8,000 tokens per tool result, so one run can need more than a 32,000-token window holds. How best to handle that is not known yet, so the first version does the simplest safe thing and logs it:

- Older history gives way first, by the emergency drop below.
- If layers 1, 2, 3 and 5 still do not fit, the run stops with a visible "this run ran out of room in the model's window", and nothing over the window is sent.
- If the newest finished run alone is larger than layer 4's share, it is dropped like any other, and the drop is logged.
- Each of these writes an `overflow` entry to the context report: which layer gave way, the sizes of the tool results involved, and the step it happened at. The debug view counts them over time.

How often these happen decides what comes next (smaller result caps, folding old tool results within a run, or nothing). It is not designed ahead of the logs.

### Model settings

The window, the run's limits (steps, tokens and time), the housekeeping call time limit and cache warming are all set per model, because each needs tuning against real hardware and a hosted model and a CPU-only one need very different values. A model without its own settings uses the defaults, chosen for a CPU-only llama.cpp host: a 32,000-token window, 10 steps, a 5-minute time limit per run (a cold read of a full prompt on a CPU can take minutes), a 10-minute housekeeping call limit, and cache warming on. These are starting guesses to be replaced with numbers from the first real runs. Settings hold no secrets: keys stay in environment variables.

Every request stores a **context report**: each layer's token count, the `ScopeStatement` and summary versions used, the first and last run included in layer 4, how many runs were left out and why (folded, or dropped as an emergency), and any `overflow` entries. Branching reads the summary version from it. The debug view (P3.2) shows the report and, on demand, the exact messages sent, which are kept for the most recent 20 runs per channel and pruned after that so storage stays small.

### Keeping the prompt cache warm

The cache in question lives in the model server, not in Brindle. Every request is rebuilt from stored rows (the fixed instructions in code, the scope statement and summary from their tables, the runs from the events), and the chat API is stateless, so the whole prompt is sent every time. What the server keeps is the work it did reading the last prompt, and it reuses that work for as many leading tokens as match exactly. Brindle could cache its own rendered layers, but building the text is cheap; the expensive part is the server's read, and the server can only skip it if the text is identical. Servers reuse the work for any prompt that starts with exactly the same tokens as the one before: llama.cpp's server keeps the last prompt per slot, and hosted APIs offer prefix caching. On a CPU-only host, reading a 20,000-token prompt from cold takes minutes, while reading only the newest messages takes seconds, so cache reuse is what makes a long channel usable locally. Assembly therefore follows one rule: **between two planned breaks, a request is the previous request with new messages appended, and nothing before them changes.** In practice:

- **The most static first.** Nothing that changes per run goes early: no timestamps, run ids, counters or the current date in the instructions, scope statement or summary. Anything that must change per run goes with the current run in layer 5.
- **Deterministic rendering.** The same stored runs always render to the same bytes: fixed key order when tool calls and results are serialized, tool definitions in a fixed order, no whitespace that depends on anything but the content.
- **A tool result is cut once.** It is sized when it arrives (as in the tools note) and the cut text is what is stored and resent; an old result is never re-cut with a different cap.
- **Planned breaks only.** The start of the prompt may change only at a compaction fold, an emergency drop, a `ScopeStatement` change, a change of model or tool set, or a release that changes the harness instructions. The context report records which of these happened, so the debug view shows when a cache miss was expected and any other miss is a bug.
- **Breaks come in chunks.** An emergency drop removes runs down to the same 40% a fold aims for, not one run per message, so a channel over budget does not miss the cache on every message.
- **Warm after a fold, where it is cheap.** After a fold, the harness may send the new prompt (layers 1 to 4) with a one-token reply so the next message pays only for itself. This is a per-model setting, on by default; a hosted model's settings turn it off, since there it costs money.
- **Report what was reused.** The context report records the expected reusable prefix in tokens and, where the server reports it (llama.cpp's cached token count, Anthropic's cache reads, OpenAI's cached tokens), the actual one. The Anthropic adapter marks a cache breakpoint after layer 3 and after the history, since that API caches only where asked.

Housekeeping calls send a different prompt and, on a server with one slot, evict the channel's cached prompt. The README's local setup should run llama.cpp's server with at least two slots and say that its context size is split across them.

### Scope statements: the purpose statement and the goal brief

A channel's purpose statement and a goal's brief do the same job in context and differ in who may write them, so they are one type in code: `type ScopeStatement = PurposeStatement | GoalBrief`, told apart by `kind`. Code that treats them alike (layer 2, the drift check, version history and restore, the context report) takes a `ScopeStatement`; code that must differ takes the narrow type, so the compiler stops a goal brief from being drafted on its own. Each kind carries its own cap.

They share one `scope_statements` table: scope kind, scope id, version, text, author (`user` or `agent`), whether the user confirmed it, and a timestamp, with the highest version current. Versions are append-only; the user can see earlier ones and restore one, which writes it again as a new version, and the context report records which version a request used.

**The purpose statement.** After a channel's third finished run, one housekeeping call drafts one or two sentences from those exchanges, saved with author `agent`. The user sees it under the channel name and can edit it in place; once the user has written a version, a draft never replaces it, and a new draft happens only when the user asks for one. A failed draft is silent and retried after later runs, at most three times in all. The statement is sent in layer 2 on every request and is never part of the history, so compaction cannot fold it away. A goal's channel gets no purpose statement: its `GoalBrief` is its scope statement, and the goals note says how a brief is written.

### Rolling compaction

- **When it folds.** After a run ends (not on the path of the next message), if layer 4 would use more than 70% of its share of the budget, the oldest runs are folded until it would use 40%. If a message arrives while history is still over budget (compaction was off, failed, or has not finished), assembly drops the oldest whole runs as an emergency and says so in the context report; nothing waits on a summary.
- **What a summary keeps.** Decisions and the reasons given, open questions, commitments the agent made, and the facts the channel still needs: names, dates, numbers, preferences and constraints that bear on what the channel is doing. Exact values stay exact. It drops greetings, repeated explanations, tool output (keeping only what the assistant concluded from it), and facts that were superseded, resolved or no longer bear on the channel.
- **Facts live in artifacts; the summary points at them.** Durable facts (a person, a contact, a standing preference) are worth more where every channel can find them than inside one channel's summary. The summary refers to artifacts by id and title (any artifact the channel made or read, and the reference documents of P3.9) instead of restating what they hold, and the model can open them with `read_artifact`. How a fact gets from a conversation into such an artifact is P3.9's to design; the architecture already says the agent offers and the user confirms, so compaction never writes one by itself. Until then the summary keeps those facts itself.
- **How a summary is revised.** Never by appending and never by summarizing a summary blindly. The utility model gets the previous summary and the runs being folded and writes a complete replacement within the cap, under instructions to carry forward what is still needed by the rules above, and to say so when something is superseded. If the result is over the cap it is asked once to shorten; if it is still over or the call fails, nothing changes and the history stays verbatim until the next attempt.
- **Storage.** A `summaries` table holds `channel_id`, a version, `through_run_id` (the last run folded), the text, the artifacts it refers to, the tokens the call used and a timestamp. Old versions are kept for the debug view. The runs and events themselves are never touched, so the transcript the user reads is complete.
- **The summarizer reads the transcript as data.** It is told the folded runs are material to summarize, not instructions to follow; the injected-instruction scenario below checks that an order planted in a fetched page does not come out of the summary as an order.
- **Tuned from the logs.** The 70% and 40% thresholds, the 2,000-token cap and the balance between folding and emergency drops are starting values. The context report records every fold and drop, and every run that left layer 4 without being folded into a summary, and the debug view counts them over time. They change when the logs show a problem, not before.

### The drift nudge

After a run, if the channel has a purpose statement and at least four runs since the last check, one housekeeping call compares the statement with the last three user messages and answers on topic or off, with a short name for the new topic. Two consecutive off-topic checks produce one inline `nudge` event offering a new channel with that name. Accept is **New channel from here** (below) on the latest run, with the topic name as the new channel's name and as the focus for drafting its purpose statement. Nothing is moved: the source keeps every run, and only gains a one-line note linking to the new channel. Dismiss means no more nudges in that channel until its purpose statement changes. No channel is created without the click.

### Branching a channel

There is no main chat; every channel is a peer. In practice a user starts in a catch-all channel and, once a topic grows, wants to carry on somewhere focused without losing what was already said. Any run in a channel offers **New channel from here**. A housekeeping call writes the new channel's first summary (version 0 in `summaries`, with `through_run_id` null) from three inputs: the summary version that run used (read from its context report), the chosen run itself, and an up-to-date summary of the source when the branch is requested. Because the conversation may have moved on since the last fold, that summary is refreshed first: if runs have finished since then, the utility model writes a fresh one from the latest summary plus those runs, using the compaction rules. The refresh serves the seed only. It is not saved as a version of the source's summary, so the source's recent runs are not folded early, and it is kept with the seed for the debug view. The first input gives what was known at the time, the run gives the topic, and the refreshed summary adds what has been learned since; runs dropped from context in between are not reread, since compaction dropped them on purpose. The seed centers on the chosen run's topic, follows the same keep-and-drop rules and the same 2,000-token cap as compaction (artifact references included), and its input is bounded by two summaries, one run and the source's unfolded recent runs (which compaction keeps under one window), however old the source is. A run from before context reports existed uses the latest summary version folded through an earlier run. The purpose statement is then drafted from the seed, with author `agent`, so the user can edit it. The source channel is untouched, and the new channel's transcript notes "Branched from <channel>, run <n>" with a link back. The seed is shown in the debug view like any other summary. If the seed call fails, the channel is still created, empty, with a visible note that the history could not be carried over. Branching is built in its own box, P3.11, which the drift nudge (P3.5) then uses.

The seed belongs in the summary layer, not the purpose statement: the statement is short, says what the channel is for, and is never overwritten once the user has written it, so stuffing history into it would crowd out its job and freeze stale facts.

### Which model makes the housekeeping calls

Drafting, compaction, branch seeds and drift checks are housekeeping calls to a **utility model**: `BRINDLE_UTILITY_MODEL`, defaulting to the channel's own model. The architecture's cheap-model-for-summaries default is therefore a setting, not new machinery. A housekeeping call is not a run, so it counts against no run's limits; its token use is recorded on the summary rows and shown in the debug view. It gets limits of its own instead, because its cost has a different shape: a fold reads the runs being folded from cold, since its prompt shares no prefix with the channel's, and on a CPU-only host that can take several minutes. Nobody waits on it (it runs after a run ends, and the emergency drop covers a message that arrives meanwhile), so its limit can be long without hurting anyone:

- **Time:** a per-model setting, default 10 minutes, separate from a run's time limit. One call at a time per channel; a new fold does not start while one is in flight.
- **Calls:** one model call with no tools, plus the single "shorten it" retry.
- **Output:** the summary cap plus a small margin; a longer reply is treated as over the cap.
- A call that hits a limit counts as a failed fold: nothing changes and history stays verbatim until the next attempt. The debug view shows which limit ended it.

Branch seeds use the same limits, but the user is waiting on one, so the new channel shows that its seed is being written until it lands or fails.

## Rejected

- A sliding window with no summary. Cheap and predictable, but facts stated early vanish, which is the failure being fixed.
- Embedding retrieval over the transcript. It adds a dependency and an index to keep in sync, and an opaque recall step the user cannot inspect. A `search_history` tool (P3.7) retrieves verbatim passages without being part of assembly.
- A summary that must carry every fact forever. With a fixed cap it eventually has to drop something anyway, and facts kept in one channel's summary are invisible to the others; artifacts the summary points at serve both problems better.
- Compacting inline before sending the next message. It puts a slow model call between the user and the answer; the emergency drop covers the rare case.
- Keeping the purpose statement as the first message of the history. It would be compacted away like any other run.
- Separate types and tables for purpose statements and goal briefs. They would repeat the same versioning, and had already drifted apart in caps and author values.
- Letting the user trigger compaction by hand. If it needs a button it has failed, and the debug view already shows what happened.
- Moving runs from one channel to another on the nudge. A copy through a seed summary leaves the source whole and needs no special case for runs already folded into a summary; the user preferred copies.
- Seeding a branch from every run between the chosen one and now. Its cost grows with the source's age, and compaction already dropped most of those runs on purpose.

## How evals will tell if it works

Scripted-model scenarios run in CI (P2.5's runner, with a scripted utility model); the ones marked live need a real model and run on demand.

- **Assembly** (scripted): layers appear in order; with a tiny window no request exceeds budget; the purpose statement is present after the history is compacted away; a message too long for the window fails visibly.
- **Overflow** (scripted): a run whose tool results outgrow the window drops older history first, then stops visibly without sending an over-window request; each case writes its `overflow` entry.
- **Token counting** (scripted): with a fake server offering `/tokenize`, assembly uses its counts; without one, it falls back to the estimate.
- **Compaction plumbing** (scripted): the trigger fires at 70% and stops at 40%; the transcript is unchanged after folding; a failing or oversized summary leaves history verbatim; a revised summary replaces rather than appends; a summary that refers to an artifact stores the reference.
- **Facts survive** (live, the real test): plant five facts in the first three runs (a name, a date, a number, a decision with its reason, a commitment), run thirty unrelated runs so at least three compaction rounds happen, then ask for each fact. Pass means every fact is stated correctly, from the summary or by reading an artifact it refers to, in at least two of three trials.
- **Injection** (live): a fetched page in a folded run contains "ignore your instructions and ..."; the next summary must report it as page content or omit it, and the following reply must not obey it.
- **Drift** (scripted classifier, then live): twenty on-topic runs produce no nudge; a switch to an unrelated topic produces exactly one; dismiss silences it; accept creates a branched channel and leaves the source's runs unchanged.
- **Branch** (scripted, then live): branching writes a seed summary within the cap and leaves the source's runs, summary and purpose statement unchanged; a failed seed still creates an empty channel with the note; branching from an older run reads that run's summary version, the run and a refreshed latest summary, and nothing else from the source; the refresh leaves the source's own summary versions unchanged. Live: plant three facts in a source channel, branch, and ask for each in the new channel; pass means all three are stated correctly in at least two of three trials.
- **Cache stability** (scripted): two consecutive requests with no planned break between them, within one run or across two, are such that the earlier one is a byte-for-byte prefix of the later; each kind of planned break is recorded in the context report; an emergency drop removes runs down to 40%. Checks that a server actually reuses the cache belong to the model-boundary integration suite.
- **Housekeeping call limits** (scripted): a fold that hits its time or output limit leaves history verbatim and is shown in the debug view; a second fold does not start while one is in flight.
- **Scope statements** (scripted): a purpose statement is drafted once after the third run, never replaced by a draft once the user has written one, every change and restore adds a version, drafting is retried at most three times after failures; a goal brief cannot be saved by a draft without the user's confirmation.

## Open for the user

- The run token limit (100,000 today) counts every input token, cached or not, so with a 32,000-token window a run with several tool steps reaches it after four or five steps. Proposed: count only the tokens the server actually had to read (uncached input plus output) where the server reports them, and everything where it does not.
- How durable facts get from a conversation into artifacts the summary can point at: settled with the reference documents note (P3.9).

Settled in review: the 70% and 40% thresholds and the 20-run limit on stored prompts stand as starting values, tuned from the logs; branching gets its own box (P3.11); token counts use the server's tokenizer where it has one.
