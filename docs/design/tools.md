# Design note: the tool registry, effect levels, approvals and result sizing

Box P2.1. Status: proposed. Implementation (P2.3) waits until this merges.

## Problem

The **run** loop in `src/server/runs.ts` answers every tool call with "no tool named X". Tools are how the model acts, and they are the first place a mistake costs something: a tool can post, send or spend, and a tool result can be large enough to wreck the context. Three things need settling before any tool is built: how tools are declared and found, how the ones that do something in the world get the user's consent, and how a result is cut down before it goes back to the model.

## Approach

### The registry

A tool is a plain object: `name`, `description`, a JSON Schema for arguments (the same shape as `ToolDefinition` in the adapter contract), an `effect` level, and an `execute(args, ctx)` function that returns a string or a structured result. `ctx` carries the run id, the **scope** (channel or goal), an abort signal, and a logger; it never carries the database handle, so a tool reaches Brindle's state only through the narrow functions the registry gives it.

The registry is a single in-process map built at startup. A run asks it for the definitions to send to the model (`registry.definitions(scope)`) and for the tool to execute a call. Arguments are validated against the schema before `execute` runs; a failure becomes an error tool result the model can read and correct, not a thrown error. An unknown tool name is the same kind of error result, as today. A tool that throws is caught, recorded as an error result with a short message, and never ends the run. MCP and ACP tools (P9) join through the same registry later, so nothing here assumes built-in tools only.

### Effect levels

Every tool declares exactly one level, and there is no default: registering a tool without one is a startup error.

- `read`: reads outside or inside Brindle and changes nothing (`web_fetch`, `web_search`, `read_feed`, `search_history`).
- `local`: writes, but only inside Brindle's own data (`create_artifact`, `update_goal_state`).
- `external`: does something in the world that the user could not simply undo (posting, sending, buying, anything with a side effect on a third party).

Rules that follow from the level: `read` and `local` run immediately. `external` never runs without approval. A tool that is both a read and an effect (a fetch that carries a credential, say) takes the higher level. `web_fetch` is `read` only because it is limited to GET with no body and no credential handle; a tool that sends data out in a request body is `external` even if the call is harmless in practice. The level is a property of the tool, not of one call, which keeps the rule checkable by reading the registry.

### The approval flow

When the model calls an `external` tool, the engine does not execute it. It appends an `approval_request` event (run id, call id, tool name, the arguments as the tool wants them shown, and a one-line reason the tool derives from them) and parks the run in a new `waiting` status. The UI shows the event as a **card** with Approve and Decline. The decision arrives on `POST /api/runs/:id/approvals/:callId` with `approve` or `decline`.

- Approve: the engine appends an `approval_decision` event, runs the tool, and the loop continues.
- Decline: the tool result sent to the model is "The user declined this action." The model may continue without it. A decline is never retried by the engine.
- Neither: a waiting run costs nothing but does not hold a **step**. The time limit is paused while waiting, since the wait is the user's time, not the model's. A separate approval timeout (default 24 hours) ends the run as "stopped: approval not given", visibly. Cancel works on a waiting run like any other.
- Restart: a `waiting` run survives a restart, because the approval request is already persisted. `recoverInterrupted()` leaves `waiting` runs alone and only fails runs that were `running`; on the first decision after restart the engine rebuilds the message list from stored events and resumes. (This is the one change to the existing engine that the implementation box must make carefully, with a test.)
- Several external calls in one model turn are requested together and decided one by one; the tool calls in a turn run in the order the model gave them.

Standing permission ("this goal may always use this tool") is a Phase 4 concern and is deliberately not designed here; the approval check is one function (`needsApproval(tool, call, scope)`) so a goal grant can later return false without touching the loop. Until then it returns true for every `external` tool. None of the first tools (P2.3) are `external`; the path exists and is tested with a fake external tool.

Approval is bound to the exact call. The card shows the arguments that will execute, and the engine executes the stored arguments, not anything re-derived, so what the user approved is what runs.

### Sizing tool results

A result goes back to the model only after it passes through one sizing step, owned by the engine, not by each tool, so no tool can forget it.

- Each tool declares a `maxResultTokens` (default 4,000), and the engine also applies a global cap per result (8,000) that a tool cannot raise. Tokens are estimated as characters divided by four; an exact tokenizer is not worth a dependency.
- Over the cap, the result is cut to fit and ends with a plain marker that says how much was dropped and, where the tool supports it, how to get the rest ("5 of 12 pages shown; call again with page=2"). Cutting keeps the head and a short tail, because errors and summaries tend to sit at the end.
- The full, untruncated result is stored on the `tool_result` event, so the UI and a later debug view show what the tool really returned. Only the model's copy is cut.
- Tools that fetch pages convert to readable text before the cap (`web_fetch` strips markup and scripts), so the cap is spent on content.
- The sizing step is also the single place the key manager's output scrubbing (P6.4) will attach, so a secret cannot reach the model by way of a result. That is noted here only so the seam is not moved later.
- The whole turn counts against the run's token limit as it does now; a cap is a courtesy to the context, the run limit is the guarantee.

### Events

New event types: `approval_request`, `approval_decision`. `tool_call` and `tool_result` keep their current shape; `tool_result` gains `truncated` (boolean) and `fullResult`. A new run status `waiting` joins `running`, `done`, `failed`, `stopped`, `cancelled`.

## Rejected

- Letting each tool decide whether to ask the user. Consent that depends on every tool author remembering is not a rule. The engine asks, based on the declared level.
- A four- or five-level scale (read, write, network, destructive, and so on). The only distinction that changes behavior is "needs the user's yes", so three levels are enough. More can be added when a behavior depends on them.
- Approving once per goal or per session by default. It is the right feature for scheduled goals and is deferred to Phase 4, where the design can see how schedules fire.
- Truncating in the model adapter. Adapters are provider-specific and should stay thin; sizing is a harness decision.
- Having the model summarize an oversized result. It costs a call per result and can change facts. Truncation with a clear marker is predictable; summarizing can be a tool of its own later.
- Executing approved calls in a separate process or sandbox. Out of scope until a tool needs it (the ACP delegate in Phase 9 is the likely first).

## How evals will tell if it works

Scenarios against the scripted model (P2.5), plus unit tests in P2.3:

- A scripted call to an `external` fake tool never executes before approval, executes with the stored arguments after approval, and returns the decline text after a decline.
- A waiting run survives a simulated restart and resumes on the decision.
- A tool returning 100,000 characters yields a model-facing result under the cap with the marker, while the stored event holds the full text.
- Invalid arguments and a throwing tool both produce error results and a run that carries on.
- Registering a tool without an effect level fails at startup.

## Open for the user

- Whether approval-waiting runs should pause the time limit (recommended: yes) or count against it.
- The default per-result cap of 4,000 tokens; raise it if fetched pages feel clipped in use.
