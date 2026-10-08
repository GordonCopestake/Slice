import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { SliceApi } from "../../apps/server/src/api/http-api.js";
import { OwnerAuth } from "../../apps/server/src/auth/owner-auth.js";
import { PiDurableAdapter } from "../../apps/server/src/adapters/pi-durable/pi-durable-adapter.js";
import { ApplicationStateStore } from "../../apps/server/src/state/application-state.js";
import { WorkflowStore } from "../../apps/server/src/records/workflow-store.js";
import { DeliveryStore } from "../../apps/server/src/records/delivery-store.js";
import { JobCoordinator } from "../../apps/server/src/workflow/coordinator.js";
import { StatusReports } from "../../apps/server/src/workflow/status-reports.js";
import { NotificationService } from "../../apps/server/src/workflow/notifications.js";
import { NotificationStore } from "../../apps/server/src/records/notification-store.js";
import { StatusStore } from "../../apps/server/src/records/status-store.js";
import type { RunnerGateway } from "../../apps/server/src/adapters/ssh-runner/runner-adapter.js";
import { fakeRunner } from "../support/fake-runner.js";

const QUESTION_JSON = '{"kind":"question","questionId":"q1","question":"Which office allocates?","choices":["front","back"]}';
const READY_JSON = '{"kind":"ready","summary":"Add an allocation screen.","criteria":[{"id":"c1","text":"Office staff can allocate items"}]}';

const PASSWORD = "phase1-test-owner-password";

type TestStack = {
  base: string;
  cookie: string;
  csrf: string;
  call: (path: string, options?: { method?: string; body?: unknown; csrf?: boolean; cookie?: string }) => Promise<{ status: number; body: any }>;
  close: () => Promise<void>;
  faux: ReturnType<typeof fauxProvider>;
};

async function startStack(options: { deliveryStore?: DeliveryStore; runner?: RunnerGateway; makeStatus?: (workflows: WorkflowStore, state: ApplicationStateStore) => StatusReports; makeNotifications?: (workflows: WorkflowStore, state: ApplicationStateStore) => NotificationService } = {}): Promise<TestStack> {
  const directory = mkdtempSync(join(tmpdir(), "slice-api-"));
  const state = ApplicationStateStore.open(join(directory, "state.sqlite"));
  const workflows = WorkflowStore.open(state.database);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const adapter = await PiDurableAdapter.open({ durableDatabasePath: join(directory, "state.sqlite"), state, models, registry: createRegistry() });
  const auth = new OwnerAuth(workflows, { SLICE_OWNER_PASSWORD: PASSWORD });
  const coordinator = new JobCoordinator(adapter, workflows, { provider: "faux", modelId: "faux-1" }, options.runner ?? fakeRunner());
  const api = new SliceApi({ auth, workflows, coordinator, webDirectory: join(process.cwd(), "apps/web/public"), ...(options.deliveryStore === undefined ? {} : { deliveryStore: options.deliveryStore }), ...(options.makeStatus === undefined ? {} : { status: options.makeStatus(workflows, state) }), ...(options.makeNotifications === undefined ? {} : { notifications: options.makeNotifications(workflows, state) }) });
  const server = createServer((request, response) => { void api.handle(request, response); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const stack: TestStack = {
    base: `http://127.0.0.1:${port}`,
    cookie: "",
    csrf: "",
    faux,
    call: async (path, options = {}) => {
      const method = options.method ?? "GET";
      const response = await fetch(`${stack.base}${path}`, {
        method,
        body: options.body === undefined ? null : JSON.stringify(options.body),
        headers: {
          "content-type": "application/json",
          ...(stack.cookie.length > 0 ? { cookie: options.cookie ?? stack.cookie } : {}),
          ...(method !== "GET" && (options.csrf ?? true) ? { "x-csrf-token": stack.csrf } : {}),
        },
      });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    },
    close: async () => {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await adapter.close();
      state.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
  return stack;
}

async function login(stack: TestStack): Promise<void> {
  const response = await fetch(`${stack.base}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { csrfToken: string };
  stack.csrf = body.csrfToken;
  const cookie = response.headers.get("set-cookie") ?? "";
  stack.cookie = cookie.split(";")[0]!;
}

test("the API refuses anonymous callers and requests without a CSRF token", async () => {
  const stack = await startStack();
  try {
    const anonymous = await stack.call("/api/jobs", { cookie: "" });
    assert.equal(anonymous.status, 401);
    await login(stack);
    const noCsrf = await stack.call("/api/hosts", { method: "POST", body: { hostId: "h" }, csrf: false });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.body.error, "csrf_token_missing");
    const wrongPassword = await fetch(`${stack.base}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "wrong" }) });
    assert.equal(wrongPassword.status, 401);
  } finally { await stack.close(); }
});

