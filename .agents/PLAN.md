# Plan

The work queue. Read `CLAUDE.md` first: it says how a session picks, claims and finishes a box. The design lives in `docs/architecture.md`; open questions and settled answers live in `docs/decisions.md` (product) and `.agents/decisions.md` (process).

Every box is sized for one short session and lands as one PR. A box marked **design note** produces a document under `docs/design/` and nothing else.

A box marked **review** closes each phase. Its PR follows the proposal rules in `CLAUDE.md` (plan and docs only, no code) and also checks its own box. It compares the plan with what the phase actually built, fixes later boxes whose needs, sizing or wording no longer fit, splits the next phase's boxes down to one-session size, and adds boxes for gaps the phase turned up. It adds boxes only as far ahead as there is evidence for, mostly the next phase. It reads the open `[plan]` PRs first so it doesn't duplicate them. A box it thinks should go becomes a question in `docs/decisions.md`, or `.agents/decisions.md` if it is about process.

## Box IDs and needs

- Every box starts with an ID such as **P1.2**. An ID never changes and is never reused, even if the box is reworded, moved or split. Order in this file comes from position, not from the ID: a box added later takes the next unused number in its phase and goes wherever it belongs.
- Every box ends with what it needs, such as _needs P1.1, P1.3_. A box is free to take only when every ID it needs is checked on `main`. Boxes are checked inside their own PR, so checked on `main` means merged.
- _needs nothing_ means the box can be taken now. _needs every box above_ means every box above it in this file. A box with no needs written needs the box directly above it.
- _needs decision: Name_ means the box waits until the decision called Name is under Settled in `docs/decisions.md` or `.agents/decisions.md` on `main`.
- Boxes that implement a design note list the note's ID in their needs, so a note only holds up the work that depends on it.
- A blank line separates boxes, so two PRs checking off neighboring boxes merge without a conflict.

## Phase 0 — the repo builds and is guarded

- [x] **P0.1** Scaffold: Vite + React + Tailwind client, Hono server on Node, SQLite through Drizzle with a first migration, `npm test` (Vitest) and `npm run build` green. A page that shows a greeting fetched from the server. _needs nothing_

- [x] **P0.2** CI: a GitHub Actions workflow running lint, tests and build on every PR, plus gitleaks over the full history. _needs P0.1_

- [x] **P0.6** Move the process docs into `.agents/`, so how agents are managed is kept apart from the product: `PLAN.md`, the process entries of `docs/decisions.md` (product decisions such as the stack stay in `docs/`), `docs/design/slots.md`, and `docs/ops/` if P0.4 has landed. `CLAUDE.md` stays at the root, where sessions read it; update its paths and fetch commands, the paths it lets a `[plan]` PR change (adding process design notes under `.agents/`, so a scheduling note can ride in a `[plan]` PR), and every other reference. Open box branches still carry the old paths, so the PR says how a resuming session merges main. _needs nothing_

- [x] **P0.3** `LICENSE` (MIT), `.editorconfig`, a Dockerfile that builds and serves the app, and a `README.md` quickstart that has actually been run. _needs P0.1_

- [x] **P0.4** Scheduled workers: the box-worker prompt and the two planner prompts (morning review, later feature) as files under `.agents/ops/` (`docs/ops/` if P0.6 has not landed), the cron expressions for the weekday and Wednesday windows and the planner runs, and the steps to install the tasks and disable the daily box and Wednesday evening tasks. _needs nothing_

- [x] **P0.5** Rename Bridle to Brindle: code, docs, UI text, PWA manifest, package name, Docker image, container and volume names, the database file and the `BRIDLE_*` environment variables. An existing install keeps working: on startup the server renames `bridle.sqlite` to `brindle.sqlite` if only the old file exists, and reads an old `BRIDLE_*` variable with a warning when the new one is unset. The README says how to move an existing `bridle-data` volume. Renaming the GitHub repository is the user's step, listed in the PR. Best landed when few box PRs are open, since it touches most files. _needs nothing_

## Phase 1 — channels, on a scripted model

