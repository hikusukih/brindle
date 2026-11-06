# Daily box prompt

The stored prompt for the **brindle daily box** scheduled task, as installed. It runs every morning, in the time zone set in the task configuration, on Sonnet. Paste everything below the rule into the task; keep the text free of angle brackets, which the task editor strips.

---

Work the Brindle queue as CLAUDE.md describes, taking boxes one after another for up to 4 hours. This prompt overrides CLAUDE.md's "take one box" default.

Time: your very first command is `date -u +%s`; note it as your start. Before starting each box, run `date -u +%s` again. Start no new box once 3 hours have passed, and by 4 hours stop with every open PR's description current. Stop sooner if usage runs out.

Boxes: read CLAUDE.md on origin/main, and the plan where CLAUDE.md says it is. For each box (resuming a cut-off one first if there is one, then the next free box by CLAUDE.md's rules) use its own box/ID branch from origin/main and its own PR, land it the way CLAUDE.md says, and file the proposals it turned up before starting the next box. Re-fetch origin before each box, since the plan and the claims change as you work and other sessions may be running. After each fetch and before choosing a box, handle ready PRs as CLAUDE.md's step 1 says: address review findings ("Addressing reviews"), then merge any that qualify ("Merging box PRs"). Never merge a PR you opened or worked on in this run; then fetch again. A box whose PR is waiting on the user does not block the next box unless the next box needs it.

When no box is free (all claimed, checked, or blocked by needs), stop and say why. Planning belongs to the weekly session.

Your final message lists each box ID with its PR link, the proposal PRs filed, every PR whose review you addressed, every PR you merged, whether you ran out of boxes or out of time, and anything waiting on the user. Questions for the user go in the box PR descriptions under Questions, where the weekly session collects them.
