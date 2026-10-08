import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
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

async function startStack(options: { deliveryStore?: DeliveryStore; makeStatus?: (workflows: WorkflowStore, state: ApplicationStateStore) => StatusReports } = {}): Promise<TestStack> {
  const directory = mkdtempSync(join(tmpdir(), "slice-api-"));
  const state = ApplicationStateStore.open(join(directory, "state.sqlite"));
  const workflows = WorkflowStore.open(state.database);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const adapter = await PiDurableAdapter.open({ durableDatabasePath: join(directory, "state.sqlite"), state, models, registry: createRegistry() });
  const auth = new OwnerAuth(workflows, { SLICE_OWNER_PASSWORD: PASSWORD });
  const coordinator = new JobCoordinator(adapter, workflows, { provider: "faux", modelId: "faux-1" }, fakeRunner());
  const api = new SliceApi({ auth, workflows, coordinator, webDirectory: join(process.cwd(), "apps/web/public"), ...(options.deliveryStore === undefined ? {} : { deliveryStore: options.deliveryStore }), ...(options.makeStatus === undefined ? {} : { status: options.makeStatus(workflows, state) }) });
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
