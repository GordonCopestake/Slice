# Phase 0 security review

Status: **independent review returned CHANGES REQUESTED**. Two P2 findings are open, so the Phase 0 gate is not
signed off. This record holds both the author's self-review and the independent reviewer's findings.

The repository rules state that the author cannot approve its own work. Two roles are recorded separately below.
Neither is an approval, and the author may not close the independent reviewer's own findings.

- Self-review: implementer, 2026-10-04. Evidence gathered by the author.
- Independent review: separate reviewer context, 2026-10-04, over `apps/server/src` and `git diff main...HEAD` at
  `51482ee`. Reviewed read-only; no file, dependency, or git state was changed by the reviewer.

## Verdict

`CHANGES REQUESTED`. No P1. The reviewer found no SQL injection, no committed credentials, no command execution, no
non-loopback listener, and no path from model output or repository content into a command, path, host, or SQL string.

One finding retracts a claim in the self-review below: the at-most-once dispatch fix from this phase does not hold.

## Open findings

### F1 — P2 — At-most-once external dispatch is still broken

`apps/server/src/workflow/external-operation-journal.ts:96`

`#release` deletes the shared per-file map out of the static registry once it empties, while journals that already
hold it keep the orphaned map. A journal constructed after that point gets a fresh empty map, cannot see the
in-flight operation, reads `running`, reconciles to `not_started`, and dispatches the same operation again.

Reproduced twice by the reviewer, including across two separate SQLite connections to one file, with a doubled
dispatch count for one operation ID.

Not reachable in the shipped service: `ExternalOperationJournal` is instantiated only in tests. It becomes reachable
when Phase 1 adds the runner journal, which is the at-most-once guarantee the phase exists to prove.

Why the suite missed it: the dedup test constructs both journals before any operation runs, so the registry entry is
still live. The `SIGKILL` test asserts the fake remote's idempotency, not Slice's dispatch control.

### F2 — P2 — `payload_hash` depends on the host locale

`apps/server/src/state/application-state.ts:20`

Canonical JSON sorts object keys with `localeCompare`, so the hash of one payload changes with `LANG`. The reviewer
showed `en_US.UTF-8` and `sv_SE.UTF-8` disagreeing on a multi-key payload, and a byte-identical retried request
rejected with `IdempotencyConflictError` across locales. It fails safe, blocking rather than duplicating, but it
turns a recoverable crash into an operation needing manual intervention. Single-key payloads such as the adapter's
`{ content }` collate identically everywhere, which is why the suite passes.

### F3 — P3 — State files are created world-readable

`apps/server/src/main.ts:18`. `state.sqlite`, its `-wal` and `-shm`, and `owner.sqlite` are created `0644`. The
`0700` parent directory is the only protection, which makes the directory check load-bearing for the whole store.

### F4 — P3 — A symlinked `SLICE_STATE_DIR` is followed silently

`apps/server/src/main.ts:17`. `statSync` follows symlinks. An attacker who can write the *parent* of the configured
path can plant a symlink and have Slice create and trust its entire store, pre-seedable with a crafted
`state.sqlite`, inside a directory they own. No race required; this defeats the permission check outright rather
than winning a timing window.

### F5 — P3 — An empty `SLICE_STATE_DIR` writes state into the working directory

`apps/server/src/main.ts:17`. `??` does not catch an empty string, and `resolve("")` is the working directory.
`.gitignore` only covers `/.slice/`, so transcripts could be committed.

### F6 — P3 — Shutdown can block forever, holding the owner lock

`apps/server/src/main.ts:58`. `server.close()` waits for every connection with no timeout. The reviewer held
shutdown open past `headersTimeout` with a trickled request, so `lock.release()` never runs and a restart fails
until the old process is killed.

### F7 — P3 — Unbounded growth in the request index and journal

`apps/server/src/state/application-state.ts:44`. No cap, TTL, or prune for either table; `result_json` is unbounded;
`threadId` enters the primary key unvalidated, unlike `requestId`.

### F8 — P3 — `hashJson` recursion is unbounded

`apps/server/src/state/application-state.ts:13`. Deep JSON overflows the stack at roughly depth 5000, before any
write. Phase 1 payloads will carry untrusted issue text.

### F9 — P3 — `config/examples/local.env` is not ignored

`.gitignore`. The example is `local.env.example`; its natural copy target matches no ignore rule, so a real
`SLICE_LOCAL_API_KEY` written there would be committable.

### F10 — P3 — No `Host` validation on the listener

`apps/server/src/main.ts:36`. Harmless now; becomes a DNS-rebinding vector when Phase 1 adds cookie-authenticated
endpoints.

### F11 — P3 — `SLICE_LOCAL_BASE_URL` is not constrained to a local host

