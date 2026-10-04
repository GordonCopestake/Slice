# Phase 0 runtime results

Status: **synthetic recovery checks pass; the local model check passed; the OpenAI cloud check is not tested**.

## Runtime and pinned packages

- Tested Node.js: `v26.7.0` on Linux x64, and `v24.19.0` in an earlier run of this phase.
- Minimum Node.js: `22.19.0`, as required by the pinned Pi Durable package.
- npm: `11.19.0` (`11.9.0` in the earlier run).
- `@earendil-works/pi-durable`: `1.0.2`.
- `@earendil-works/pi-ai`: `1.0.2`.
- `@earendil-works/chord`: `1.0.2`.
- TypeScript: `7.0.2`; Node type declarations: `22.19.19`.

Direct dependencies are pinned exactly. `package-lock.json` pins the complete install graph. Pi Durable is experimental. Upgrade it only with the recovery suite and provider checks enabled.

## Checks run

`npm run check` passes on Node `v26.7.0`: typecheck, build, and all 20 Node tests.

The tests use the Pi AI faux provider, disposable SQLite files, and fake external systems. The process tests send `SIGKILL` to a real Node worker and then reopen its state.

- Repeat a completed submission after restart: Pi returns the same submission, no second model call occurs, and changed input under the same request ID is rejected.
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

## Pinned runtime API checks

These cover the task, document, event, compaction, and cancellation APIs named in the Phase 0 scope, against Pi Durable `1.0.2`.

- Manual compaction summarizes the transcript with exactly one extra model call and reports a `submissionId`, not an `entryId`, because a conversation-owned compaction places its summary through a write submission.
- Manual compaction of an empty transcript completes with neither identifier and makes no model call.
- A conversation document written in one commit is readable in the next, and survives closing and reopening the harness on the same file.
- A conversation document write without its conversation ID is rejected instead of resolving to a document somewhere else.
- `watchEvents` attaches with a `snapshot`, then reports `run_start`, `turn_start`, `message_end`, `submission`, and `run_end` for a completed input, and `compaction_start` and `compaction_end` for a compaction.

## Recovery measurement

The exit check asks for a measurement rather than an assumption from persistence. The `SIGKILL` tests time the resume worker from spawn to its recovered result and fail if recovery exceeds 10 seconds. On Node `v26.7.0`, Linux x64, three consecutive runs:

| Recovery path | Measured |
| --- | --- |
| Replay-safe tool after `SIGKILL` | 269-335 ms |
| External operation reconciled after `SIGKILL` | 46-47 ms |

Both are dominated by Node process start-up, not by Slice state replay. These are synthetic local runs on one host; they are not a service-level objective for a deployed service.

## Live provider checks

Local model smoke test: **passed** on 2026-10-04.

- Endpoint: `http://ws-p3:8080/v1`, an OpenAI-compatible llama-swap server.
- Model: `Qwen3.8-27B-ABLITERATED-GGUF`, the model reported as `loaded` at the time of the run.
- Result: `{"status":"passed","provider":"slice-local","model":"Qwen3.8-27B-ABLITERATED-GGUF","stopReason":"stop"}`.

The endpoint requires an API key and answers `401` without one, so `SLICE_LOCAL_API_KEY` was set for the run. The key was passed in the process environment only and is not committed. The response was a streamed chat completion and the model returned the exact requested string.

OpenAI smoke test: **not tested**. No approved model profile and API credential were configured for this run.

Run the checks after configuring the service environment:

```sh
npm run smoke:local
npm run smoke:openai
```

Each command sends a short text prompt and reports the provider and model ID. These smoke tests do not prove tool-call, streaming, cancellation, structured-output, image, long-context, or privacy-policy compatibility. Those checks remain required before a profile can serve a production role.

Notes on this endpoint, for whoever picks the production profile:

- The server listed eight models. Most were `unloaded`, so the first request against one would pay a model load. Several carry `abliterated` or `uncensored` names, which means refusal behaviour was deliberately removed. That is a policy decision for the owner, not a default to inherit from a smoke test.
- The chosen model is a reasoning model: it emits `reasoning_content` first. A small output budget is consumed before any visible text appears, so `SLICE_LOCAL_OUTPUT_TOKENS` must leave room for reasoning or the response reads as empty.
- The server reports `function_calling: true` and `tools` in `supported_parameters`. This smoke test sent a text-only prompt and did not exercise tool calls.

## API and recovery limits

- Pi Durable `1.0.2` is experimental. Keep it behind `PiDurableAdapter` and rerun the recovery tests before any upgrade.
- The pinned Pi AI OpenAI-compatible client refuses to send any request whose auth carries no API key. A keyless local endpoint therefore receives a non-secret placeholder from `SLICE_LOCAL_API_KEY`'s absence. An endpoint that checks a real key must set that variable; the key is read from the environment only and rejected if it carries a control character.
- `watchEvents` is marked experimental by Pi Durable. One `AgentEventStream` accepts `start()` only once; a second call throws `Watch is already started`. Keep one listener per stream for the life of the subscription.
- A document draft from `tx.doc()` is a settled overlay once its commit ends and throws `Cannot use a settled overlay` on a later read. Read the value inside its own commit, including when reading a stored document back.
- `Conversation.abort()` only reaches non-background tasks unless it is passed `{ background: true }`. Cancelling user work must pass that option or conversation-owned background tasks keep running.
- Pi Durable has no cross-process storage lock. Slice owns a state directory with a separate SQLite write lock and rejects a second service process.
- The external operation journal's in-flight deduplication is per process, keyed by resolved database file. It stops two connections in one process from dispatching the same operation twice. It cannot deduplicate two OS processes; the single-owner lock is what prevents that.
- SQLite WAL with `synchronous=NORMAL` supports process-crash recovery, but the newest commits can be lost after power or host failure. This is not a backup strategy.
- Pi Durable replays a tool only when it is marked safe. Mark a tool safe only when replay cannot duplicate its effect. Other interrupted work needs a durable operation record and remote reconciliation. An unknown remote result remains blocked.
- A local provider uses Pi AI's OpenAI-compatible completions API. Compatibility must be checked per endpoint; a successful text response is only a smoke test.
- This phase has no authenticated user API, browser UI, GitHub or SSH connection, Telegram integration, repository worktree, PR workflow, release, or deployment support.

## Outstanding for the phase gate

- The OpenAI cloud smoke test is still **not tested**. It needs an approved cloud model profile and an API credential, so the phase exit check cannot be signed off until it runs.
- Code review and security review need a second person. The author implemented this work and cannot approve it; no security review record exists yet.
