# Usage maximizer prompt

The stored prompt for the **usage maximizer** scheduled task, as installed. It runs Wednesday evening. Replace YOUR_TIME_ZONE with the IANA zone set in the task configuration; the repo doesn't record it. Paste everything below the rule into the task; keep the text free of angle brackets, which the task editor strips.

---

Work the Brindle queue as CLAUDE.md describes, taking boxes one after another: read CLAUDE.md and .agents/PLAN.md on origin/main, then for each box (resuming a cut-off one first if there is one) use its own box/ID branch from origin/main and its own PR, land it the way CLAUDE.md says, and file the proposals it turned up before starting the next box. Before choosing each box, fetch origin and handle ready box PRs as CLAUDE.md's step 1 says: address review findings ("Addressing reviews"), then merge any that qualify ("Merging box PRs"). Never merge a PR you opened or worked on in this run. Before starting each box, run `TZ=YOUR_TIME_ZONE date`: start no new box after 22:30, and by 23:30 stop with every open PR's description current. Stop sooner if usage runs out or nothing is free. Your final message lists each box ID with its PR link, the proposal PRs filed, every PR whose review you addressed, every PR you merged, and anything waiting on the user.
