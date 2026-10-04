# Phase 0 runtime results

Status: **synthetic recovery checks pass; live model checks are not tested**.

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

`npm run check` passes on Node `v26.7.0`: typecheck, build, and all 17 Node tests.

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

Local model smoke test: **not tested**. No local endpoint was configured for this run.

OpenAI smoke test: **not tested**. No approved model profile and API credential were configured for this run.

Run the checks after configuring the service environment:

```sh
npm run smoke:local
npm run smoke:openai
```

Each command sends a short text prompt and reports the provider and model ID. These smoke tests do not prove tool-call, streaming, cancellation, structured-output, image, long-context, or privacy-policy compatibility. Those checks remain required before a profile can serve a production role.

## API and recovery limits

- Pi Durable `1.0.2` is experimental. Keep it behind `PiDurableAdapter` and rerun the recovery tests before any upgrade.
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

- Live model checks are still **not tested**. They need an owner-supplied local endpoint and an approved cloud model profile, so the phase exit check cannot be signed off until they run.
- Code review and security review need a second person. The author implemented this work and cannot approve it; no security review record exists yet.
