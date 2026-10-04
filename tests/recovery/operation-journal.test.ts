import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApplicationStateStore } from "../../apps/server/src/state/application-state.js";
import {
  ExternalOperationJournal,
  UncertainExternalOperationError,
} from "../../apps/server/src/workflow/external-operation-journal.js";

test("an unresolved external operation stays blocked and does not dispatch again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slice-operation-unknown-"));
  const state = ApplicationStateStore.open(join(directory, "state.sqlite"));
  let dispatches = 0;
  try {
    const first = new ExternalOperationJournal(state.database, "first-process");
    await assert.rejects(
      first.run("publish:123", { version: "v1" }, {
        execute: async () => {
          dispatches += 1;
          throw new Error("Connection ended after dispatch");
        },
        reconcile: async () => ({ status: "unknown", reason: "remote status endpoint unavailable" }),
      }),
      /Connection ended after dispatch/,
    );

    const resumed = new ExternalOperationJournal(state.database, "resumed-process");
    await assert.rejects(
      resumed.run("publish:123", { version: "v1" }, {
        execute: async () => {
          dispatches += 1;
          return { published: true };
        },
        reconcile: async () => ({ status: "unknown", reason: "remote status endpoint unavailable" }),
      }),
      UncertainExternalOperationError,
    );
    assert.equal(dispatches, 1);
    const row = state.database
      .prepare("SELECT status FROM slice_external_operations WHERE operation_id = ?")
      .get("publish:123") as { status: string };
    assert.equal(row.status, "uncertain");
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("separate journal instances share in-flight operation deduplication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slice-operation-concurrent-"));
  const state = ApplicationStateStore.open(join(directory, "state.sqlite"));
  let dispatches = 0;
  let finishExecution: ((value: { completed: true }) => void) | undefined;
  const execution = new Promise<{ completed: true }>((resolve) => {
    finishExecution = resolve;
  });
  const driver = {
    execute: async () => {
      dispatches += 1;
      return execution;
    },
    reconcile: async () => ({ status: "unknown" as const, reason: "not expected" }),
  };
  try {
    const firstJournal = new ExternalOperationJournal(state.database, "first-owner");
    const secondJournal = new ExternalOperationJournal(state.database, "same-owner");
    const first = firstJournal.run("publish:concurrent", { version: "v1" }, driver);
    const second = secondJournal.run("publish:concurrent", { version: "v1" }, driver);
    assert.equal(dispatches, 1);
    assert.throws(
      () => secondJournal.run("publish:concurrent", { version: "v2" }, driver),
      /different input/,
    );
    finishExecution?.({ completed: true });
    assert.deepEqual(await Promise.all([first, second]), [{ completed: true }, { completed: true }]);
    assert.equal(dispatches, 1);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});
