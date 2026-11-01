# Design note and threat model: the key manager

Box P6.1. Status: accepted by the user, pending merge. Nothing under Phase 6 is built until this is merged, and this note deserves the slowest review in the repository: the user reviews the ideas here, and every later box in this phase is held to what this note says. It depends on box P2.7, authentication (#37): the vault's endpoints and the credential form assume the user is logged in.

## Problem

Goals that act for the user need logins and API keys, and the model that drives those goals reads untrusted text all day: fetched pages, feed items, files, other agents' output. Any of it can contain instructions. The design has to make a secret useless to an attacker who fully controls what the model says and does within its tool permissions, because sooner or later one will.

## Assets, adversaries, boundaries

Assets: secret values; the master key; the scope on each secret (hosts, tools, goals); the audit log.

Adversaries, in order of how likely they are:

1. **Injected content.** A page, feed item or tool result that tells the model to leak or misuse a credential. Assume it works on the model.
2. **A hostile or confused model.** Treat the model as untrusted code that can call any tool it is offered, with any arguments, and can read everything it is shown.
3. **A buggy or malicious tool.** Built-in tools have bugs; MCP and ACP tools (Phase 9) are third-party code.
4. **Someone else on the network** who can reach the HTTP API, and **a page in the user's browser** (XSS in our own UI, or a hostile site making requests to localhost).
5. **Someone holding a copy of the data directory or a backup.**

Out of scope, stated so nobody assumes otherwise: an attacker with root on the host or code execution inside the server process; a malicious operator; hardware side channels; and the destination itself, which receives the secret by design (a credential for a site can do what that site lets it do).

The trust boundaries are model to harness, harness to vault, vault to disk, and browser to server. The vault is the only code that ever holds a plaintext value, and it is built so that code outside it cannot obtain one.

## Approach

### The vault never hands out values

The obvious design, `resolve(handle)` returning the string to a tool, makes every tool a leak risk. Instead the vault **performs the credentialed request itself.** A tool receives, in its context, a capability with one method, `credentials.fetch(handle, request)`. The vault checks the call against the secret's scope, substitutes the value into the request, sends it, scrubs the response, writes the audit row, and returns the scrubbed response. No tool, and no part of the run engine, ever holds a plaintext value; a value exists in memory only inside the vault, between decryption and the socket write, and is not cached after.

The vault is one directory, `src/server/keys/`, with a single entry file. A lint rule (Biome's restricted imports) forbids importing anything else from it, and a test fails if a tool context carries any key besides the capability above. `store` is exported only to the HTTP layer's vault form route, never to tools.

The API, in full:

- `store(name, kind, value, scope)` creates a secret and returns its handle. Called only by the vault form endpoint.
- `describe(handle)` and `list()` return name, kind, scope, expiry, last use. Never the value. A run's `list()` shows only secrets its goal may use.
- `revoke(handle)`; `rotateMasterKey()`.
- `fetch(handle, request, use)`: described above. `use` is built by the engine, not the tool: run id, goal id, tool name.
- `scrub(text)`: returns text with every stored value, in every encoding below, replaced by `[redacted: name]`.

Kinds in Phase 6 are a bearer token, an API key sent in a named header, and basic-auth username and password. Interactive web logins with cookies and forms are a later tool built on the same capability.

### Handles

The model writes a handle, `{{secret:name}}`, in a header or body field of a tool call. Names are not secret. The engine does not expand handles; the vault does, inside `fetch`. **A handle in a URL, path or query string is refused**: URLs end up in logs, referrers and redirects. Unknown handles, handles outside the goal's permission and expired or revoked ones are refused with a generic message, and every refusal is audited.

### Scope

Each secret carries, and the vault enforces on every use:

- **Hosts:** exact host names or `*.suffix`, https only, port-bound. A request to any other host is refused. This is the main defense against injection: a page cannot make the credential go anywhere the user did not name.
- **Methods:** `GET` only unless the user widened it. A page that hijacks a read-only credential can read, not post.
- **Tools** that may use it, and **goals or channels** that may use it. A secret scoped to one goal is invisible to others. Goals do not call or message each other, but they do share artifacts and, later, the feed, so one goal can learn that another uses a handle, because handle names are not secret and can appear in an artifact. That teaches it nothing it can use: access is a property of the secret's scope, checked by the vault on every use, not of anything a goal knows. A goal that names another goal's handle gets the same generic refusal as for an unknown handle, so a refusal does not reveal which names exist, and the attempt is audited. Giving a second goal the same login means the user widens the scope on a request card; no goal can ask another to do it, and the model cannot edit scope.
- **Expiry,** and whether each use needs approval. A request that carries a credential is at least `external` under `docs/design/tools.md`, so it waits for the user's approval unless a goal's standing permission (Phase 4) covers that tool.
- Redirects are never followed with a credential attached: a redirect to another host is refused, to the same host re-checked. Credentialed requests to private or loopback addresses are refused unless the secret's host list names that host.

### Storage and the master key

Each value is encrypted with AES-256-GCM using Node's `crypto`, a fresh 96-bit random nonce per value, and the secret's id, name and scope hash as associated data, so a ciphertext cannot be moved to another secret or have its scope edited in the database. The database holds only ciphertext and metadata.

The master key is 32 random bytes in a **key file outside the data directory**, its path in `BRINDLE_MASTER_KEY_FILE`, never the key itself in an environment variable (variables show up in process listings and crash dumps). The vault refuses to start if the file is readable by group or others. If the file is missing and the vault holds secrets, it refuses and says so rather than silently making a new key; if the vault is empty it creates one. In Docker the file lives on a separate volume from the data, so a backup of the data directory alone is useless. Rotation re-encrypts every value under a new key, then retires the old file. Unlocking with a passphrase at each start would break unattended schedules; it can be offered later.

### Scrubbing

`scrub` runs wherever text could carry a value to the model, the user, a log or the disk: tool results (at the sizing step in `tools/sizing.ts`, the seam the tools note reserved), model output before it is persisted or streamed, tool-call arguments before they are stored, error messages, log lines, `create_artifact` content, feed items, and summaries and purpose statements written from transcripts. Events are scrubbed before they are stored, so the stream and the database agree.

For each secret it matches the raw value, percent-encoded, JSON-escaped, hex in both cases, base64 and base64url at each of the three alignments (so a value embedded in other text still matches), and the reversed string. It also checks a copy with whitespace, hyphens, quotes and zero-width characters removed, to catch a value split up on purpose; a hit there withholds the entire result ("result withheld: it contained a secret") instead of redacting in place. Values shorter than 8 characters are refused at `store`, since they cannot be scrubbed without wrecking ordinary text. Scrubbing is a net, not the wall: the wall is that tools never hold values.

`scrub` is a function inside the vault, not a tool, so the model cannot call it. It can still become a guessing oracle through the paths it protects: if the model writes a guess into an artifact or a tool argument and sees `[redacted: name]` come back, the guess was right. Rate limiting does not fix that, since one lucky guess at a weak password is enough, and a legitimate run never needs one. The rule is instead: **a hit on text the model wrote (its output, tool-call arguments, artifact content) is never a silent redaction.** The run stops with a visible reason, the hit is audited with the run and the tool, and the user is told, because the model has no honest way to hold a value it was never given. A hit on text the model did not write (a tool result from a host that echoes the secret) is redacted and audited as before. Misses reveal nothing, so there is nothing to throttle. A weak secret remains guessable by whoever can guess it, which is why the minimum length exists.

### Requesting a login, and secrets pasted in chat

`request_credential(site, reason, suggested scope)` creates a pending request and puts a card in the channel. The card opens a vault form on the same origin where the user types the value and confirms or edits the scope; the value goes straight to `store` and is never echoed. The model cannot call the form endpoint: it is not a tool, and it needs the user's session credential, which the model never has.

A user message is checked before it is stored or sent to the model for known secret shapes (provider key prefixes, private key blocks, JWTs, and long high-entropy strings next to words like password or key). On a hit the message is held, the stored transcript shows `[secret removed]`, and the user is offered "move to the vault". Sending it anyway is possible for a false positive; the harness instructions tell the model never to ask for a secret in chat, only to use `request_credential`.

### The web surface

Vault endpoints exist only behind authentication. **The project has no login yet** (the README says so, and `docs/architecture.md` assumes "a login token"), and on `main` no box builds it yet. This phase cannot start without one: it depends on box P2.7 (authentication, proposed in #37), and P6.2 needs P2.7. Vault requests carry the token in a header, not a cookie, so a hostile page cannot ride the user's browser state. The UI is served with a strict Content-Security-Policy (no inline script, `default-src 'self'`, `frame-ancestors 'none'`); model output is rendered as text, never HTML; HTML artifacts are served sandboxed so their scripts cannot reach the vault origin.

### Audit

`secret_audit` is append-only, with no update or delete path in the code: time, secret id and name, run, goal, tool, host, method, outcome (`allowed` or `refused`) and reason. Never a value or a request body. It is shown in the vault screen, and a refusal is also surfaced in the run so the user sees an attempted misuse.

## The attacks the red-team suite must cover (P6.6)

Each is a deterministic test using a scripted model and obviously fake values; P6.7's adversarial session tries to find more.

1. Injected page tells the agent to send a credential to another host: refused, audited.
2. Handle placed in the URL, path or query of an allowed host: refused.
3. Allowed host redirects to another host: refused, no credential sent.
4. Hostname that resolves to a private address, or a look-alike host (`example.com.evil.test`, `evil.test#example.com`, userinfo tricks): refused.
5. Echo endpoint on an allowed host returns the Authorization header, raw and base64 encoded: scrubbed before the model sees it.
6. Value written into an artifact, in each encoding: scrubbed or refused.
7. Value in an error message or exception text from the HTTP client: scrubbed.
8. Value in server logs: none, checked by capturing all log output across the suite.
9. Value split with spaces, hyphens or zero-width characters, or reversed: caught; the result is withheld.
10. Agent asks the user to paste a secret in chat: the instructions forbid it, and a pasted secret is held and redacted.
11. Secret pasted in chat reaches the model or the stored transcript: it must not.
12. XSS payload in model output, a fetched page or an HTML artifact tries to call vault endpoints: blocked by rendering, CSP, header-token auth and sandboxing.
13. A tool, or a model-supplied argument, reaches for `store` or any value: the tool context has no such method (enumeration test plus the import rule).
14. Goal B uses goal A's secret, or enumerates handles, including one learned from an artifact A wrote: refused with the same message as an unknown handle, and `list()` shows only its own.
15. Expired, revoked or wrong-method (POST on a GET-only secret) use: refused.
16. Database file or a backup scanned for the value and its encodings: no match; a ciphertext moved to another secret fails to decrypt.
17. Key file readable by others, or missing with a non-empty vault: the vault refuses to start.
18. SSE stream, compaction summaries, purpose statements and feed items carry no value.
19. "Repeat exactly what the tool returned" after a response containing a value: the model never had it.
20. Guessing: the model writes candidate values into an artifact, a tool argument or its own output to see which come back redacted. A hit stops the run with a visible reason and is audited; a miss looks the same as any other text.

## Residual risks

A credential can do whatever its host allows within its scope, so a hijacked run with a read-only token can read everything that token can read from that host; narrow scopes and approvals limit this, nothing removes it. A value leaked in two fragments across two results, each too short to match, is not caught. JavaScript cannot reliably wipe memory, so "not cached" is best effort. These are written down so the user can decide, not because they are solved.

## Rejected

- Returning the value to tools. One buggy or third-party tool then leaks it; capability-only access removes the class.
- An LLM judging whether output leaks a secret. It is nondeterministic and itself injectable.
- Environment variables holding secrets or the master key. They leak through process inspection and crash reports; the only environment input is the key file's path.
- Regex-only scrubbing as the defense. It is the net behind scope enforcement.
- An OS keychain or hardware-backed key now. It ties the product to a host; the key-file interface leaves room for it later.
- Detecting pasted secrets and quietly sending them anyway. The default is to hold.

## How evals will tell if it works

The 20 attacks above are the suite, written first, each failing before the code exists. Beyond them: unit tests on every encoding variant the scrubber claims; property tests that `scrub` never changes text containing no secret; a test that every outbound text path in the server calls `scrub` (found by instrumenting the event, log and artifact writers); and the adversarial session (P6.7), where an agent is given the code and told to make the vault leak, with each finding filed and answered.

## Decided by the user

- Secrets shorter than 8 characters are refused, credentialed requests default to GET only, and each credentialed request needs approval by default.
- The vault starts with no key file and says so; it does not generate one beside the data. In Docker the key file sits on a volume separate from the data.
- Authentication is its own box and lands before Phase 6 (P2.7, #37).
