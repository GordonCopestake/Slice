# Phase 0 runtime results

Status: **synthetic recovery checks pass; the local model check passed; the cloud model check passed on the
ChatGPT Plus/Pro subscription route** (`openai-codex`, `gpt-6-luna`, 2026-10-07). The plain OpenAI API-billing
profile (`SLICE_OPENAI_MODEL_ID` with `OPENAI_API_KEY`) remains **not tested**; no API-billing credential was configured.

## Runtime and pinned packages

- Latest local verification: 2026-10-06 with Node.js `v24.21.0` on Linux x64 and npm `11.19.0`.
- Earlier complete verification: Node.js `v26.7.0` on Linux x64 and `v24.19.0` in an earlier run of this phase.
- Minimum Node.js: `22.19.0`, as required by the pinned Pi Durable package.
- npm: `11.19.0` (`11.9.0` in the earlier run).
- `@earendil-works/pi-durable`: `1.0.2`.
- `@earendil-works/pi-ai`: `1.0.2`.
- `@earendil-works/chord`: `1.0.2`.
- TypeScript: `7.0.2`; Node type declarations: `22.19.19`.

Direct dependencies are pinned exactly. `package-lock.json` pins the complete install graph. Pi Durable is experimental. Upgrade it only with the recovery suite and provider checks enabled.

## Checks run

`npm run check` passes on Node `v26.7.0`: typecheck, build, and all 46 Node tests (2026-10-07). Earlier runs: Node `v24.21.0` with all 33 tests (2026-10-06), and Node `v26.7.0` with the 23 tests that existed at that time.

The tests use the Pi AI faux provider, disposable SQLite files, and fake external systems. The process tests send `SIGKILL` to a real Node worker and then reopen its state.

- Repeat a completed submission after restart: Pi returns the same submission, no second model call occurs, and changed input under the same request ID is rejected.
- Crash between reserving a request ID and recording its submission: the retried request resolves to the submission already admitted and the model is not called again, because Pi treats `requestId` as a deduplication key scoped to the conversation.
- Create two conversations: their transcripts and model replies stay separate.
- Kill a worker after a fake external effect: Pi replays the explicitly replay-safe tool; the remote idempotency key keeps the effect count at one.
- Kill a worker after an external effect but before the journal records success: restart reconciliation finds the remote receipt and does not dispatch the effect again.
- Return an unknown remote status: the operation stays `uncertain`, raises `UncertainExternalOperationError`, and is not dispatched a second time.
- Call the same active operation through two journal instances: it is dispatched once, and reuse with changed input is rejected.
- Call the same active operation through two connections to one SQLite file: it is dispatched once, and reuse with changed input is rejected.
- Let an in-flight call settle, then run it again: the journal dispatches again instead of replaying a stale promise.
- Abort a durable background task: its abort handler records an aborted terminal state.
- Cancel a thread through the adapter while a conversation-owned background task is live: the task reaches an aborted terminal state before `cancel()` returns.
- Start a second owner for the same state directory: it fails closed. The lock releases after shutdown, a restarted service reports healthy, and an existing state directory is restricted to owner access.
- Start the HTTP service on loopback: `/healthz` returns the runtime health response.
- Local model configuration against a loopback endpoint: a configured API key arrives as the `Authorization` header, an endpoint without a key receives the non-secret placeholder, and a base URL carrying credentials, a non-HTTP scheme, or a key with a control character is rejected.
- Local model token limits: the reply budget defaults to 32768 inside a 262144 context window, both are configurable, and a reply budget larger than the window is rejected at startup.

## Pinned runtime API checks

These cover the task, document, event, compaction, and cancellation APIs named in the Phase 0 scope, against Pi Durable `1.0.2`.

- Manual compaction summarizes the transcript with exactly one extra model call and reports a `submissionId`, not an `entryId`, because a conversation-owned compaction places its summary through a write submission.
- Manual compaction of an empty transcript completes with neither identifier and makes no model call.
- A conversation document written in one commit is readable in the next, and survives closing and reopening the harness on the same file.
- A conversation document write without its conversation ID is rejected instead of resolving to a document somewhere else.
- `watchEvents` attaches with a `snapshot`, then reports `run_start`, `turn_start`, `message_end`, `submission`, and `run_end` for a completed input, and `compaction_start` and `compaction_end` for a compaction.

## Recovery measurement

The exit check asks for a measurement rather than an assumption from persistence. The `SIGKILL` tests time the resume worker from spawn to its recovered result and fail if recovery exceeds 10 seconds. On Node `v26.7.0`, Linux x64, re-measured 2026-10-07 at commit `37bc291`, three consecutive runs:

| Recovery path | Measured |
| --- | --- |
| Replay-safe tool after `SIGKILL` | 308-333 ms |
| External operation reconciled after `SIGKILL` | 52-58 ms |

Both are dominated by Node process start-up, not by Slice state replay. These are synthetic local runs on one host; they are not a service-level objective for a deployed service.

## Live provider checks

Local model smoke test: **passed** on 2026-10-04.

- Endpoint: an OpenAI-compatible local llama-swap server; the private address is redacted.
- Model: `qwen27b`, the server's alias for `Qwen3.8-27B-UD-Q5_K_XL`, reported as Qwen3.8 27B Q5.
- Result: `{"status":"passed","provider":"slice-local","model":"qwen27b","stopReason":"stop"}`.

The endpoint requires an API key and answers `401` without one, so `SLICE_LOCAL_API_KEY` was set for the run. The key was passed in the process environment only and is not committed. The response was a streamed chat completion and the model returned the exact requested string.

OpenAI cloud check: **passed** on 2026-10-07 on the ChatGPT Plus/Pro subscription route the owner selected.

