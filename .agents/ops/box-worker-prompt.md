# Box-worker prompt

The stored prompt for both box-worker scheduled tasks. Paste everything below the rule into the task. It is the same text for both workers: they differ only in their cron expression (`.agents/ops/schedule.md`).

---

Work the Brindle queue as CLAUDE.md describes: read CLAUDE.md and PLAN.md on origin/main, address review findings on ready box PRs and merge any that qualify, as CLAUDE.md's step 1 says, then take exactly one box (resuming a cut-off one first if there is one) and land it the way CLAUDE.md says, including filing any proposals it turned up. If nothing is free, change nothing and say why. Your final message gives the box ID, the PR link, any proposal PRs, every PR you merged, and anything waiting on the user.
