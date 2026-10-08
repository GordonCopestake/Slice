# Phase 3 results: evidence, thread history, and notifications

Status: **synthetic checks pass (133 Node tests; 28 were added in Phase 3). The live exit check is
not tested** — it needs a phone/tablet/desktop browser trial against a running service with a real
preview, and a linked Telegram account, none of which existed for this run. Synthetic and live
results are kept separate below.

## What this phase delivers

- **Durable calibrated status reports.** Each job has a reporting plan (interval, generation, next
  due time) and immutable report records unique per job, generation, and due time. The default
  interval is 10 minutes; the owner can set 1–60 minutes or turn reports off for that job. A
  scheduler tick coalesces overdue boundaries into **one current report**, never a backlog; a
  restart at a boundary produces exactly one report for that time and recovers the next due time.
  Reaching ready, confirmed cancellation, terminal failure, or archive records one final update and
  stops periodic reports. Steering and settings changes start a new generation, which invalidates
  queued deliveries of the old one.
- **Reports without a model.** A routine report is built only from committed workflow events, runner
  state, completed checks, and durable records. Event types map to approved plain-language phrases;
  unknown events render as generic activity; raw commands, payloads, action logs, and model text
  never enter a report. Paused, waiting, and blocked jobs keep reporting and say what they are.
- **Calibrated ETA.** Estimates come from comparable completed jobs in the same project and stage:
  median with a min–max range, cohort size, and the mean error of past estimates measured against
  finished jobs. With no comparable history the report states the remaining time cannot yet be
  estimated. Estimates carried by reports are scored when the job finishes.
- **Notification outbox with honest delivery states.** Every notification has a stable
  deduplication ID: a retried delivery re-uses one row, so one report appears in history and the
  retry shows as delivery state (`queued → sent/failed/uncertain/suppressed`) with attempt counts
  and backoff. A send whose outcome is unknown is `uncertain` and is never blindly replayed.
  Before every send the service re-checks the link, the reporting generation, and expiry, and
  suppresses stale work instead of retrying it forever. Notification failure never stops work.
- **Telegram alerts and linking without webhooks.** Alerts (question waiting, blocked, patch
  rejected, ready, merged, cleanup pending) come from the durable event ledger with a per-job
  cursor, so a restart neither loses nor duplicates one. Periodic Telegram reports are opt-in per
  channel and per job. Account linking uses a single-use 15-minute code the owner sends to the
  bot; a getUpdates poll confirms it. The bot token only appears in the live request URL — never
  in argv, logs, stored rows, or model context.
- **Result page, searchable picker, archived views.** The thread picker has Active and Archived
  views, searchable by title, project, job id, PR number, branch, and creation date; searching
  reads records only and never attaches to or resumes a worker. An archived thread opens as a
  result page: reports, delivery evidence, merge record, acceptance, retained artifacts with
  retention state, and a linked follow-up form. Follow-up creates a new thread; the archived one
  stays untouched and read-only.
- **Evidence retention and safe download.** Evidence artifacts live outside the workspace and
  survive cleanup for the configured retention period (365 days). Downloads go through the control
  service as attachments (evidence can never execute inside the authenticated page) after a
  sha256 check against the recorded digest. An expired artifact returns 410 with its manifest
  record — kind, digest, expiry — intact. Artifact ids are validated against the job; a URL
  parameter never becomes a path.
- **Isolated previews and screenshot evidence.** A project may declare a preview command (plain
  argv like a build check), a port, and 1–10 browser scenarios (route + viewport). The runner runs
  the preview as a supervised, journaled process; `capture_screenshot` runs the **registered**
  headless browser (absolute path in the runner configuration, never a model-supplied command)
  against the job's own preview loopback at the stated commit. Baseline images are captured at the
  recorded base revision and 'after' images on the reviewed head, with the same scenarios and
  viewports; each is stored as a binary artifact plus a metadata artifact (scenario, route,
  viewport, commit, phase, capture time). A project with no preview states screenshots are **not
  applicable**; a failed capture is stated as failed. Closing a preview page never affects the job.
  Cleanup stops the preview first and the runner refuses deletion while any operation is unsettled.

## Checks run

`npm run check` passes: format, typecheck, build, and 133 Node tests. The Phase 3 tests map onto the
spec's verification table:

