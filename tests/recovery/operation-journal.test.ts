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

test("journals on separate connections share in-flight operation deduplication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slice-operation-two-connections-"));
  const databasePath = join(directory, "state.sqlite");
  const firstState = ApplicationStateStore.open(databasePath);
  const secondState = ApplicationStateStore.open(databasePath);
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
    reconcile: async () => ({ status: "not_started" as const }),
  };
  try {
    const first = new ExternalOperationJournal(firstState.database, "first-owner").run(
      "publish:two-connections",
      { version: "v1" },
      driver,
    );
    const second = new ExternalOperationJournal(secondState.database, "second-owner").run(
      "publish:two-connections",
      { version: "v1" },
      driver,
    );
    assert.equal(dispatches, 1, "a second connection must not dispatch an operation already in flight");
    assert.throws(
      () => new ExternalOperationJournal(secondState.database, "second-owner").run(
        "publish:two-connections",
        { version: "v2" },
        driver,
      ),
      /different input/,
    );
    finishExecution?.({ completed: true });
    assert.deepEqual(await Promise.all([first, second]), [{ completed: true }, { completed: true }]);
    assert.equal(dispatches, 1);
  } finally {
    firstState.close();
    secondState.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an operation is dispatched again once the in-flight call has settled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slice-operation-settled-"));
  const databasePath = join(directory, "state.sqlite");
  const firstState = ApplicationStateStore.open(databasePath);
  const secondState = ApplicationStateStore.open(databasePath);
  try {
    const first = new ExternalOperationJournal(firstState.database, "first-owner").run(
      "publish:settled",
      { version: "v1" },
      {
        execute: async () => {
          throw new Error("dispatch failed after the remote call");
        },
        reconcile: async () => ({ status: "not_started" as const }),
      },
    );
    await assert.rejects(first, /dispatch failed/);

    const second = new ExternalOperationJournal(secondState.database, "second-owner").run(
      "publish:settled",
      { version: "v1" },
      {
        execute: async () => ({ published: true }),
        reconcile: async () => ({ status: "not_started" as const }),
      },
    );
    assert.deepEqual(await second, { published: true });
  } finally {
    firstState.close();
    secondState.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a journal built after an operation settled still shares in-flight state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slice-operation-late-journal-"));
  const databasePath = join(directory, "state.sqlite");
  const firstState = ApplicationStateStore.open(databasePath);
  const secondState = ApplicationStateStore.open(databasePath);
  let dispatches = 0;
  let finishB: ((value: { id: string }) => void) | undefined;
  const gateB = new Promise<{ id: string }>((resolve) => {
    finishB = resolve;
  });
  const driver = {
    execute: async (key: string) => {
      dispatches += 1;
      return key === "publish:settled-first" ? { id: "done" } : gateB;
    },
    reconcile: async () => ({ status: "not_started" as const }),
  };
  try {
    // Settle one operation so the shared in-flight set becomes empty, which previously deleted it from the registry.
    const first = new ExternalOperationJournal(firstState.database, "first-owner");
    assert.deepEqual(
      await first.run("publish:settled-first", { version: "v1" }, driver),
      { id: "done" },
    );
    assert.equal(dispatches, 1);

    // Start a second operation that stays in flight, then build a fresh journal on another connection.
    const inFlight = first.run("publish:b", { version: "v1" }, driver);
    assert.equal(dispatches, 2);
    const late = new ExternalOperationJournal(secondState.database, "late-owner").run(
      "publish:b",
      { version: "v1" },
      driver,
    );
    assert.equal(dispatches, 2, "a journal built after a settle must still see the operation in flight");
    finishB?.({ id: "publish:b" });
    assert.deepEqual(await Promise.all([inFlight, late]), [{ id: "publish:b" }, { id: "publish:b" }]);
    assert.equal(dispatches, 2);
  } finally {
    firstState.close();
    secondState.close();
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
