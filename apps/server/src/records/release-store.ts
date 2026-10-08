import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Release tracking and rollback rehearsal records.
 *
 * A release is what actually landed on a project's default branch, tied to the evidence artifact
 * that can restore it. A rehearsal is an attempt to restore an earlier release in a staging
 * workspace and run the project's checks against it. Neither grants any production credential: a
 * rehearsal runs on the project's registered worker, in a workspace Slice owns, using the retained
 * artifact - never a deployment system.
 */

export type ReleaseState = "recorded" | "superseded";
export type RehearsalOutcome = "passed" | "failed" | "uncertain";

export type ReleaseRecord = {
  releaseId: string;
  projectId: string;
  jobId: string;
  commitSha: string;
  branch: string;
  prNumber: number | null;
  hostId: string;
  artifactId: string | null;
  artifactDigest: string | null;
  state: ReleaseState;
  createdAt: number;
};

export type RehearsalRecord = {
  rehearsalId: string;
  projectId: string;
  releaseId: string;
  hostId: string;
  headCommit: string;
  outcome: RehearsalOutcome;
  checks: { checkId: string; status: string; exitCode: number | null; outputTail: string }[];
  evidenceArtifactId: string | null;
  reason: string | null;
  createdAt: number;
};

/** Paths whose change makes "just roll back" a claim that needs evidence, not an assumption. */
const DATABASE_SENSITIVE = /(^|\/)(migrations?|schema|db|database|sql)\//i;
const DATABASE_SUFFIX = /\.(sql|migration)$/i;

export function databaseSensitive(paths: string[]): string[] {
  return paths.filter((path) => DATABASE_SENSITIVE.test(path) || DATABASE_SUFFIX.test(path));
}

export function releaseId(projectId: string, commitSha: string): string {
  return `rel-${projectId}-${commitSha.slice(0, 12)}`;
}

export function rehearsalId(releaseId: string, attempt: number): string {
  return `reh-${releaseId}-${attempt}`;
}

export function rehearsalKey(releaseId: string): string {
  return `rehearsal:${releaseId}`;
}

export function compatibilityKey(jobId: string): string {
  return `rollback-compatibility:${jobId}`;
}

export function verificationKeyForRelease(release: ReleaseRecord): string {
  return createHash("sha256").update([
    "slice-release-v1",
    release.projectId,
    release.releaseId,
    release.commitSha,
    release.artifactDigest ?? "no-artifact",
  ].join("\n")).digest("hex");
}

export class ReleaseStore {
  readonly #database: DatabaseSync;

