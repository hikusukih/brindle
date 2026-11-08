# Schedule

Only the clock starts sessions. Each scheduled task keeps its own copy of its prompt; the file named here is the text to paste. Times are America/New_York, which is also the zone set in each task's configuration. A task that starts late, waiting for usage, is fine; the order below is what matters.

A day, in order:

- 5:30 AM, Brindle PR Review Task: reviews what the afternoon box session made ready.
- 6:30 AM, brindle answers: acts on the user's answers from the evening.
- 7:00 AM, brindle box: boxes for up to 4 hours, acting on the early review.
- 11:30 AM, Brindle PR Review Task: reviews what the morning box session made ready.
- 12:15 PM, brindle page: rebuilds the weekly page and files proposals, for up to 2 hours.
- 2:30 PM, brindle answers: acts on the user's answers from the morning.
- 3:00 PM, brindle box: boxes for up to 4 hours.
- Wednesday 6:50 PM, usage maximizer: boxes until 11:30 PM.

The tasks:

- brindle answers (`answers-prompt.md`): 6:30 AM and 2:30 PM, up to 30 minutes, on Opus. The only session that acts on the user's answers on the weekly page: merges what they approved, closes what they closed, posts requested changes and records decisions. It runs half an hour before each box session so the answers are in place when the box session picks its work.
- brindle box (`box-prompt.md`): 7:00 AM and 3:00 PM, boxes for up to 4 hours, on Sonnet. One task with two times; until November 2026 it was brindle daily box and ran only in the morning.
- brindle page (`page-prompt.md`): 12:15 PM, up to 2 hours, on Opus. Rebuilds the weekly page and files proposals within the cap; it never acts on answers. Until November 2026 it was brindle weekly and also acted on answers; it replaced brindle planning before that.
- usage maximizer (`usage-maximizer-prompt.md`): Wednesday 6:50 PM, working boxes until 11:30 PM.
- Brindle PR Review Task (`pr-review-prompt.md`): a GitHub trigger on PRs being opened, plus 5:30 AM and 11:30 AM runs that re-review PRs with new commits. The task editor offers no trigger for new pushes, and agents can't start a task made in the editor.

Why these times: each review lands before the next box session, so a `needs changes` finding is fixed the same day and a clean PR's 3 quiet hours have passed by the next box session, which can merge it. Each answers run lands before a box session, so an approval that frees a box is merged before work is picked. The page rebuild runs after the morning review, so it shows fresh review states, and finishes before the afternoon answers run.

When a task's prompt changes, change its file in the same PR, so the repo keeps the text to paste, and update the installed task the day the PR merges. Prompts name files through `CLAUDE.md` (such as "the plan where CLAUDE.md says it is") rather than by path, so a moved file doesn't break an installed task.

The slots design, with two box workers an hour and two planner runs a day, was never installed and is retired (`.agents/design/slots.md`).
