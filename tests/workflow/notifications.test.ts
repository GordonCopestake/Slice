import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApplicationStateStore } from "../../apps/server/src/state/application-state.js";
import { WorkflowStore, type BuildProfile } from "../../apps/server/src/records/workflow-store.js";
import { StatusStore } from "../../apps/server/src/records/status-store.js";
import { NotificationStore } from "../../apps/server/src/records/notification-store.js";
import { NotificationService } from "../../apps/server/src/workflow/notifications.js";
import { StatusReports } from "../../apps/server/src/workflow/status-reports.js";
import type { TelegramGateway, TelegramSendOutcome, TelegramMessage } from "../../apps/server/src/adapters/telegram/telegram.js";

const PROFILE: BuildProfile = { setup: [], checks: [{ id: "test", command: "npm test" }] };

type FakeTelegram = TelegramGateway & { outcomes: TelegramSendOutcome[]; sent: { chatId: string; text: string }[]; messages: TelegramMessage[]; offsetSeen: number };

function fakeTelegram(outcomes: TelegramSendOutcome[]): FakeTelegram {
  return {
    outcomes,
    sent: [],
    messages: [],
    offsetSeen: 0,
    async sendMessage(chatId: string, text: string): Promise<TelegramSendOutcome> {
      this.sent.push({ chatId, text });
      return this.outcomes[this.sent.length - 1] ?? this.outcomes[this.outcomes.length - 1] ?? { status: "sent" };
    },
    async getUpdates(offset: number): Promise<TelegramMessage[]> {
      this.offsetSeen = offset;
      return this.messages;
    },
  };
}

type Stack = {
  cleanup: () => void;
  workflows: WorkflowStore;
  status: StatusStore;
  outbox: NotificationStore;
  service: NotificationService;
  telegram: FakeTelegram;
  makeJob: (id: string) => string;
};

function stack(outcomes: TelegramSendOutcome[] = [{ status: "sent" }]): Stack {
  const directory = mkdtempSync(join(tmpdir(), "slice-notify-"));
  const state = ApplicationStateStore.open(join(directory, "state.sqlite"));
  const workflows = WorkflowStore.open(state.database);
  workflows.registerHost({ hostId: "runner-a", address: "runner.internal", os: "linux", sshUser: "slice", runnerRoot: "/srv/slice/jobs" });
  workflows.createProject({ projectId: "demo", repoSlug: "owner/demo", defaultBranch: "main", hostId: "runner-a", buildProfile: PROFILE });
  const status = StatusStore.open(state.database);
  const outbox = NotificationStore.open(state.database);
  const telegram = fakeTelegram(outcomes);
  const service = new NotificationService({ workflows, notifications: outbox, status, telegram });
  const makeJob = (id: string): string => workflows.createJob({ requestId: id, payloadHash: `h-${id}`, projectId: "demo", title: `Job ${id}`, requestText: "r", issue: null }).job!.jobId;
  return { cleanup: () => { state.close(); rmSync(directory, { recursive: true, force: true }); }, workflows, status, outbox, service, telegram, makeJob };
}

test("the outbox deduplicates by stable ID: a retry re-uses one notification row", async () => {
  const h = stack();
  try {
    const jobId = h.makeJob("j1");
    h.outbox.setChatId("42");
    const first = h.outbox.enqueue({ notificationId: "report:j1:1:100", jobId, kind: "report", generation: 1, channel: "telegram", recipientRef: "42", payload: { dueAt: 100 }, expiresAt: Date.now() + 60_000 });
    const second = h.outbox.enqueue({ notificationId: "report:j1:1:100", jobId, kind: "report", generation: 1, channel: "telegram", recipientRef: "42", payload: { dueAt: 100 }, expiresAt: Date.now() + 60_000 });
    assert.equal(first, true);
    assert.equal(second, false, "the same deduplication ID never queues a second message");
    assert.equal(h.outbox.listForJob(jobId).length, 1);
  } finally { h.cleanup(); }
});

test("a failed delivery retries the same notification and the history shows the attempts", async () => {
  const h = stack([{ status: "failed", reason: "refused" }, { status: "sent" }]);
  try {
    const jobId = h.makeJob("j1");
    h.outbox.setChatId("42");
    h.outbox.enqueue({ notificationId: "alert:j1:5", jobId, kind: "alert", generation: 1, channel: "telegram", recipientRef: "42", payload: { type: "question_asked" }, expiresAt: Date.now() + 3_600_000 });
    assert.equal(await h.service.deliverDue(Date.now() + 1), 0);
    let row = h.outbox.listForJob(jobId)[0]!;
    assert.equal(row.status, "queued", "a refused send stays retryable");
    assert.equal(row.attempts, 1);
    assert.ok(row.nextAttemptAt !== null && row.nextAttemptAt > Date.now());
    assert.equal(await h.service.deliverDue((row.nextAttemptAt ?? 0) + 1), 1);
    row = h.outbox.listForJob(jobId)[0]!;
    assert.equal(row.status, "sent");
    assert.equal(row.attempts, 2);
    assert.equal(h.outbox.listForJob(jobId).length, 1, "one report appears in history; the retry is a status, not a second record");
  } finally { h.cleanup(); }
});

