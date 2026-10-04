import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, defineTask, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await import("node:fs/promises").then(({ access }) => access(path));
      return;
    } catch {
      await delay(20);
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

test("a durable background task stops through its abort handler", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slice-cancel-"));
  const startedPath = join(directory, "started");
  const WaitTask = defineTask<{ startedPath: string }, { phase: "wait" }, string>({
    name: "test.cancellable-wait",
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: async (task, runtime, context) => {
        await writeFile(task.input.startedPath, "ready");
        await runtime.sleep(Date.now() + 60_000, context);
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: "unexpected" } }),
          context,
        );
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "test.cancellable", tasks: [WaitTask] }));
  const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "durable.sqlite")), {
    models: createModels(),
    registry,
  }, BACKGROUND_CONTEXT);

  try {
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    const taskId = await conversation.commit(
      (tx) => tx.createTask(WaitTask, { startedPath }, { ownership: { kind: "conversation" }, background: true }),
      BACKGROUND_CONTEXT,
    );
    harness.resume();
    await waitForFile(startedPath);
    assert.equal(await harness.abortTask(taskId, BACKGROUND_CONTEXT), "marked");
    const stopped = await harness.waitForTask(taskId, BACKGROUND_CONTEXT);
    assert.equal(stopped.state.status, "terminal");
    assert.equal(stopped.state.outcome.status, "aborted");
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  }
});
