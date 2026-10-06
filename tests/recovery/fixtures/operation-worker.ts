import { DatabaseSync } from "node:sqlite";
import { writeFile } from "node:fs/promises";
import { ApplicationStateStore } from "../../../apps/server/src/state/application-state.js";
import { ExternalOperationJournal } from "../../../apps/server/src/workflow/external-operation-journal.js";

const [mode, statePath, remotePath, gatePath, resultPath] = process.argv.slice(2);
if (!mode || !statePath || !remotePath || !gatePath || !resultPath) throw new Error("Missing worker arguments");
const state = ApplicationStateStore.open(statePath);
const journal = new ExternalOperationJournal(state.database, mode);
const driver = {
  execute: async (key: string, payload: { readonly value: string }) => {
    const remote = new DatabaseSync(remotePath);
    remote.exec("CREATE TABLE IF NOT EXISTS external_effects (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    remote.prepare("INSERT OR IGNORE INTO external_effects (key, value) VALUES (?, ?)").run(key, payload.value);
    remote.close();
    if (mode === "start") {
      await writeFile(gatePath, "effect-recorded");
      await new Promise<never>(() => setInterval(() => {}, 1_000));
    }
    return { receipt: `receipt:${key}` } as const;
  },
  reconcile: async (key: string) => {
    const remote = new DatabaseSync(remotePath);
    remote.exec("CREATE TABLE IF NOT EXISTS external_effects (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    const row = remote.prepare("SELECT value FROM external_effects WHERE key = ?").get(key) as { value: string } | undefined;
    remote.close();
    return row === undefined
      ? { status: "not_started" as const }
      : { status: "completed" as const, result: { receipt: `receipt:${key}` } };
  },
};

try {
  const result = await journal.run("external:test-1", { value: "written" }, driver);
  await writeFile(resultPath, JSON.stringify(result));
} finally {
  state.close();
}
