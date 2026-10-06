import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Keep one process as the owner of a Slice state directory. SQLite releases the lock on process death. */
export class SingleOwnerLock {
  readonly #database: DatabaseSync;
  #released = false;

  private constructor(database: DatabaseSync) {
    this.#database = database;
  }

  static acquire(filePath: string): SingleOwnerLock {
    mkdirSync(dirname(filePath), { recursive: true });
    const database = new DatabaseSync(filePath);
    try {
      database.exec("PRAGMA busy_timeout = 0;");
      database.exec("BEGIN IMMEDIATE;");
      return new SingleOwnerLock(database);
    } catch {
      database.close();
      throw new Error("Another Slice process already owns this state directory");
    }
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    try {
      this.#database.exec("ROLLBACK;");
    } finally {
      this.#database.close();
    }
  }
}
