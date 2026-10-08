# Phase 2 results: deliver a checked PR

Status: **synthetic checks pass (105 Node tests; 23 were added in Phase 2). The live exit check is
not tested** — it needs a disposable GitHub repository with branch protection, a GitHub App, a
branch-writer deploy key, a check-publisher App, and a real SSH runner host, none of which existed
for this run. Synthetic and live results are kept separate below.

## What this phase delivers

- **Author role with a validated patch contract.** The author answers with exactly one JSON object —
  a unified git diff plus a summary, or a blocked declaration. The control service validates the patch
  before it reaches a workspace: size limits, at most 100 files, no absolute paths, no `..` escapes,
  and no writes to `.github/`, `.slice/`, `.git/`, or `.gitmodules`, so a PR cannot edit its own gate.
  The runner is the only thing that commits: `apply_change` runs `git apply --check`, then
  `apply --index`, then a commit stamped `slice-op:<operationId>`. An expected-parent guard makes a
  racing or replayed apply fail loudly instead of stacking commits.
- **Independent review with distinct model identities.** `SLICE_AUTHOR_*`, `SLICE_CODE_REVIEW_*`, and
  `SLICE_SECURITY_REVIEW_*` must all be configured together, and the service refuses to start when any
  two resolve to the same provider and model id. Reviewers run in fresh conversations that never fork
  the author's transcript, receive the requirements, the full patch, the full contents of changed
  files, the check results, and the prior findings. Reports are strict JSON: verdict
  `pass | changes_required | unable_to_review` plus findings with stable id, severity, category, file,
  claim, impact, correction, verification method, and status. Invalid output gets two formatting
  repairs and then becomes a failed review, never a pass.
- **Findings the author cannot close.** A finding is resolved only by a later report from the same
  role, recorded as `verified_fixed` or `not_applicable` with the resolving review named. Critical,
  high, and medium findings block readiness and cannot be waived. Low and informational findings do
  not block a passing review.
- **Repair rounds with a hard limit.** At most four author→check→review rounds. A failing check, an
  open blocking finding, or a non-passing review schedules the next round with the failure evidence
  fed back to the author. At the limit the job blocks with the recorded reasons; a limit is never
  converted into approval.
- **Verification keys and staleness.** Every check result and review report is bound to a key of
  repository, base commit, head commit, requirements revision, profile revision, and policy version.
  A new head produces a new key, so prior approvals and evidence no longer satisfy the gate, and both
  reviews re-run on the new commit. Acceptance is bound to the same key and goes stale when the key
  changes or when readiness is withdrawn.
- **Deterministic readiness gate.** The gate is application code, not a model: required checks pass on
  the current head, both reviews pass on the same key, no open critical/high/medium finding remains,
  and the worktree is clean. The evaluation is recorded with its input key and reasons.
- **Publishing with host acknowledgement.** Publishing runs as journaled external operations in order:
  push the reviewed commit (a runner-exported git bundle pushed by the control host, which holds the
  publishing credential; the runner never sees it), find-or-create the draft PR, publish the five
  `slice/*` gate checks for exactly that head, promote the draft, then re-read the PR and the statuses.
  The job becomes `ready` only when the PR is open, no longer draft, its head equals the reviewed
  commit, and every required check is acknowledged. An outage leaves the job in `publishing`; a retry
  finds the existing PR instead of creating a second one.
- **Identities that cannot merge.** The git-host client has no merge, push, or protection method — the
  capability is absent from the code, not merely unused. The publisher can create, promote, and annotate
  pull requests only. Merging is the owner's action on the host.
- **Verified merge observation, archiving, and cleanup.** A poll (every 60 seconds, plus on demand)
  reads the PR state; only `merged` with a recorded merge revision whose head matches the reviewed
  head archives the thread. A non-null `merge_commit_sha` on an open PR is a test-merge hint, not
  confirmation, and a closed PR does not archive or clean anything. After a verified merge the final
  packet is exported to persistent artifact storage with digests, then the runner's idempotent
  `cleanup_job` removes exactly that job's workspace — after every operation for the job is confirmed
  stopped, with path containment under the job root and a manifest match. A failed or unreachable
  cleanup leaves the archived thread and all evidence intact and offers a retry.
- **Steering after readiness.** Steering a published job first withdraws readiness: acceptance is
  marked stale, the PR returns to draft, and the gate resets, before the new requirements revision
  runs the full loop again. Steering a merged, archived thread is refused with an explanation.

## Checks run

`npm run check` passes: format, typecheck, build, and 105 Node tests. The Phase 2 tests are real
integration tests, not stubs of the workflow:

- `tests/workflow/delivery.test.ts` drives the whole loop against a **real runner binary**, a **real
  git repository**, a **real bare remote over file://**, real bundle export and push, and faux models
  scripted per role. It proves: the clean path to `ready` with published checks; an intentionally
  faulty author output blocked by the checks, fixed, and re-reviewed on the new commit; a blocking
  review finding blocked, repaired, and both reviews re-run under a new verification key; the round
  limit blocking instead of forcing agreement; a verified merge archiving the job, cleaning only its
  own workspace, and keeping the packet, patches, checks, and merge record; a closed PR not archiving;
  an outage after the host accepted the PR finding the existing PR instead of creating a second; and
  steering withdrawing readiness and re-running the full gate.
- `tests/runner/runner.test.ts` adds `apply_change` (commit, marker, stale-parent refusal, rejected
  garbage patch), interrupted-apply reconciliation by marker commit, `read_source` path containment,
  and `export_commit` refusing anything that is not the branch head.