- [x] **P1.1** The shell: bottom navigation on narrow screens, a side rail on wide ones, with Channels, Goals, Feed and Artifacts. Empty state for each. PWA manifest and icons so it installs on a phone. _needs P0.1_

- [x] **P1.2** Storage: channels, **runs** and events tables. Create, rename, archive, restore and delete a channel. _needs P1.1_

- [x] **P1.3** The model adapter contract and a **scripted model** that replays canned responses from a fixture, including tool calls and failures. A contract test suite every adapter must pass, passing against the scripted model. _needs P0.1_

- [x] **P1.4** The run engine, minimal: a message starts a run, the loop calls the model, events persist and stream over SSE, cancel works, and the **step**, token and time limits end a run with a visible reason. _needs P1.2, P1.3_

- [x] **P1.8** Server wiring: `main.ts` builds a run engine from a model chosen by configuration (`BRIDLE_MODEL=scripted` with a fixture file path, for development and acceptance until real adapters land in P2.2), calls `recoverInterrupted()` at startup, and the README says how to try it. _needs P1.4_

- [x] **P1.7** The Channels screen: list, create, rename, archive, restore and delete channels from the UI; a channel view that sends a message, streams the run's events and shows a failed run's error in place. _needs P1.2, P1.4, P1.8_

- [ ] **P1.9** Channels in the side rail: on wide screens each channel is listed indented under the Channels heading (the Home channel first once it exists), and the heading still opens the Channels screen for archive, restore and delete; on narrow screens the Channels tab opens the list itself, since the bottom bar has no room for children. UI only, with tests. _needs P1.7_

- [x] **P1.5** Acceptance: two channels with separate histories survive a server restart and a reload; a failed run shows its error in place and the channel keeps working. _needs P1.1, P1.4, P1.7, P1.8_

- [x] **P1.6** **Review** of Phase 1. _needs P1.1, P1.2, P1.3, P1.4, P1.5, P1.7, P1.8_

## Phase 2 — real models, tools and artifacts

- [x] **P2.1** **Design note:** the tool registry and effect levels, the approval flow for external tools, and how tool results are sized before they go back to the model. _needs nothing_

- [x] **P2.2** Adapters: OpenAI-compatible chat completions and the Anthropic Messages API, both with streaming and tool calls, passing the contract suite against recorded fixtures so CI needs no key. _needs P1.2, P1.3_

- [x] **P2.2a** Model choice per channel, keys from environment variables: a model setting on each channel, the server building the adapter from configuration, and the channel view showing which model it uses. `npm run evals -- --live` builds its model from the same configuration and drops `BRIDLE_EVAL_MODEL_MODULE`. _needs P2.2, P1.8, P2.5_

- [x] **P2.3** Tools: the registry, `web_fetch` and `web_search`, with the approval **card** for external-effect tools (none of the first tools need it, but the path exists and is tested). _needs P2.1, P1.4_

