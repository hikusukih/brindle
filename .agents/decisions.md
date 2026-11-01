# Process decisions

How agents are managed here: sessions, the plan, scheduling. Product decisions are in `docs/decisions.md`. Same rules as there: open questions first with a recommendation, settled decisions below with the reason.

## Open

None.

## Settled

- Work happens in Claude Code on the web sessions, which push a branch and open a PR. Sessions never merge their own PRs. A later session may merge a box PR of code or UI work once it has no conflict, green checks, no open questions and 4 quiet hours (`CLAUDE.md`, Merging box PRs), so the queue doesn't stall on the user for work CI can judge. The user still merges design notes, review boxes, `[plan]` proposals, decision PRs and anything labeled `needs-careful-review`, because those are where the user reviews ideas. Later sessions also fix the findings of a `needs changes` review on ready box PRs, since the session that built the box has ended and the user would otherwise be the only one to act on it. Merging right away by the session that did the work was rejected: no one but CI would see the code before `main`, and the user would have no window to stop it.
- The plan lives in this repo (`PLAN.md`), not anywhere else.
- The plan changes through `[plan]` proposal PRs kept apart from box work, so an idea that turns up mid-box is recorded and offered, not acted on or lost when the session ends. Each phase ends with a review box.
- Scheduled sessions work the queue unattended, started only by the clock (`docs/design/slots.md`): two box-worker tasks an hour, offset by half an hour, from 07:00 to 10:30 on most days and from 00:01 to 22:31 on Wednesday, plus two planner runs a day. The window follows the clock, not the provider's five-hour window, and the time zone lives in the task configuration. The old daily box task and Wednesday evening task are disabled the day the new tasks go on. Whether scheduled and interactive sessions share a usage meter doesn't change this: the aim is to use more of the allowance than before, not all of it. Boxes have stable IDs and explicit needs, and a pushed `box/<ID>` branch is the claim, so sessions never take the same box. GitHub Issues were rejected: the plan would live in two places, and plan changes would stop showing up as PR diffs.
- The planner runs twice a day: a morning session reviews the day's area of the code base, and a session hours later proposes one feature or fleshes out an existing one. Both share a cap of 3 open `[plan]` PRs. Each starts by reading new comments on open PRs and answers every one with an action or a recorded deferred action, so no comment is left open. The planner runs on Opus or better, and on Fable only when there is spare promotional usage; the model is set in the task configuration.
