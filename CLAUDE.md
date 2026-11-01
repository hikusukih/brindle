# Working in this repo

Brindle is a self-hosted personal agent: a harness plus a phone-friendly web app. `docs/architecture.md` is the design, `.agents/PLAN.md` is the work queue, `docs/decisions.md` holds open product questions and settled answers. Process (how agents are managed) lives under `.agents/`: the plan, `.agents/decisions.md` and process design notes such as `.agents/design/slots.md`.

## A session's shape

Sessions are short; they often run on whatever usage is left at the end of a window, and can be cut off. Some are started by hand and some by a schedule, unattended, with no memory of earlier runs. More than one can be running at once. Take one box unless the session's prompt says otherwise. So:

1. **Find free work.** Run `git fetch --prune origin '+refs/heads/main:refs/remotes/origin/main' '+refs/heads/box/*:refs/remotes/origin/box/*'` (the clone may be single-branch on some other branch, so both destinations are spelled out; `+` lets a claim branch that was rewritten update; `--prune` drops claims whose branch was deleted on merge), read `.agents/PLAN.md` on `origin/main`, where the box ID and needs rules are at the top, and list the claimed boxes with `git branch -r --list 'origin/box/*'`. Then, in this order:
   - First address review findings on ready box PRs, as **Addressing reviews** below says.
   - Then merge any box PR that qualifies under **Merging box PRs** below, one at a time, then fetch again: a merge can free boxes. This doesn't count as the session's box.
   - Resume a cut-off box if there is one: a claimed box whose PR is still a draft (or which has no PR at all) and whose branch's last commit (`git log -1 --format=%cI origin/box/<ID>`) is more than 6 hours old. Check out its branch, read the PR description, open the draft PR if it is missing, and carry on. Anything newer may be another session still working; leave it alone.
   - Otherwise take the topmost box that is unchecked, unclaimed, and free by its needs.
   - A claimed box whose PR is ready is waiting on the user, or on a later session to merge it under **Merging box PRs**. A claimed box whose PR was closed without merging was declined; leave it until the user edits the box or deletes the branch.
   - If nothing is free, change nothing and say why in the session's final message.
2. **Claim it before any other work.** The claim is a pushed branch named `box/<ID>` whose first commit is an empty commit only this session has. The environment may start the session on a branch of its own, such as `claude/<random-words>`, and name that as the push target. For box work, `box/<ID>` is the push target instead, and this file is the permission to push it: don't stop to ask. Leave the starting branch unpushed.

   ```
   git switch -c box/P1.2 origin/main
   git commit --allow-empty -m "claim P1.2"
   git push origin box/P1.2
   ```

   If the push is rejected as not a fast-forward, another session claimed the box first: go back to step 1. If it is refused for any other reason (permissions, a branch-name restriction), stop, change nothing else, and quote the error in the session's final message; the claim scheme needs fixing before any box is taken. The empty commit is what makes a race fail; pushing `origin/main` unchanged to an existing branch succeeds silently, so never skip it.
3. **Open a draft PR right away**, titled `[<ID>] <short summary>`, and keep its description current: what's done, what's left, anything surprising, and a **Proposals** list (see below). If the session is cut off, the draft PR is the handoff.
4. Finish with tests and the build green, the box checked in `.agents/PLAN.md` within the same PR, and the PR marked ready. Then file the PR's proposals.
5. Never merge a PR you opened or worked on in this session; merging `main` into its branch doesn't count as working on it. A later session may merge a box PR under **Merging box PRs** below; everything else, the user merges.
6. If a box turns out to need a decision from the user, land that instead of the work: on the box's own branch, add the question with a recommendation to `docs/decisions.md` (`.agents/decisions.md` if it is about process) and add _needs decision: Name_ to the box, leave the box unchecked, and mark the PR ready with a title starting `[<ID>] Decision needed:`. Once it merges, the box waits for the decision to be settled, and the claim goes away with the branch. Then go back to step 1; this doesn't count as the session's box.

If a box turns out too big for one session, split it in `.agents/PLAN.md` within its PR: the part being landed keeps the ID, the rest get suffixed IDs (`P1.2a`, `P1.2b`) that need `P1.2` unless they truly don't. Never renumber or reuse an ID.

## Addressing reviews

The review task posts a comment starting `Brindle review:` on a daily run after the morning box work, for every ready PR that has no review yet or has new commits since its last one (a PR opened ready is also reviewed right away; box PRs open as drafts, so theirs come from the daily run). The session that built a box has usually ended by then, so later sessions act on it.

