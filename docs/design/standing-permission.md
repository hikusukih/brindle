# Design note: standing permission for external tools

Box P4.10. Status: proposed. Implementation waits until this merges, and its boxes are filed as `[plan]` proposals once it does. Terms in bold at their first use here (**run**, **scope** and **card**) are defined in the glossary in `docs/architecture.md`.

## Problem

An `external` tool never runs without the user's yes, which is the right rule for a chat and the wrong one for a goal that runs at 6:30 in the morning while the user sleeps: every scheduled run that wants to send, post or buy parks at a **card** nobody sees until it times out. The tools note left one seam for this, `needsApproval(tool, call, scope)`, and deferred the design to Phase 4. This note settles what a goal can be granted, where grants live, how the user reviews and revokes them, how the check consults them, what an unattended run does without one, and how each use shows up afterward. The constraint throughout: a grant must never be something a model, a fetched page or a goal's own text can create or widen.

## Approach

### What a grant is

A grant belongs to one goal and covers one tool and one subject, with a limit:

- **Tool.** Only a tool that opts in can be granted. An `external` tool declares a `grantSubject(args)` function that returns the one thing a grant would be about, derived by the tool's own code from the arguments: the recipient of an email, the host of a request, the account a post goes to. A tool without one cannot be granted and always shows a card. Anything that spends money, deletes, or has no natural subject should not opt in.
- **Subject.** An exact string, such as `sam@example.com`. A grant for a subject never covers another. A grant for "any subject" exists but takes a second, separate confirmation and is not offered by default.
- **Limit.** Both a number of uses and an expiry, with defaults (20 uses, 30 days) the user can change before accepting. A grant with no limit cannot be created from a card; the goal's page can make one after a plain warning.

A grant is created only by a user's click: on the approval card for an `external` call in a goal's run, an extra choice beside Approve and Decline, "Approve and allow this again for this goal", showing the tool and the subject, with the limit editable; or on the goal's page. The model has no tool for it, and nothing in a brief, a state document, a fetched page or a message can make one.

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

- The card for a scheduled run is marked as waiting on the goal, and the goal's tile on the Goals screen says "waiting for you", so a user who opens the app finds it without hunting for a run.
- A call that timed out or was declined is not asked again by a later fire until the user has looked. Nothing new is stored for this. A fire looks at the most recent run of this goal that holds an `approval_decision` event for the same tool and subject. If that decision was declined or timed out, and the user has not looked since, the call is not asked again, and the run is told in its task message that the call was not approved and why it stopped, so it can carry on without repeating the question every morning. "Looked" means one of these happened after that decision: the user opened that run or the goal's page, or approved or declined the same call by hand. Because the lookup goes to the most recent run that decided, not to the previous fire, a third fire behaves like the second.
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

## How evals will tell if it works

- **The check** (scripted): a matching, live grant runs the call with no card, writes `approval_decision` with `by: "grant"` and spends one use; a different subject, an expired grant, a used-up one, a revoked one, and a channel's run each show a card; an archived goal's grant does not apply, and does again once the goal is restored.
- **Creation** (scripted): approving a card with the allow-again choice creates a grant with the subject the tool derived, not one typed by the model; no tool or message creates one; "any subject" needs its own confirmation.
- **Unattended** (scripted): a scheduled run needing an ungranted call parks, ends as "stopped: approval not given" after the timeout, marks the goal as waiting, and the next two fires are told not to repeat the call, until the user opens the run or the goal's page, after which the card comes back.
- **Injection** (scripted, then live): a fetched page tells the model to send to a subject that has no grant, and the run stops at a card; a page that tells it to widen its own permission has no tool to do it with; a grant for one goal does not apply in another goal's run.
- **Key manager** (scripted, once P6 lands): a call using a secret that requires approval per use shows a card even under a live grant.
- **Concurrency** (scripted): two runs spending the last use of a grant at once spend it once and one of them shows a card.

## Open for the user

- The defaults, 20 uses and 30 days, and whether "any subject" should exist at all.
- Whether the first tools to opt in should be decided in advance. Proposed: none ship with a grant until someone picks one on purpose, so the feature starts as plumbing with a fake tool, as the approval flow did.
