import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, createRegistry, type ConversationId, type EntryId } from "@earendil-works/pi-durable";
import { PiDurableAdapter } from "../../apps/server/src/adapters/pi-durable/pi-durable-adapter.js";
import { ApplicationStateStore } from "../../apps/server/src/state/application-state.js";

function newModels() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models, registry: createRegistry() };
}

async function answerText(adapter: PiDurableAdapter, threadId: ConversationId, answerId: EntryId): Promise<string> {
  const conversation = await adapter.conversation(threadId);
  assert.ok(conversation);
  const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, answerId), BACKGROUND_CONTEXT);
  const message = entry?.model?.[0];
  assert.ok(message);
  if (typeof message.content === "string") return message.content;
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

test("request IDs survive a harness restart and reject different input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slice-adapter-"));
  const { faux, models, registry } = newModels();
  const durableDatabasePath = join(directory, "state.sqlite");
  const statePath = durableDatabasePath;
  const agent = { model: { provider: "faux", modelId: "faux-1" } };
  try {
    faux.setResponses([fauxAssistantMessage("accepted")]);
    let state = ApplicationStateStore.open(statePath);
    let adapter = await PiDurableAdapter.open({ durableDatabasePath, state, models, registry });
    const threadId = await adapter.createThread(agent);
    const first = await adapter.submit(threadId, "req-1", "Add a status label");
    const settled = await first.wait(BACKGROUND_CONTEXT);
    assert.equal(settled.status, "done");
    if (settled.status !== "done" || settled.type !== "input") throw new Error("Expected a completed input submission");
    assert.equal(faux.state.callCount, 1);
    assert.equal(await answerText(adapter, threadId, settled.answer), "accepted");
    await adapter.close();
    state.close();

    state = ApplicationStateStore.open(statePath);
    adapter = await PiDurableAdapter.open({ durableDatabasePath, state, models, registry });
    const repeated = await adapter.submit(threadId, "req-1", "Add a status label");
    assert.equal(repeated.id, first.id);
    assert.equal((await repeated.wait(BACKGROUND_CONTEXT)).status, "done");
    assert.equal(faux.state.callCount, 1, "the completed request must not call the model again");
    await assert.rejects(adapter.submit(threadId, "req-1", "Different request"), /different input/);
    await adapter.close();
    state.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a request reserved before a crash does not call the model twice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slice-adapter-crash-"));
  const { faux, models, registry } = newModels();
  const statePath = join(directory, "state.sqlite");
  const content = "Add a status label";
  const agent = { model: { provider: "faux", modelId: "faux-1" } };
  try {
    faux.setResponses([fauxAssistantMessage("accepted")]);
    let state = ApplicationStateStore.open(statePath);
    let adapter = await PiDurableAdapter.open({ durableDatabasePath: statePath, state, models, registry });
    const threadId = await adapter.createThread(agent);

    // Reproduce a crash in the window the adapter cannot close: the request index is reserved, the submission is
    // admitted, and the process stops before the submission ID is recorded against the index row.
    const conversation = await adapter.conversation(threadId);
    assert.ok(conversation);
    const admitted = await conversation.submit(
      { type: "input", content, requestId: "req-crash" },
      BACKGROUND_CONTEXT,
    );
    assert.equal(state.reserveSubmission(String(threadId), "req-crash", { content }), undefined);
    assert.equal((await admitted.wait(BACKGROUND_CONTEXT)).status, "done");
    await adapter.close();
    state.close();

    faux.setResponses([fauxAssistantMessage("must not be used")]);
    state = ApplicationStateStore.open(statePath);
    adapter = await PiDurableAdapter.open({ durableDatabasePath: statePath, state, models, registry });
    const retried = await adapter.submit(threadId, "req-crash", content);
    assert.equal(retried.id, admitted.id, "the reserved request must resolve to the submission already admitted");
    assert.equal((await retried.wait(BACKGROUND_CONTEXT)).status, "done");
    assert.equal(faux.state.callCount, 1, "the model must not be called a second time for a reserved request");
    await adapter.close();
    state.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("threads keep independent transcripts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slice-threads-"));
  const { faux, models, registry } = newModels();
  const state = ApplicationStateStore.open(join(directory, "application.sqlite"));
  let adapter: PiDurableAdapter | undefined;
  try {
    faux.setResponses([fauxAssistantMessage("alpha reply"), fauxAssistantMessage("beta reply")]);
    adapter = await PiDurableAdapter.open({
      durableDatabasePath: join(directory, "state.sqlite"),
      state,
      models,
      registry,
    });
    const agent = { model: { provider: "faux", modelId: "faux-1" } };
    const alpha = await adapter.createThread(agent);
    const beta = await adapter.createThread(agent);
    const alphaSubmission = await adapter.submit(alpha, "alpha-1", "alpha request");
    const alphaResult = await alphaSubmission.wait(BACKGROUND_CONTEXT);
    const betaSubmission = await adapter.submit(beta, "beta-1", "beta request");
    const betaResult = await betaSubmission.wait(BACKGROUND_CONTEXT);

    assert.equal(alphaResult.status, "done");
    assert.equal(betaResult.status, "done");
    if (alphaResult.status !== "done" || alphaResult.type !== "input") throw new Error("Expected completed alpha input");
    if (betaResult.status !== "done" || betaResult.type !== "input") throw new Error("Expected completed beta input");
    assert.equal(await answerText(adapter, alpha, alphaResult.answer), "alpha reply");
    assert.equal(await answerText(adapter, beta, betaResult.answer), "beta reply");
  } finally {
    await adapter?.close();
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});