- Take a ready box PR whose latest `Brindle review:` says `needs changes` and is newer than its last commit other than a `main` merge. Leave `needs your decision` to the user, and leave PRs that aren't box PRs.
- Skip it if it has the `addressing-review` label, unless an earlier session was cut off: take it over if the label was added more than 6 hours ago (the `labeled` event in the PR's timeline) and the branch has no commit since, or if the latest `Brindle review:` is newer than the label, since then the earlier session's push landed and was reviewed. Otherwise add the label before any other work, so two sessions don't fix the same PR.
- Check out its `box/<ID>` branch and merge `main` in if it is behind. Fix each finding that is in the box's scope. For one that isn't, or that you think is wrong, don't widen the PR: say why in your reply, and file a proposal if it is a plan change.
- Commit all the fixes, then, before pushing, reply to the review with one line per finding (fixed, naming the commit, or not fixing and why) and update the PR description: the review task reads those replies when it runs. Push everything as one push, then remove the label. The review task looks again on its next scheduled run.
- This doesn't count as the session's box, and the session never merges a PR it fixed (step 5).

## Merging box PRs

A session may merge a box PR only when every one of these holds; if any is in doubt, leave it for the user. Sessions post on GitHub under the user's login, so a comment counts as the user's only when it doesn't end with the `Generated by [Claude Code]` footer.

- It is a box PR: branch `box/<ID>`, title `[<ID>] ...`, not a draft, and the title doesn't start with `Decision needed:`.
- It is code or UI work. Not a **design note** or **review** box, and the diff touches nothing under `docs/` or `.agents/` except checking its own box in `.agents/PLAN.md`. Not labeled `needs-careful-review`, and nothing under the key manager's code. Those are where the user reviews ideas, so the user merges them.
- No merge conflict, and every check is green on the current head. If the branch is behind `main`, merge `main` into it (never rebase), push, and wait for the checks; that push doesn't restart the quiet period.
- No open questions: no unresolved review thread, every comment from the user has a reply after it, the description lists nothing as left to do or waiting on the user, and every line under **Proposals** is a link to a filed PR. If the PR has a comment starting `Brindle review:`, the latest one says `ready to merge` and is newer than the last commit other than a `main` merge.
- Quiet for 4 hours: no commit other than a `main` merge, and no comment or review other than a `Brindle review: ready to merge`, in the last 4 hours, and it has been ready that long. The user stops a merge with a `hold` label or a comment of their own saying `hold`; it stays stopped until the label is removed or the user says go.
- The diff does what the box says and its own box is checked. If it does something else too, don't merge: comment on the PR saying what, and leave it.

Merge with a merge commit, the way the repo already merges, and delete the branch if GitHub didn't. If GitHub refuses the merge (branch protection, permissions), leave the PR and quote the error in the session's final message. The final message lists every PR the session merged.

## Proposals: changing the plan

The plan changes through proposal PRs, kept apart from box work, so the user can take or leave each idea on its own and no idea rides in with a box's code. A box PR touches `.agents/PLAN.md` only to check its own box or to split it.

- **Record it the moment it turns up.** When the work shows a reason to do something differently (a box that's wrong or missing a need, a better approach, a design note that no longer fits what was built) or suggests a new feature, add a line to the **Proposals** list in the box's draft PR description right away, so it survives a cut-off. Don't change course on the box itself: finish it as written, or land a decision instead if it can't be done as written (step 6).
- **File each one as its own PR** once the box PR is ready, one idea per PR so each can be merged or closed alone. A session that resumes a box files any proposals the earlier session listed but didn't get to.

  ```
  git switch -c plan/<short-name> origin/main
  git commit -am "<summary>"
  git push origin plan/<short-name>
  ```

  Open it ready, not draft, titled `[plan] <summary>`. Its description says what turned it up (which box, what was seen) and what it would change. Then replace the line in the box PR's Proposals list with a link to it.
- **What a proposal may change:** `.agents/PLAN.md`, `docs/decisions.md`, `.agents/decisions.md`, `docs/architecture.md` and process design notes under `.agents/design/`, never code. It can add boxes, reword or move unclaimed ones, change needs, or add an open question with a recommendation. It never checks a box, never deletes one (it proposes dropping it as a question in a decisions file instead), never renumbers, and leaves claimed boxes alone (the suggestion goes in `docs/decisions.md`, or `.agents/decisions.md` for process). A new feature that changes the design gets a line in `docs/architecture.md`; a big one gets a **design note** box rather than a design.
- **New box IDs** take the next unused number in their phase, counting `main` and every open box and proposal branch, so two open proposals don't hand out the same ID. Right before pushing, for phase 2:

  ```
  git fetch --prune origin '+refs/heads/main:refs/remotes/origin/main' '+refs/heads/box/*:refs/remotes/origin/box/*' '+refs/heads/plan/*:refs/remotes/origin/plan/*'
  git grep -h -o -E '\*\*P2\.[0-9]+' $(git for-each-ref --format='%(refname:short)' refs/remotes/origin/main refs/remotes/origin/box/ refs/remotes/origin/plan/) -- .agents/PLAN.md | sort -t. -k2 -n -u | tail -1
  ```

  That prints the highest ID in use; take the next one.
- Proposals don't count as the session's box, and the session never merges them. A proposal the user closes was declined: don't file it again unless something new turns up, and if so, say what in the new PR.

## Supervision: three kinds of change

- **Harness behavior** (context assembly, compaction, the goal model, the scheduler, the tool permission model, the key manager) starts with a **design note** in `docs/design/`, about a page: the problem, the approach, what was rejected and why, and how evals will tell if it works. The note is its own PR. Implementation waits until the user merges it. The user reviews ideas here, not diffs.
- **Implementation** of a merged design note: an ordinary PR with tests and, where the note says so, eval scenarios.
- **UI-only work**: an ordinary PR.

Anything under the key manager's code gets the label `needs-careful-review` and a PR description that names what the change could leak if it were wrong.

## The scrub rule

This repo is public. Nothing in it identifies a real person's machines, network or accounts: no real host names, domains, IP addresses, email addresses, usernames or file paths from anyone's computer. Examples use reserved names (`example.com`, `192.0.2.10`) and obviously fake secrets made of repeating patterns (`sk-test-1234abcd1234abcd`), never realistic-looking random strings. gitleaks runs in CI; it is a backstop, not the rule.

## Writing conventions

- US English.
- Markdown prose is never hard-wrapped: one line per paragraph or bullet.
- No Markdown tables; use bullet lists. Docs here are read as plain text.
- Comments explain why, not what.
- Terms defined in the glossary in `docs/architecture.md` are in bold at their first use in each document, such as **run**, and plain after that. Use them only in the glossary's meaning, so the core terms don't drift between documents.

## Engineering conventions

- Every adapter passes the shared contract suite. Every harness behavior with a design note has eval scenarios.
- Secrets reach the server only through environment variables or the key manager, never through config files in the repo.
- Keep it one process and one package until there is a measured reason not to.