- `tests/adapters/git-host.test.ts` asserts the client exposes no merge capability, publishes only
  `slice/<name>` contexts, opens only `slice/...` branches as drafts, and never reads an unmerged
  `merge_commit_sha` as a merge.
- `tests/adapters/branch-publisher.test.ts` proves a bundle that does not carry the reviewed commit is
  refused, a remote head outside the recorded lineage blocks the push, https pushes require the token
  environment, and remote URLs may not embed credentials.
- `tests/api/http-api.test.ts` covers the delivery endpoints: no delivery record before delivery runs,
  acceptance refused before readiness, merge observation refused without a configured loop, and
  steering an archived thread refused with `job_archived`.

## Live exit check — not tested

The Phase 2 exit check ("an intentionally faulty author output is blocked, fixed, and reviewed again
on the new commit; a PR becomes ready only after evidence and publication are confirmed; in the
disposable repository all checks and human approval pass, the owner can merge, and the publisher still
cannot; merge archives the job and cleanup removes only its resources while retaining evidence")
requires owner infrastructure that does not exist yet. It stays open until run against:

1. A disposable GitHub repository with branch protection on the target branch.
2. A branch-writer deploy key: it must push `slice/<job>/*` and be refused on the target branch.
3. A GitHub App with `Pull requests: write` and no `Contents: write`: it must create and promote a
   draft PR and be refused at the merge endpoint.
4. A separate check-publisher App bound to the five required `slice/*` checks.
5. A real SSH runner host with the runner installed.

Until then the identity separation is proven only at the code level (the publisher has no merge
capability in its interface) and by the synthetic host in the tests. **Host-side enforcement is
untested.**

## Known limits of Phase 2

- Merge observation is polling only. Webhook intake with delivery deduplication is not implemented;
  the spec's "webhook hint, verified by host read" path is not exercised.
- Model budget reservation, token accounting, and cost settlement are not implemented; only the round
  limit is enforced. The spec's budget rules remain open work.
- Baseline-failure exceptions and owner exceptions are not implemented: a baseline check failure
  blocks the job, and no waiver path exists.
- Escalation review, validation role, browser scenarios, screenshots, and previews belong to Phase 3.
- Periodic status reports and the notification outbox belong to Phase 3; `reportsEnabled` settings are
  stored but nothing acts on them yet.
- GitHub status contexts are published through the commit-statuses API. Required-check binding to a
  GitHub App and merge-queue behaviour are host-side configuration the service verifies only when the
  live onboarding check runs.
- REST draft promotion (`PATCH … {"draft": true|false}`) is used for withdrawal and promotion; it is
  exercised only against the synthetic host.
- The delivery loop resumes on restart by re-reading the recorded stage. A job blocked before the
  restart stays blocked; it is not auto-retried.

## Review rounds

Five independent review passes were run over the Phase 2 diff before this record was written. Each
round is a separate commit and each finding is stated with its consequence:

1. **Loop bounds, ownership, archived read-only.** The advance loop cap (12) was smaller than a
   worst-case four-round delivery (17+ steps), which could stall a job mid-delivery; `reconcile_apply`
   did not check that the operation belonged to the requested job; a merged job stayed `running`;
   answers could still reach an archived thread; a publishing job stuck on an outage waited for a
   restart instead of the periodic sweep.
2. **Gate scheduling from structured data.** The gate decided "the author can fix this" by matching
   the word *check* in reason strings; it now judges from the structured gate inputs, so rewording a
   reason can never change scheduling. (This round also verified, with no change needed, that the git
   bundle crosses the runner channel as base64 — ssh publishing never reads the runner's filesystem —
   and that review repair attempts already use distinct journal request ids.)
3. **Finding ids namespaced by role.** Finding ids are model-supplied text; a code-review and a
   security-review finding could both be called `F1`, and the second was silently dropped by the
   `(job_id, finding_id)` primary key — a security finding could vanish behind a name collision.
   Ids are now stored as `<role>:<id>`, and a resolution that re-uses the namespaced id shown in the
   review context is not doubled.
4. **Undo partial patch application.** The runner's undo paths used `git checkout -- .`, which
   restores the worktree *from the index* — but `git apply --index` had already staged the partial
   application, so a failed apply left applied content staged and copied back. All three undo paths
   now use `git reset --hard HEAD` plus `git clean -fd`.
5. **Documentation accuracy.** Test counts in this record corrected to 105; no code change.

## Running Phase 2 locally

```bash
npm run build
export SLICE_OWNER_PASSWORD='…'                # owner login
export SLICE_GITHUB_TOKEN='…'                  # reads issues; creates/promotes PRs (no merge capability in code)
export SLICE_GIT_PUSH_TOKEN='…'                # branch-writer credential for https remotes
export SLICE_REQUIREMENTS_PROVIDER=… SLICE_REQUIREMENTS_MODEL_ID=…
export SLICE_AUTHOR_PROVIDER=… SLICE_AUTHOR_MODEL_ID=…
export SLICE_CODE_REVIEW_PROVIDER=… SLICE_CODE_REVIEW_MODEL_ID=…   # must differ from the author
export SLICE_SECURITY_REVIEW_PROVIDER=… SLICE_SECURITY_REVIEW_MODEL_ID=…  # must differ from both
export SLICE_RUNNER_MODE=local
export SLICE_RUNNER_ROOT=/srv/slice/jobs
npm run serve
```

For a single-machine trial, register a project whose `gitRemoteUrl` is a local bare repository
(`file:///…/origin.git`) so push, PR bookkeeping, and cleanup can be observed without GitHub. The
three delivery model variables must name three distinct provider/model pairs or the service refuses
to start.
