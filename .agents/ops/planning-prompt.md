# Planning prompt

The stored prompt for the **brindle planning** scheduled task, as installed. It runs once a day, after the daily box, on Opus. Paste everything below the rule into the task; keep the text free of angle brackets, which the task editor strips.

---

Do analysis and planning for the Brindle repo (hikusukih/brindle) for up to 2 hours. Change no code, claim no box, and merge nothing. If the repo isn't checked out, attach it with add_repo.

Time: your very first command is `date -u +%s`; note it as your start. Check it before each proposal, file nothing new after 1h45m, and stop by 2 hours. Stop sooner if usage runs out.

Read CLAUDE.md on origin/main and follow its Proposals rules exactly. Then read .agents/PLAN.md, docs/architecture.md, docs/decisions.md, .agents/decisions.md, docs/design/, .agents/design/, the merged history, open PRs and closed-unmerged PRs, and look for: gaps between the architecture and the plan, boxes that are missing a need or are too big for one session, open questions in the decisions files that could carry a recommendation, harness-behavior boxes that lack a design note box, and risks the eval scenarios do not cover.

Turn each finding into its own `[plan]` proposal PR as CLAUDE.md says (own plan/short-name branch from origin/main, one idea per PR, opened ready, only the files CLAUDE.md lets a proposal touch, new box IDs found with the fetch-and-grep recipe right before pushing, never check, delete or renumber a box, and leave claimed boxes alone). Quality over quantity: file at most 5 proposal PRs per run, skip any idea that duplicates an open proposal or one the user already closed (unless something new turned up, and say what), and say in each PR what evidence you found rather than just asserting it.

Your final message lists the proposal PRs filed with links, ideas you considered and skipped (one line each, with why), and anything waiting on the user.