- Route: `npm run auth:openai` (device-code OAuth sign-in owned by the pinned `openai-codex` client), then
  `npm run smoke:pluspro`.
- Provider and model: `openai-codex` / `gpt-6-luna`, reasoning effort `max` (the profile default). Subscription
  billing, not API billing; no `OPENAI_API_KEY` was used.
- Result: `{"status":"passed","provider":"openai-codex","model":"gpt-6-luna","stopReason":"stop","reasoningEffort":"max"}`.
- The OAuth tokens are stored by `FileCredentialStore` in `credentials.json` inside the state directory, created
  `0600` and replaced by atomic rename. No token was printed, logged, or committed. The sign-in sends a stable
  per-installation id from `installation-id` in the same directory.
- The smoke test reports `not_tested` with a reason, and exits non-zero, when the profile is not enabled or no
  credential is stored; it cannot report a pass without a live call.

The API-billing OpenAI profile (`SLICE_OPENAI_MODEL_ID` with `OPENAI_API_KEY`) is **not tested**: no API-billing
credential was configured for this run.

Run the checks after configuring the service environment:

```sh
npm run smoke:local
npm run smoke:openai
npm run auth:openai   # one interactive sign-in for the Plus/Pro route
npm run smoke:pluspro
```

Each command sends a short text prompt and reports the provider and model ID. These smoke tests do not prove tool-call, streaming, cancellation, structured-output, image, long-context, or privacy-policy compatibility. Those checks remain required before a profile can serve a production role.

### Model selection

The models on the test endpoint exist for testing only. Production does not adopt any of them: the owner selects a model when they configure a profile, and later phases attach per-project model and privacy rules. Phase 0 therefore records the model used for a check, not a preferred or approved model.

Notes on the endpoint, for whoever selects a model:

- The endpoint listed eight models, most `unloaded`, so the first request against one pays a model load. Several carry `abliterated` or `uncensored` names, meaning refusal behaviour was deliberately removed; none is a production candidate by default.
- Every model reports `function_calling: true` with `tools` in `supported_parameters`. This check sent a text-only prompt and did not exercise tool calls.
- These models are reasoning models: they emit `reasoning_content` before any visible text. The reply budget must leave room for it. At 32 output tokens the model returned an empty body with `finish_reason: "length"`, which is why the smoke test now names that cause instead of reporting a bare failure.

## API and recovery limits

- Pi Durable `1.0.2` is experimental. Keep it behind `PiDurableAdapter` and rerun the recovery tests before any upgrade.
- The pinned Pi AI OpenAI-compatible client refuses to send any request whose auth carries no API key. A keyless local endpoint therefore receives a non-secret placeholder from `SLICE_LOCAL_API_KEY`'s absence. An endpoint that checks a real key must set that variable; the key is read from the environment only and rejected if it carries a control character.
- The local profile's window and reply budget are declared configuration, not discovered facts. The defaults are 262144 and 32768, chosen to match the context length the test endpoint advertises. Nothing reads `/v1/models` at startup, so a model with a different window must set `SLICE_LOCAL_CONTEXT_TOKENS`; an over-long request is rejected by the server rather than truncated by Slice.
- `watchEvents` is marked experimental by Pi Durable. One `AgentEventStream` accepts `start()` only once; a second call throws `Watch is already started`. Keep one listener per stream for the life of the subscription.
- A document draft from `tx.doc()` is a settled overlay once its commit ends and throws `Cannot use a settled overlay` on a later read. Read the value inside its own commit, including when reading a stored document back.
- `Conversation.abort()` only reaches non-background tasks unless it is passed `{ background: true }`. Cancelling user work must pass that option or conversation-owned background tasks keep running.
- Pi Durable has no cross-process storage lock. Slice owns a state directory with a separate SQLite write lock and rejects a second service process.
- The external operation journal's in-flight deduplication is per process, keyed by resolved database file. It stops two connections in one process from dispatching the same operation twice. It cannot deduplicate two OS processes; the single-owner lock is what prevents that.
- SQLite WAL with `synchronous=NORMAL` supports process-crash recovery, but the newest commits can be lost after power or host failure. This is not a backup strategy.
- Pi Durable replays a tool only when it is marked safe. Mark a tool safe only when replay cannot duplicate its effect. Other interrupted work needs a durable operation record and remote reconciliation. An unknown remote result remains blocked.
- Credentials for the Plus/Pro route live in `credentials.json` in the state directory (`0600`, atomic rename
  replacement, serialized per-provider writes in one process). There is no cross-process credential lock; the
  single-owner lock is what keeps one service process per state directory. `npm run auth:openai` is the only
  sign-in path and never reads or prints a token.
- A local provider uses Pi AI's OpenAI-compatible completions API. Compatibility must be checked per endpoint; a successful text response is only a smoke test.
- This phase has no authenticated user API, browser UI, GitHub or SSH connection, Telegram integration, repository worktree, PR workflow, release, or deployment support.

## Phase gate: CLOSED

The independent review passed and the owner signed off the Phase 0 gate on 2026-10-07, covering the security-fix
re-review and the Plus/Pro credential code added after the initial review (`FileCredentialStore`, `installationId`,
the sign-in and smoke diagnostics, and the `SLICE_PLUS_PRO` profile). The findings, the self-review rows the initial
review refuted, and the ordered fix list remain recorded in [the Phase 0 security review](phase0-security-review.md).

The author implemented this work and did not approve it. Known gaps carried into Phase 1, so they are not mistaken
for closed: no retention policy for the request index or the operation journal (deferred to Phase 1), power-loss
durability unproven, and the pinned `@earendil-works` packages remain experimental — any upgrade requires rerunning
the recovery suite and the provider checks.
