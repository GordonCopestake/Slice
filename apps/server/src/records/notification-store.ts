import { DatabaseSync } from "node:sqlite";

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function assertId(name: string, value: string): void {
  if (!ID_PATTERN.test(value)) throw new TypeError(`${name} must be 1-128 letters, numbers, dots, underscores, colons, or hyphens`);
}

export type NotificationStatus = "queued" | "sent" | "failed" | "uncertain" | "suppressed";

export type NotificationRecord = {
  notificationId: string;
  jobId: string;
  kind: string;
  generation: number;
  channel: string;
  recipientRef: string;
  payload: Record<string, unknown>;
  status: NotificationStatus;
  attempts: number;
  nextAttemptAt: number | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
};

/**
 * Phase 3 notification outbox. Every notification has a stable deduplication ID, so a retried
 * delivery re-uses the same row and the history shows the attempts: one report record, one
 * notification, visible retries. Uncertain sends (the request may have reached Telegram) are never
 * blindly replayed; the spec accepts an occasional duplicate there and records the state honestly.
 */
export class NotificationStore {
  readonly #database: DatabaseSync;

  private constructor(database: DatabaseSync) {
    this.#database = database;
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS slice_notifications (
        notification_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('report', 'alert')),
        generation INTEGER NOT NULL,
        channel TEXT NOT NULL,
        recipient_ref TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed', 'uncertain', 'suppressed')) DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS slice_notify_due ON slice_notifications (status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS slice_notify_job ON slice_notifications (job_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS slice_notify_cursor (
        job_id TEXT PRIMARY KEY,
        last_seq INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS slice_telegram (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        chat_id TEXT,
        link_code TEXT,
        link_code_expires_at INTEGER,
        periodic_enabled INTEGER NOT NULL DEFAULT 0,
        update_offset INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);
    this.#database.prepare("INSERT INTO slice_telegram (singleton, updated_at) VALUES (1, ?) ON CONFLICT(singleton) DO NOTHING").run(Date.now());
  }

  static open(database: DatabaseSync): NotificationStore {
    return new NotificationStore(database);
  }

  // ---------------------------------------------------------------- outbox

  /** Enqueue with a stable deduplication ID; a repeat enqueue is a no-op, never a second message. */
  enqueue(input: { notificationId: string; jobId: string; kind: "report" | "alert"; generation: number; channel: string; recipientRef: string; payload: Record<string, unknown>; expiresAt: number }): boolean {
    assertId("notificationId", input.notificationId);
    assertId("jobId", input.jobId);
    const now = Date.now();
    const info = this.#database
      .prepare(`INSERT INTO slice_notifications (notification_id, job_id, kind, generation, channel, recipient_ref, payload_json, next_attempt_at, expires_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(notification_id) DO NOTHING`)
      .run(input.notificationId, input.jobId, input.kind, input.generation, input.channel, input.recipientRef.slice(0, 200), JSON.stringify(input.payload).slice(0, 8_000), now, input.expiresAt, now, now);
    return info.changes === 1;
  }

  dueNotifications(now: number, limit = 20): NotificationRecord[] {
    const rows = this.#database
      .prepare("SELECT * FROM slice_notifications WHERE status = 'queued' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?")
      .all(now, limit) as Record<string, unknown>[];
    return rows.map(toNotification);
  }

  listForJob(jobId: string, limit = 20): NotificationRecord[] {
    assertId("jobId", jobId);
    const rows = this.#database.prepare("SELECT * FROM slice_notifications WHERE job_id = ? ORDER BY created_at DESC LIMIT ?").all(jobId, limit) as Record<string, unknown>[];
    return rows.map(toNotification);
  }

  markSent(notificationId: string): void {
    assertId("notificationId", notificationId);
    this.#database.prepare("UPDATE slice_notifications SET status = 'sent', attempts = attempts + 1, next_attempt_at = NULL, updated_at = ? WHERE notification_id = ?").run(Date.now(), notificationId);
  }

  /** A refused send retries with backoff until the attempt limit, then stays failed. */
  markFailed(notificationId: string, maxAttempts = 5): void {
    assertId("notificationId", notificationId);
    const row = this.#database.prepare("SELECT attempts FROM slice_notifications WHERE notification_id = ?").get(notificationId) as { attempts: number } | undefined;
    const attempts = (row?.attempts ?? 0) + 1;
    const exhausted = attempts >= maxAttempts;
    this.#database
      .prepare("UPDATE slice_notifications SET status = ?, attempts = ?, next_attempt_at = ?, updated_at = ? WHERE notification_id = ?")
      .run(exhausted ? "failed" : "queued", attempts, exhausted ? null : Date.now() + Math.min(3_600_000, 30_000 * 2 ** attempts), Date.now(), notificationId);
  }

