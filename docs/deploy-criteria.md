# Ready to deploy

Brindle is useful enough to deploy when every item below holds. This is a milestone inside the plan, not a new phase: the boxes that get it there are taken first (see _Deploy first_ in `.agents/plan/README.md`), and the phases and the final A boxes carry on after it. Each item names the box that proves it.

## The criteria

- **Runs on a local model.** Pointed at an OpenAI-compatible llama.cpp server on CPU, a channel conversation completes. Brindle reads the context window from the server. A request that is too long gets a clear "too long for the model" error instead of hanging or failing silently. (P2.11 reads the window; P2.10 proves the error and the stalled-call limits against a fake llama.cpp server.)
- **Long channels keep working.** A conversation of 50+ turns still answers. Facts, decisions and commitments from early in the conversation are still recalled after compaction. (P3.4)
- **Goals can be made from the phone.** On the Goals screen, typing a goal in plain words produces a draft (title, brief, schedule). Nothing is created until the user confirms it, and the goal appears as a tile with its next run. (P4.3a)
- **Goals act on a schedule, unattended.** A goal's scheduled run starts on its own at the right time in the user's time zone, and its result appears in the goal's channel. If the server restarts, scheduled runs pick back up without anyone stepping in. (P4.12)
- **Unattended runs can't go rogue or get stuck.** A scheduled run that needs approval for an external call waits for it. If nobody approves within the timeout, the run ends as "approval not given" and nothing is sent. (P4.12)
- **Goals remember.** A goal keeps a state document that each run reads and updates. The user can view it, edit it and see its history. (P4.4, plus the boxes split from it: its gallery entry and putting the document into every goal run's context.)
- **End-to-end proof.** A "learn Rust" goal builds a curriculum in its state document, the curriculum shows up in the gallery, and a later scheduled lesson updates its progress. (P4.7)
- **Failures are visible.** A scheduled run that failed, was missed, or stopped on a limit leaves a report the user sees, not a silent gap. (P5.7 design note, then P5.8 stores the reports and P5.11 shows them in the goal's channel and on its Goals tile)
- **Phone-first basics hold.** Installed as an app on a phone, the login persists, and channels, goals and artifacts are each one tap apart. The phone reaches the server over HTTPS, which installing needs. (P2.23)

## Not required to deploy

- The feed and the Atom/RSS feeds.
- The vault and credential requests.
- Suggestions, briefs and push notifications.
- Plug-ins and MCP over HTTP.
- The Home channel and move offers.
- The Soul.
- Settings screens for each model's limits: editing the model settings JSON file is enough.

## Deploy-path boxes

These boxes, and every box they need, are taken before any other free box: P2.10, P2.11, P2.11a, P3.4, P4.3a, P4.4 and the boxes split from it (P4.4a, P4.4b, P4.4c), P4.7, P4.12, P5.7, P5.8, P5.11, P2.23.

When a box on this list is split, the new suffixed boxes join the list. When every criterion above holds, the user says so and this section is emptied.