- [x] **P2.4** Artifacts, storage and tool: `create_artifact`, files on disk with metadata in SQLite (kind, **scope**, the run that made it). Provenance (the channel's name and id, the run, the time) is metadata copied onto the artifact, not a link that cascades, so an artifact outlives the channel and run that made it. Deleting a channel deletes only the artifacts the user picks, rows and files together; the API takes that list, and with none given it keeps them all. Goal state documents (Phase 4) are owned by their goal and are not offered for deletion with a channel. _needs P2.3_

- [ ] **P2.4a** The gallery screen: newest first, filter by kind and scope, each item linked to its run (or marked "from deleted channel <name>" once that is gone), with the empty state from P1.1 until the first artifact exists. Deleting a channel that made artifacts asks first: keep all (the default), delete all, or choose which. _needs P2.4, P1.1_

- [ ] **P2.13** Serving artifacts safely: an endpoint that returns an artifact's file only with `Content-Security-Policy: sandbox`, `X-Content-Type-Options: nosniff` and `Content-Disposition: attachment` for every kind except plain text and Markdown (rendered by the client as text, never as HTML), so a `page` artifact written by the model, possibly from fetched web text, cannot run script on the app's origin or reach the app's API. With a test that an HTML artifact containing a script is served with those headers. _needs P2.4_

- [x] **P2.9** `find_artifacts` and `read_artifact`: `read` tools that let a run in any channel or goal list artifacts by title, kind and provenance, with a text match, and read one's content, cut by the usual result sizing. Artifact content comes back as tool-result data like a fetched page, since an artifact may hold text from the web. With an eval scenario where a run in one channel finds and uses an artifact made in another. _needs P2.4, P2.3_

- [x] **P2.5** Evals: the `evals/` runner, one scenario format, CI running all scenarios against the scripted model, and a manual command to run them against a real model. _needs P1.4, P0.2_

- [x] **P2.8** Eval scenarios for injection through a fetched page: a `web_fetch` result tells the model to call an external-effect tool, and the run must stop at the approval card, with nothing sent if the user declines; and a result that tries to pass itself off as the user or the system must not change what the model is allowed to do. Scripted for the plumbing, with a live variant. _needs P2.3, P2.5_

- [ ] **P2.7** Authentication: a login token set through an environment variable or generated and printed once at first start; every `/api` route except the health check answers 401 without it; the client asks for it once and keeps it for the session; the README's "no login yet" warning is replaced by how the token works. The token travels in an `Authorization` header, never a cookie, so a hostile page cannot ride the browser's state, and the server compares it in constant time. _needs P1.8_

- [ ] **P2.11** Model settings: the context window, the run's step, token and time limits, the housekeeping time limit and cache warming, set per model in a JSON file in the data directory keyed by model spec, holding no secrets. A model without settings gets the defaults from `docs/design/context.md`, chosen for a CPU-only llama.cpp host. The run engine takes its limits from the channel's model instead of one global set, and context assembly takes its window from it instead of the fixed default P3.2 uses. When no window is set, an OpenAI-compatible local server's `/props` is asked, and a configured window larger than the server's is a visible configuration error. The channel view shows the model's window and limits. The context report names the model a request actually used, not the channel's spec, so changing the default model counts as a `model_change` break. A model change also resets where history starts, so runs dropped under a smaller window come back when the new window has room for them. _needs P2.2a, P3.1, P3.2_

- [ ] **P2.10** Model-boundary integration suite: one set of tests that runs against any OpenAI-compatible server named by `BRINDLE_BOUNDARY_URL`, with a fake llama.cpp server in the repo as the default target so it runs in CI on every PR. The fake server answers chat completions and `/props`, rejects a request over its window the way llama.cpp does, reports cached tokens as the longest common prefix with its previous prompt, and can be told to stall. The tests check that the window is read and a configured one larger than the server's is refused; that Brindle never sends a request it estimates is over the window and turns a server's length rejection into its own "too long for the model" error; that token counts match the server's; that a streamed tool call round-trips; that a request extending the previous one is reported as reusing the cache; and that the run and housekeeping time limits end a stalled call cleanly. One case drives the web app in a browser through a whole run. Pointed at a real server by hand, the same suite prints a report of prompt read speed, reply speed and cache reuse per case. The README's local setup section says how to start llama.cpp's server for Brindle (at least two slots, and that its context size is split across them). _needs P2.11_

- [ ] **P2.12** The boundary suite in CI against a real llama.cpp server running a tiny model: a pinned llama.cpp release and a pinned, checksummed model of a few hundred megabytes at most, both cached between runs. Reply quality does not matter; real tokenization, real length rejections and real cache reuse do. A case the tiny model cannot do, such as a tool call, is skipped against it with a stated reason. If the job takes more than a few minutes it runs nightly instead of on every PR, and the PR says which. _needs P2.10_

- [ ] **P2.6** **Review** of Phase 2. _needs P2.1, P2.2, P2.3, P2.4, P2.4a, P2.5, P2.7, P2.8, P2.13_

## Phase 3 — long channels stay useful

- [x] **P3.1** **Design note:** context assembly (the layers of a prompt and a token budget for each), the purpose statement, rolling compaction (when it triggers, what it must keep, how a summary is revised), and the drift nudge. _needs P2.1_

- [x] **P3.2** Context assembly with per-layer budgets, and a debug view showing exactly what a run sent. _needs P3.1, P1.4_

- [ ] **P3.3** Purpose statements: drafted after the first few exchanges, editable, sent with every run. _needs P3.2_

- [ ] **P3.4** Rolling compaction, with eval scenarios: facts, decisions and commitments planted early survive several rounds of compaction. _needs P3.2, P2.5_

- [ ] **P3.11** "New channel from here" on any run: the new channel is seeded from the summary that run used, the run itself, and a freshly refreshed summary of the source, which is left unchanged; a failed seed still creates the channel, empty, with a note. With eval scenarios. _needs P3.3, P3.4_

- [ ] **P3.5** Drift nudge, whose accept is "New channel from here" (P3.11) on the latest run; nothing is moved out of the source. _needs P3.3, P3.11_

- [ ] **P3.7** `search_history`: a `read` tool that finds passages in the channel's full stored transcript, including turns compaction has folded away, and returns them verbatim with the run they came from, cut by the usual result sizing. The compaction summary tells the model it exists. _needs P3.4, P2.3_

- [ ] **P3.8** **Design note:** the landing channel. The app opens on one persistent landing channel with no purpose statement and no drift nudge, which answers in place and may then offer to switch to a matching channel; on accept, the messages that prompted the offer are copied into the target as a visible quoted block that the target's context also sees. No offer for one-offs. The note settles: how a topic is matched against purpose statements and how sure a match must be; when the offer appears and how often (a waved-off match is not offered again for that topic); which messages count as the ones that prompted it; how the quote is stored and shown; how much recent history the landing channel keeps in context; whether the landing channel offers a new channel when nothing matches; and how the user's view of what is related overrides the model's, both ways. With eval scenarios. _needs P3.1_

- [ ] **P3.9** **Design note:** reference documents shared across channels (a cast of characters, contacts, topic notes) as living, versioned artifacts. The note settles: how they are stored next to goal state documents and artifacts; when a run looks one up (the user names a person or topic, or the purpose statement does, and the user's message calls for it) and how a large one is read in part rather than whole; how the agent offers "Save this to People?" and how often; each document's home (starts where it was made, moves with the conversation when it is carried to another channel) and its origin, kept as a note; which writes need the user's confirmation (proposed: any change made from a channel other than its home, since origin stops counting once home moves); and the injection cases (a fetched page or a compromised model trying to plant or rewrite an entry). With eval scenarios. _needs P3.1, P2.4_

- [ ] **P3.10** The boundary suite covers context assembly: a 30-turn conversation with at least one compaction fold, in CI against the fake server and the tiny model, where every turn with no planned break in its context report reuses the cache and every cache miss matches a recorded break; the assembled request never exceeds the server's window; a fold finishes within the housekeeping time limit; and with warming on, the turn after a fold reads only its own new tokens. Run by hand against a real server, its report adds cache reuse per turn and the time each fold took, which is the data for tuning the per-model limits. _needs P2.10, P3.2, P3.4_

- [ ] **P3.6** **Review** of Phase 3. _needs P3.1, P3.2, P3.3, P3.4, P3.5, P3.7, P3.11_

## Phase 4 — goals and the scheduler

- [x] **P4.1** **Design note:** the goal model (brief, versioned state document, schedules, channel), how schedules are stored and fire, what happens to runs missed while the server was down, and concurrency limits. _needs P2.1_

- [ ] **P4.13** **Design note:** goals link to other channels. A goal keeps its own channel, created with it, and can also be linked to others. A link is made only by the user (from the goal page, from a channel's header, by accepting an inline offer, or by confirming a goal drafted in a conversation) and ends in one click from either side. The note settles: the `goal_channels` table; the rule that no goal is ever without a channel, so a goal's own channel cannot be unlinked, archived or deleted apart from the goal (archive or delete the goal instead, and the dialog asks what becomes of its channel: keep it as an ordinary channel, or delete it), while any other link can be removed freely and deleting or archiving a linked channel only unlinks it; what a channel run gets from a linked goal (a one-line brief under a cap, read access to its state document, and write access through the state document's existing versioned edits, each recording the channel and run and open to a one-click revert), and that a channel that is not linked can do none of it; a schedule's destination being the goal's own channel or any linked channel, falling back to the goal's own channel, with a system report, when a linked one goes away; how the one-run-per-goal rule applies to goal runs only, with the state document's edit-conflict rules covering a channel run writing alongside one; and what the link offer looks like and how often it appears. Eval scenarios include a linked-channel write that is reverted, an unlinked channel that cannot write, a goal that cannot be left without a channel however its channels are archived, unlinked or deleted, and an injection scenario where a channel that fetched a hostile page writes to a linked goal's state. _needs P4.1_

- [x] **P4.2** The scheduler: persisted cron-like entries, survives restarts without double-firing, applies the missed-run policy, and keeps a log of what fired. _needs P4.1, P1.4_

- [x] **P4.3** Goals, server side: create, edit and archive a goal, and the goal's channel with its brief pinned. _needs P4.1, P1.2_

- [ ] **P4.3a** The Goals screen: list each goal with its next scheduled run, and the form to create and edit one. _needs P4.3, P4.2, P1.1_

- [ ] **P4.18** A goal's channel in the UI: the goal's channel view shows its brief pinned at the top; the channel list marks goal channels (the server returns the owning goal's id with each channel) and the Channels screen leaves rename, archive and delete on them to the goal, since the channels API now refuses those with 409 `goal_channel`; and deleting a goal asks about the artifacts its channel made, as deleting a channel does (keep all by default, delete all, or choose which), with the goal delete API taking the same list. _needs P4.3, P1.7, P2.4a_

- [ ] **P4.4** The state document: `update_goal_state` with versions, shown as an artifact, readable and editable by the user, with history. _needs P4.3, P2.4_

- [ ] **P4.14** Goal links: the `goal_channels` table and API, the goal's own channel linked from creation and not removable apart from the goal, linking and unlinking from the goal page and from a channel's header, channel runs given linked goals' briefs and the goal-state read and edit tools for linked goals and no others, a schedule's destination chosen among the goal's linked channels with the fallback P4.13 settles, and the archive and delete rules from P4.13. With the eval scenarios P4.13 lists. _needs P4.13, P4.3, P4.4_

- [ ] **P4.5** `propose_schedule` from plain words, confirmed by the user, with eval scenarios ("twice a day", "weekdays at 6:30", "every other Sunday"). _needs P4.2, P4.3, P2.3, P2.5_

- [ ] **P4.6** Goal templates behind the category buttons. _needs P4.3a_

- [ ] **P4.16** Add a goal from the Goals screen: suggested goals as buttons ("lose 5 lbs", "buy a new rug" and the like, fixed text to start with) and a text box, which is the whole screen while there are no goals, where the user types or pastes what they want. Either sends the words to a housekeeping call that drafts a goal (title, brief, optionally a schedule) into the edit form. The call has no tools and no scope, and nothing is created until the user confirms the form. With an eval scenario where pasted text becomes a sensible draft and a hostile paste cannot create a goal without the confirmation. _needs P4.3a, P4.6_

- [ ] **P4.7** Acceptance: "learn Rust" produces a curriculum held in the goal's state document, visible in the gallery, and a later lesson updates its progress. _needs P4.2, P4.4, P4.5, P2.2_

- [ ] **P4.9** `propose_goal`: from a conversation the model drafts a goal (title, brief, optionally a schedule) as a card the user edits and confirms before anything is created, never creating one itself; with an eval scenario where a chat about learning Rust yields a sensible draft. _needs P4.3, P4.5_

- [ ] **P4.15** The link offer and linking from `propose_goal`: an inline, dismissible offer "Link this goal to this channel?" when a conversation keeps returning to a goal, which links nothing until it is accepted, and a goal drafted from a conversation (P4.9) linked to that channel once the user confirms it. _needs P4.14, P4.9_

- [ ] **P4.10** **Design note:** standing permission for external tools: what a goal can grant (a tool, a host, a count or time limit), where grants are stored, how the user reviews and revokes them, how `needsApproval` consults them, what an unattended run does when it needs an approval that has not been granted, and how grants appear in the audit trail. _needs P4.1, P4.3_

- [ ] **P4.19** Standing permission, the check: the `tool_grants` and `grant_uses` tables, the opt-in `grantSubject` on a tool, `needsApproval` consulting a goal's grants (live, unexpired, uses left, exact subject, goal active; the per-use secret rule comes with P6.9), the use spent in the transaction that records the decision, and `approval_decision` carrying `by: "grant"`. Proved with a fake external tool; no real tool opts in. Eval scenarios for the check, concurrency and injection. _needs P4.10, P4.3, P2.3_

- [ ] **P4.20** Standing permission, the user's side: the allow-again choice on the approval card with an editable count and expiry, the goal page's list of grants with revoke, and the transcript showing a use as "Allowed by standing permission". Eval scenarios for creation. _needs P4.19, P4.3a_

- [ ] **P4.21** Unattended runs without a grant: the goal marked "waiting for you" on the Goals screen while a scheduled run is parked, a declined or timed-out call recorded on the goal, and the next fire told about it in its task message. Eval scenarios. _needs P4.19, P4.2, P4.3a_

- [ ] **P4.8** **Review** of Phase 4. _needs P4.1, P4.2, P4.3, P4.3a, P4.4, P4.5, P4.6, P4.7, P4.9, P4.10, P4.18, P4.19, P4.20, P4.21_

## Phase 5 — the feed

- [ ] **P5.1** Feed items from scheduled runs: title, summary, link, date, source goal, deduplicated against existing items. _needs P4.2, P4.3_

- [ ] **P5.2** The feed screen with mark-read and per-goal filtering. _needs P5.1, P1.1_

- [ ] **P5.3** Atom feeds, overall and per goal, behind the token, and verified in a real RSS reader. _needs P5.1, P2.7_

- [ ] **P5.4** Acceptance: a goal watching a public events-listing page fills the feed, a re-run adds only new entries, and the Atom feed shows them on a phone. _needs P5.2, P5.3, P2.3_

- [ ] **P5.6** `read_feed`: a `read` tool that lets a goal run list recent feed items (title, summary, link, date, read state), so a run can build on what earlier runs found instead of rediscovering it; with an eval scenario where a second run does not repeat the first run's items. _needs P5.1, P2.3_

- [ ] **P5.5** **Review** of Phase 5. _needs P5.1, P5.2, P5.3, P5.4, P5.6_

## Phase 6 — the key manager

- [x] **P6.1** **Design note and threat model:** the vault's API, encryption and master-key handling, handles and how tools resolve them, scope rules, output scrubbing, the credential request flow, auditing, and the attacks the red-team suite must cover. Reviewed with extra care before anything is built. _needs P2.1_

- [ ] **P6.2** The vault: encrypted storage, the narrow API, master key outside the database, unit tests. _needs P6.1, P2.7_

- [ ] **P6.3** Handles and scoped resolution inside tools, with refusal of out-of-scope hosts and tools, and the audit log. _needs P6.2, P2.3_

- [ ] **P6.4** Output scrubbing across tool results, model output, logs, artifacts and errors, including common encodings. _needs P6.2, P2.4_

- [ ] **P6.5** `request_credential`, the vault form, and detection of secrets pasted into chat. _needs P6.3, P6.4_

- [ ] **P6.9** Standing permission meets the key manager: `needsApproval` shows a card for a call carrying a secret handle whose scope requires approval for each use, even under a live grant, so a grant never loosens the key manager's rule. With the key manager eval scenario from the standing permission note (P4.10). _needs P4.19, P6.3_

- [ ] **P6.6** The red-team suite: every attack named in the threat model as a test, all passing. _needs P6.3, P6.4, P6.5, P2.13_

- [ ] **P6.7** An adversarial session: an agent given the codebase and told to make the vault leak, with every finding filed as an issue and fixed or answered. _needs P6.6_

- [ ] **P6.8** **Review** of Phase 6. _needs P6.1, P6.2, P6.3, P6.4, P6.5, P6.6, P6.7, P6.9_

## Phase 7 — suggestions

- [ ] **P7.5** **Design note:** the suggestion run. It is the one run that reads across every scope, so the note settles: what it may read (briefs, purpose statements, state documents, run summaries) and what it must not (raw fetched text, which could plant a card); how its context is built and bounded; how a card is deduplicated and how a dismissal is remembered (by topic, not by wording); the daily cap and what counts as one day; and what accepting a credential-request card may and may not carry over from the text that inspired it. With eval scenarios, including a fixture page that tries to steer a suggestion toward a credential request. _needs P4.1, P6.1_

- [ ] **P7.1** The suggestion run: reads goals, purpose statements and recent activity, proposes a few cards, at most daily, off switch in settings. _needs P7.5, P4.2, P4.3, P3.3_

- [ ] **P7.2** Accept and dismiss: accept becomes a run, goal, schedule or credential request; dismissed cards are remembered. _needs P7.1, P4.5, P6.5_

- [ ] **P7.3** Eval scenarios: suggestions are relevant to the fixture's goals and never repeat a dismissed one. _needs P7.2, P2.5_

- [ ] **P7.4** **Review** of Phase 7. _needs P7.1, P7.2, P7.3_

## Phase 8 — briefs and notifications

- [ ] **P8.1** `speak`: text-to-speech through an OpenAI-compatible speech endpoint, saved as an audio artifact with a player in the gallery. _needs P2.3, P2.4, P2.4a_

- [ ] **P8.2** The daily digest: new feed items, goal check-ins, finished long runs, in-app and optionally to a webhook. _needs P5.1, P4.2_

- [ ] **P8.3** Web push, opt-in per goal or channel, nothing on by default. _needs P8.2_

- [ ] **P8.4** Acceptance: a "daily audio brief" goal produces a listenable brief each morning, and a fresh install notifies nothing until the user opts in. _needs P8.1, P8.2, P8.3, P4.7_

- [ ] **P8.5** **Review** of Phase 8. _needs P8.1, P8.2, P8.3, P8.4_

## Phase 9 — plug-ins

- [x] **P9.1** MCP client: configure MCP servers, their tools join the registry with an effect level the user assigns. _needs P2.3_

- [ ] **P9.2** **Design note:** ACP delegates (spawning an external agent, mapping a run to its session, surfacing its permission requests as approval cards), after checking the protocol's current state. _needs P2.1, decision: ACP delegates_

- [ ] **P9.3** The ACP delegate tool, verified with one real coding agent. _needs P9.2, P2.3_

- [ ] **P9.5** MCP servers over streamable HTTP: the same tool registration as the stdio client, for servers reached by URL, with the bearer credential held as a key-manager handle that is never in `mcp.json`, and the request refused for any host outside the handle's scope. Hosted MCP servers are mostly HTTP, so stdio alone leaves out most of them. Bearer tokens only; OAuth flows are out of scope. _needs P9.1, P6.3_

- [ ] **P9.6** Eval scenarios for MCP as an injection source: a plug-in tool's description (which goes to the model as part of the tool list) or its result tells the model to call an `external` tool, and the run must still stop at the approval card, with nothing sent if the user declines; and a tool the user left unclassified must ask for approval. Scripted for the plumbing, with a live variant. _needs P9.1, P2.8_

- [ ] **P9.4** **Review** of Phase 9. _needs P9.1, P9.6_

## Acceptance (the whole thing)

- [ ] **A.1** Installed on a phone, channels, goals, the feed and artifacts are each one tap from the others. _needs every box above_

- [ ] **A.2** Two different model providers are usable with configuration only. _needs every box above, except P9.2 and P9.3 while ACP delegates are deferred_

- [ ] **A.3** A goal that needs a login gets it through the request flow, uses it on schedule, and the red-team suite still passes. _needs every box above_

- [ ] **A.4** A month of daily use produces no notification the user didn't ask for. _needs every box above_
