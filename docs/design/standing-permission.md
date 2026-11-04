# Design note: standing permission for external tools

Box P4.10. Status: proposed. Implementation waits until this merges, and its boxes are filed as `[plan]` proposals once it does. Terms in bold at their first use here (**run**, **scope** and **card**) are defined in the glossary in `docs/architecture.md`.

## Problem

An `external` tool never runs without the user's yes, which is the right rule for a chat and the wrong one for a goal that runs at 6:30 in the morning while the user sleeps: every scheduled run that wants to send, post or buy parks at a **card** nobody sees until it times out. The tools note left one seam for this, `needsApproval(tool, call, scope)`, and deferred the design to Phase 4. This note settles what a goal can be granted, where grants live, how the user reviews and revokes them, how the check consults them, what an unattended run does without one, and how each use shows up afterward. The constraint throughout: a grant must never be something a model, a fetched page or a goal's own text can create or widen.

## Approach

### What a grant is

A grant belongs to one goal and covers one tool and one subject, with a limit:

- **Tool.** Only a tool that opts in can be granted. An `external` tool declares a `grantSubject(args)` function that returns the one thing a grant would be about, derived by the tool's own code from the arguments: the recipient of an email, the host of a request, the account a post goes to. A tool without one cannot be granted and always shows a card. Anything that spends money, deletes, or has no natural subject should not opt in, because a subject cannot bound what it does.
- **Subject.** An exact string, such as `sam@example.com`. A grant for a subject never covers another. A grant always names one exact subject: there is no "any subject" grant, no path creates one without a subject, and the goal's page cannot make one either.
- **Limit.** Both a number of uses and an expiry. The defaults are 20 uses and 30 days, settled; they are instance settings (`grant_default_uses`, `grant_default_days` in the server's settings table, not constants) the user can change before accepting or in settings. A grant with no limit cannot be created from a card; the goal's page can make one after a plain warning.

A grant is created only by a user's click: on the approval card for an `external` call in a goal's run, an extra choice beside Approve and Decline, "Approve and allow this again for this goal", showing the tool and the subject, with the limit editable; or on the goal's page. Every card that offers it says in its own text that this allows the action for an extended period and names the values in force when the card is built, such as "Allow sending to sam@example.com for this goal, for the next 20 uses or 30 days", so the user never has to guess what a click grants. Nothing starts with a grant: none is seeded or pre-enabled on install, on upgrade, or when a tool opts in; a grant exists only after a user's click on such a card or on the goal's page. Which tool opts in first therefore does not matter for safety; the card wording and the absence of pre-enabled grants are the safeguard. The model has no tool for it, and nothing in a brief, a state document, a fetched page or a message can make one.

### Where grants live

A `tool_grants` table: id, goal id, tool name, subject, uses left, expiry time, created time, where it was created (the run and call of the card, or the page), and a revoked time. Deleting the goal deletes its grants. A second table, `grant_uses`, is append-only: grant id, run id, call id, time. Grants are checked only for a run whose scope is a goal; a channel's run never consults one, and a grant for one goal never applies to another.

### How the check uses them

`needsApproval(tool, call, scope)` returns false only when all of these hold:

- the tool is `external` and opts in, and the scope is an active goal (an archived goal's grants are kept but suspended, like its schedules);
- the tool's own `grantSubject(call.arguments)` equals the subject of a grant for this goal and tool that is not revoked, not expired, and has uses left;
- the arguments passed the schema check, and the call has no secret handle whose own scope says each use needs approval (a grant never loosens the key manager's per-use rule; the stricter of the two wins).

It then spends a use in the same transaction that records the decision, before the tool runs, so a call that fails still counts. The call that runs is the stored one, as the tools note already requires. The subject is computed from the stored arguments, never from anything the model says about them.

### What an unattended run does without one

Nothing new is needed beyond the goals note: the run parks at the card, the approval timeout for a scheduled run is 12 hours, and the run then ends as "stopped: approval not given", visibly. Three additions make that usable:

- The card for a scheduled run is marked as waiting on the goal. A blue dot shows on the goal's channel in the channel list and the side rail and bubbles up to the Goals screen, where the goal's tile says "waiting for you", so a user who opens the app finds it without hunting for a run. The Home channel gets no transcript message, since reports do not post into transcripts; it shows the same dot on its entry for the goal, in the place it lists goals that need the user. The dot clears on the same "looked" event as the rule below, or when the card is decided.
- A goal's first run happens at creation. When the user saves a new goal, it runs once at once, as the user's own run in its channel and not as a scheduled fire, using the task prompt of its first enabled schedule, so any `external` call it wants parks as a card while the user is still there, and the allow-again choice can be taken then. The calls need not go through: declining them all is fine, and the run still ends normally. It uses the interactive approval wait, not the 12-hour one, and counts as the goal's one run at a time, so the first scheduled fire waits for it. Goals.md has no run at creation today; this note states what it needs, and the change to goals.md is filed as a `[plan]` proposal.
- A call that timed out or was declined is not asked again by a later fire until the user has looked. Nothing new is stored for this. A fire looks at the most recent run of this goal that holds an `approval_decision` event for the same call. The same call means the same tool and, where the tool has a `grantSubject`, the same subject; a tool without one, which is every tool until one opts in, is matched on its name and its stored arguments, so a different recipient or URL is a different call. If that decision was declined or timed out, and the user has not looked since, the call is not asked again, and the run is told in its task message that the call was not approved and why it stopped, so it can carry on without repeating the question every morning. "Looked" means one of these happened after that decision: the user opened that run or the goal's page, or approved or declined the same call by hand. Because the lookup goes to the most recent run that decided, not to the previous fire, a third fire behaves like the second.
- Nothing pushes a notification. Pushes are opt-in (Phase 8); until then the card waits where the user will see it.

### Review and revoke

The goal's page lists its grants: tool, subject, uses left, expiry, last used and where it was created. Revoke is one tap and takes effect for the next check; a call already approved and running finishes. Changing a grant is revoking it and making a new one, so history stays honest. An expired or used-up grant stays listed, grayed, for 30 days so "why did it start asking again" has an answer on the page.

### The audit trail

Every use is visible where it happened. The run's transcript shows the call as it shows an approved card, with "Allowed by standing permission" and a link to the grant instead of Approve and Decline, in an `approval_decision` event that carries `by: "grant"` and the grant id. `grant_uses` is the same fact seen from the grant's side, and the goal's page shows the latest uses of each grant. Creation and revocation are the rows themselves, with their times.

### What a grant does not do

A grant fixes what tool and which subject, not what is sent. A run that has read a hostile page can still be talked into sending a different message to an allowed address. The limits (a count, an expiry, a subject) bound the damage, the transcript shows every use, and a tool that takes free text to a subject whose risk is its content should not opt in. This is why grants default to a small count and a short expiry, and why the first tools to opt in should be few and chosen on purpose.

## Rejected

- Letting the model ask for a grant, or reading one from a goal's brief. Anything the model or a brief can say is something a page can say; consent has to come from a click.
- A goal-wide "allow everything" or a global grant across goals. One bad run would then have the user's widest permission.
- Approving the exact call again on a schedule. The arguments differ every run, so it would never match, and loosening the match is a grant by another name.
- Learning grants from past approvals. It turns habit into permission without the user deciding anything.
- Counting a use only when a call succeeds. A failing call that retries until it works would spend nothing and give a loop with no bound.
- Notifying on every park. Phase 8 owns notifications, and nothing is on by default.
- A grant for "any subject", behind a second confirmation or not. The user ruled it out: a grant that names no subject cannot bound what a hostile page asks for.
- Deciding in advance which tool opts in first, or shipping the feature with no real opt-in. The user's answer is that the order does not matter while each grant card spells out the extended period and its values, and no grant exists before a click.

## How evals will tell if it works

- **The check** (scripted): a matching, live grant runs the call with no card, writes `approval_decision` with `by: "grant"` and spends one use; a different subject, an expired grant, a used-up one, a revoked one, and a channel's run each show a card; an archived goal's grant does not apply, and does again once the goal is restored.
- **Creation** (scripted): approving a card with the allow-again choice creates a grant with the subject the tool derived, not one typed by the model; no tool or message creates one; no path, including the goal's page, creates a grant without a subject; a fresh install, and a tool newly opting in, have no grants.
- **The card** (scripted): the allow-again text states the extended period and contains the configured count and expiry, and shows the changed numbers after the settings change.
- **Alert and first run** (scripted): a parked scheduled call puts the dot on the goal's channel, the Goals screen tile and the Home entry, and it clears on the user opening the run or deciding the card; saving a new goal starts one run at once whose `external` calls park as cards under the interactive wait, declining them leaves the run ended normally, and the first scheduled fire waits for it.
- **Unattended** (scripted): a scheduled run needing an ungranted call, once for a tool with no `grantSubject` (matched on name and arguments) and once for a tool with one, parks, ends as "stopped: approval not given" after the timeout, marks the goal as waiting, and the next two fires are told not to repeat the call, until the user opens the run or the goal's page, after which the card comes back.
- **Injection** (scripted, then live): a fetched page tells the model to send to a subject that has no grant, and the run stops at a card; a page that tells it to widen its own permission has no tool to do it with; a grant for one goal does not apply in another goal's run.
- **Key manager** (scripted, once P6 lands): a call using a secret that requires approval per use shows a card even under a live grant.
- **Concurrency** (scripted): two runs spending the last use of a grant at once spend it once and one of them shows a card.

## Settled by the user

- The defaults are 20 uses and 30 days.
- There is no "any subject" grant.
- The order in which tools opt in is not the safeguard; the card wording and the absence of pre-enabled grants are.