test("an uncertain send is recorded as uncertain and never blindly replayed", async () => {
  const h = stack([{ status: "uncertain", reason: "outcome unknown" }]);
  try {
    const jobId = h.makeJob("j1");
    h.outbox.setChatId("42");
    h.outbox.enqueue({ notificationId: "alert:j1:5", jobId, kind: "alert", generation: 1, channel: "telegram", recipientRef: "42", payload: { type: "blocked" }, expiresAt: Date.now() + 3_600_000 });
    await h.service.deliverDue(Date.now() + 1);
    const row = h.outbox.listForJob(jobId)[0]!;
    assert.equal(row.status, "uncertain");
    assert.equal(row.nextAttemptAt, null, "uncertain work is reconciled or left visible, never replayed blindly");
    assert.equal(await h.service.deliverDue(Date.now() + 10_000), 0);
  } finally { h.cleanup(); }
});

test("expired and stale-generation notifications are suppressed before sending", async () => {
  const h = stack();
  try {
    const jobId = h.makeJob("j1");
    h.outbox.setChatId("42");
    h.outbox.enqueue({ notificationId: "alert:j1:exp", jobId, kind: "alert", generation: 1, channel: "telegram", recipientRef: "42", payload: { type: "blocked" }, expiresAt: Date.now() - 1 });
    const plan = h.status.ensurePlan({ jobId, reportsEnabled: true, reportIntervalMinutes: 10, createdAt: Date.now() });
    h.outbox.enqueue({ notificationId: `report:${jobId}:1:${plan.nextReportAt}`, jobId, kind: "report", generation: 1, channel: "telegram", recipientRef: "42", payload: { dueAt: plan.nextReportAt }, expiresAt: Date.now() + 3_600_000 });
    h.status.setPlanSettings(jobId, true, 20); // generation 2: the queued generation-1 report is stale
    assert.equal(await h.service.deliverDue(Date.now() + 1), 0);
    const rows = h.outbox.listForJob(jobId);
    assert.deepEqual(rows.map((row) => row.status).sort(), ["suppressed", "suppressed"]);
    assert.equal(h.telegram.sent.length, 0, "nothing was sent");
  } finally { h.cleanup(); }
});

test("periodic Telegram delivery is opt-in: unlinked or disabled queues nothing", () => {
  const h = stack();
  try {
    const jobId = h.makeJob("j1");
    h.status.ensurePlan({ jobId, reportsEnabled: true, reportIntervalMinutes: 10, createdAt: Date.now() });
    h.service.enqueueReport(jobId, Date.now());
    assert.equal(h.outbox.listForJob(jobId).length, 0, "no link: no periodic Telegram notification");
    h.outbox.setChatId("42");
    h.service.enqueueReport(jobId, Date.now());
    assert.equal(h.outbox.listForJob(jobId).length, 0, "linked but periodic Telegram is off");
    h.outbox.setPeriodicEnabled(true);
    h.service.enqueueReport(jobId, Date.now());
    assert.equal(h.outbox.listForJob(jobId).length, 1, "the web thread always has the report; Telegram is the opt-in copy");
  } finally { h.cleanup(); }
});

test("alerts come from the durable event ledger and are scanned exactly once", () => {
  const h = stack();
  try {
    const jobId = h.makeJob("j1");
    h.outbox.setChatId("42");
    h.workflows.appendEvent(jobId, "question_asked", { questionId: "q1" });
    h.service.scanAlerts();
    h.service.scanAlerts();
    const rows = h.outbox.listForJob(jobId);
    assert.equal(rows.length, 1, "the cursor means one alert per event, not one per scan");
    assert.equal(rows[0]!.kind, "alert");
    // Events that are not alert-worthy never queue anything.
    h.workflows.appendEvent(jobId, "head_check_result", { checkId: "test", status: "succeeded" });
    h.service.scanAlerts();
    assert.equal(h.outbox.listForJob(jobId).length, 1);
  } finally { h.cleanup(); }
});

test("account linking confirms only the current single-use code and records the offset", async () => {
  const h = stack();
  try {
    const code = h.service.startLinkCode();
    h.telegram.messages = [{ updateId: 7, messageId: 7, chatId: "chat-99", text: `/link ${code}` }];
    assert.equal(await h.service.pollLink(), true);
    assert.equal(h.service.telegramStatus().linked, true);
    assert.equal(h.telegram.offsetSeen, 0, "the first poll starts from the stored offset");
    // A second poll requests only updates after the highest update_id already seen.
    h.telegram.messages = [];
    await h.service.pollLink();
    assert.equal(h.telegram.offsetSeen, 7, "the offset advances by update_id, never re-reading a spent link");
    // The code is spent: presenting it again does nothing.
    assert.equal(h.outbox.confirmLink("chat-99", code), false);
    assert.equal(h.service.telegramStatus().linkPending, false);
    // Unlinking is immediate.
    h.service.unlinkTelegram();
    assert.equal(h.service.telegramStatus().linked, false);
  } finally { h.cleanup(); }
});

test("a delivered report carries only approved summary fields", async () => {
  const h = stack();
  try {
    const jobId = h.makeJob("j1");
    h.outbox.setChatId("42");
    h.outbox.setPeriodicEnabled(true);
    const reports = new StatusReports({ workflows: h.workflows, deliveryStore: null, status: h.status, notify: (id, _kind, dueAt) => h.service.enqueueReport(id, dueAt) });
    const job = h.workflows.getJob(jobId)!;
    reports.onJobCreated(job);
    reports.tick(job.createdAt + 600_001);
    const queued = h.outbox.listForJob(jobId)[0]!;
    assert.equal(queued.kind, "report");
    assert.equal(await h.service.deliverDue((queued.nextAttemptAt ?? 0) + 1), 1);
    const text = h.telegram.sent[0]!.text;
    assert.ok(text.includes(job.title));
    assert.ok(text.includes("in progress"));
    assert.ok(!text.includes("npm test"), "raw commands never enter a notification");
  } finally { h.cleanup(); }
});