| Verification | Result |
|---|---|
| New job starts with reports enabled | Plan seeded at creation; first report due `createdAt + 10 min` |
| Valid custom interval | Applied; next due time recomputed; job view shows the same setting |
| Interval outside 1–60 | 400 `interval_out_of_range`; saved interval and generation unchanged |
| Reports off for one job | No periodic reports; alerts still queue |
| Restart at a report boundary | One report for that due time; next due time recovered |
| Several missed ticks | One current report; next tick scheduled in the future |
| Paused across a boundary | Report says paused and claims no active progress |
| Job finishes or is cancelled | One final report; plan final; no later periodic report |
| Report text for private reasoning or raw commands | Test asserts build commands never appear |
| No comparable history | Report states the remaining time cannot yet be estimated |
| Comparable history | Range, cohort size, and measured estimate error |
| Telegram periodic delivery off | Report stays in the web thread; nothing queued for Telegram |
| A report notification is retried | One row; status `queued → sent` with attempts 2 |
| Uncertain Telegram delivery | Status `uncertain`, no replay scheduled |
| Stale generation / expired notification | Suppressed before sending; nothing sent |
| Open a prior archived thread from the picker | Correct project, PR number, and read-only enforcement |
| Search archived threads by PR number and title | Matches without touching a worker |
| Reopen a merged thread for follow-up | Linked new job; archived thread unchanged and read-only |
| Open archived result after worktree deletion | Packet, screenshots, merge record, and artifacts remain |
| Evidence artifact reaches retention expiry | 410 with manifest intact; UI shows expired state |
| Workspace deletion with a preview running | Runner refuses until the preview is confirmed stopped |
| Screenshot capture without a registered browser | Refused `browser_not_configured`; stated, never invented |

The preview test is a full delivery run: real runner binary, real preview server in the fixture
repository, a registered fake browser, baseline and after captures at two different commits, and
survival of the screenshot artifacts after merge cleanup.

## Live exit check — not tested

The Phase 3 exit check ("the user can assess the result from an iPhone, iPad, or desktop browser
without opening source files; closing a preview does not stop the job; evidence remains accessible
after workspace cleanup") has **not** been run against real devices and a real service. The synthetic
run proves the server-side halves (evidence survives cleanup; the preview is an independent runner
process), but the browser-assessment half needs an owner trial. It stays open until run with:

1. A phone and a desktop browser against the running web app.
2. A real project with a preview and at least one browser scenario, and a registered browser on the runner host.
3. A linked Telegram account receiving one alert and one opt-in periodic report.

## Known limits of Phase 3

- Telegram linking polls `getUpdates`; webhook delivery, inline requirement answers, and Telegram
  commands (Phase 5) are not implemented. Alerts are one-way.
- Telegram delivery deduplication is per notification id. An `uncertain` send can still produce an
  occasional duplicate message on Telegram itself; the outbox states this honestly rather than
  replaying.
- Reports show provider spend as "not yet tracked": Phase 2 did not implement token/cost accounting,
  and a report never invents a number.
- ETA calibration cohorts are same-project, same-stage completed jobs; a project with few completed
  jobs will say "cannot yet be estimated" for a long time. That is the calibrated behaviour, not a
  bug.
- Screenshots require a registered headless browser on the runner host. Without one, projects with
  preview scenarios record `screenshot_failed` events; the gate does not treat missing screenshots
  as passing evidence, and nothing is invented.
- The preview is reachable on the runner host's network (the URL is recorded in the thread); the
  control service does not proxy preview traffic through the authenticated origin. Preview
  authentication and reverse-proxy policy are deployment concerns (see spec: preview routing is
  separate from the control UI).
- Chromium's own sandbox is left at its default; the runner never adds `--no-sandbox`.
- Archived search is a substring match over a bounded haystack, not full-text search.

## Review rounds

Five independent review passes were run over the Phase 3 diff before this record was written. Each
round is a separate commit; each finding is stated with its consequence:

1. **Preview re-plan, long ledgers, Telegram offsets.** A second preview phase reused the first
   phase's operation id — it only worked while the first preview was still alive, and a preview that
   had died would make the 'after' captures fail; phases now use distinct ids and a dead preview is
   reconciled first. Status reports and calibration read the whole event ledger instead of the first
   200 events. Telegram's getUpdates offset is the global `update_id`, not the message id, so a spent
   link message is never re-read.
2. **Follow-up reporting plan.** A follow-up job created from an archived thread carried no reporting
   plan and would never report; it is now registered like any new job.
3. **Web search focus and checkbox state.** The thread search re-rendered the whole view per
   keystroke, dropping focus and typed text (a real problem on phones); only the results now update.
   The element helper set `checked` as an attribute, so a false value still rendered a checked box —
   the reports-off and Telegram-periodic toggles were inverted on load.
4. **Confirmed termination before settling.** `stop_preview` settled the journal row the instant it
   signalled, so a following cleanup could delete while the preview was still dying; it now waits for
   confirmed termination, and a still-shutting-down preview leaves cleanup to refuse and retry.
5. **Full-diff review.** Scope, secrets, generated files, and documentation counts checked; no code
   change beyond this record.

## Running Phase 3 locally

```bash
npm run build
export SLICE_OWNER_PASSWORD='…'
# Optional Telegram alerts. Environment only; never committed or logged.
# SLICE_TELEGRAM_BOT_TOKEN=replace-outside-this-file
…(Phase 2 variables)…
npm run serve
```

A project registers a preview at creation:

```json
{ "projectId": "demo", "…": "…",
  "preview": { "command": "node preview-server.js 8123", "port": 8123,
    "scenarios": [{ "id": "home", "route": "/", "width": 800, "height": 600 }] } }
```

and the runner host records the browser in `<runnerRoot>/.runner.json`:

```json
{ "allowedSources": ["file:///srv/slice/demo/origin.git"], "allowedBrowser": "/usr/bin/chromium" }
```
