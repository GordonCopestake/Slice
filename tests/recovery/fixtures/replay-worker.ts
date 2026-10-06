import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, defineTool, type ConversationId } from "@earendil-works/pi-durable";
import { PiDurableAdapter } from "../../../apps/server/src/adapters/pi-durable/pi-durable-adapter.js";
import { ApplicationStateStore } from "../../../apps/server/src/state/application-state.js";

const [mode, durablePath, statePath, remotePath, threadPath, gatePath, resultPath] = process.argv.slice(2);
if (!mode || !durablePath || !statePath || !remotePath || !threadPath || !gatePath || !resultPath) {
  throw new Error("Missing worker arguments");
}

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const marker = defineTool({
  name: "create-marker",
  description: "Create an idempotent test marker.",
  parameters: Type.Object({ key: Type.String() }),
  replay: "safe",
  execute: async ({ key }) => {
    const remote = new DatabaseSync(remotePath);
    remote.exec(`
      CREATE TABLE IF NOT EXISTS marker_effects (key TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS marker_attempts (key TEXT NOT NULL);
    `);
    remote.prepare("INSERT INTO marker_attempts (key) VALUES (?)").run(key);
    remote.prepare("INSERT OR IGNORE INTO marker_effects (key) VALUES (?)").run(key);
    remote.close();
    await writeFile(gatePath, "effect-recorded");
    if (mode === "start") await new Promise<never>(() => setInterval(() => {}, 1_000));
    return { content: [{ type: "text", text: "marker created" }] };
  },
});
const registry = createRegistry();
registry.install(defineExtension({ name: "test.safe-marker", tools: [marker] }));
faux.setResponses(
  mode === "start"
    ? [fauxAssistantMessage(fauxToolCall("create-marker", { key: "one-stable-key" }), { stopReason: "toolUse" })]
    : [fauxAssistantMessage("complete")],
);
const state = ApplicationStateStore.open(statePath);
const adapter = await PiDurableAdapter.open({
  durableDatabasePath: durablePath,
  state,
  models,
  registry,
});

try {
  const agent = { model: { provider: "faux", modelId: "faux-1" } };
  let threadId: ConversationId;
  if (mode === "start") {
    threadId = await adapter.createThread(agent);
    await writeFile(threadPath, String(threadId));
  } else {
    threadId = Number(await readFile(threadPath, "utf8")) as ConversationId;
  }
  const submission = await adapter.submit(threadId, "crash-replay", "Create the marker");
  const settled = await submission.wait(BACKGROUND_CONTEXT);
  await writeFile(resultPath, settled.status);
} finally {
  await adapter.close();
  state.close();
}
