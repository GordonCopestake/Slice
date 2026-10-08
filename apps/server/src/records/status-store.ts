import { DatabaseSync } from "node:sqlite";

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function assertId(name: string, value: string): void {
  if (!ID_PATTERN.test(value)) throw new TypeError(`${name} must be 1-128 letters, numbers, dots, underscores, colons, or hyphens`);
}

export type ReportPlan = {
  jobId: string;
  enabled: boolean;
  intervalMinutes: number;
  generation: number;
  nextReportAt: number | null;
  lastReportAt: number | null;
  final: boolean;
  updatedAt: number;
};

export type StatusReportRecord = {
  jobId: string;
  generation: number;
  dueAt: number;
  createdAt: number;
  contentVersion: string;
  final: boolean;
  report: Record<string, unknown>;
};

export type EtaEstimate = {
  estimateSeconds: number;
  minSeconds: number;
  maxSeconds: number;
  cohortSize: number;
  meanAbsErrorSeconds: number | null;
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  const middle = sorted[mid] ?? sorted[mid - 1] ?? 0;
  return sorted.length % 2 === 1 ? middle : ((sorted[mid - 1] ?? 0) + middle) / 2;
}

/**
 * Phase 3 status truth: the per-job reporting plan (interval, generation, next due time), the
 * immutable report records, and the small duration history that calibrates estimates. A report
 * record is unique per job, generation, and due time, so a restart at a report boundary creates
 * exactly one report for that time, and missed ticks coalesce instead of producing a backlog.
 */
export class StatusStore {
  readonly #database: DatabaseSync;

