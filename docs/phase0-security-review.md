# Phase 0 security review

Status: **author self-review complete; independent review still required**.

The repository rules state that the author cannot approve its own work, so this record is **not** an approval. It
is the reviewer's checklist plus the evidence the implementer gathered, written so a second person can check the
same properties instead of starting from scratch. Nothing here should be read as a sign-off.

Reviewer: unassigned. Date of self-review: 2026-10-04. Scope: the Phase 0 diff against `main`, plus the whole of
`apps/server/src`.

## Properties checked, and how

| Property | Evidence | Result |
| --- | --- | --- |
| No SQL built by string interpolation | Every statement in `application-state.ts` and `external-operation-journal.ts` uses bound parameters; searched for `` prepare(`…${ `` and `` exec(`…${ `` | Pass |
| No command execution from Slice | No `child_process`, `eval`, or `new Function` in `apps/server/src`; `SIGKILL` tests spawn workers from test fixtures only | Pass |
| Credentials absent from source and committed configuration | `SLICE_LOCAL_API_KEY` is read from the environment; `config/examples/local.env.example` holds a placeholder; no `Bearer` literal in any tracked file | Pass |
| Credentials refused in configuration that gets logged or stored | Base URL with userinfo is rejected; a key containing a control character is rejected to block header injection | Pass |
| Model endpoints restricted to configured hosts | The service only ever calls the configured base URL; the model cannot choose an endpoint or a path | Pass |
| State directory private to its owner | `main.ts` creates it `0700` and refuses to start when the existing mode grants any group or other access | Pass |
| One process owns a state directory | `SingleOwnerLock` takes a SQLite write transaction and fails closed; covered by two tests | Pass |
| Service not reachable off the host | Listener binds `127.0.0.1` only | Pass |
| Minimal HTTP surface | Only `GET /healthz`; an exact path match, no body parsing, no dynamic routing | Pass |
| Untrusted input bounded | Request IDs and operation IDs are length- and charset-checked; submission content is capped at 100,000 characters | Pass |
| External dispatch at most once | The operation journal records `running`/`uncertain`/`succeeded` before dispatch, and an ambiguous result stays blocked rather than replayed | Pass |
| Model output never trusted as policy | Policy, paths, and hosts come from configuration; nothing in this phase lets model output select a command, path, or host | Pass |
| No secrets in logs | `/healthz` returns a fixed body. Startup failures print `error.message` only | Pass with a note, see below |

## Findings

### 1. The local model endpoint had no way to authenticate, and the keyless path was broken

Found while running the live check, and fixed in this phase. The local provider resolved auth to an empty object,
and the base URL was rejected if it carried credentials, so an endpoint requiring a key could not be called at all.
Separately, the pinned Pi AI client refuses to send any request whose auth carries no API key, so the keyless path
always failed with `No API key for provider`. That path had never been exercised because no endpoint was configured.
A keyless endpoint now receives a non-secret placeholder and an endpoint that checks a key receives
`SLICE_LOCAL_API_KEY` from the environment.

### 2. Cancelling a thread left conversation-owned background tasks running

Fixed in this phase. `Conversation.abort()` reaches only non-background tasks unless passed `{ background: true }`,
so a background task could continue and commit its outcome after `cancel()` returned.

### 3. Two connections to one state file could dispatch an external operation twice

Fixed in this phase. In-flight deduplication was keyed by `DatabaseSync` object identity, so a second connection
missed the first's in-flight call, saw `running`, and dispatched again when reconciliation reported `not_started`.
Deduplication is now keyed by resolved database file.

### 4. Startup error text is not filtered

Accepted, not fixed. `main.ts` prints `error.message` to stderr when startup fails. Today every message that can
reach that path is Slice's own text and names no secret, and the service is loopback-only. If a future failure can
carry provider or driver text, that text must be sanitised before it is printed. Watch this when the service gains
an authenticated user API.

### 5. The state directory permission check is not atomic with opening the database

Accepted for Phase 0. The mode is checked with `statSync` before the database is opened, so a process able to change
the directory mode in that window could widen access. The directory is owner-only `0700` and the threat requires
local access as the same user, who can read the database directly regardless. Revisit if the state directory ever
lives somewhere other users can write.

### 6. No rate limiting or authentication on the HTTP listener

Not applicable yet. Phase 0 exposes one unauthenticated read-only endpoint on loopback. Phase 1 adds
authentication and must add rate limiting with it.

## Still required before the phase gate closes

- An independent reviewer signs off on this record. The implementer cannot approve it.
- The OpenAI cloud smoke test is **not tested**; it needs an approved cloud model profile and a credential.
- A dependency review of the three pinned `@earendil-works` packages, which are experimental and unreviewed here.