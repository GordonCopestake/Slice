import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineDoc,
  Harness,
  watchEvents,
  type AgentEvent,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

/** A conversation document with latest-only history, the shape Phase 0 reads back after a restart. */
const NotesDoc = defineDoc<{ items: string[] }>({ kind: "test.slice-notes", version: 1, scope: "conversation", history: "latest", fork: "current", initial: () => ({ items: [] }) });

const agent = { model: { provider: "faux", modelId: "faux-1" } };

function newModels() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}

async function openHarness(directory: string, models = createModels()) {
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(directory, "durable.sqlite")),
    { models, registry: createRegistry(), settings: { compaction: { keepRecentTokens: 0 } } },
    BACKGROUND_CONTEXT,
  );
  harness.resume();
  return harness;
}

type EventStream = Awaited<ReturnType<typeof watchEvents>>;

/**
 * One listener for the life of the stream, because `start()` rejects a second call. `until` resolves with every
 * event seen so far, so assertions never race the listener.
 */
function recordEvents(stream: EventStream) {
  const seen: AgentEvent[] = [];
  const waiters: Array<{
    predicate: (events: readonly AgentEvent[]) => boolean;
    settle: (events: readonly AgentEvent[]) => void;
  }> = [];
  stream.start(async (events) => {
    seen.push(...events);
    for (const waiter of waiters.splice(0)) {
      if (waiter.predicate(seen)) waiter.settle(seen);
      else waiters.push(waiter);
    }
  });
  return {
    until(predicate: (events: readonly AgentEvent[]) => boolean, timeoutMs = 10_000): Promise<AgentEvent[]> {
      if (predicate(seen)) return Promise.resolve(seen);
      return new Promise<AgentEvent[]>((resolve, reject) => {
        const waiter = {
          predicate,
          settle: (events: readonly AgentEvent[]): void => {
            clearTimeout(timer);
            resolve([...events]);
          },
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for conversation events; saw ${[...new Set(seen.map((event) => event.type))].join(", ")}`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

test("a manual compaction summarizes the transcript and reports its summary submission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slice-compact-"));
  const { faux, models } = newModels();
  faux.setResponses([
    fauxAssistantMessage("Noted the rotation schedule."),
    fauxAssistantMessage("Earlier turns: the deploy key rotates monthly."),
  ]);
  const harness = await openHarness(directory, models);
  try {
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, BACKGROUND_CONTEXT);
    const submission = await conversation.submit(
      { type: "input", content: "The deploy key rotates monthly", requestId: "req-1" },
      BACKGROUND_CONTEXT,
    );
    assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, "done");
    assert.equal(faux.state.callCount, 1);

    const taskId = await conversation.compact("Keep the rotation schedule", BACKGROUND_CONTEXT);
    const settled = await harness.waitForTask(taskId, BACKGROUND_CONTEXT);
    assert.equal(settled.state.status, "terminal");
    if (settled.state.outcome.status !== "completed") throw new Error("Expected a completed compaction");
    // A conversation-owned compaction places its summary through a write submission, not a direct entry.
    assert.equal(typeof settled.state.outcome.result.submissionId, "number");
    assert.equal(settled.state.outcome.result.entryId, undefined);
    assert.equal(faux.state.callCount, 2, "compaction must summarize with exactly one extra model call");
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a conversation document survives a harness restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slice-document-"));
  const written = await (async (): Promise<ConversationId> => {
    const harness = await openHarness(directory);
    try {
      const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, BACKGROUND_CONTEXT);
      await conversation.commit(async (tx) => {
        const notes = await tx.doc(NotesDoc, conversation.id);
        notes.items.push("deploy key rotates monthly");
      }, BACKGROUND_CONTEXT);
      return conversation.id;
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  })();

  const harness = await openHarness(directory);
  try {
    const reopened = await harness.conversation(written, BACKGROUND_CONTEXT);
    assert.ok(reopened);
    // The draft overlay is only readable inside its own transaction, so the read is a commit.
    const items = await reopened.commit(
      async (tx) => [...(await tx.doc(NotesDoc, reopened.id)).items],
      BACKGROUND_CONTEXT,
    );
    assert.deepEqual(items, ["deploy key rotates monthly"]);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  }
});

test("conversation events report a run and a compaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slice-events-"));
  const { faux, models } = newModels();
  faux.setResponses([
    fauxAssistantMessage("Answer to the input."),
    fauxAssistantMessage("Summary of earlier turns."),
  ]);
  const harness = await openHarness(directory, models);
  try {
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, BACKGROUND_CONTEXT);
    const stream = await watchEvents(harness, conversation.id, BACKGROUND_CONTEXT);
    assert.equal(stream.snapshot.type, "snapshot");
    const events = recordEvents(stream);

    const submission = await conversation.submit(
      { type: "input", content: "Add a status label", requestId: "req-1" },
      BACKGROUND_CONTEXT,
    );
    assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, "done");
    const types = new Set(
      (await events.until((seen) => seen.some((event) => event.type === "run_end"))).map((event) => event.type),
    );
    for (const expected of ["run_start", "turn_start", "message_end", "submission", "run_end"] as const) {
      assert.ok(types.has(expected), `Expected a ${expected} event, saw ${[...types].join(", ")}`);
    }

    await harness.waitForTask(await conversation.compact(undefined, BACKGROUND_CONTEXT), BACKGROUND_CONTEXT);
    const compactionTypes = new Set(
      (await events.until((seen) => seen.some((event) => event.type === "compaction_end"))).map((event) => event.type),
    );
    assert.ok(compactionTypes.has("compaction_start"), "Expected a compaction_start event");
    assert.ok(compactionTypes.has("compaction_end"), "Expected a compaction_end event");

    await stream.stop();
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a conversation document write without its conversation ID is rejected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slice-document-scope-"));
  const harness = await openHarness(directory);
  try {
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, BACKGROUND_CONTEXT);
    // Deliberately breaks the typed signature to prove the runtime guard rejects the address instead of
    // silently reading or creating a document somewhere else.
    await assert.rejects(
      conversation.commit(
        async (tx) => tx.doc(NotesDoc, undefined as unknown as ConversationId),
        BACKGROUND_CONTEXT,
      ),
      /requires a conversation ID/,
    );
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  }
});

test("compaction of an empty transcript completes without a summary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slice-compact-empty-"));
  const { faux, models } = newModels();
  const harness = await openHarness(directory, models);
  try {
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, BACKGROUND_CONTEXT);
    const settled = await harness.waitForTask(
      await conversation.compact(undefined, BACKGROUND_CONTEXT),
      BACKGROUND_CONTEXT,
    );
    assert.equal(settled.state.status, "terminal");
    if (settled.state.outcome.status !== "completed") throw new Error("Expected a completed compaction");
    assert.equal(settled.state.outcome.result.entryId, undefined);
    assert.equal(settled.state.outcome.result.submissionId, undefined);
    assert.equal(faux.state.callCount, 0, "an empty transcript must not call the model");
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  }
});