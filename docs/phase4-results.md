# Phase 4 results — more hosts, release readiness, and rollback evidence

Status: **synthetic checks pass (161 Node tests; 19 were added in Phase 4). The live exit check has
not been run** — it needs a real Windows worker, a real second Linux host, and a real staging
environment. No claim below is presented as a live result.

Phase 4 contract (`docs/build-spec.md`, "Phase 4 Add more hosts and release readiness"): additional
SSH hosts and runner pools, per-project model and privacy rules, capacity limits, Windows build
profiles, cleanup recovery across host outages, release tracking, and rollback rehearsal records,
connecting existing release controls **without giving workers production credentials**. A project
requiring Windows stays disabled until its enforced sandbox and real toolchain checks pass.

## What exists now

### Placement: pools, capacity, and worker OS

- Hosts carry `capacity` (1–64) and an `enabled` flag. A disabled host keeps the work it already has
  and takes no new job.
- Named host pools are registered (`/api/host-pools`); a project may draw from one.
- Placement is decided by Slice, never by a model, in this order: registered host or pool → enabled →
  OS match → free capacity. Every failure is recorded on the job as a stated reason
  (`no_registered_host`, `host_disabled`, `no_matching_host_os`, `no_host_capacity`) with the actual
  occupancy in the detail, e.g. `linux-b 2/2`.
- A job holds its host until cleanup confirms the worktree is gone (`slice_workspaces.released`,
  set only after the runner confirms deletion). A cancelled job releases its slot immediately. A
  job's own workspace never blocks its own re-placement, so delivery re-runs stay possible on the
  host they already occupy.

### Per-project model and privacy rules

- Projects carry `modelRules`: allowed providers, allowed model ids, `allowCloud`, and
  `localOnlyRoles`.
- "Local" is only what the owner lists in `SLICE_LOCAL_PROVIDERS`. It is never inferred from a
  provider's name. A project that forbids cloud models with no local provider configured is
  **blocked with a stated reason**, not quietly run on a cloud model.
- Rules are enforced before the requirements role sees the request, and before any of the three
  delivery roles sees the patch. Malformed rules are normalised at the store boundary: wrong types,
  oversized lists, path-shaped names (`../secrets`), and mixed case never reach a role conversation.

### Windows workers and toolchain attestation

- Hosts accept a drive path root (`D:\slice\jobs`) when `os` is `windows`; shell metacharacters are
  refused on both platforms, for host roots and for workspace paths.
- A Windows project **cannot be created** without declaring the toolchain its build profile needs.
- The runner's `probe_toolchain` operation runs the project's own declared tool commands in the job
  worktree, with a stripped environment (`PATH` only), through the same plain-argv pattern as every
  other operation, and reports each tool's real exit code and the version it actually printed. A
  chained command (`node --version && calc.exe`) is refused per tool.
- Attestations are stored per (host, project) and bound to the project's **profile revision**. A
  missing, failed, partial, stale, or different-command attestation is not ready. Attestations never
  transfer between hosts. Changing the project invalidates its attestation.
- A project with a declared toolchain cannot be activated until a usable host is attested
  (`409 toolchain_unverified`), and its jobs block with that reason before any workspace is prepared.

### Blocked jobs have a retry path

`POST /api/jobs/:id/retry` re-enters the same placement and preparation path after the owner fixes
the environment. `resume` stays reserved for paused jobs; retrying a blocked job without fixing
anything blocks again with the same stated reason.

### Release tracking and rollback rehearsal

- A verified merge records a **release**: commit, branch, PR number, host, and the git bundle retained
  as an evidence artifact. The bundle is now retained at publish time, not only pushed — without it a
  release could not be restored after cleanup.
- A **rollback rehearsal** restores a release into a staging workspace Slice owns on the project's
  registered worker, from the retained bundle, and runs the project's own checks against it. The
  outcome is what the checks reported: `passed`, `failed`, or `uncertain`. A missing, expired, or
  digest-mismatched artifact is `uncertain` with a stated reason, never a silent absence and never a
  pass. Evidence is written as a digest-recorded artifact with a 90-day retention.
- Restore is bundle-verified before git reads it, fetched into the job's own repository, and the
  worktree is reset to exactly the expected commit. Nothing is cloned from a caller-supplied URL and
  nothing is merged.
- **No production credential is involved.** A rehearsal uses the registered worker and Slice's own
  artifact store. Slice still cannot merge (Phase 2 rule unchanged).

### Rollback compatibility evidence in the readiness gate

A change whose patch touches database paths (`migrations/`, `schema/`, `db/`, `database/`, `sql/`, or
a `*.sql` / `*.migration` file) cannot pass the gate without evidence: a **passing rehearsal of the
release a rollback would return to**. The gate records a structured
`rollbackCompatibility` block (required, satisfied, paths, releaseId, rehearsalId). Missing evidence
never schedules a repair round — it is not something the author can write its way out of — and the
job blocks with the reason.

### Cleanup recovery across host outages

Archived threads whose workspace deletion failed or is pending are retried on a 5-minute schedule, and
interrupted staging workspaces are reclaimed. Evidence, release records, and the archived thread are
never touched by this sweep. Cleanup still requires confirmed process termination (Phase 1/3 rule
unchanged).

## Verification

`npm run check` passes: format, typecheck, build, and **161 Node tests** (19 added in this phase).