test("hosts and projects register through the owner API", async () => {
  const stack = await startStack();
  try {
    await login(stack);
    const host = await stack.call("/api/hosts", { method: "POST", body: { hostId: "runner-a", address: "runner.internal", os: "linux", sshUser: "slice", runnerRoot: "/srv/slice/jobs" } });
    assert.equal(host.status, 201);
    const project = await stack.call("/api/projects", { method: "POST", body: {
      projectId: "demo", repoSlug: "owner/demo", defaultBranch: "main", hostId: "runner-a",
      buildProfile: { setup: [], checks: [{ id: "test", command: "npm test" }] },
    } });
    assert.equal(project.status, 201);
    const list = await stack.call("/api/projects");
    assert.equal(list.body.projects.length, 1);
    const paused = await stack.call("/api/projects/demo/status", { method: "POST", body: { status: "paused" } });
    assert.equal(paused.body.project.status, "paused");
  } finally { await stack.close(); }
});

test("a job is created once per request ID, asks its question, and continues on the answer", async () => {
  const stack = await startStack();
  try {
    await login(stack);
    await stack.call("/api/hosts", { method: "POST", body: { hostId: "runner-a", address: "runner.internal", os: "linux", sshUser: "slice", runnerRoot: "/srv/slice/jobs" } });
    await stack.call("/api/projects", { method: "POST", body: {
      projectId: "demo", repoSlug: "owner/demo", defaultBranch: "main", hostId: "runner-a",
      buildProfile: { setup: [], checks: [{ id: "test", command: "npm test" }] },
    } });

    stack.faux.setResponses([fauxAssistantMessage(QUESTION_JSON)]);
    const payload = { requestId: "web-1", projectId: "demo", title: "Allocation screen", request: "Let the office allocate items" };
    const created = await stack.call("/api/jobs", { method: "POST", body: payload });
    assert.equal(created.status, 201);
    assert.equal(created.body.job.runState, "waiting_user");

    // The same submission returns the same job and does not call the model again.
    const retry = await stack.call("/api/jobs", { method: "POST", body: payload });
    assert.equal(retry.body.job.jobId, created.body.job.jobId);
    assert.equal(stack.faux.state.callCount, 1);

    // The same ID with different input is rejected and the job is unchanged.
    const conflict = await stack.call("/api/jobs", { method: "POST", body: { ...payload, request: "Different request" } });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, "idempotency_conflict");

    const detail = await stack.call(`/api/jobs/${created.body.job.jobId}`);
    assert.equal(detail.body.questions.length, 1);
    const question = detail.body.questions[0];

    stack.faux.setResponses([fauxAssistantMessage(READY_JSON)]);
    const answered = await stack.call(`/api/jobs/${created.body.job.jobId}/requirements/answers`, {
      method: "POST", body: { questionId: question.questionId, revision: question.revision, answer: "front" },
    });
    assert.equal(answered.status, 200);
    assert.equal(answered.body.job.stage, "implementation");

    // A late second answer to the same question cannot change the job.
    const late = await stack.call(`/api/jobs/${created.body.job.jobId}/requirements/answers`, {
      method: "POST", body: { questionId: question.questionId, revision: question.revision, answer: "back" },
    });
    assert.equal(late.status, 409);
    assert.equal(late.body.accepted, false);
  } finally { await stack.close(); }
});

