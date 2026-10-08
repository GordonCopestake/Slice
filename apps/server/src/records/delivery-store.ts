import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { hashJson } from "../state/application-state.js";

/** Shared identifier rule for every key that reaches a SQL parameter or a workspace path. */
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function assertId(name: string, value: string): void {
  if (!ID_PATTERN.test(value)) throw new TypeError(`${name} must be 1-128 letters, numbers, dots, underscores, colons, or hyphens`);
}

const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/;

function assertCommit(name: string, value: string): void {
  if (!COMMIT_PATTERN.test(value)) throw new TypeError(`${name} must be a lowercase hex commit id`);
}

/**
 * Delivery stage is separate from the job's workflow stage so archiving, cleanup, and release
 * tracking cannot overwrite one another. A job stays at workflow stage "implementation" while its
 * delivery record moves through authoring, checks, review, gate, publishing, ready, and finished.
 */
export type DeliveryStage = "authoring" | "checks" | "review" | "gate" | "publishing" | "ready" | "finished";
export type PrState = "none" | "draft" | "ready" | "merged";
export type ArchiveState = "active" | "archived";
export type CleanupState = "available" | "pending" | "failed" | "cleaned";
export type GateVerdict = "pending" | "pass" | "blocked";
export type ReviewRole = "code-review" | "security-review";
export type FindingSeverity = "critical" | "high" | "medium" | "low" | "informational";
export type FindingStatus = "open" | "verified_fixed" | "not_applicable" | "escalated";
export type ReviewVerdict = "pass" | "changes_required" | "unable_to_review";

export type DeliveryRecord = {
  jobId: string;
  stage: DeliveryStage;
  round: number;
  baseCommit: string;
  headCommit: string;
  gateVerdict: GateVerdict;
  prNumber: number | null;
  prUrl: string | null;
  prState: PrState;
  mergedRevision: string | null;
  mergedAt: number | null;
  archiveState: ArchiveState;
  archiveReason: string | null;
  cleanupState: CleanupState;
  updatedAt: number;
};

export type CheckResultRecord = {
  id: number;
  jobId: string;
  checkId: string;
  headCommit: string;
  baseCommit: string;
  requirementsRevision: number;
  profileRevision: number;
  verificationKey: string;
  command: string;
  environment: string;
  exitCode: number | null;
  status: "succeeded" | "failed" | "uncertain";
  outputTail: string;
  sourceDigest: string;
  createdAt: number;
};

export type FindingInput = {
  id: string;
  severity: FindingSeverity;
  category: string;
  file: string;
  claim: string;
  impact: string;
  correction: string;
  verification: string;
  status: FindingStatus;
};

export type ReviewReportRecord = {
  id: number;
  jobId: string;
  role: ReviewRole;
  headCommit: string;
  requirementsRevision: number;
  verificationKey: string;
  verdict: ReviewVerdict;
  provider: string;
  modelId: string;
  scope: string;
  findings: FindingInput[];
  createdAt: number;
};