| Exit-check row | Synthetic stand-in | Status |
|---|---|---|
| A Linux project and a Windows project complete on the correct hosts | `no_matching_host_os` blocks a Windows project until a Windows host is enabled; a Windows project lands on `win-a` and a Linux project never lands on it; Windows roots and workspace paths accept drive paths | **synthetic only** — no real Windows worker or Windows runner was used |
| A previous release is restored in staging using its retained artifact | merge → release with retained bundle → `restoreStaging` restores it into a staging workspace on the real runner and the project's checks pass | synthetic (real git, real runner, fake git host) |
| A database-sensitive change cannot claim easy rollback without compatibility evidence | a patch adding `migrations/001_add_column.sql` is blocked by the gate with the database-paths reason; after a passing rehearsal the same job reaches ready with `rollbackCompatibility.satisfied = true` | synthetic |
| Add two repository projects with different SSH hosts | pool placement across two hosts with distinct capacity; each job records its own host and workspace | synthetic |
| Run one task in each of two repositories | capacity accounting proves two workspaces coexist on one host without sharing a workspace, and a third is refused | synthetic |
| Lose an SSH host | rehearsal and cleanup record `uncertain`/`failed` with a stated reason and are retried | synthetic |
| Disable or remove a registered project | a disabled host keeps existing work and takes none; activation is refused without attestation | synthetic |

Tests use faux models, a real git fixture, a real runner process, a real local preview server, a fake
git host, and a fake Telegram transport. **Nothing in this phase has been run against a real Windows
host, a real second Linux host, or a real staging environment.**

## Limits and honest gaps

- **No Windows runner has been executed.** The Windows path is validated at the registry, placement,
  path-validation, and toolchain-attestation layers. The runner itself has only ever been run on Linux
  in this repository. "Enforced sandbox" for Windows means the same source allowlist, plain-argv
  command pattern, worktree isolation, and lease fencing as Linux — asserted by shared validation, not
  yet demonstrated on Windows.
- A rehearsal occupies a real worker slot and is subject to host capacity. On a single-host project at
  capacity, the owner must raise capacity or free a slot before rehearsing.
- Rollback evidence is a rehearsal pass, not a data-restore proof. It shows the previous revision
  builds and passes the project's checks; it does not prove a database dump restores cleanly.
- `databaseSensitive` is a path-pattern rule. A database change hidden in an unrelated path is not
  detected by it; the review roles remain the backstop for that.
- Model privacy rules constrain which configured profiles may be used for which role on which project.
  They do not redact content; a permitted cloud provider still sees the patch it is given.
- Host pools are static lists the owner registers. There is no auto-discovery and no load balancing
  beyond "first host in registration order with room".
- Release recording depends on a verified merge observation from the git host. A merge Slice cannot
  verify records no release.

## Review rounds

Five independent review passes were run over the Phase 4 diff before this record was written. Each
round is a separate commit; each finding is stated with its consequence:

1. **Attestation binding, staging isolation, journal reuse.** Toolchain evidence was bound to the
   project's profile revision, so pausing and resuming silently invalidated a passing check; it is now
   bound to a digest of the declared probes, and editing probes (which had no path at all) invalidates
   the evidence. Two concurrent rehearsals could share one staging workspace and report results from
   each other's checkout — one rehearsal per project now. A second rehearsal of the same release could
   not re-create its workspace because the journal's settled `prepare` row for the shared staging id
   made the adapter skip preparation; each attempt now gets its own workspace and check operation ids.
2. **Maintenance workspaces leaked host slots.** A rehearsal cleaned its staging workspace but never
   released it, so the host kept counting a slot for a workspace that no longer existed. A second
   toolchain check hit the same settled-`prepare` problem after the first had cleaned its probe
   workspace; each verification now gets its own maintenance workspace, reclaimed by the sweep.
3. **Policy re-checked per step; latest rehearsal wins.** Model and privacy rules were enforced only
   at workspace-ready, so a rule tightened later would still let author and review rounds run on a
   forbidden model; every step of the state machine re-checks now. Rollback evidence had taken the
   best rehearsal ever recorded — a later failure is real signal, so the gate reads the most recent
   rehearsal for the rollback target.
4. **A project chooses its own worker OS.** The web form took a project's required OS from the host
   form's select, so a Linux project could be created as a Windows one by accident.
5. **Full-diff review.** Scope, secrets, generated files, and documentation counts checked; no code
   change beyond this record.

## Running Phase 4 locally

```
SLICE_RUNNER_MODE=ssh
SLICE_SSH_IDENTITY_FILE=...            # pinned known_hosts, StrictHostKeyChecking=yes
SLICE_GIT_PUSH_TOKEN=...               # branch writer only; never in URLs or argv
SLICE_LOCAL_PROVIDERS=ollama           # providers the owner considers local
```

Register a second host with `capacity` and, for a Windows worker, `os: "windows"` and a drive root.
Register a pool, point a project at it, declare the project's `toolchain`, run
`POST /api/projects/<id>/toolchain-check`, then activate the project. After a merge is observed,
`GET /api/projects/<id>/releases` lists the release and `POST .../releases/<id>/restore-staging`
rehearses restoring it.

To reach the Phase 4 exit check, the owner must provide: two Linux hosts (or one Linux and one
Windows host) with the runner installed, two demo repositories, and a staging environment. The
Windows project must be shown completing on the Windows worker with a passing toolchain attestation,
and a previous release must be restored in staging from its retained artifact.
