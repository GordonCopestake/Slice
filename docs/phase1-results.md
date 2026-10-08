# Phase 1 results: responsive requests for registered projects

Status: **synthetic checks pass (82 Node tests). The live exit check is not tested** — it needs two
disposable demo repositories, one Linux runner host, and a browser trial, none of which existed for
this run. Synthetic and live results are kept separate below.

## What this phase delivers

- **Single-owner authentication.** The password is environment-supplied (`SLICE_OWNER_PASSWORD`) and
  stored only as a scrypt derivation. Sessions are HttpOnly, SameSite=Strict cookies; every mutating
  route additionally requires the CSRF token issued at login. Failed logins are counted per process.
- **Project and host registry.** Hosts and projects are registered before work is accepted. A project
  names its repository slug, default branch, allowed host, and a versioned build profile whose commands
  are fixed text — shell metacharacters are refused at registration. Pausing or removing a project
  stops new jobs and leaves a tombstone for history.
- **Jobs from a request or a GitHub issue.** Creation is idempotent per request ID and payload hash;
  reuse with different input is rejected (409) and the job is unchanged. An issue maps to one job with
  its repository, number, URL, and update time recorded; a second request for the same issue returns the
  existing job instead of starting duplicate work; pull requests are excluded from the picker; an issue
  link must name the project's own registered repository.
- **Requirements exchange.** The role answers with exactly one JSON object — a question with choices, or
  a ready declaration with criteria. Anything else blocks the job as a failed task. Questions are
  durable: a restart keeps the pending question, and an answer for a superseded revision is rejected.
- **State page and event reconnection.** The responsive web app (no framework dependencies) shows
  threads, a new-request form, and a job page with live activity, question answers, steering, and
  pause/resume/cancel. The event stream sends a snapshot, then resumes the durable ledger from a cursor;
  closing the browser never affects the job.
- **Pause, cancel, and steering.** Run-state transitions are guarded by the state they leave, so racing
  coordinators cannot double-advance a job. Cancel aborts the durable conversation including background
  tasks, signals remote work first, and records `cancel pending on host` when the host is unreachable.
  A steering command carries a command revision; a stale revision is rejected and returns current state
  without applying the instruction. Steering starts a new requirements revision and invalidates open questions.
- **Runner with journal, supervised operations, and fenced leases.** See `runner/main.ts`. Every runner
  call goes through the Phase 0 external-operation journal: stable operation IDs, at-most-once dispatch,
  and reattach-by-operation-ID instead of replay. A lease generation gates admission; a replacement
  lease waits for reconciliation of the previous generation's running work.
- **Retention (the Phase 0 F7 carry-over).** Terminal request-index and operation rows older than 90
  days are pruned, never the most recent 1000 rows, and never an `uncertain` operation.

## Checks run

`npm run check` passes: typecheck, build, and all 82 Node tests. The runner tests execute the real
runner binary against a real git fixture repository. The API tests drive the real HTTP surface,
including the SSE stream. Model work uses the Pi AI faux provider.

Property checks that passed, mapped to the specification's required verification:

| Check | Result |
|---|---|
| Retry the same web submission | One job, one pending requirements exchange |
| Reuse a request ID with different input | 409; existing job unchanged |
| Restart during requirements | Pending question survives in durable state (store test) |
| Answer for an old question after requirements changed | Rejected; revision unchanged |
| Steering with an old command revision | Rejected; current state returned; model not called |
| Report interval outside 1–60 | Rejected without changing the saved interval |
| Select a GitHub issue | One job with repository, number, URL, and update time recorded |
| Select a pull request in the picker | Excluded at the adapter and unselectable at the API |
| Issue that already has a job | Existing job returned; no duplicate started |
| Attempt a second store owner | Still enforced by the Phase 0 single-owner lock (service test) |
| Cancel during remote work | Group cancel signalled; uncertain remote state stays visible |
| Change an SSH host key | Transport refuses (fake-ssh test shows the 255 path surfaces) |
| Service crashes after starting a named remote operation before recording its PID | Runner reconcile reports uncertain; no duplicate dispatch |
| Restart after remote process start | Journal reattaches by operation ID; dispatch count stays one |
| Worktree path fails manifest checks | Runner refuses cleanup with `manifest_mismatch` and deletes nothing |
| Two projects, two jobs | Each job records its own project profile revision, host, and workspace paths |

## Not tested (live exit check)

The Phase 1 exit check — a user submitting a small change from phone and desktop browsers against two
disposable demo repositories on one Linux runner, answering a question, steering, closing and
reconnecting — **was not run**: it needs demo repositories, an SSH runner host with the runner
installed and its host key pinned, and a real browser session. Until it runs, treat Phase 1 as
synthetically verified only. The GitHub issue reads were tested against a stubbed GitHub, not live.

## Limits and known gaps

- **TLS is not terminated by Slice.** The service listens on loopback only. The web app must sit behind
  the TLS reverse proxy the specification requires; set `SLICE_COOKIE_SECURE=1` there. Until then the
  cookie is not `Secure`, which is safe on loopback and unsafe anywhere else.
- **No HTTPS enforcement or HSTS**; the proxy owns that.
- **Status reports are stored settings, not yet generated.** Interval and enable/disable persist and
  validate now; the 10-minute report generator and the notification outbox are Phase 3.
- **Steering is recorded and starts a new requirements revision**, but the full impact classification
  (clarification / constraint / scope change) and evidence invalidation across reviews and checks arrive
  with the review gates in Phase 2.
- **The author conversation and PR creation are Phase 2.** A Phase 1 job ends in `implementation` with
  the workspace prepared and the baseline checks recorded.
- **Runner sources are public clones for now.** Private demo repositories need a runner-side credential
  (deploy key) that is not yet wired; the runner only accepts allowlisted sources.
- **The web app is a small dependency-free SPA**, not the Vue 3 layout from the mockups. The spec calls
  Vue "proposed"; the same thread and project structure is preserved at phone and desktop widths, but
  the polished mockup layouts, the timeline view, and the archived-thread picker are Phase 3 work.
- **Login state is cookie-only and the CSRF token is returned once at login**, so a page reload requires
  re-authentication. A session-refresh flow is a small follow-up, not a gate item.
- **No rate limiting beyond the per-process login guard**; the proxy owns network-level limits.
- **Power-loss durability remains as documented in Phase 0** (`synchronous=NORMAL` WAL).

## Running Phase 1 locally

```sh
export SLICE_OWNER_PASSWORD='a-long-owner-password'   # enables /api and the web app
export SLICE_REQUIREMENTS_PROVIDER=slice-local        # or openai-codex after npm run auth:openai
export SLICE_REQUIREMENTS_MODEL_ID=your-model-id
export SLICE_RUNNER_MODE=local                        # single-machine demo runner
export SLICE_RUNNER_ROOT=$PWD/.slice/runner-root      # create it and put allowed sources in .runner.json
npm run check && npm start
```

Open `http://127.0.0.1:3000/`, sign in, register a host and a project, then start a request. For an SSH
runner, set `SLICE_RUNNER_MODE=ssh`, `SLICE_RUNNER_ENTRY` (absolute path of `dist/runner/main.js` on the
host), and place the host's key in `.slice/known_hosts/<hostId>` before use; the transport refuses to
run without the pin. `SLICE_SSH_IDENTITY_FILE` and `SLICE_GITHUB_TOKEN` are read from the environment
only. Never commit credentials.
