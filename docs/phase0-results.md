# Phase 0 runtime results

Status: **synthetic recovery checks pass; live model checks are not tested**.

## Runtime and pinned packages

- Tested Node.js: `v24.19.0` on Linux x64.
- Minimum Node.js: `22.19.0`, as required by the pinned Pi Durable package.
- npm: `11.9.0`.
- `@earendil-works/pi-durable`: `1.0.2`.
- `@earendil-works/pi-ai`: `1.0.2`.
- `@earendil-works/chord`: `1.0.2`.
- TypeScript: `7.0.2`; Node type declarations: `22.19.19`.

Direct dependencies are pinned exactly. `package-lock.json` pins the complete install graph. Pi Durable is experimental. Upgrade it only with the recovery suite and provider checks enabled.

## Checks run

`npm run check` passes on Node `v24.19.0`: typecheck, build, and all 9 Node tests.

The tests use the Pi AI faux provider, disposable SQLite files, and fake external systems. The process tests send `SIGKILL` to a real Node worker and then reopen its state.

- Repeat a completed submission after restart: Pi returns the same submission, no second model call occurs, and changed input under the same request ID is rejected.
- Create two conversations: their transcripts and model replies stay separate.
- Kill a worker after a fake external effect: Pi replays the explicitly replay-safe tool; the remote idempotency key keeps the effect count at one.
- Kill a worker after an external effect but before the journal records success: restart reconciliation finds the remote receipt and does not dispatch the effect again.
- Return an unknown remote status: the operation stays `uncertain`, raises `UncertainExternalOperationError`, and is not dispatched a second time.
- Call the same active operation through two journal instances: it is dispatched once, and reuse with changed input is rejected.
- Abort a durable background task: its abort handler records an aborted terminal state.
- Start a second owner for the same state directory: it fails closed. The lock releases after shutdown, a restarted service reports healthy, and an existing state directory is restricted to owner access.
- Start the HTTP service on loopback: `/healthz` returns the runtime health response.

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
- Pi Durable has no cross-process storage lock. Slice owns a state directory with a separate SQLite write lock and rejects a second service process.
- SQLite WAL with `synchronous=NORMAL` supports process-crash recovery, but the newest commits can be lost after power or host failure. This is not a backup strategy.
- Pi Durable replays a tool only when it is marked safe. Mark a tool safe only when replay cannot duplicate its effect. Other interrupted work needs a durable operation record and remote reconciliation. An unknown remote result remains blocked.
- A local provider uses Pi AI's OpenAI-compatible completions API. Compatibility must be checked per endpoint; a successful text response is only a smoke test.
- This phase has no authenticated user API, browser UI, GitHub or SSH connection, Telegram integration, repository worktree, PR workflow, release, or deployment support.