  private constructor(database: DatabaseSync) {
    this.#database = database;
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS slice_releases (
        release_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        branch TEXT NOT NULL,
        pr_number INTEGER,
        host_id TEXT NOT NULL,
        artifact_id TEXT,
        artifact_digest TEXT,
        state TEXT NOT NULL CHECK (state IN ('recorded', 'superseded')) DEFAULT 'recorded',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS slice_rollback_rehearsals (
        rehearsal_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        release_id TEXT NOT NULL,
        host_id TEXT NOT NULL,
        head_commit TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('passed', 'failed', 'uncertain')),
        checks_json TEXT NOT NULL,
        evidence_artifact_id TEXT,
        reason TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS slice_releases_project ON slice_releases (project_id, created_at DESC);
    `);
  }

  static open(database: DatabaseSync): ReleaseStore {
    return new ReleaseStore(database);
  }

  /** Record what landed. Re-recording the same commit is idempotent. */
  recordRelease(input: { projectId: string; jobId: string; commitSha: string; branch: string; prNumber: number | null; hostId: string; artifactId: string | null; artifactDigest: string | null }): ReleaseRecord {
    const id = releaseId(input.projectId, input.commitSha);
    const now = Date.now();
    this.#database.prepare(
      `INSERT INTO slice_releases (release_id, project_id, job_id, commit_sha, branch, pr_number, host_id, artifact_id, artifact_digest, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'recorded', ?)
       ON CONFLICT(release_id) DO UPDATE SET artifact_id = excluded.artifact_id, artifact_digest = excluded.artifact_digest`,
    ).run(id, input.projectId, input.jobId, input.commitSha, input.branch, input.prNumber, input.hostId, input.artifactId, input.artifactDigest, now);
    // Only one release per project is current; older ones stay available for restore.
    this.#database.prepare("UPDATE slice_releases SET state = 'superseded' WHERE project_id = ? AND release_id <> ? AND created_at < ?")
      .run(input.projectId, id, now);
    return this.getRelease(id)!;
  }

  getRelease(releaseIdValue: string): ReleaseRecord | undefined {
    const row = this.#database.prepare("SELECT * FROM slice_releases WHERE release_id = ?").get(releaseIdValue) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toRelease(row);
  }

  listReleases(projectId: string): ReleaseRecord[] {
    return (this.#database.prepare("SELECT * FROM slice_releases WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as Record<string, unknown>[]).map(toRelease);
  }

  currentRelease(projectId: string): ReleaseRecord | undefined {
    const row = this.#database.prepare("SELECT * FROM slice_releases WHERE project_id = ? AND state = 'recorded' ORDER BY created_at DESC LIMIT 1").get(projectId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toRelease(row);
  }

  /**
   * What a rollback would restore: the newest release that is still current for the project.
   * A database-sensitive change must show that this revision can actually be put back.
   */
  rollbackTarget(projectId: string): ReleaseRecord | undefined {
    const row = this.#database.prepare("SELECT * FROM slice_releases WHERE project_id = ? AND state = 'recorded' ORDER BY created_at DESC LIMIT 1").get(projectId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toRelease(row);
  }

  recordRehearsal(input: { rehearsalId: string; projectId: string; releaseId: string; hostId: string; headCommit: string; outcome: RehearsalOutcome; checks: { checkId: string; status: string; exitCode: number | null; outputTail: string }[]; evidenceArtifactId: string | null; reason: string | null }): RehearsalRecord {
    const now = Date.now();
    this.#database.prepare(
      `INSERT INTO slice_rollback_rehearsals (rehearsal_id, project_id, release_id, host_id, head_commit, outcome, checks_json, evidence_artifact_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(rehearsal_id) DO UPDATE SET outcome = excluded.outcome, checks_json = excluded.checks_json,
         evidence_artifact_id = excluded.evidence_artifact_id, reason = excluded.reason, created_at = excluded.created_at`,
    ).run(input.rehearsalId, input.projectId, input.releaseId, input.hostId, input.headCommit, input.outcome, JSON.stringify(input.checks), input.evidenceArtifactId, input.reason, now);
    return this.getRehearsal(input.rehearsalId)!;
  }

  getRehearsal(id: string): RehearsalRecord | undefined {
    const row = this.#database.prepare("SELECT * FROM slice_rollback_rehearsals WHERE rehearsal_id = ?").get(id) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : {
      rehearsalId: String(row.rehearsal_id),
      projectId: String(row.project_id),
      releaseId: String(row.release_id),
      hostId: String(row.host_id),
      headCommit: String(row.head_commit),
      outcome: String(row.outcome) as RehearsalOutcome,
      checks: JSON.parse(String(row.checks_json)) as RehearsalRecord["checks"],
      evidenceArtifactId: row.evidence_artifact_id === null || row.evidence_artifact_id === undefined ? null : String(row.evidence_artifact_id),
      reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
      createdAt: Number(row.created_at),
    };
  }

  listRehearsals(projectId: string): RehearsalRecord[] {
    return (this.#database.prepare("SELECT * FROM slice_rollback_rehearsals WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as Record<string, unknown>[]).map((row) => ({
      rehearsalId: String(row.rehearsal_id),
      projectId: String(row.project_id),
      releaseId: String(row.release_id),
      hostId: String(row.host_id),
      headCommit: String(row.head_commit),
      outcome: String(row.outcome) as RehearsalOutcome,
      checks: JSON.parse(String(row.checks_json)) as RehearsalRecord["checks"],
      evidenceArtifactId: row.evidence_artifact_id === null || row.evidence_artifact_id === undefined ? null : String(row.evidence_artifact_id),
      reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
      createdAt: Number(row.created_at),
    }));
  }

  /** A release may only be restored in staging when its retained artifact is still available. */
  restorableReleases(projectId: string, availableArtifactIds: Set<string>): ReleaseRecord[] {
    return this.listReleases(projectId).filter((release) => release.artifactId !== null && availableArtifactIds.has(release.artifactId));
  }
}

function toRelease(row: Record<string, unknown>): ReleaseRecord {
  return {
    releaseId: String(row.release_id),
    projectId: String(row.project_id),
    jobId: String(row.job_id),
    commitSha: String(row.commit_sha),
    branch: String(row.branch),
    prNumber: row.pr_number === null || row.pr_number === undefined ? null : Number(row.pr_number),
    hostId: String(row.host_id),
    artifactId: row.artifact_id === null || row.artifact_id === undefined ? null : String(row.artifact_id),
    artifactDigest: row.artifact_digest === null || row.artifact_digest === undefined ? null : String(row.artifact_digest),
    state: String(row.state) as ReleaseState,
    createdAt: Number(row.created_at),
  };
}
