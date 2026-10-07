import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { PiDurableAdapter } from "../../apps/server/src/adapters/pi-durable/pi-durable-adapter.js";
import { ApplicationStateStore } from "../../apps/server/src/state/application-state.js";
import { WorkflowStore, type BuildProfile } from "../../apps/server/src/records/workflow-store.js";
import { JobCoordinator, parseRequirementsOutput } from "../../apps/server/src/workflow/coordinator.js";

const PROFILE: BuildProfile = { setup: [], checks: [{ id: "test", command: "npm test" }] };

const QUESTION_JSON = '{"kind":"question","questionId":"q1","question":"Which office allocates?","choices":["front","back"]}';
const READY_JSON = '{"kind":"ready","summary":"Add an allocation screen.","criteria":[{"id":"c1","text":"Office staff can allocate items"}]}';

type Harness = {
  coordinator: JobCoordinator;
  adapter: PiDurableAdapter;
  workflows: WorkflowStore;
  faux: ReturnType<typeof fauxProvider>;
  close: () => Promise<void>;
};

async function newHarness(): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "slice-coordinator-"));
  const state = ApplicationStateStore.open(join(directory, "state.sqlite"));
  const workflows = WorkflowStore.open(state.database);
  workflows.registerHost({ hostId: "runner-a", address: "runner.internal", os: "linux", sshUser: "slice", runnerRoot: "/srv/slice/jobs" });
  workflows.createProject({ projectId: "demo", repoSlug: "owner/demo", defaultBranch: "main", hostId: "runner-a", buildProfile: PROFILE });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const adapter = await PiDurableAdapter.open({
    durableDatabasePath: join(directory, "state.sqlite"),
    state,
    models,
    registry: createRegistry(),
  });
  const coordinator = new JobCoordinator(adapter, workflows, { provider: "faux", modelId: "faux-1" });
  return {
    coordinator,
    adapter,
    workflows,
    faux,
    close: async () => {
      await adapter.close();
      state.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("the requirements schema accepts only the two declared shapes", () => {
  assert.deepEqual(parseRequirementsOutput(READY_JSON)?.kind, "ready");
  assert.deepEqual(parseRequirementsOutput(QUESTION_JSON)?.kind, "question");
  assert.equal(parseRequirementsOutput("I think we should just build it."), null, "prose is a failed task, not a pass");
  assert.equal(parseRequirementsOutput('{"kind":"approve","reason":"looks fine"}'), null, "unknown verdicts are rejected");
  assert.equal(parseRequirementsOutput('{"kind":"ready","summary":"x","criteria":[]}'), null, "ready without criteria is rejected");
  assert.equal(parseRequirementsOutput(JSON.stringify({ kind: "question", questionId: "q1", question: "ok?", choices: ["x".repeat(300)] })), null, "an over-long choice is rejected");
});

test("a request that needs an answer waits for the user, then continues on the answer", async () => {
  const h = await newHarness();
  try {
    h.faux.setResponses([fauxAssistantMessage(QUESTION_JSON)]);
    const job = await h.coordinator.createJob({ requestId: "req-1", payloadHash: "h1", projectId: "demo", title: "Allocation", requestText: "Let the office allocate items", issue: null });
    assert.equal(job.runState, "waiting_user");
    assert.equal(job.stage, "requirements");
    const questions = h.workflows.openQuestions(job.jobId);
    assert.equal(questions.length, 1);
    assert.equal(questions[0]?.question, "Which office allocates?");

    h.faux.setResponses([fauxAssistantMessage(READY_JSON)]);
    const answered = await h.coordinator.answerQuestion(job.jobId, questions[0]!.questionId, questions[0]!.revision, "front");
    assert.equal(answered.accepted, true);
    assert.equal(answered.job.stage, "planning");
    assert.equal(answered.job.runState, "running");
    const events = h.workflows.eventsAfter(job.jobId, 0);
    assert.deepEqual(events.map((event) => event.type), ["job_created", "question_asked", "stage", "question_answered", "requirements_ready"]);
  } finally { await h.close(); }
});

test("invalid role output blocks the job instead of passing it", async () => {
  const h = await newHarness();
  try {
    h.faux.setResponses([fauxAssistantMessage("Sure! I will add a nice screen for allocation.")]);
    const job = await h.coordinator.createJob({ requestId: "req-1", payloadHash: "h1", projectId: "demo", title: "Allocation", requestText: "Add a screen", issue: null });
    assert.equal(job.runState, "blocked");
    const events = h.workflows.eventsAfter(job.jobId, 0);
    assert.ok(events.some((event) => event.type === "requirements_output_rejected"));
  } finally { await h.close(); }
});

test("a job with no configured requirements profile blocks with a stated reason", async () => {
  const h = await newHarness();
  try {
    const unconfigured = new JobCoordinator(h.adapter, h.workflows, null);
    const job = await unconfigured.createJob({ requestId: "req-1", payloadHash: "h1", projectId: "demo", title: "Allocation", requestText: "Add a screen", issue: null });
    assert.equal(job.runState, "blocked");
    const events = h.workflows.eventsAfter(job.jobId, 0);
    assert.ok(events.some((event) => event.type === "blocked" && JSON.stringify(event.payload).includes("model profile")));
    assert.equal(h.faux.state.callCount, 0, "no model is invented for an unconfigured profile");
  } finally { await h.close(); }
});

test("pause, resume, and cancel move the job through the declared states", async () => {
  const h = await newHarness();
  try {
    h.faux.setResponses([fauxAssistantMessage(READY_JSON)]);
    const job = await h.coordinator.createJob({ requestId: "req-1", payloadHash: "h1", projectId: "demo", title: "Allocation", requestText: "Add a screen", issue: null });
    assert.equal(job.runState, "running");

    const paused = h.coordinator.pause(job.jobId);
    assert.equal(paused.runState, "paused");
    // A paused job is already at the pause boundary; a second pause changes nothing and is refused.
    assert.throws(() => h.coordinator.pause(job.jobId), /cannot be paused/);
    assert.equal(h.workflows.getJob(job.jobId)?.runState, "paused", "the refused pause left the state alone");
    // Pause is refused again from paused because 'paused' is not an admitted source state.
    assert.equal(h.workflows.setRunState(job.jobId, ["running", "waiting_user"], "pause_requested"), undefined);
    const resumed = h.coordinator.resume(job.jobId);
    assert.equal(resumed.runState, "running");

    const cancelled = await h.coordinator.cancel(job.jobId);
    assert.equal(cancelled.runState, "cancelled");
    const types = h.workflows.eventsAfter(job.jobId, 0).map((event) => event.type);
    for (const expected of ["pause_requested", "paused", "resumed", "cancel_requested", "cancelled"]) {
      assert.ok(types.includes(expected), `expected a ${expected} event`);
    }
  } finally { await h.close(); }
});

test("steering with a stale command revision is refused without applying the instruction", async () => {
  const h = await newHarness();
  try {
    h.faux.setResponses([fauxAssistantMessage(READY_JSON)]);
    const job = await h.coordinator.createJob({ requestId: "req-1", payloadHash: "h1", projectId: "demo", title: "Allocation", requestText: "Add a screen", issue: null });
    const stale = await h.coordinator.steer(job.jobId, "steer-1", "hash-a", job.commandRevision + 5, "Change course");
    assert.equal(stale.recorded, false);
    assert.equal(stale.job.commandRevision, 1, "the current state is returned unchanged");
    assert.equal(h.faux.state.callCount, 1, "a refused instruction must not reach the model");

    h.faux.setResponses([fauxAssistantMessage(QUESTION_JSON)]);
    const applied = await h.coordinator.steer(job.jobId, "steer-2", "hash-b", job.commandRevision, "Also cover the back office");
    assert.equal(applied.recorded, true);
    assert.equal(applied.job.runState, "waiting_user", "steering can raise a new question");
    assert.equal(applied.job.requirementsRevision, 2, "steering starts a new requirements revision");
    assert.equal(h.workflows.getJob(job.jobId)?.commandRevision, 2);
  } finally { await h.close(); }
});
