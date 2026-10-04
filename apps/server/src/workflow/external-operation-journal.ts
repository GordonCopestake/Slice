import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { hashJson, type JsonValue } from "../state/application-state.js";

export type Reconciliation<R extends JsonValue> =
  | { readonly status: "completed"; readonly result: R }
  | { readonly status: "not_started" }
  | { readonly status: "unknown"; readonly reason: string };

export type ExternalOperationDriver<P extends JsonValue, R extends JsonValue> = {
  /** The key is stable across retries. The remote side should enforce it when possible. */
  execute(idempotencyKey: string, payload: P): Promise<R>;
  /** Resolve an operation that was in flight when the previous process stopped. */
  reconcile(idempotencyKey: string, payload: P): Promise<Reconciliation<R>>;
};

export class UncertainExternalOperationError extends Error {
  readonly operationId: string;

  constructor(operationId: string, reason: string) {
    super(`External operation ${operationId} needs reconciliation: ${reason}`);
    this.name = "UncertainExternalOperationError";
    this.operationId = operationId;
  }
}

type OperationRow = {
  payload_hash: string;
  status: "running" | "uncertain" | "succeeded";
  owner_id: string;
  result_json: string | null;
};

type InFlightOperation = { payloadHash: string; promise: Promise<JsonValue> };

/** At-most-once local dispatch with explicit reconciliation after an ambiguous result. */
export class ExternalOperationJournal {
  /**
   * Keyed by resolved database file so that separate connections to one file share in-flight operations. Entries are
   * kept for the life of the process: removing an emptied map orphans the reference held by journals that already
   * share it, and a journal built afterwards would start with an empty map and dispatch an in-flight operation twice.
   */
  static readonly #inFlightByFile = new Map<string, Map<string, InFlightOperation>>();
  /** An in-memory database has no shared file, so its connections are coordinated by object identity instead. */
  static readonly #inFlightByDatabase = new WeakMap<DatabaseSync, Map<string, InFlightOperation>>();

  readonly #database: DatabaseSync;
  readonly #ownerId: string;
  readonly #inFlight: Map<string, InFlightOperation>;

  constructor(database: DatabaseSync, ownerId: string = randomUUID()) {
    this.#database = database;
    this.#ownerId = ownerId;
    this.#inFlight = ExternalOperationJournal.#sharedInFlight(database);
  }

  run<P extends JsonValue, R extends JsonValue>(
    operationId: string,
    payload: P,
    driver: ExternalOperationDriver<P, R>,
  ): Promise<R> {
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(operationId)) throw new TypeError("Invalid external operation ID");
    const payloadHash = hashJson(payload);
    const active = this.#inFlight.get(operationId);
    if (active !== undefined) {
      if (active.payloadHash !== payloadHash) throw new Error("An active operation ID cannot be reused with different input");
      return active.promise as Promise<R>;
    }

    const promise = this.#run(operationId, payload, payloadHash, driver);
    this.#inFlight.set(operationId, { payloadHash, promise: promise as Promise<JsonValue> });
    void promise.finally(() => this.#release(operationId, promise)).catch(() => {});
    return promise;
  }

  static #fileOf(database: DatabaseSync): string | null {
    const location = database.location();
    return location === null || location === "" ? null : resolve(location);
  }

  static #sharedInFlight(database: DatabaseSync): Map<string, InFlightOperation> {
    const file = ExternalOperationJournal.#fileOf(database);
    if (file === null) {
      const existing = ExternalOperationJournal.#inFlightByDatabase.get(database);
      if (existing !== undefined) return existing;
      const created = new Map<string, InFlightOperation>();
      ExternalOperationJournal.#inFlightByDatabase.set(database, created);
      return created;
    }
    const existing = ExternalOperationJournal.#inFlightByFile.get(file);
    if (existing !== undefined) return existing;
    const created = new Map<string, InFlightOperation>();
    ExternalOperationJournal.#inFlightByFile.set(file, created);
    return created;
  }

  /** Forget a settled operation so a later call dispatches again instead of replaying a stale promise. */
  #release(operationId: string, promise: Promise<JsonValue>): void {
    if (this.#inFlight.get(operationId)?.promise === promise) this.#inFlight.delete(operationId);
  }

  async #run<P extends JsonValue, R extends JsonValue>(
    operationId: string,
    payload: P,
    payloadHash: string,
    driver: ExternalOperationDriver<P, R>,
  ): Promise<R> {
    let row = this.#read(operationId);
    if (row !== undefined && row.payload_hash !== payloadHash) {
      throw new Error("An external operation ID cannot be reused with different input");
    }
    if (row?.status === "succeeded") return this.#readResult<R>(row);

    if (row === undefined) {
      this.#database
        .prepare(
          `INSERT INTO slice_external_operations
            (operation_id, payload_hash, status, owner_id, result_json, updated_at)
           VALUES (?, ?, 'running', ?, NULL, ?)`,
        )
        .run(operationId, payloadHash, this.#ownerId, Date.now());
    } else {
      this.#setUncertain(operationId);
      let result: Reconciliation<R>;
      try {
        result = await driver.reconcile(operationId, payload);
      } catch {
        throw new UncertainExternalOperationError(operationId, "the remote system did not return a reliable status");
      }
      if (result.status === "completed") {
        this.#setSucceeded(operationId, result.result);
        return result.result;
      }
      if (result.status === "unknown") {
        throw new UncertainExternalOperationError(operationId, result.reason);
      }
      this.#setRunning(operationId);
    }

    try {
      const result = await driver.execute(operationId, payload);
      this.#setSucceeded(operationId, result);
      return result;
    } catch (error) {
      this.#setUncertain(operationId);
      throw error;
    }
  }

  #read(operationId: string): OperationRow | undefined {
    return this.#database
      .prepare(
        `SELECT payload_hash, status, owner_id, result_json
         FROM slice_external_operations WHERE operation_id = ?`,
      )
      .get(operationId) as OperationRow | undefined;
  }

  #readResult<R extends JsonValue>(row: OperationRow): R {
    if (row.result_json === null) throw new Error("A completed external operation has no stored result");
    return JSON.parse(row.result_json) as R;
  }

  #setUncertain(operationId: string): void {
    this.#database
      .prepare("UPDATE slice_external_operations SET status = 'uncertain', updated_at = ? WHERE operation_id = ?")
      .run(Date.now(), operationId);
  }

  #setRunning(operationId: string): void {
    this.#database
      .prepare(
        "UPDATE slice_external_operations SET status = 'running', owner_id = ?, updated_at = ? WHERE operation_id = ?",
      )
      .run(this.#ownerId, Date.now(), operationId);
  }

  #setSucceeded(operationId: string, result: JsonValue): void {
    const resultJson = JSON.stringify(result);
    if (resultJson === undefined) throw new TypeError("External operation results must be JSON values");
    this.#database
      .prepare(
        `UPDATE slice_external_operations
         SET status = 'succeeded', owner_id = ?, result_json = ?, updated_at = ?
         WHERE operation_id = ?`,
      )
      .run(this.#ownerId, resultJson, Date.now(), operationId);
  }
}
