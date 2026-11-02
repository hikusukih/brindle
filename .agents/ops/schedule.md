# Schedule

Only the clock starts sessions. Each scheduled task keeps its own copy of its prompt; the file named here is the text to paste. The expressions use the time zone set in the task configuration, which this repo does not record.

- brindle daily box (`daily-box-prompt.md`): every morning, working boxes for up to 4 hours.
- brindle planning (`planning-prompt.md`): once a day, after the daily box.
- usage maximizer (`usage-maximizer-prompt.md`): Wednesday evening, working boxes until 23:30.
- Brindle PR Review Task (`pr-review-prompt.md`): a GitHub trigger on PRs being opened, plus a daily run after the daily box that re-reviews PRs with new commits. The task editor offers no trigger for new pushes, and agents can't start a task made in the editor.

When a task's prompt changes, change its file in the same PR, so the repo keeps the text to paste, and update the installed task the day the PR merges. Prompts name files through `CLAUDE.md` (such as "the plan where CLAUDE.md says it is") rather than by path, so a moved file doesn't break an installed task.

The slots design, with two box workers an hour and two planner runs a day, was never installed and is retired (`.agents/design/slots.md`).