`apps/server/src/adapters/models/configured-models.ts:47`. Only scheme and userinfo are checked, so a link-local
address such as `169.254.169.254` is accepted and the API key is sent to it. Configuration-only, so hardening.

### F12 — P3 — Windows silently skips the state privacy check

`apps/server/src/main.ts:19`. The `process.platform !== "win32"` guard skips enforcement instead of refusing to
start.

### F13 — P3 — Handle leaks on partial startup failure

`apps/server/src/state/application-state.ts:66` leaks the database handle if the DDL throws, and
`apps/server/src/adapters/pi-durable/pi-durable-adapter.ts:34` leaks the storage handle if `Harness.open` throws.

### F14 — P3 — Smaller items

`server.once("error", rejectListen)` is never removed after a successful listen, so later server errors are
swallowed. The API key control-character guard covers C0 and DEL but not `U+0085` or `U+2028`. An explicit
`undefined` in a payload yields a confusing `TypeError`. `docs/phase0-results.md` commits a LAN hostname and port.
The recorded recovery timings did not reproduce on the reviewer's fourth sample. Thirty commits share only two
distinct subjects, which weakens the commit-bound evidence the specification asks for.

## Self-review evidence, as checked by the independent reviewer

| Property | Self-review said | Reviewer verdict |
| --- | --- | --- |
| No SQL built by string interpolation | Pass | Confirmed; all 12 sites use bound parameters |
| No command execution from Slice | Pass | Confirmed; imports limited to five `node:` builtins |
| Credentials absent from source and config | Pass, "no `Bearer` literal in any tracked file" | Property confirmed, **stated evidence false**: two test files contain synthetic `Bearer` literals |
| Credentials refused in logged or stored config | Pass | Confirmed; `new URL` fails with a bare message and does not echo the input |
| Model endpoints restricted to configured hosts | Pass | Confirmed with a qualification; see F11 |
| State directory private to its owner | Pass | Confirmed with gaps; see F3 and F4 |
| One process owns a state directory | Pass | Confirmed; `busy_timeout=0` plus `BEGIN IMMEDIATE`, fails closed |
| Service not reachable off the host | Pass | Confirmed; loopback listener only, external address refused |
| Minimal HTTP surface | Pass | Confirmed across 14 request variants |
| Untrusted input bounded | Pass | **Partially refuted**: `threadId` unvalidated, `hashJson` unbounded depth, no retention bound |
| External dispatch at most once | Pass | **Refuted**; see F1 |
| Model output never trusted as policy | Pass | Confirmed; no model-derived value reaches a command, path, host, or SQL text |
| No secrets in logs | Pass with a note | Confirmed; worst case is a filesystem path |

## Confirmed clean

SQL injection, command execution, prompt-injection and trust boundaries, `ReDoS` in the three anchored validator
regexes, network exposure, and supply-chain spot checks: three direct dependencies pinned exactly, `lockfileVersion`
3, 136 of 136 entries with integrity hashes from the npm registry, three install scripts all from the registry, and
the transitively added `pi-telemetry` contains no network code. The approved specification and mockups are
unmodified.

## Accepted risks, as argued by the reviewer

- **Unfiltered startup error text** is low for Phase 0. Every message reachable today is Slice's own text or a
  filesystem or SQLite message whose worst content is a path. Revisit when an authenticated API arrives.
- **The non-atomic permission check** stays low, but for different reasons than the self-review gave: the default
  `.slice` under a non-shared working directory is safe, the specification places state in root-owned
  `/var/lib/slice`, the listener is loopback-only, and the database holds transcripts rather than credentials. The
  author added this risk by considering only a same-user race and did not consider F4's parent-directory attacker,
  who does not need a race at all.

## Next steps, in order

1. Fix F1 and add a regression test that constructs the second journal after an operation has settled and while
   another is in flight.
2. Fix F2 with locale-independent ordering and pin a hash for a key set containing non-ASCII keys.
3. Fix F3 through F6, which are cheap and remove the load-bearing single controls.
4. Fix F7 through F12 and the F14 items.
5. Correct the self-review rows the reviewer refuted.
6. Re-run the independent review over the fixes.
7. Build the OpenAI cloud login, run the cloud smoke test, and record it.
8. Sign off only when the reviewer and the owner both agree, and when the cloud check is no longer "not tested".

## Still required before the gate closes

- An independent reviewer signs off. The author cannot approve this record or close F1 and F2.
- The OpenAI cloud smoke test is **not tested**; it needs an approved cloud model and a credential.
- A dependency review of the three pinned `@earendil-works` packages, which are experimental and unreviewed here.
- Power-loss and host-failure durability is documented as unproven, with `synchronous=NORMAL` in WAL mode.