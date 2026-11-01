# Decisions

Open questions first, each with a recommendation. A session that hits a question not listed here adds it with a recommendation and moves on to work that doesn't depend on it. Settled decisions move to the bottom with the reason, one line each.

## Open

- **Text-to-speech provider.** Recommend an OpenAI-compatible speech endpoint, so a local TTS server and a hosted one are interchangeable.
- **Web search provider.** Recommend a self-hosted SearXNG-style JSON endpoint named by an environment variable, with `web_search` registered only when it is set, because it needs no key and nothing about the user's queries goes to a third party by default. A hosted API (Brave, Tavily and the like) can be added later as a second backend behind the same tool if SearXNG proves unreliable. Box P2.3 lands this as `BRINDLE_SEARCH_URL`; closing this question confirms it.

- **Backup and restore.** Everything a user would grieve to lose (channels, goal state documents, artifacts, the vault) lives in one data directory on one host. Recommend documenting, not building, a first answer: a README section saying to stop the server or use SQLite's online backup for the database and copy the artifacts directory alongside it, and, once the vault exists, to back up its key file separately from the data directory so that a stolen backup does not open the vault. A built-in export can follow if the manual steps prove error-prone.
- **ACP delegates.** Whether a run may hand a task to an external agent over ACP (boxes P9.2 and P9.3). Recommend deferring it: the user sees no current need, has no agent in mind to verify against, and does not want to trust third-party agents with their files. Nothing built depends on it. A draft design note, with the protocol checked against the v1 schema, is parked at `docs/design/acp.md` with the status deferred; it is not approved, and P9.3 stays blocked. Settling this as "deferred" leaves the boxes waiting; reopen it when there is a specific agent worth delegating to, and re-check the protocol then, since the note will be stale.

## Settled

- Public repo, MIT license.
- Stack: TypeScript throughout, React + Vite + Tailwind PWA, Hono on Node, SQLite through Drizzle, SSE, Vitest, Docker. The most standard choice, so any agent can pick it up cold.
- The harness is ours; models are pluggable behind an adapter. Whether external agents plug in as ACP delegates is reopened under Open.
- The agent may ask for logins. Credentials go through the key manager, which is held to a higher bar than the rest of the code.
- Name: Brindle. Several AI-agent tools already use Bridle, and Bindle is a WebAssembly package system; no software named Brindle turned up. The rename landed as box P0.5.
- Where it runs: the Docker image on an always-on host, reached over a private network or a reverse proxy the operator already runs. Nothing in the code assumes a particular host.
- Default models: one strong model for conversation and goal planning, and one cheap or local model for watchers and summaries, chosen per **scope** in configuration. Models are reached through the OpenAI-style API first, since one adapter then covers local servers such as Ollama and hosted models alike (P2.2); the adapter contract (P1.3) is the interface that keeps other providers from becoming a big refactor.
- Card means only an item the user acts on (an approval, a suggestion, a credential request form). The purpose card was renamed purpose statement, and the shared type and table are `ScopeStatement`, `PurposeStatement` and `scope_statements`, so one word doesn't carry two meanings. Both terms are in the glossary.
- Master key for the vault: a key file outside the data directory with owner-only permissions, its path set by `BRINDLE_MASTER_KEY_FILE`, and an OS keychain as a later option. The vault starts without a key file and says so rather than generating one beside the data, so a backup never holds both. Settled with the key manager design note (P6.1).
- Run cost budget: deferred. Models run locally at first, so there is no price to track; a per-model rate table would only go stale. Runs are bounded by the step, token and time limits, and fitting a request into the model's context window is handled by context assembly (`docs/design/context.md`). Reopen when a hosted, paid model is in regular use.