  private constructor(database: DatabaseSync) {
    this.#database = database;
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS slice_report_plan (
        job_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        interval_minutes INTEGER NOT NULL DEFAULT 10,
        generation INTEGER NOT NULL DEFAULT 1,
        next_report_at INTEGER,
        last_report_at INTEGER,
        final INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS slice_status_reports (
        job_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        due_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        content_version TEXT NOT NULL,
        final INTEGER NOT NULL DEFAULT 0,
        report_json TEXT NOT NULL,
        PRIMARY KEY (job_id, generation, due_at)
      );
      CREATE INDEX IF NOT EXISTS slice_reports_job_time ON slice_status_reports (job_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS slice_job_stages (
        job_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        entered_at INTEGER NOT NULL,
        ready_at INTEGER NOT NULL,
        PRIMARY KEY (job_id, stage)
      );
      CREATE TABLE IF NOT EXISTS slice_estimate_errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        estimate_seconds INTEGER NOT NULL,
        actual_seconds INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  static open(database: DatabaseSync): StatusStore {
    return new StatusStore(database);
  }

  // ----------------------------------------------------------------- plan

  /** Seed the plan from the job's stored report settings; the first report is due one interval after creation. */
  ensurePlan(job: { jobId: string; reportsEnabled: boolean; reportIntervalMinutes: number; createdAt: number }): ReportPlan {
    assertId("jobId", job.jobId);
    this.#database
      .prepare(`INSERT INTO slice_report_plan (job_id, enabled, interval_minutes, generation, next_report_at, updated_at)
                VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(job_id) DO NOTHING`)
      .run(job.jobId, job.reportsEnabled ? 1 : 0, job.reportIntervalMinutes, job.createdAt + job.reportIntervalMinutes * 60_000, Date.now());
    return this.getPlan(job.jobId)!;
  }

  getPlan(jobId: string): ReportPlan | undefined {
    assertId("jobId", jobId);
    const row = this.#database.prepare("SELECT * FROM slice_report_plan WHERE job_id = ?").get(jobId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toPlan(row);
  }

  /** Changing the interval or enablement starts a new generation; queued deliveries for the old generation are no longer sent. */
  setPlanSettings(jobId: string, enabled: boolean, intervalMinutes: number): ReportPlan {
    assertId("jobId", jobId);
    if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 60) {
      throw new TypeError("Report intervals must be between 1 and 60 minutes");
    }
    const now = Date.now();
    this.#database
      .prepare(`UPDATE slice_report_plan SET enabled = ?, interval_minutes = ?, generation = generation + 1,
                next_report_at = ?, final = 0, updated_at = ? WHERE job_id = ?`)
      .run(enabled ? 1 : 0, intervalMinutes, enabled ? now + intervalMinutes * 60_000 : null, now, jobId);
    return this.getPlan(jobId)!;
  }

  /** A new request for changes (steering) starts a new reporting generation. */
  bumpGeneration(jobId: string): ReportPlan | undefined {
    assertId("jobId", jobId);
    const plan = this.getPlan(jobId);
    if (plan === undefined) return undefined;
    const now = Date.now();
    this.#database
      .prepare("UPDATE slice_report_plan SET generation = generation + 1, next_report_at = ?, final = 0, updated_at = ? WHERE job_id = ?")
      .run(plan.enabled ? now + plan.intervalMinutes * 60_000 : null, now, jobId);
    return this.getPlan(jobId);
  }

  /** Plans whose next tick is due at or before 'now'. Overdue plans appear once, not once per missed tick. */
  duePlans(now: number): ReportPlan[] {
    const rows = this.#database
      .prepare("SELECT * FROM slice_report_plan WHERE enabled = 1 AND final = 0 AND next_report_at IS NOT NULL AND next_report_at <= ? ORDER BY job_id")
      .all(now) as Record<string, unknown>[];
    return rows.map(toPlan);
  }

  activePlans(): ReportPlan[] {
    const rows = this.#database.prepare("SELECT * FROM slice_report_plan WHERE final = 0 ORDER BY job_id").all() as Record<string, unknown>[];
    return rows.map(toPlan);
  }

  scheduleNext(jobId: string, now: number): void {
    assertId("jobId", jobId);
    const plan = this.getPlan(jobId);
    if (plan === undefined) return;
    this.#database
      .prepare("UPDATE slice_report_plan SET next_report_at = ?, last_report_at = ?, updated_at = ? WHERE job_id = ?")
      .run(now + plan.intervalMinutes * 60_000, now, now, jobId);
  }

  markFinal(jobId: string): void {
    assertId("jobId", jobId);
    this.#database.prepare("UPDATE slice_report_plan SET final = 1, next_report_at = NULL, updated_at = ? WHERE job_id = ?").run(Date.now(), jobId);
  }

  // -------------------------------------------------------------- reports

  /** One record per job, generation, and due time; a duplicate due time returns the stored record. */
  recordReport(jobId: string, generation: number, dueAt: number, contentVersion: string, isFinal: boolean, report: Record<string, unknown>): StatusReportRecord | undefined {
    assertId("jobId", jobId);
    this.#database
      .prepare(`INSERT INTO slice_status_reports (job_id, generation, due_at, created_at, content_version, final, report_json)
                VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(job_id, generation, due_at) DO NOTHING`)
      .run(jobId, generation, dueAt, Date.now(), contentVersion, isFinal ? 1 : 0, JSON.stringify(report));
    return this.getReport(jobId, generation, dueAt);
  }

  getReport(jobId: string, generation: number, dueAt: number): StatusReportRecord | undefined {
    const row = this.#database.prepare("SELECT * FROM slice_status_reports WHERE job_id = ? AND generation = ? AND due_at = ?").get(jobId, generation, dueAt) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toReport(row);
  }

  listReports(jobId: string, limit = 20): StatusReportRecord[] {
    assertId("jobId", jobId);
    const rows = this.#database.prepare("SELECT * FROM slice_status_reports WHERE job_id = ? ORDER BY due_at DESC LIMIT ?").all(jobId, limit) as Record<string, unknown>[];
    return rows.map(toReport);
  }

  // ------------------------------------------------------- calibration data

  /**
   * Record a finished job's stage timeline for calibration. 'stageEntries' maps stage name to the
   * time it was first entered; readyAt is when the job became ready (or its terminal time).
   */
  recordCompletion(jobId: string, projectId: string, stageEntries: Map<string, number>, readyAt: number): void {
    assertId("jobId", jobId);
    assertId("projectId", projectId);
    // Completion is recorded once; re-scoring the same job would double-count estimate errors.
    const already = this.#database.prepare("SELECT 1 FROM slice_job_stages WHERE job_id = ? LIMIT 1").get(jobId);
    if (already !== undefined) return;
    const insert = this.#database.prepare("INSERT INTO slice_job_stages (job_id, project_id, stage, entered_at, ready_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(job_id, stage) DO NOTHING");
    for (const [stage, enteredAt] of stageEntries) insert.run(jobId, projectId, stage, enteredAt, readyAt);
    this.#scoreStoredEstimates(jobId, projectId, readyAt);
  }

  /** Comparable history: same project, same stage, jobs that reached ready. */
  etaFor(projectId: string, stage: string, now: number): EtaEstimate | null {
    assertId("projectId", projectId);
    const rows = this.#database
      .prepare("SELECT entered_at, ready_at FROM slice_job_stages WHERE project_id = ? AND stage = ?")
      .all(projectId, stage) as { entered_at: number; ready_at: number }[];
    if (rows.length === 0) return null;
    const durations = rows.map((row) => Math.round((row.ready_at - row.entered_at) / 1000)).filter((value) => Number.isFinite(value) && value >= 0);
    if (durations.length === 0) return null;
    const errors = this.#database
      .prepare("SELECT estimate_seconds, actual_seconds FROM slice_estimate_errors WHERE project_id = ?")
      .all(projectId) as { estimate_seconds: number; actual_seconds: number }[];
    const meanAbs = errors.length === 0 ? null : errors.reduce((sum, e) => sum + Math.abs(e.estimate_seconds - e.actual_seconds), 0) / errors.length;
    return {
      estimateSeconds: Math.round(median(durations)),
      minSeconds: Math.min(...durations),
      maxSeconds: Math.max(...durations),
      cohortSize: durations.length,
      meanAbsErrorSeconds: meanAbs === null ? null : Math.round(meanAbs),
    };
  }

  /** When a job finishes, score every estimate its reports carried against what actually happened. */
  #scoreStoredEstimates(jobId: string, projectId: string, readyAt: number): void {
    const reports = this.#database.prepare("SELECT created_at, report_json FROM slice_status_reports WHERE job_id = ?").all(jobId) as { created_at: number; report_json: string }[];
    const insert = this.#database.prepare("INSERT INTO slice_estimate_errors (job_id, project_id, estimate_seconds, actual_seconds, created_at) VALUES (?, ?, ?, ?, ?)");
    for (const row of reports) {
      let report: { eta?: { estimateSeconds?: number } | null };
      try {
        report = JSON.parse(row.report_json) as { eta?: { estimateSeconds?: number } | null };
      } catch {
        continue;
      }
      const estimate = report.eta?.estimateSeconds;
      if (typeof estimate !== "number") continue;
      insert.run(jobId, projectId, Math.round(estimate), Math.max(0, Math.round((readyAt - row.created_at) / 1000)), Date.now());
    }
  }
}

function toPlan(row: Record<string, unknown>): ReportPlan {
  return {
    jobId: String(row.job_id),
    enabled: Number(row.enabled) === 1,
    intervalMinutes: Number(row.interval_minutes),
    generation: Number(row.generation),
    nextReportAt: row.next_report_at === null ? null : Number(row.next_report_at),
    lastReportAt: row.last_report_at === null ? null : Number(row.last_report_at),
    final: Number(row.final) === 1,
    updatedAt: Number(row.updated_at),
  };
}

function toReport(row: Record<string, unknown>): StatusReportRecord {
  let report: Record<string, unknown>;
  try {
    report = JSON.parse(String(row.report_json)) as Record<string, unknown>;
  } catch {
    report = { unreadable: true };
  }
  return {
    jobId: String(row.job_id),
    generation: Number(row.generation),
    dueAt: Number(row.due_at),
    createdAt: Number(row.created_at),
    contentVersion: String(row.content_version),
    final: Number(row.final) === 1,
    report,
  };
}