export type FindingRecord = FindingInput & {
  id: string;
  jobId: string;
  reviewId: number;
  role: ReviewRole;
  resolvedBy: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ArtifactRecord = {
  id: string;
  jobId: string;
  kind: string;
  digest: string;
  sizeBytes: number;
  path: string;
  verificationKey: string;
  expiresAt: number;
  createdAt: number;
};

/** Severities that block readiness and cannot be waived. */
export const BLOCKING_SEVERITIES: readonly FindingSeverity[] = ["critical", "high", "medium"];

export type VerificationKeyInput = {
  repoSlug: string;
  baseCommit: string;
  headCommit: string;
  requirementsRevision: number;
  profileRevision: number;
  policyVersion: string;
};

/**
 * The key every approval and evidence record is bound to. A head, base, requirements, profile, or
 * policy change produces a different key, and records under an older key no longer satisfy the gate.
 */
export function verificationKey(input: VerificationKeyInput): string {
  return hashJson({
    repoSlug: input.repoSlug,
    baseCommit: input.baseCommit,
    headCommit: input.headCommit,
    requirementsRevision: input.requirementsRevision,
    profileRevision: input.profileRevision,
    policyVersion: input.policyVersion,
  });
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * Phase 2 delivery truth: the per-job delivery state row, append-only commit, check, review,
 * finding, artifact, and acceptance records. Review reports are never rewritten; resolution
 * history is recorded as finding status changes with the resolving review named.
 */
export class DeliveryStore {
  readonly #database: DatabaseSync;

  private constructor(database: DatabaseSync) {
    this.#database = database;
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS slice_delivery (
        job_id TEXT PRIMARY KEY,
        stage TEXT NOT NULL CHECK (stage IN ('authoring', 'checks', 'review', 'gate', 'publishing', 'ready', 'finished')),
        round INTEGER NOT NULL DEFAULT 0,
        base_commit TEXT NOT NULL,
        head_commit TEXT NOT NULL DEFAULT '',
        gate_verdict TEXT NOT NULL CHECK (gate_verdict IN ('pending', 'pass', 'blocked')) DEFAULT 'pending',
        gate_json TEXT NOT NULL DEFAULT '{}',
        pr_number INTEGER,
        pr_url TEXT,
        pr_state TEXT NOT NULL CHECK (pr_state IN ('none', 'draft', 'ready', 'merged')) DEFAULT 'none',
        merged_revision TEXT,
        merged_at INTEGER,
        archive_state TEXT NOT NULL CHECK (archive_state IN ('active', 'archived')) DEFAULT 'active',
        archive_reason TEXT,
        cleanup_state TEXT NOT NULL CHECK (cleanup_state IN ('available', 'pending', 'failed', 'cleaned')) DEFAULT 'available',
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS slice_commits (
        job_id TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        parent TEXT NOT NULL,
        patch_sha256 TEXT NOT NULL,
        role TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (job_id, commit_sha)
      );
      CREATE TABLE IF NOT EXISTS slice_check_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        check_id TEXT NOT NULL,
        head_commit TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        requirements_revision INTEGER NOT NULL,
        profile_revision INTEGER NOT NULL,
        verification_key TEXT NOT NULL,
        command TEXT NOT NULL,
        environment TEXT NOT NULL,
        exit_code INTEGER,
        status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'uncertain')),
        output_tail TEXT NOT NULL DEFAULT '',
        source_digest TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS slice_check_job_key ON slice_check_results (job_id, verification_key);
      CREATE TABLE IF NOT EXISTS slice_review_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('code-review', 'security-review')),
        head_commit TEXT NOT NULL,
        requirements_revision INTEGER NOT NULL,
        verification_key TEXT NOT NULL,
        verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'changes_required', 'unable_to_review')),
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        findings_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS slice_review_job_key ON slice_review_reports (job_id, verification_key);
      CREATE TABLE IF NOT EXISTS slice_findings (
        finding_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        review_id INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('code-review', 'security-review')),
        severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'informational')),
        category TEXT NOT NULL,
        file TEXT NOT NULL,
        claim TEXT NOT NULL,
        impact TEXT NOT NULL,
        correction TEXT NOT NULL,
        verification TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'verified_fixed', 'not_applicable', 'escalated')),
        resolved_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (job_id, finding_id)
      );
      CREATE TABLE IF NOT EXISTS slice_artifacts (
        artifact_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        digest TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        path TEXT NOT NULL,
        verification_key TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (job_id, artifact_id)
      );
      CREATE TABLE IF NOT EXISTS slice_acceptance (
        job_id TEXT PRIMARY KEY,
        verification_key TEXT NOT NULL,
        accepted_at INTEGER NOT NULL,
        stale INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  static open(database: DatabaseSync): DeliveryStore {
    return new DeliveryStore(database);
  }

  // ------------------------------------------------------------- delivery

  ensureDelivery(jobId: string, baseCommit: string): DeliveryRecord {
    assertId("jobId", jobId);
    assertCommit("baseCommit", baseCommit);
    const now = Date.now();
    this.#database
      .prepare(`INSERT INTO slice_delivery (job_id, stage, round, base_commit, updated_at) VALUES (?, 'authoring', 0, ?, ?)
                ON CONFLICT(job_id) DO NOTHING`)
      .run(jobId, baseCommit, now);
    return this.getDelivery(jobId)!;
  }

  getDelivery(jobId: string): DeliveryRecord | undefined {
    assertId("jobId", jobId);
    const row = this.#database.prepare("SELECT * FROM slice_delivery WHERE job_id = ?").get(jobId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toDelivery(row);
  }

  setDeliveryStage(jobId: string, stage: DeliveryStage): DeliveryRecord | undefined {
    assertId("jobId", jobId);
    this.#database.prepare("UPDATE slice_delivery SET stage = ?, updated_at = ? WHERE job_id = ?").run(stage, Date.now(), jobId);
    return this.getDelivery(jobId);
  }

  /** A new authoring round bumps the counter; the round limit is enforced by the delivery loop. */
  bumpRound(jobId: string): number {
    assertId("jobId", jobId);
    this.#database.prepare("UPDATE slice_delivery SET round = round + 1, updated_at = ? WHERE job_id = ?").run(Date.now(), jobId);
    return this.getDelivery(jobId)!.round;
  }

  recordHead(jobId: string, headCommit: string): DeliveryRecord | undefined {
    assertId("jobId", jobId);
    assertCommit("headCommit", headCommit);
    this.#database.prepare("UPDATE slice_delivery SET head_commit = ?, updated_at = ? WHERE job_id = ?").run(headCommit, Date.now(), jobId);
    return this.getDelivery(jobId);
  }

  recordGate(jobId: string, verdict: GateVerdict, gateRecord: unknown): DeliveryRecord | undefined {
    assertId("jobId", jobId);
    this.#database.prepare("UPDATE slice_delivery SET gate_verdict = ?, gate_json = ?, updated_at = ? WHERE job_id = ?")
      .run(verdict, JSON.stringify(gateRecord), Date.now(), jobId);
    return this.getDelivery(jobId);
  }

  setPr(jobId: string, pr: { number: number; url: string; state: PrState }): DeliveryRecord | undefined {
    assertId("jobId", jobId);
    if (!Number.isSafeInteger(pr.number) || pr.number <= 0) throw new TypeError("PR numbers must be positive integers");
    if (pr.url.length === 0 || pr.url.length > 500) throw new TypeError("PR URLs must be 1-500 characters");
    this.#database.prepare("UPDATE slice_delivery SET pr_number = ?, pr_url = ?, pr_state = ?, updated_at = ? WHERE job_id = ?")
      .run(pr.number, pr.url, pr.state, Date.now(), jobId);
    return this.getDelivery(jobId);
  }

  /** Only a verified merge sets the merged revision; a non-null merge_commit_sha on an open PR is not merge confirmation. */
  recordMerge(jobId: string, mergedRevision: string, reason: string): DeliveryRecord | undefined {
    assertId("jobId", jobId);
    assertCommit("mergedRevision", mergedRevision);
    this.#database.prepare(
      "UPDATE slice_delivery SET pr_state = 'merged', merged_revision = ?, merged_at = ?, archive_state = 'archived', archive_reason = ?, stage = 'finished', updated_at = ? WHERE job_id = ?",
    ).run(mergedRevision, Date.now(), reason, Date.now(), jobId);
    return this.getDelivery(jobId);
  }

  setCleanupState(jobId: string, state: CleanupState): DeliveryRecord | undefined {
    assertId("jobId", jobId);
    this.#database.prepare("UPDATE slice_delivery SET cleanup_state = ?, updated_at = ? WHERE job_id = ?").run(state, Date.now(), jobId);
    return this.getDelivery(jobId);
  }

  listActiveDeliveries(): DeliveryRecord[] {
    return (this.#database.prepare("SELECT * FROM slice_delivery WHERE archive_state = 'active' ORDER BY job_id").all() as Record<string, unknown>[])
      .map(toDelivery);
  }

  // ------------------------------------------------------------- commits

  recordCommit(input: { jobId: string; commit: string; parent: string; patchText: string; role: string; message: string }): void {
    assertId("jobId", input.jobId);
    assertCommit("commit", input.commit);
    assertCommit("parent", input.parent);
    this.#database
      .prepare("INSERT INTO slice_commits (job_id, commit_sha, parent, patch_sha256, role, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(job_id, commit_sha) DO NOTHING")
      .run(input.jobId, input.commit, input.parent, sha256(input.patchText), input.role, input.message.slice(0, 500), Date.now());
  }

  listCommits(jobId: string): { commit: string; parent: string; patchSha256: string; role: string; message: string; createdAt: number }[] {
    assertId("jobId", jobId);
    return (this.#database.prepare("SELECT * FROM slice_commits WHERE job_id = ? ORDER BY created_at").all(jobId) as Record<string, unknown>[])
      .map((row) => ({
        commit: String(row.commit_sha),
        parent: String(row.parent),
        patchSha256: String(row.patch_sha256),
        role: String(row.role),
        message: String(row.message),
        createdAt: Number(row.created_at),
      }));
  }

  // -------------------------------------------------------- check results

  recordCheckResult(input: {
    jobId: string;
    checkId: string;
    headCommit: string;
    baseCommit: string;
    requirementsRevision: number;
    profileRevision: number;
    repoSlug: string;
    policyVersion: string;
    command: string;
    environment: string;
    exitCode: number | null;
    status: CheckResultRecord["status"];
    outputTail: string;
    sourceDigest: string;
  }): CheckResultRecord {
    assertId("jobId", input.jobId);
    assertId("checkId", input.checkId);
    assertCommit("headCommit", input.headCommit);
    assertCommit("baseCommit", input.baseCommit);
    // A result that does not declare its source digest is rejected here, not just at the gate.
    if (!/^[0-9a-f]{7,64}$/.test(input.sourceDigest)) throw new TypeError("Check results must declare a source digest");
    const key = verificationKey({
      repoSlug: input.repoSlug,
      baseCommit: input.baseCommit,
      headCommit: input.headCommit,
      requirementsRevision: input.requirementsRevision,
      profileRevision: input.profileRevision,
      policyVersion: input.policyVersion,
    });
    const now = Date.now();
    const info = this.#database
      .prepare(`INSERT INTO slice_check_results
        (job_id, check_id, head_commit, base_commit, requirements_revision, profile_revision, verification_key, command, environment, exit_code, status, output_tail, source_digest, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.jobId, input.checkId, input.headCommit, input.baseCommit, input.requirementsRevision, input.profileRevision, key,
        input.command.slice(0, 500), input.environment.slice(0, 200), input.exitCode, input.status, input.outputTail.slice(0, 8_000), input.sourceDigest, now);
    return {
      id: Number(info.lastInsertRowid),
      jobId: input.jobId,
      checkId: input.checkId,
      headCommit: input.headCommit,
      baseCommit: input.baseCommit,
      requirementsRevision: input.requirementsRevision,
      profileRevision: input.profileRevision,
      verificationKey: key,
      command: input.command,
      environment: input.environment,
      exitCode: input.exitCode,
      status: input.status,
      outputTail: input.outputTail,
      sourceDigest: input.sourceDigest,
      createdAt: now,
    };
  }

  listCheckResults(jobId: string, verificationKeyFor?: string): CheckResultRecord[] {
    assertId("jobId", jobId);
    const rows = verificationKeyFor === undefined
      ? this.#database.prepare("SELECT * FROM slice_check_results WHERE job_id = ? ORDER BY created_at").all(jobId)
      : this.#database.prepare("SELECT * FROM slice_check_results WHERE job_id = ? AND verification_key = ? ORDER BY created_at").all(jobId, verificationKeyFor);
    return (rows as Record<string, unknown>[]).map(toCheckResult);
  }

  // ------------------------------------------------------- review reports

  recordReviewReport(input: {
    jobId: string;
    role: ReviewRole;
    headCommit: string;
    requirementsRevision: number;
    profileRevision: number;
    repoSlug: string;
    baseCommit: string;
    policyVersion: string;
    verdict: ReviewVerdict;
    provider: string;
    modelId: string;
    scope: string;
    findings: FindingInput[];
  }): ReviewReportRecord {
    assertId("jobId", input.jobId);
    assertCommit("headCommit", input.headCommit);
    if (input.findings.length > 50) throw new TypeError("A review report carries at most 50 findings");
    const key = verificationKey({
      repoSlug: input.repoSlug,
      baseCommit: input.baseCommit,
      headCommit: input.headCommit,
      requirementsRevision: input.requirementsRevision,
      profileRevision: input.profileRevision,
      policyVersion: input.policyVersion,
    });
    const now = Date.now();
    const info = this.#database
      .prepare(`INSERT INTO slice_review_reports
        (job_id, role, head_commit, requirements_revision, verification_key, verdict, provider, model_id, scope, findings_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.jobId, input.role, input.headCommit, input.requirementsRevision, key, input.verdict, input.provider, input.modelId,
        input.scope.slice(0, 2_000), JSON.stringify(input.findings), now);
    const reviewId = Number(info.lastInsertRowid);
    for (const finding of input.findings) {
      this.#upsertFinding(input.jobId, reviewId, input.role, finding, now);
    }
    return {
      id: reviewId,
      jobId: input.jobId,
      role: input.role,
      headCommit: input.headCommit,
      requirementsRevision: input.requirementsRevision,
      verificationKey: key,
      verdict: input.verdict,
      provider: input.provider,
      modelId: input.modelId,
      scope: input.scope,
      findings: input.findings,
      createdAt: now,
    };
  }

  /**
   * A finding raised by a role is updated only by a later report from the same role, and only in the
   * direction open -> verified_fixed / not_applicable / escalated. The author never closes a finding.
   */
  #upsertFinding(jobId: string, reviewId: number, role: ReviewRole, finding: FindingInput, now: number): void {
    assertId("findingId", finding.id);
    const existing = this.#database.prepare("SELECT * FROM slice_findings WHERE job_id = ? AND finding_id = ?").get(jobId, finding.id) as Record<string, unknown> | undefined;
    if (existing === undefined) {
      this.#database
        .prepare(`INSERT INTO slice_findings (finding_id, job_id, review_id, role, severity, category, file, claim, impact, correction, verification, status, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(finding.id, jobId, reviewId, role, finding.severity, finding.category.slice(0, 200), finding.file.slice(0, 300),
          finding.claim.slice(0, 4_000), finding.impact.slice(0, 2_000), finding.correction.slice(0, 2_000), finding.verification.slice(0, 2_000),
          finding.status === "open" ? "open" : "open", now, now);
      // A first report may also carry the reviewer's own resolution of an earlier finding.
      if (finding.status !== "open") {
        this.#database.prepare("UPDATE slice_findings SET status = ?, resolved_by = ?, updated_at = ? WHERE job_id = ? AND finding_id = ?")
          .run(finding.status, `review:${reviewId}:${role}`, now, jobId, finding.id);
      }
      return;
    }
    if (String(existing.role) !== role) return; // only the originating role resolves its own finding
    if (String(existing.status) !== "open") return; // resolutions are append-only history
    if (finding.status === "open") return; // re-reporting an open finding keeps it open
    this.#database.prepare("UPDATE slice_findings SET status = ?, resolved_by = ?, updated_at = ? WHERE job_id = ? AND finding_id = ?")
      .run(finding.status, `review:${reviewId}:${role}`, now, jobId, finding.id);
  }

  listReviewReports(jobId: string, verificationKeyFor?: string): ReviewReportRecord[] {
    assertId("jobId", jobId);
    const rows = verificationKeyFor === undefined
      ? this.#database.prepare("SELECT * FROM slice_review_reports WHERE job_id = ? ORDER BY created_at").all(jobId)
      : this.#database.prepare("SELECT * FROM slice_review_reports WHERE job_id = ? AND verification_key = ? ORDER BY created_at").all(jobId, verificationKeyFor);
    return (rows as Record<string, unknown>[]).map(toReviewReport);
  }

  listFindings(jobId: string): FindingRecord[] {
    assertId("jobId", jobId);
    return (this.#database.prepare("SELECT * FROM slice_findings WHERE job_id = ? ORDER BY created_at").all(jobId) as Record<string, unknown>[])
      .map((row) => ({
        id: String(row.finding_id),
        jobId: String(row.job_id),
        reviewId: Number(row.review_id),
        role: String(row.role) as ReviewRole,
        severity: String(row.severity) as FindingSeverity,
        category: String(row.category),
        file: String(row.file),
        claim: String(row.claim),
        impact: String(row.impact),
        correction: String(row.correction),
        verification: String(row.verification),
        status: String(row.status) as FindingStatus,
        resolvedBy: row.resolved_by === null ? null : String(row.resolved_by),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      }));
  }

  openBlockingFindings(jobId: string): FindingRecord[] {
    return this.listFindings(jobId).filter((f) => f.status === "open" && BLOCKING_SEVERITIES.includes(f.severity));
  }

  // ------------------------------------------------------------ artifacts

  recordArtifact(input: { jobId: string; id: string; kind: string; digest: string; sizeBytes: number; path: string; verificationKey: string; expiresAt: number }): ArtifactRecord {
    assertId("jobId", input.jobId);
    assertId("artifactId", input.id);
    if (!/^[0-9a-f]{64}$/.test(input.digest)) throw new TypeError("Artifact digests must be sha256 hex");
    if (input.sizeBytes < 0 || !Number.isSafeInteger(input.sizeBytes)) throw new TypeError("Artifact sizes must be non-negative integers");
    const now = Date.now();
    this.#database
      .prepare(`INSERT INTO slice_artifacts (artifact_id, job_id, kind, digest, size_bytes, path, verification_key, expires_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(job_id, artifact_id) DO UPDATE SET digest = excluded.digest, size_bytes = excluded.size_bytes, path = excluded.path, verification_key = excluded.verification_key, expires_at = excluded.expires_at`)
      .run(input.id, input.jobId, input.kind.slice(0, 60), input.digest, input.sizeBytes, input.path.slice(0, 500), input.verificationKey, input.expiresAt, now);
    return this.getArtifact(input.jobId, input.id)!;
  }

  getArtifact(jobId: string, artifactId: string): ArtifactRecord | undefined {
    assertId("jobId", jobId);
    assertId("artifactId", artifactId);
    const row = this.#database.prepare("SELECT * FROM slice_artifacts WHERE job_id = ? AND artifact_id = ?").get(jobId, artifactId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toArtifact(row);
  }

  listArtifacts(jobId: string): ArtifactRecord[] {
    assertId("jobId", jobId);
    return (this.#database.prepare("SELECT * FROM slice_artifacts WHERE job_id = ? ORDER BY artifact_id").all(jobId) as Record<string, unknown>[])
      .map(toArtifact);
  }

  // ----------------------------------------------------------- acceptance

  recordAcceptance(jobId: string, key: string): void {
    assertId("jobId", jobId);
    this.#database
      .prepare("INSERT INTO slice_acceptance (job_id, verification_key, accepted_at, stale) VALUES (?, ?, ?, 0) ON CONFLICT(job_id) DO UPDATE SET verification_key = excluded.verification_key, accepted_at = excluded.accepted_at, stale = 0")
      .run(jobId, key, Date.now());
  }

  getAcceptance(jobId: string): { verificationKey: string; acceptedAt: number; stale: boolean } | undefined {
    assertId("jobId", jobId);
    const row = this.#database.prepare("SELECT * FROM slice_acceptance WHERE job_id = ?").get(jobId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : { verificationKey: String(row.verification_key), acceptedAt: Number(row.accepted_at), stale: Number(row.stale) === 1 };
  }

  /** Acceptance bound to a different verification key is stale, never silently reused. */
  markAcceptanceStaleIfKeyDiffers(jobId: string, key: string): boolean {
    assertId("jobId", jobId);
    const acceptance = this.getAcceptance(jobId);
    if (acceptance === undefined) return false;
    if (acceptance.verificationKey === key) return false;
    this.#database.prepare("UPDATE slice_acceptance SET stale = 1 WHERE job_id = ?").run(jobId);
    return true;
  }

  /** Steering or withdrawal makes the recorded acceptance stale immediately. */
  markAcceptanceStale(jobId: string): void {
    assertId("jobId", jobId);
    this.#database.prepare("UPDATE slice_acceptance SET stale = 1 WHERE job_id = ?").run(jobId);
  }
}

function toDelivery(row: Record<string, unknown>): DeliveryRecord {
  return {
    jobId: String(row.job_id),
    stage: String(row.stage) as DeliveryStage,
    round: Number(row.round),
    baseCommit: String(row.base_commit),
    headCommit: String(row.head_commit),
    gateVerdict: String(row.gate_verdict) as GateVerdict,
    prNumber: row.pr_number === null ? null : Number(row.pr_number),
    prUrl: row.pr_url === null ? null : String(row.pr_url),
    prState: String(row.pr_state) as PrState,
    mergedRevision: row.merged_revision === null ? null : String(row.merged_revision),
    mergedAt: row.merged_at === null ? null : Number(row.merged_at),
    archiveState: String(row.archive_state) as ArchiveState,
    archiveReason: row.archive_reason === null ? null : String(row.archive_reason),
    cleanupState: String(row.cleanup_state) as CleanupState,
    updatedAt: Number(row.updated_at),
  };
}

function toCheckResult(row: Record<string, unknown>): CheckResultRecord {
  return {
    id: Number(row.id),
    jobId: String(row.job_id),
    checkId: String(row.check_id),
    headCommit: String(row.head_commit),
    baseCommit: String(row.base_commit),
    requirementsRevision: Number(row.requirements_revision),
    profileRevision: Number(row.profile_revision),
    verificationKey: String(row.verification_key),
    command: String(row.command),
    environment: String(row.environment),
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    status: String(row.status) as CheckResultRecord["status"],
    outputTail: String(row.output_tail),
    sourceDigest: String(row.source_digest),
    createdAt: Number(row.created_at),
  };
}

function toReviewReport(row: Record<string, unknown>): ReviewReportRecord {
  return {
    id: Number(row.id),
    jobId: String(row.job_id),
    role: String(row.role) as ReviewRole,
    headCommit: String(row.head_commit),
    requirementsRevision: Number(row.requirements_revision),
    verificationKey: String(row.verification_key),
    verdict: String(row.verdict) as ReviewVerdict,
    provider: String(row.provider),
    modelId: String(row.model_id),
    scope: String(row.scope),
    findings: parseJson<FindingInput[]>(String(row.findings_json), []),
    createdAt: Number(row.created_at),
  };
}

function toArtifact(row: Record<string, unknown>): ArtifactRecord {
  return {
    id: String(row.artifact_id),
    jobId: String(row.job_id),
    kind: String(row.kind),
    digest: String(row.digest),
    sizeBytes: Number(row.size_bytes),
    path: String(row.path),
    verificationKey: String(row.verification_key),
    expiresAt: Number(row.expires_at),
    createdAt: Number(row.created_at),
  };
}