  /** An send whose outcome is unknown stays uncertain; it is never blindly replayed. */
  markUncertain(notificationId: string): void {
    assertId("notificationId", notificationId);
    this.#database.prepare("UPDATE slice_notifications SET status = 'uncertain', attempts = attempts + 1, next_attempt_at = NULL, updated_at = ? WHERE notification_id = ?").run(Date.now(), notificationId);
  }

  markSuppressed(notificationId: string): void {
    assertId("notificationId", notificationId);
    this.#database.prepare("UPDATE slice_notifications SET status = 'suppressed', next_attempt_at = NULL, updated_at = ? WHERE notification_id = ?").run(Date.now(), notificationId);
  }

  // ------------------------------------------------------- event scan cursor

  getLastSeq(jobId: string): number {
    assertId("jobId", jobId);
    const row = this.#database.prepare("SELECT last_seq FROM slice_notify_cursor WHERE job_id = ?").get(jobId) as { last_seq: number } | undefined;
    return row?.last_seq ?? 0;
  }

  setLastSeq(jobId: string, lastSeq: number): void {
    assertId("jobId", jobId);
    this.#database.prepare("INSERT INTO slice_notify_cursor (job_id, last_seq) VALUES (?, ?) ON CONFLICT(job_id) DO UPDATE SET last_seq = excluded.last_seq").run(jobId, lastSeq);
  }

  // -------------------------------------------------------------- telegram

  getTelegram(): { chatId: string | null; periodicEnabled: boolean; linkCode: string | null; linkCodeExpiresAt: number | null; updateOffset: number } {
    const row = this.#database.prepare("SELECT * FROM slice_telegram WHERE singleton = 1").get() as Record<string, unknown>;
    return {
      chatId: row.chat_id === null || row.chat_id === undefined ? null : String(row.chat_id),
      periodicEnabled: Number(row.periodic_enabled) === 1,
      linkCode: row.link_code === null || row.link_code === undefined ? null : String(row.link_code),
      linkCodeExpiresAt: row.link_code_expires_at === null || row.link_code_expires_at === undefined ? null : Number(row.link_code_expires_at),
      updateOffset: Number(row.update_offset),
    };
  }

  startLinkCode(code: string): void {
    if (!/^[A-Za-z0-9]{6,16}$/.test(code)) throw new TypeError("Link codes must be 6-16 alphanumeric characters");
    this.#database.prepare("UPDATE slice_telegram SET link_code = ?, link_code_expires_at = ?, updated_at = ? WHERE singleton = 1")
      .run(code, Date.now() + 15 * 60_000, Date.now());
  }

  /** Confirm a chat that presented the current, unexpired code. One code, one link. */
  confirmLink(chatId: string, presentedCode: string): boolean {
    const current = this.getTelegram();
    if (current.linkCode === null || current.linkCodeExpiresAt === null || current.linkCode !== presentedCode || current.linkCodeExpiresAt < Date.now()) return false;
    this.#database.prepare("UPDATE slice_telegram SET chat_id = ?, link_code = NULL, link_code_expires_at = NULL, updated_at = ? WHERE singleton = 1")
      .run(chatId.slice(0, 64), Date.now());
    return true;
  }

  setChatId(chatId: string): void {
    this.#database.prepare("UPDATE slice_telegram SET chat_id = ?, updated_at = ? WHERE singleton = 1").run(chatId.slice(0, 64), Date.now());
  }

  unlinkTelegram(): void {
    this.#database.prepare("UPDATE slice_telegram SET chat_id = NULL, link_code = NULL, link_code_expires_at = NULL, updated_at = ? WHERE singleton = 1").run(Date.now());
  }

  setPeriodicEnabled(enabled: boolean): void {
    this.#database.prepare("UPDATE slice_telegram SET periodic_enabled = ?, updated_at = ? WHERE singleton = 1").run(enabled ? 1 : 0, Date.now());
  }

  setUpdateOffset(offset: number): void {
    this.#database.prepare("UPDATE slice_telegram SET update_offset = ?, updated_at = ? WHERE singleton = 1").run(offset, Date.now());
  }
}

function toNotification(row: Record<string, unknown>): NotificationRecord {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
  } catch {
    payload = { unreadable: true };
  }
  return {
    notificationId: String(row.notification_id),
    jobId: String(row.job_id),
    kind: String(row.kind),
    generation: Number(row.generation),
    channel: String(row.channel),
    recipientRef: String(row.recipient_ref),
    payload,
    status: String(row.status) as NotificationStatus,
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at === null ? null : Number(row.next_attempt_at),
    expiresAt: Number(row.expires_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
