# Daily box prompt

The stored prompt for the **brindle daily box** scheduled task, as installed. It runs every morning, in the time zone set in the task configuration, on Sonnet. Paste everything below the rule into the task; keep the text free of angle brackets, which the task editor strips.

---

Work the Brindle queue as CLAUDE.md describes, taking boxes one after another for up to 4 hours. This prompt overrides CLAUDE.md's "take one box" default.

Time: your very first command is `date -u +%s`; note it as your start. Before starting each box, run `date -u +%s` again. Start no new box once 3 hours have passed, and by 4 hours stop with every open PR's description current. Stop sooner if usage runs out.

Boxes: read CLAUDE.md and .agents/PLAN.md on origin/main. For each box (resuming a cut-off one first if there is one, then the topmost free box by CLAUDE.md's rules) use its own box/ID branch from origin/main and its own PR, land it the way CLAUDE.md says, and file the proposals it turned up before starting the next box. Re-fetch origin before each box, since the plan and the claims change as you work and other sessions may be running. After each fetch and before choosing a box, handle ready box PRs as CLAUDE.md's step 1 says: address review findings ("Addressing reviews"), then merge any that qualify ("Merging box PRs"). Never merge a PR you opened or worked on in this run; then fetch again. A box whose PR is waiting on the user does not block the next box unless the next box needs it.

When no box is free (all claimed, checked, or blocked by needs), switch to analysis and planning for whatever time remains. Change no code. Read .agents/PLAN.md, docs/architecture.md, docs/decisions.md, .agents/decisions.md, docs/design/, the merged history, open PRs and closed-unmerged PRs, and look for: gaps between the architecture and the plan, boxes that are missing a need or are too big for one session, open questions in the decisions files that could carry a recommendation, harness-behavior boxes that lack a design note box, and risks the eval scenarios do not cover. Turn each finding into its own `[plan]` proposal PR exactly as CLAUDE.md's Proposals section says (own plan/short-name branch, one idea per PR, only the files CLAUDE.md lets a proposal touch, new box IDs found with the fetch-and-grep recipe, and never check, delete or renumber a box). Quality over quantity: file at most 5 proposal PRs per run, skip any idea that duplicates an open proposal or one the user already closed (unless something new turned up, and say what), and say in each PR what evidence you found rather than just asserting it. Proposals do not count as boxes.

Your final message lists each box ID with its PR link, the proposal PRs filed, every PR whose review you addressed, every PR you merged, whether you ran out of boxes or out of time, and anything waiting on the user.
