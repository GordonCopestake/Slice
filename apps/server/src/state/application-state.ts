import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };

type SubmissionRow = {
  payload_hash: string;
  submission_id: number | null;
};

/** Deepest payload accepted. Issue text and tool arguments are untrusted, so the walk is bounded rather than recursive to the stack limit. */
const MAX_JSON_DEPTH = 64;

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Request values must use finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value).sort(([left], [right]) => compareKeys(left, right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

/** UTF-16 code-unit order, so the canonical form does not change with the host locale or collation tables. */
function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertDepth(value: JsonValue, depth: number): void {
  if (depth > MAX_JSON_DEPTH) throw new TypeError(`Request values must not nest deeper than ${MAX_JSON_DEPTH} levels`);
  if (Array.isArray(value)) {
    for (const item of value) assertDepth(item, depth + 1);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) assertDepth(entry, depth + 1);
  }
}

export function hashJson(value: JsonValue): string {
  assertDepth(value, 0);
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("This request ID was already used with different input");
    this.name = "IdempotencyConflictError";
  }
}

/** Application-owned records use the same SQLite file as Pi Durable. */
export class ApplicationStateStore {
  readonly #database: DatabaseSync;

  private constructor(database: DatabaseSync) {
    this.#database = database;
    try {
      this.#database.exec("PRAGMA journal_mode = WAL;");
      this.#database.exec("PRAGMA synchronous = NORMAL;");
      this.#database.exec("PRAGMA busy_timeout = 5000;");
      this.#database.exec(`
      CREATE TABLE IF NOT EXISTS slice_submission_requests (
        thread_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        submission_id INTEGER,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (thread_id, request_id)
      );
    `);
      this.#database.exec(`
      CREATE TABLE IF NOT EXISTS slice_external_operations (
        operation_id TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'uncertain', 'succeeded')),
        owner_id TEXT NOT NULL,
        result_json TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
    } catch (error) {
      // A half-initialised store must not keep its handle open on the state file.
      this.#database.close();
      throw error;
    }
  }

  static open(filePath: string): ApplicationStateStore {
    mkdirSync(dirname(filePath), { recursive: true });
    return new ApplicationStateStore(new DatabaseSync(filePath));
  }

  /** Reserve an API request ID and reject reuse with a different payload. */
  reserveSubmission(threadId: string, requestId: string, payload: JsonValue): number | undefined {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(threadId)) {
      throw new TypeError("Thread IDs must be 1–128 letters, numbers, dots, underscores, colons, or hyphens");
    }
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)) {
      throw new TypeError("Request IDs must be 1–128 letters, numbers, dots, underscores, colons, or hyphens");
    }
    const payloadHash = hashJson(payload);
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO slice_submission_requests
          (thread_id, request_id, payload_hash, submission_id, created_at)
         VALUES (?, ?, ?, NULL, ?)`,
      )
      .run(threadId, requestId, payloadHash, Date.now());
    const row = this.#database
      .prepare(
        `SELECT payload_hash, submission_id FROM slice_submission_requests
         WHERE thread_id = ? AND request_id = ?`,
      )
      .get(threadId, requestId) as SubmissionRow | undefined;
    if (row === undefined) throw new Error("Could not reserve request ID");
    if (row.payload_hash !== payloadHash) throw new IdempotencyConflictError();
    return row.submission_id ?? undefined;
  }

  recordSubmission(threadId: string, requestId: string, submissionId: number): void {
    this.#database
      .prepare(
        `UPDATE slice_submission_requests SET submission_id = ?
         WHERE thread_id = ? AND request_id = ? AND submission_id IS NULL`,
      )
      .run(submissionId, threadId, requestId);
  }

  submissionId(threadId: string, requestId: string): number | undefined {
    const row = this.#database
      .prepare(
        `SELECT submission_id FROM slice_submission_requests
         WHERE thread_id = ? AND request_id = ?`,
      )
      .get(threadId, requestId) as { submission_id: number | null } | undefined;
    return row?.submission_id ?? undefined;
  }

  /** Internal database shared by the request index and external-operation journal. */
  get database(): DatabaseSync {
    return this.#database;
  }

  close(): void {
    this.#database.close();
  }
}
