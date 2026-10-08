import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ApplicationStateStore } from "../../apps/server/src/state/application-state.js";
import { WorkflowStore, type BuildProfile } from "../../apps/server/src/records/workflow-store.js";
import { StatusStore } from "../../apps/server/src/records/status-store.js";
import { StatusReports, DEFAULT_REPORT_INTERVAL_MINUTES } from "../../apps/server/src/workflow/status-reports.js";

const PROFILE: BuildProfile = { setup: ["npm ci"], checks: [{ id: "test", command: "npm run test-suite --secret-flag" }] };

type Stack = {
  state: ApplicationStateStore;
  workflows: WorkflowStore;
  status: StatusStore;
  reports: StatusReports;
  cleanup: () => void;
};

function stack(): Stack {
  const directory = mkdtempSync(join(tmpdir(), "slice-reports-"));
  const state = ApplicationStateStore.open(join(directory, "state.sqlite"));
  const workflows = WorkflowStore.open(state.database);
  workflows.registerHost({ hostId: "runner-a", address: "runner.internal", os: "linux", sshUser: "slice", runnerRoot: "/srv/slice/jobs" });
  workflows.createProject({ projectId: "demo", repoSlug: "owner/demo", defaultBranch: "main", hostId: "runner-a", buildProfile: PROFILE });
  const status = StatusStore.open(state.database);
  const reports = new StatusReports({ workflows, deliveryStore: null, status });
  return { state, workflows, status, reports, cleanup: () => { state.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function makeJob(h: Stack, requestId: string): ReturnType<WorkflowStore["getJob"]> {
  const { job } = h.workflows.createJob({ requestId, payloadHash: `hash-${requestId}`, projectId: "demo", title: `Job ${requestId}`, requestText: "Add a screen.", issue: null });
  h.reports.onJobCreated(job!);
  return h.workflows.getJob(job!.jobId);
}

function firstReport(h: Stack, jobId: string): Record<string, unknown> {
  const [first] = h.reports.reportsFor(jobId);
  assert.ok(first !== undefined, "expected a report");
  return first.report;
}

test("a new job schedules its first report one default interval after creation", () => {
  const h = stack();
  try {
    const job = makeJob(h, "r1")!;
    assert.equal(DEFAULT_REPORT_INTERVAL_MINUTES, 10);
    const plan = h.reports.planFor(job.jobId)!;
    assert.equal(plan.enabled, true);
    assert.equal(plan.intervalMinutes, 10);
    assert.equal(plan.nextReportAt, job.createdAt + 600_000, "first report is due 10 minutes after creation");
    // Not due yet: a tick at creation time produces nothing.
    assert.equal(h.reports.tick(job.createdAt + 1_000), 0);
    assert.equal(h.reports.tick(job.createdAt + 600_000), 1);
    const reports = h.reports.reportsFor(job.jobId);
    assert.equal(reports.length, 1);
    const report = reports[0]?.report as Record<string, unknown> | undefined;
    assert.ok(report !== undefined);
    const text = JSON.stringify(report);
    // Approved fields only: no raw build command or setup text may appear in a routine report.
    assert.ok(!text.includes("npm run test-suite"), "raw commands must not enter reports");
    assert.ok(!text.includes("npm ci"), "setup commands must not enter reports");
    assert.ok((report.eta as { note: string }).note.includes("cannot yet be estimated"), "no history: the ETA says it cannot be estimated");
    assert.equal(report.spend !== undefined, true);
    assert.equal(typeof report.nextReportAt, "number");
  } finally { h.cleanup(); }
});

test("overdue ticks coalesce into one current report, and a restart recovers the next due time", () => {
  const h = stack();
  try {
    const job = makeJob(h, "r1")!;
    // The service was down across three report boundaries.
    const late = job.createdAt + 600_000 * 3 + 5_000;
    assert.equal(h.reports.tick(late), 1, "missed ticks produce one current report, not a backlog");
    const plan = h.reports.planFor(job.jobId)!;
    assert.ok(plan.nextReportAt !== null && plan.nextReportAt > late, "the next tick is scheduled in the future");
    // Restart at a report boundary: a fresh service over the same state produces exactly one report.
    const revived = new StatusReports({ workflows: h.workflows, deliveryStore: null, status: h.status });
    assert.equal(revived.tick(plan.nextReportAt!), 1);
    assert.equal(revived.tick(plan.nextReportAt!), 0, "the same due time is never recorded twice");
    const reports = h.reports.reportsFor(job.jobId);
    const dueTimes = new Set(reports.map((report) => report.dueAt));
    assert.equal(dueTimes.size, reports.length, "one record per due time");
  } finally { h.cleanup(); }
});

test("report settings: valid intervals apply, invalid intervals are rejected without changing the saved value", () => {
  const h = stack();
  try {
    const job = makeJob(h, "r1")!;
    const before = h.reports.planFor(job.jobId)!;
    assert.throws(() => h.reports.settingsChanged(job.jobId, true, 0), /between 1 and 60/);
    assert.throws(() => h.reports.settingsChanged(job.jobId, true, 61), /between 1 and 60/);
    const unchanged = h.reports.planFor(job.jobId)!;
    assert.equal(unchanged.intervalMinutes, before.intervalMinutes);
    assert.equal(unchanged.generation, before.generation, "a rejected change starts no new generation");
    const updated = h.reports.settingsChanged(job.jobId, true, 30);
    assert.equal(updated.intervalMinutes, 30);
    assert.equal(updated.generation, before.generation + 1, "a settings change invalidates the old generation's queued deliveries");
    assert.ok(updated.nextReportAt !== null && updated.nextReportAt >= Date.now() + 29 * 60_000);
  } finally { h.cleanup(); }
});

test("turning reports off stops periodic reports", () => {
  const h = stack();
  try {
    const job = makeJob(h, "r1")!;
    h.reports.settingsChanged(job.jobId, false, 10);
    assert.equal(h.reports.tick(job.createdAt + 600_000 * 5), 0);
    assert.equal(h.reports.reportsFor(job.jobId).length, 0);
  } finally { h.cleanup(); }
});

test("a paused job's report says it is paused and claims no active progress", () => {
  const h = stack();
  try {
    const job = makeJob(h, "r1")!;
    h.workflows.setRunState(job.jobId, ["running"], "pause_requested");
    h.workflows.setRunState(job.jobId, ["pause_requested"], "paused");
    h.workflows.appendEvent(job.jobId, "paused", {});
    h.reports.tick(job.createdAt + 600_000);
    const report = firstReport(h, job.jobId) as { blockers: string[]; inProgress: string; time: Record<string, number> };
    assert.ok(report.blockers.some((line) => line.includes("paused")), "the report states the pause");
    assert.ok(report.blockers.some((line) => line.includes("no active worker progress is claimed")));
    assert.ok((report.time.pausedSeconds ?? -1) >= 0);
  } finally { h.cleanup(); }
});

test("a cancelled job records one final status and stops periodic reports", () => {
  const h = stack();
  try {
    const job = makeJob(h, "r1")!;
    h.workflows.setRunState(job.jobId, ["running"], "cancel_requested");
    h.workflows.setRunState(job.jobId, ["cancel_requested"], "cancelled");
    h.workflows.appendEvent(job.jobId, "cancelled", {});
    h.reports.finalize(job.jobId, "the job was cancelled; no further periodic reports will be sent");
    const reports = h.reports.reportsFor(job.jobId);
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.final, true);
    const plan = h.reports.planFor(job.jobId)!;
    assert.equal(plan.final, true);
    assert.equal(plan.nextReportAt, null);
    assert.equal(h.reports.tick(Date.now() + 10_000_000), 0, "no later periodic report is produced");
  } finally { h.cleanup(); }
});

test("steering starts a new reporting generation", () => {
  const h = stack();
  try {
    const job = makeJob(h, "r1")!;
    const before = h.reports.planFor(job.jobId)!.generation;
    h.reports.onSteering(job.jobId);
    const after = h.reports.planFor(job.jobId)!;
    assert.equal(after.generation, before + 1);
    assert.ok(after.nextReportAt !== null && after.nextReportAt > Date.now());
  } finally { h.cleanup(); }
});

test("comparable completed history produces a calibrated range with cohort size and measured error", () => {
  const h = stack();
  try {
    // Three completed jobs in the same project: authoring took 20, 30, and 40 minutes.
    const base = Date.now() - 86_400_000;
    for (const [index, minutes] of [20, 30, 40].entries()) {
      const jobId = `hist-${index}`;
      h.workflows.createJob({ requestId: `hist-req-${index}`, payloadHash: `h${index}`, projectId: "demo", title: `Hist ${index}`, requestText: "r", issue: null });
      h.status.recordCompletion(jobId, "demo", new Map([["authoring", base + index * 1000], ["requirements", base]]), base + minutes * 60_000);
    }
    const job = makeJob(h, "r1")!;
    h.workflows.appendEvent(job.jobId, "author_round", { round: 1 });
    h.reports.tick(job.createdAt + 600_000);
    const report = firstReport(h, job.jobId) as { eta: Record<string, unknown> };
    assert.equal(report.eta.cohortSize, 3);
    assert.equal(report.eta.minSeconds, 20 * 60);
    assert.equal(report.eta.maxSeconds, 40 * 60);
    assert.equal(report.eta.estimateSeconds, 30 * 60);
    assert.ok(String(report.eta.note).includes("3 comparable job(s)"));
    assert.ok(String(report.eta.note).includes("no estimate accuracy measured yet"));
  } finally { h.cleanup(); }
});

test("estimates carried by reports are scored when the job completes", () => {
  const h = stack();
  try {
    // One prior completed job gives the cohort; the current job carries an estimate.
    const base = Date.now() - 86_400_000;
    h.workflows.createJob({ requestId: "hist-req", payloadHash: "h", projectId: "demo", title: "Hist", requestText: "r", issue: null });
    h.status.recordCompletion("hist-1", "demo", new Map([["authoring", base], ["requirements", base]]), base + 30 * 60_000);

    const job = makeJob(h, "r1")!;
    h.workflows.appendEvent(job.jobId, "author_round", { round: 1 });
    h.reports.tick(job.createdAt + 600_000);
    const carried = (firstReport(h, job.jobId) as { eta: { estimateSeconds?: number } }).eta;
    assert.equal(typeof carried.estimateSeconds, "number", "the report carried an estimate to score");

    // The job reaches ready; completion scoring records the carried estimate against reality.
    h.workflows.appendEvent(job.jobId, "ready_for_owner", { prNumber: 1 });
    h.status.recordCompletion(job.jobId, "demo", new Map([["authoring", job.createdAt], ["requirements", job.createdAt]]), Date.now());
    const estimate = h.status.etaFor("demo", "authoring", Date.now());
    assert.ok(estimate !== null && estimate.meanAbsErrorSeconds !== null, "estimate accuracy is measured against the finished job");
  } finally { h.cleanup(); }
});