test("pause, resume, cancel, and stale steering behave over HTTP", async () => {
  const stack = await startStack();
  try {
    await login(stack);
    await stack.call("/api/hosts", { method: "POST", body: { hostId: "runner-a", address: "runner.internal", os: "linux", sshUser: "slice", runnerRoot: "/srv/slice/jobs" } });
    await stack.call("/api/projects", { method: "POST", body: {
      projectId: "demo", repoSlug: "owner/demo", defaultBranch: "main", hostId: "runner-a",
      buildProfile: { setup: [], checks: [{ id: "test", command: "npm test" }] },
    } });
    stack.faux.setResponses([fauxAssistantMessage(READY_JSON)]);
    const created = await stack.call("/api/jobs", { method: "POST", body: { requestId: "web-1", projectId: "demo", title: "Allocation", request: "Add it" } });
    const jobId = created.body.job.jobId;

    const paused = await stack.call(`/api/jobs/${jobId}/pause`, { method: "POST", body: {} });
    assert.equal(paused.body.job.runState, "paused");
    const resumed = await stack.call(`/api/jobs/${jobId}/resume`, { method: "POST", body: {} });
    assert.equal(resumed.body.job.runState, "running");

    const stale = await stack.call(`/api/jobs/${jobId}/steer`, {
      method: "POST", body: { requestId: "steer-1", instruction: "wrong revision", expectedCommandRevision: 99 },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.recorded, false);
    assert.equal(stale.body.job.commandRevision, 1, "the current state is returned without applying the instruction");

    const cancelled = await stack.call(`/api/jobs/${jobId}/cancel`, { method: "POST", body: {} });
    assert.equal(cancelled.body.job.runState, "cancelled");
  } finally { await stack.close(); }
});

test("report settings reject intervals outside 1-60 without changing the saved value", async () => {
  const stack = await startStack();
  try {
    await login(stack);
    await stack.call("/api/hosts", { method: "POST", body: { hostId: "runner-a", address: "runner.internal", os: "linux", sshUser: "slice", runnerRoot: "/srv/slice/jobs" } });
    await stack.call("/api/projects", { method: "POST", body: {
      projectId: "demo", repoSlug: "owner/demo", defaultBranch: "main", hostId: "runner-a",
      buildProfile: { setup: [], checks: [{ id: "test", command: "npm test" }] },
    } });
    stack.faux.setResponses([fauxAssistantMessage(READY_JSON)]);
    const created = await stack.call("/api/jobs", { method: "POST", body: { requestId: "web-1", projectId: "demo", title: "Allocation", request: "Add it" } });
    const jobId = created.body.job.jobId;

    const bad = await stack.call(`/api/jobs/${jobId}/status-settings`, { method: "PATCH", body: { reportsEnabled: true, intervalMinutes: 90 } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.job.reportIntervalMinutes, 10, "the saved interval is unchanged");
    const good = await stack.call(`/api/jobs/${jobId}/status-settings`, { method: "PATCH", body: { reportsEnabled: false, intervalMinutes: 30 } });
    assert.equal(good.status, 200);
    assert.equal(good.body.job.reportsEnabled, false);
    assert.equal(good.body.job.reportIntervalMinutes, 30);
  } finally { await stack.close(); }
});

test("the event stream sends a snapshot and then the durable ledger from the cursor", async () => {
  const stack = await startStack();
  try {
    await login(stack);
    await stack.call("/api/hosts", { method: "POST", body: { hostId: "runner-a", address: "runner.internal", os: "linux", sshUser: "slice", runnerRoot: "/srv/slice/jobs" } });
    await stack.call("/api/projects", { method: "POST", body: {
      projectId: "demo", repoSlug: "owner/demo", defaultBranch: "main", hostId: "runner-a",
      buildProfile: { setup: [], checks: [{ id: "test", command: "npm test" }] },
    } });
    stack.faux.setResponses([fauxAssistantMessage(QUESTION_JSON)]);
    const created = await stack.call("/api/jobs", { method: "POST", body: { requestId: "web-1", projectId: "demo", title: "Allocation", request: "Add it" } });
    const jobId = created.body.job.jobId;

    const controller = new AbortController();
    const response = await fetch(`${stack.base}/api/jobs/${jobId}/events`, {
      headers: { cookie: stack.cookie }, signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.ok(String(response.headers.get("content-type")).includes("text/event-stream"));
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const seen: { event: string; data: string }[] = [];
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      for (const block of buffer.split("\n\n")) {
        if (!block.startsWith("event:")) continue;
        const eventName = /^event: (.*)$/m.exec(block)?.[1] ?? "";
        const data = /^data: (.*)$/m.exec(block)?.[1] ?? "";
        seen.push({ event: eventName, data });
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n\n") + 2);
      if (seen.some((item) => item.event === "snapshot") && seen.some((item) => item.event === "event" && item.data.includes("question_asked"))) break;
    }
    controller.abort();
    assert.ok(seen.some((item) => item.event === "snapshot"), "the reconnecting client receives a state snapshot first");
    assert.ok(seen.some((item) => item.event === "event" && item.data.includes("question_asked")), "the ledger resumes from the cursor");
  } finally { await stack.close(); }
});

test("an issue maps to one job with its source link, and a second request shows the existing job", async () => {
  const stack = await startStack();
  const originalFetch = globalThis.fetch;
  try {
    // Stub only the GitHub read: one real issue and one pull request that the picker must exclude.
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (!String(input).includes("api.github.com")) return originalFetch(input as never, init);
      return new Response(JSON.stringify([
        { number: 7, id: 700, title: "Goods-ready screen", body: "Let the office allocate items.", html_url: "https://github.com/owner/demo/issues/7", state: "open", labels: [], updated_at: "2026-10-07T10:00:00Z" },
        { number: 8, id: 800, title: "A pull request", body: "", html_url: "https://github.com/owner/demo/pull/8", state: "open", pull_request: { url: "x" }, updated_at: "2026-10-07T10:00:00Z" },
      ]), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await login(stack);
    await stack.call("/api/hosts", { method: "POST", body: { hostId: "runner-a", address: "runner.internal", os: "linux", sshUser: "slice", runnerRoot: "/srv/slice/jobs" } });
    await stack.call("/api/projects", { method: "POST", body: {
      projectId: "demo", repoSlug: "owner/demo", defaultBranch: "main", hostId: "runner-a",
      buildProfile: { setup: [], checks: [{ id: "test", command: "npm test" }] },
    } });

    const issues = await stack.call("/api/projects/demo/issues");
    assert.equal(issues.status, 200);
    assert.deepEqual(issues.body.issues.map((issue: { number: number }) => issue.number), [7], "pull requests are excluded from the issue picker");

    stack.faux.setResponses([fauxAssistantMessage(READY_JSON)]);
    const created = await stack.call("/api/jobs/from-issue", { method: "POST", body: { requestId: "issue-7", projectId: "demo", issueNumber: 7 } });
    assert.equal(created.status, 201);
    assert.equal(created.body.existing, false);
    assert.equal(created.body.job.issue.issueNumber, 7);
    assert.equal(created.body.job.issue.url, "https://github.com/owner/demo/issues/7", "the source link stays intact on the job");

    // A second request for the same issue shows the existing job instead of starting duplicate work.
    const duplicate = await stack.call("/api/jobs/from-issue", { method: "POST", body: { requestId: "issue-7-b", projectId: "demo", issueNumber: 7 } });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.existing, true);
    assert.equal(duplicate.body.job.jobId, created.body.job.jobId);

    // A pull request cannot be selected as an issue task.
    const asPr = await stack.call("/api/jobs/from-issue", { method: "POST", body: { requestId: "issue-8", projectId: "demo", issueNumber: 8 } });
    assert.equal(asPr.status, 404);
    assert.equal(asPr.body.error, "issue_not_found");
  } finally {
    globalThis.fetch = originalFetch;
    await stack.close();
  }
});

test("status report settings and history are exposed through the API", async () => {
  const stack = await startStack({ makeStatus: (workflows, state) => new StatusReports({ workflows, deliveryStore: null, status: StatusStore.open(state.database) }) });
  try {
    await login(stack);
    await stack.call("/api/hosts", { method: "POST", body: { hostId: "runner-a", address: "runner.internal", os: "linux", sshUser: "slice", runnerRoot: "/srv/slice/jobs" } });
    await stack.call("/api/projects", { method: "POST", body: {
      projectId: "demo", repoSlug: "owner/demo", defaultBranch: "main", hostId: "runner-a",
      buildProfile: { setup: [], checks: [{ id: "test", command: "npm test" }] },
    } });
    stack.faux.setResponses([fauxAssistantMessage(QUESTION_JSON)]);
    const created = await stack.call("/api/jobs", { method: "POST", body: { requestId: "web-r1", projectId: "demo", title: "Reports", request: "Add reporting" } });
    assert.equal(created.status, 201);
    const jobId = created.body.job.jobId;

    const initial = await stack.call(`/api/jobs/${jobId}/status-reports`);
    assert.equal(initial.status, 200);
    assert.equal(initial.body.plan.intervalMinutes, 10);
    assert.deepEqual(initial.body.reports, [], "no report exists before the first tick");

    // An interval outside 1-60 is rejected and the saved interval is unchanged.
    const bad = await stack.call(`/api/jobs/${jobId}/report-settings`, { method: "POST", body: { enabled: true, intervalMinutes: 90 } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "interval_out_of_range");
    const afterBad = await stack.call(`/api/jobs/${jobId}/status-reports`);
    assert.equal(afterBad.body.plan.intervalMinutes, 10);

    const updated = await stack.call(`/api/jobs/${jobId}/report-settings`, { method: "POST", body: { enabled: true, intervalMinutes: 30 } });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.plan.intervalMinutes, 30);
    assert.equal(updated.body.job.reportIntervalMinutes, 30, "the job view shows the same setting");
    assert.equal(updated.body.plan.generation, 2, "a settings change starts a new generation");

    const missing = await stack.call("/api/jobs/no-such-job/status-reports");
    assert.equal(missing.status, 404);
  } finally {
    await stack.close();
  }
});

test("telegram linking state and the job notification view are exposed", async () => {
  const stack = await startStack({
    makeNotifications: (workflows, state) => new NotificationService({
      workflows,
      notifications: NotificationStore.open(state.database),
      status: StatusStore.open(state.database),
      telegram: null,
    }),
  });
  try {
    await login(stack);
    const status = await stack.call("/api/telegram");
    assert.equal(status.status, 200);
    assert.equal(status.body.telegram.botConfigured, false, "no bot token: the service says so instead of pretending");
    assert.equal(status.body.telegram.linked, false);

    const code = await stack.call("/api/telegram/link-code", { method: "POST", body: {} });
    assert.equal(code.status, 200);
    assert.match(code.body.code, /^[a-f0-9]{12}$/);

    const periodic = await stack.call("/api/telegram/periodic", { method: "POST", body: { enabled: true } });
    assert.equal(periodic.status, 200);
    assert.equal(periodic.body.telegram.periodicEnabled, true);

    await stack.call("/api/hosts", { method: "POST", body: { hostId: "runner-a", address: "runner.internal", os: "linux", sshUser: "slice", runnerRoot: "/srv/slice/jobs" } });
    await stack.call("/api/projects", { method: "POST", body: {
      projectId: "demo", repoSlug: "owner/demo", defaultBranch: "main", hostId: "runner-a",
      buildProfile: { setup: [], checks: [{ id: "test", command: "npm test" }] },
    } });
    stack.faux.setResponses([fauxAssistantMessage(QUESTION_JSON)]);
    const created = await stack.call("/api/jobs", { method: "POST", body: { requestId: "web-n1", projectId: "demo", title: "Notify", request: "Add alerts" } });
    const notifications = await stack.call(`/api/jobs/${created.body.job.jobId}/notifications`);
    assert.equal(notifications.status, 200);
    assert.deepEqual(notifications.body.notifications, [], "nothing queued while the channel is unconfigured");
  } finally {
    await stack.close();
  }
});

test("the thread picker searches active and archived views without touching workers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "slice-api-search-"));
  const state = ApplicationStateStore.open(join(directory, "state.sqlite"));
  const deliveryStore = DeliveryStore.open(state.database);
  const stack = await startStack({ deliveryStore });
  try {
    await login(stack);
    await stack.call("/api/hosts", { method: "POST", body: { hostId: "runner-a", address: "runner.internal", os: "linux", sshUser: "slice", runnerRoot: "/srv/slice/jobs" } });
    await stack.call("/api/projects", { method: "POST", body: {
      projectId: "demo", repoSlug: "owner/demo", defaultBranch: "main", hostId: "runner-a",
      buildProfile: { setup: [], checks: [{ id: "test", command: "npm test" }] },
    } });
    stack.faux.setResponses([fauxAssistantMessage(READY_JSON), fauxAssistantMessage(READY_JSON)]);
    const a = await stack.call("/api/jobs", { method: "POST", body: { requestId: "s1", projectId: "demo", title: "Goods ready screen", request: "Add a goods ready screen" } });
    const b = await stack.call("/api/jobs", { method: "POST", body: { requestId: "s2", projectId: "demo", title: "Allocation report", request: "Add an allocation report" } });

    const byTitle = await stack.call("/api/jobs?query=allocation");
    assert.deepEqual(byTitle.body.jobs.map((job: { jobId: string }) => job.jobId), [b.body.job.jobId]);

    // Archive job a through the delivery records, exactly as a verified merge would.
    deliveryStore.ensureDelivery(a.body.job.jobId, "abc1234");
    deliveryStore.setPr(a.body.job.jobId, { number: 47, url: "https://example.test/pr/47", state: "ready" });
    deliveryStore.recordMerge(a.body.job.jobId, "def5678", "test archive");

    const active = await stack.call("/api/jobs?view=active");
    assert.deepEqual(active.body.jobs.map((job: { jobId: string }) => job.jobId), [b.body.job.jobId], "archived threads leave the active view");
    const archived = await stack.call("/api/jobs?view=archived");
    assert.deepEqual(archived.body.jobs.map((job: { jobId: string }) => job.jobId), [a.body.job.jobId]);
    assert.equal(archived.body.jobs[0].prNumber, 47);

    // Search by PR number works in the archived view without resuming anything.
    const byPr = await stack.call("/api/jobs?view=archived&query=47");
    assert.deepEqual(byPr.body.jobs.map((job: { jobId: string }) => job.jobId), [a.body.job.jobId]);

    // Archived threads stay read-only.
    const steer = await stack.call(`/api/jobs/${a.body.job.jobId}/steer`, { method: "POST", body: { requestId: "s3", instruction: "reopen", expectedCommandRevision: 1 } });
    assert.equal(steer.status, 409);
    assert.equal(steer.body.error, "job_archived");
  } finally {
    await stack.close();
    state.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a merged archived thread offers a linked follow-up job and stays untouched", async () => {
  const directory = mkdtempSync(join(tmpdir(), "slice-api-followup-"));
  const state = ApplicationStateStore.open(join(directory, "state.sqlite"));
  const workflows = WorkflowStore.open(state.database);
  const deliveryStore = DeliveryStore.open(state.database);
  const stack = await startStack({ deliveryStore, makeStatus: (workflows, state2) => new StatusReports({ workflows, deliveryStore, status: StatusStore.open(state2.database) }) });
  try {
    await login(stack);
    await stack.call("/api/hosts", { method: "POST", body: { hostId: "runner-a", address: "runner.internal", os: "linux", sshUser: "slice", runnerRoot: "/srv/slice/jobs" } });
    await stack.call("/api/projects", { method: "POST", body: {
      projectId: "demo", repoSlug: "owner/demo", defaultBranch: "main", hostId: "runner-a",
      buildProfile: { setup: [], checks: [{ id: "test", command: "npm test" }] },
    } });
    stack.faux.setResponses([fauxAssistantMessage(READY_JSON), fauxAssistantMessage(QUESTION_JSON)]);
    const original = await stack.call("/api/jobs", { method: "POST", body: { requestId: "f1", projectId: "demo", title: "Merged work", request: "Do the thing" } });
    const jobId = original.body.job.jobId;

    // Follow-up before archiving is refused: active work uses steering.
    const early = await stack.call(`/api/jobs/${jobId}/follow-up`, { method: "POST", body: { requestId: "f2", title: "too early", request: "more" } });
    assert.equal(early.status, 409);
    assert.equal(early.body.error, "job_not_archived");

    deliveryStore.ensureDelivery(jobId, "abc1234");
    deliveryStore.recordMerge(jobId, "def5678", "test merge");

    const follow = await stack.call(`/api/jobs/${jobId}/follow-up`, { method: "POST", body: { requestId: "f3", title: "Follow-up work", request: "Extend the merged feature" } });
    assert.equal(follow.status, 201);
    assert.equal(follow.body.predecessorJobId, jobId);

    const originalView = await stack.call(`/api/jobs/${jobId}`);
    assert.equal(originalView.body.archived, true);
    assert.equal(originalView.body.followUpJobId, follow.body.job.jobId);
    const followView = await stack.call(`/api/jobs/${follow.body.job.jobId}`);
    assert.equal(followView.body.predecessorJobId, jobId);
    assert.equal(followView.body.archived, false, "the follow-up is a live thread of its own");

    // The follow-up is a real thread: it carries its own reporting plan from creation.
    const followReports = await stack.call(`/api/jobs/${follow.body.job.jobId}/status-reports`);
    assert.equal(followReports.status, 200);
    assert.equal(followReports.body.plan.intervalMinutes, 10);
  } finally {
    await stack.close();
    state.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("evidence artifacts download safely, expire honestly, and never resolve a URL to a path", async () => {
  const directory = mkdtempSync(join(tmpdir(), "slice-api-artifact-"));
  const state = ApplicationStateStore.open(join(directory, "state.sqlite"));
  const workflows = WorkflowStore.open(state.database);
  const deliveryStore = DeliveryStore.open(state.database);
  const stack = await startStack({ deliveryStore });
  try {
    await login(stack);
    await stack.call("/api/hosts", { method: "POST", body: { hostId: "runner-a", address: "runner.internal", os: "linux", sshUser: "slice", runnerRoot: "/srv/slice/jobs" } });
    await stack.call("/api/projects", { method: "POST", body: {
      projectId: "demo", repoSlug: "owner/demo", defaultBranch: "main", hostId: "runner-a",
      buildProfile: { setup: [], checks: [{ id: "test", command: "npm test" }] },
    } });
    stack.faux.setResponses([fauxAssistantMessage(READY_JSON)]);
    const created = await stack.call("/api/jobs", { method: "POST", body: { requestId: "art1", projectId: "demo", title: "Evidence", request: "Keep the proof" } });
    const jobId = created.body.job.jobId;

    const content = "final packet contents";
    const digest = createHash("sha256").update(content).digest("hex");
    const file = join(directory, "packet.json");
    writeFileSync(file, content);
    deliveryStore.ensureDelivery(jobId, "abc1234");
    deliveryStore.recordArtifact({ jobId, id: "final-packet", kind: "packet", digest, sizeBytes: content.length, path: file, verificationKey: "k", expiresAt: Date.now() + 86_400_000 });
    deliveryStore.recordArtifact({ jobId, id: "old-log", kind: "log", digest, sizeBytes: 3, path: file, verificationKey: "k", expiresAt: Date.now() - 1_000 });

    const response = await fetch(`${stack.base}/api/jobs/${jobId}/artifacts/final-packet`, { headers: { cookie: stack.cookie } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-disposition") ?? "", /attachment/);
    assert.equal(await response.text(), content);

    const expired = await stack.call(`/api/jobs/${jobId}/artifacts/old-log`);
    assert.equal(expired.status, 410);
    assert.equal(expired.body.error, "artifact_expired");
    assert.equal(expired.body.digest, digest, "the manifest record remains after the file expires");

    const missing = await stack.call(`/api/jobs/${jobId}/artifacts/nothing-here`);
    assert.equal(missing.status, 404);

    // A path-traversal attempt is rejected by the id rule before any file access.
    const traversal = await fetch(`${stack.base}/api/jobs/${jobId}/artifacts/..%2Fstate`, { headers: { cookie: stack.cookie } });
    assert.ok(traversal.status === 404 || traversal.status === 400);
  } finally {
    await stack.close();
    state.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a project cannot be activated until its declared toolchain passes on a usable host", async () => {
  const probed: string[] = [];
  const stack = await startStack({ runner: fakeRunner({ probeToolchain: async (input) => {
    probed.push(input.hostId);
    return { allPassed: true, tools: input.tools.map((tool) => ({ id: tool.id, command: tool.command, exitCode: 0, version: "v22.19.0", outputTail: "" })) };
  } }) });
  try {
    await login(stack);
    await stack.call("/api/hosts", { method: "POST", body: { hostId: "win-a", address: "win.internal", os: "windows", sshUser: "slice", runnerRoot: "D:/slice/jobs" } });
    const created = await stack.call("/api/projects", { method: "POST", body: {
      projectId: "win", repoSlug: "owner/win", defaultBranch: "main", hostId: "win-a", requiredOs: "windows",
      toolchain: [{ id: "node", command: "node --version" }],
      buildProfile: { setup: [], checks: [{ id: "test", command: "npm test" }] },
    } });
    assert.equal(created.status, 201);

    // Before any probe has run, activation is refused with the reason, not a silent no.
    const tooEarly = await stack.call("/api/projects/win/status", { method: "POST", body: { status: "paused" } });
    assert.equal(tooEarly.status, 200);
    const blocked = await stack.call("/api/projects/win/status", { method: "POST", body: { status: "active" } });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, "toolchain_unverified");

    const check = await stack.call("/api/projects/win/toolchain-check", { method: "POST" });
    assert.equal(check.status, 200);
    assert.equal(check.body.passed, true);
    assert.equal(check.body.hostId, "win-a");
    assert.match(check.body.tools[0].version, /^v22/);
    assert.deepEqual(probed, ["win-a"]);

    const activated = await stack.call("/api/projects/win/status", { method: "POST", body: { status: "active" } });
    assert.equal(activated.status, 200, "the attested project can be activated");

    // Pausing and resuming is not a toolchain change; the evidence survives it.
    const paused = await stack.call("/api/projects/win/status", { method: "POST", body: { status: "paused" } });
    assert.equal(paused.status, 200);
    const reactivated = await stack.call("/api/projects/win/status", { method: "POST", body: { status: "active" } });
    assert.equal(reactivated.status, 200, "a status change does not demand a fresh probe");
  } finally { await stack.close(); }
});

test("a toolchain check that the host cannot answer is reported, not hidden", async () => {
  const stack = await startStack({ runner: fakeRunner({ probeToolchain: async (input) => ({
    allPassed: false,
    tools: input.tools.map((tool) => ({ id: tool.id, command: tool.command, exitCode: 127, version: null, outputTail: "command not found" })),
  }) }) });
  try {
    await login(stack);
    await stack.call("/api/hosts", { method: "POST", body: { hostId: "win-a", address: "win.internal", os: "windows", sshUser: "slice", runnerRoot: "D:/slice/jobs" } });
    await stack.call("/api/projects", { method: "POST", body: {
      projectId: "win", repoSlug: "owner/win", defaultBranch: "main", hostId: "win-a", requiredOs: "windows",
      toolchain: [{ id: "node", command: "node --version" }],
      buildProfile: { setup: [], checks: [{ id: "test", command: "npm test" }] },
    } });
    const check = await stack.call("/api/projects/win/toolchain-check", { method: "POST" });
    assert.equal(check.status, 200);
    assert.equal(check.body.passed, false);
    assert.equal(check.body.tools[0].exitCode, 127);
    assert.equal(check.body.tools[0].version, null);
    const activation = await stack.call("/api/projects/win/status", { method: "POST", body: { status: "active" } });
    assert.equal(activation.status, 409);

    const noToolchain = await stack.call("/api/projects/nope/toolchain-check", { method: "POST" });
    assert.equal(noToolchain.status, 404);
  } finally { await stack.close(); }
});

test("a blocked job retries after the owner fixes the environment", async () => {
  const stack = await startStack();
  try {
    await login(stack);
    await stack.call("/api/hosts", { method: "POST", body: { hostId: "runner-a", address: "runner.internal", os: "linux", sshUser: "slice", runnerRoot: "/srv/slice/jobs" } });
    await stack.call("/api/projects", { method: "POST", body: {
      projectId: "gated", repoSlug: "owner/gated", defaultBranch: "main", hostId: "runner-a",
      toolchain: [{ id: "node", command: "node --version" }],
      buildProfile: { setup: [], checks: [{ id: "test", command: "npm test" }] },
    } });
    stack.faux.setResponses([fauxAssistantMessage(READY_JSON)]);
    const job = await stack.call("/api/jobs", { method: "POST", body: { requestId: "g1", projectId: "gated", title: "Gated", request: "Do it" } });
    assert.equal(job.status, 201);
    const jobId = job.body.job.jobId;
    assert.equal((await stack.call(`/api/jobs/${jobId}`)).body.job.runState, "blocked");

    // Retrying without fixing anything blocks again, with the same stated reason.
    const again = await stack.call(`/api/jobs/${jobId}/retry`, { method: "POST" });
    assert.equal(again.status, 200);
    assert.equal(again.body.job.runState, "blocked");

    const resumeAttempt = await stack.call(`/api/jobs/${jobId}/resume`, { method: "POST" });
    assert.equal(resumeAttempt.status, 409, "resume is for paused jobs, not blocked ones");

    // The owner verifies the worker through the same route a real deployment uses, then retries.
    const check = await stack.call("/api/projects/gated/toolchain-check", { method: "POST" });
    assert.equal(check.status, 200);
    assert.equal(check.body.passed, true);
    const retried = await stack.call(`/api/jobs/${jobId}/retry`, { method: "POST" });
    assert.equal(retried.status, 200);
    assert.equal(retried.body.job.runState, "running");
    assert.equal(retried.body.job.stage, "implementation");
  } finally { await stack.close(); }
});

test("editing a project's probes invalidates its attestation instead of leaving a stale pass", async () => {
  const stack = await startStack();
  try {
    await login(stack);
    await stack.call("/api/hosts", { method: "POST", body: { hostId: "win-a", address: "win.internal", os: "windows", sshUser: "slice", runnerRoot: "D:/slice/jobs" } });
    await stack.call("/api/projects", { method: "POST", body: {
      projectId: "win", repoSlug: "owner/win", defaultBranch: "main", hostId: "win-a", requiredOs: "windows",
      toolchain: [{ id: "node", command: "node --version" }],
      buildProfile: { setup: [], checks: [{ id: "test", command: "npm test" }] },
    } });
    assert.equal((await stack.call("/api/projects/win/toolchain-check", { method: "POST" })).body.passed, true);
    assert.equal((await stack.call("/api/projects/win/status", { method: "POST", body: { status: "active" } })).status, 200);

    const edited = await stack.call("/api/projects/win/toolchain", { method: "POST", body: { toolchain: [{ id: "node", command: "node --version" }, { id: "git", command: "git --version" }] } });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.attested.ready, false, "the new probe set is not attested");
    assert.match(edited.body.attested.reason, /different set of probes/);

    // A hostile edit is refused outright, not stored and not silently dropped.
    const hostile = await stack.call("/api/projects/win/toolchain", { method: "POST", body: { toolchain: [{ id: "evil", command: "git --version && calc.exe" }] } });
    assert.equal(hostile.status, 400);
  } finally { await stack.close(); }
});

test("a second toolchain check re-prepares its own workspace instead of trusting a cleaned one", async () => {
  const stack = await startStack();
  try {
    await login(stack);
    await stack.call("/api/hosts", { method: "POST", body: { hostId: "win-a", address: "win.internal", os: "windows", sshUser: "slice", runnerRoot: "D:/slice/jobs" } });
    await stack.call("/api/projects", { method: "POST", body: {
      projectId: "win", repoSlug: "owner/win", defaultBranch: "main", hostId: "win-a", requiredOs: "windows",
      toolchain: [{ id: "node", command: "node --version" }],
      buildProfile: { setup: [], checks: [{ id: "test", command: "npm test" }] },
    } });
    const first = await stack.call("/api/projects/win/toolchain-check", { method: "POST" });
    assert.equal(first.status, 200);
    assert.equal(first.body.passed, true);
    // The first check cleaned its workspace away; the second must prepare a fresh one, not assume
    // the earlier journal row still describes a live workspace.
    const second = await stack.call("/api/projects/win/toolchain-check", { method: "POST" });
    assert.equal(second.status, 200, second.body.message ?? "");
    assert.equal(second.body.passed, true);
  } finally { await stack.close(); }
});
