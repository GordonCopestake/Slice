import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { IdempotencyConflictError } from "../state/application-state.js";

/** Shared identifier rule for every key that reaches a SQL parameter or a workspace path. */
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function assertId(name: string, value: string): void {
  if (!ID_PATTERN.test(value)) throw new TypeError(`${name} must be 1-128 letters, numbers, dots, underscores, colons, or hyphens`);
}

export type HostRecord = {
  hostId: string;
  address: string;
  os: "linux" | "windows";
  sshUser: string;
  runnerRoot: string;
  createdAt: number;
};

export type ProjectStatus = "active" | "paused" | "removed";

export type BuildProfile = {
  /** Commands run in order inside the job workspace. Each is a fixed profile entry, never model text. */
  readonly setup: readonly string[];
  readonly checks: readonly { readonly id: string; readonly command: string }[];
};

export type ProjectRecord = {
  projectId: string;
  revision: number;
  gitProvider: "github";
  repoSlug: string;
  defaultBranch: string;
  hostId: string;
  buildProfile: BuildProfile;
  /** Where the feature branch is pushed; defaults to https://github.com/<slug>.git. */
  gitRemoteUrl: string | null;
  status: ProjectStatus;
  createdAt: number;
  updatedAt: number;
};

export type JobStage = "requirements" | "planning" | "implementation";
export type JobRunState =
  | "running"
  | "waiting_user"
  | "pause_requested"
  | "paused"
  | "cancel_requested"
  | "cancelled"
  | "blocked"
  | "completed";

export type IssueSnapshot = {
  provider: "github";
  repoSlug: string;
  issueNumber: number;
  issueId: number;
  url: string;
  title: string;
  issueUpdatedAt: string;
};

export type JobRecord = {
  jobId: string;
  projectId: string;
  profileRevision: number;
  title: string;
  requestText: string;
  threadId: string;
  stage: JobStage;
  runState: JobRunState;
  commandRevision: number;
  generation: number;
  requirementsRevision: number;
  issue: IssueSnapshot | null;
  reportsEnabled: boolean;
  reportIntervalMinutes: number;
  createdAt: number;
  updatedAt: number;
};

export type JobEvent = {
  jobId: string;
  seq: number;
  type: string;
  payload: unknown;
  createdAt: number;
};

export type PendingQuestion = {
  jobId: string;
  questionId: string;
  revision: number;
  requirementsRevision: number;
  question: string;
  choices: readonly string[];
  status: "open" | "answered" | "stale";
  answer: string | null;
  createdAt: number;
};

export type WorkspaceRecord = {
  jobId: string;
  hostId: string;
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;
  leaseGeneration: number;
  updatedAt: number;
};

export type OperationStatus = "planned" | "running" | "succeeded" | "failed" | "uncertain";

export type RunnerOperationRecord = {
  operationId: string;
  jobId: string;
  leaseGeneration: number;
  intent: string;
  status: OperationStatus;
  observed: unknown;
  createdAt: number;
  updatedAt: number;
};

/** Rows younger than this are never pruned; terminal rows older than it are, subject to the floor. */
const RETENTION_DAYS = 90;
/** Prune never deletes the most recent rows of a table, so a busy service keeps its recent history. */
const RETENTION_FLOOR_ROWS = 1000;

function parseJson<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * Workflow truth for Phase 1: projects, hosts, jobs, the event ledger, requirements questions,
 * steering, issue links, workspaces, and runner operations. It shares the state SQLite file with
 * Pi Durable and the Phase 0 stores. Every statement uses bound parameters.
 */
export class WorkflowStore {
  readonly #database: DatabaseSync;

  private constructor(database: DatabaseSync) {
    this.#database = database;
    try {
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS slice_hosts (
          host_id TEXT PRIMARY KEY,
          address TEXT NOT NULL,
          os TEXT NOT NULL CHECK (os IN ('linux', 'windows')),
          ssh_user TEXT NOT NULL,
          runner_root TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS slice_projects (
          project_id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL,
          git_provider TEXT NOT NULL CHECK (git_provider = 'github'),
          repo_slug TEXT NOT NULL,
          default_branch TEXT NOT NULL,
          host_id TEXT NOT NULL,
          build_profile_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'removed')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS slice_jobs (
          job_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          profile_revision INTEGER NOT NULL,
          title TEXT NOT NULL,
          request_text TEXT NOT NULL,
          thread_id TEXT NOT NULL UNIQUE,
          stage TEXT NOT NULL CHECK (stage IN ('requirements', 'planning', 'implementation')),
          run_state TEXT NOT NULL CHECK (run_state IN
            ('running', 'waiting_user', 'pause_requested', 'paused', 'cancel_requested', 'cancelled', 'blocked', 'completed')),
          command_revision INTEGER NOT NULL,
          generation INTEGER NOT NULL,
          requirements_revision INTEGER NOT NULL,
          issue_json TEXT,
          reports_enabled INTEGER NOT NULL DEFAULT 1,
          report_interval_minutes INTEGER NOT NULL DEFAULT 10,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS slice_job_events (
          job_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (job_id, seq)
        );
        CREATE TABLE IF NOT EXISTS slice_pending_questions (
          job_id TEXT NOT NULL,
          question_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          requirements_revision INTEGER NOT NULL,
          question TEXT NOT NULL,
          choices_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('open', 'answered', 'stale')),
          answer TEXT,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (job_id, question_id)
        );
        CREATE TABLE IF NOT EXISTS slice_steering_events (
          job_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          command_revision INTEGER NOT NULL,
          instruction TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (job_id, request_id)
        );
        CREATE TABLE IF NOT EXISTS slice_issue_links (
          provider TEXT NOT NULL,
          repo_slug TEXT NOT NULL,
          issue_number INTEGER NOT NULL,
          issue_id INTEGER NOT NULL,
          url TEXT NOT NULL,
          issue_updated_at TEXT NOT NULL,
          title TEXT NOT NULL,
          job_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (provider, repo_slug, issue_number, job_id)
        );
        CREATE TABLE IF NOT EXISTS slice_workspaces (
          job_id TEXT PRIMARY KEY,
          host_id TEXT NOT NULL,
          repo_path TEXT NOT NULL,
          worktree_path TEXT NOT NULL,
          branch TEXT NOT NULL,
          base_commit TEXT NOT NULL,
          lease_generation INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS slice_runner_operations (
          operation_id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          lease_generation INTEGER NOT NULL,
          intent TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('planned', 'running', 'succeeded', 'failed', 'uncertain')),
          observed_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS slice_request_jobs (
          request_id TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          job_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (request_id)
        );
        CREATE TABLE IF NOT EXISTS slice_sessions (
          token_hash TEXT PRIMARY KEY,
          csrf_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS slice_owner_credentials (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          salt TEXT NOT NULL,
          hash TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);
    } catch (error) {
      this.#database.close();
      throw error;
    }
    // Migration: Phase 2 adds a per-project push remote. Existing rows keep NULL and use the default.
    const columns = this.#database.prepare("PRAGMA table_info(slice_projects)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "git_remote_url")) {
      this.#database.exec("ALTER TABLE slice_projects ADD COLUMN git_remote_url TEXT");
    }
  }

  static open(database: DatabaseSync): WorkflowStore {
    return new WorkflowStore(database);
  }

  // ---------------------------------------------------------------- hosts

  registerHost(host: Omit<HostRecord, "createdAt">): HostRecord {
    assertId("hostId", host.hostId);
    if (!/^[A-Za-z0-9._-]{1,253}$/.test(host.address)) throw new TypeError("Host addresses must be a hostname or IP literal");
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(host.sshUser)) throw new TypeError("SSH users must be 1-64 letters, numbers, dots, underscores, or hyphens");
    if (!/^\/[A-Za-z0-9._/-]{1,200}$/.test(host.runnerRoot)) throw new TypeError("Runner roots must be an absolute POSIX path");
    const createdAt = Date.now();
    this.#database
      .prepare(`INSERT INTO slice_hosts (host_id, address, os, ssh_user, runner_root, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(host.hostId, host.address, host.os, host.sshUser, host.runnerRoot, createdAt);
    return { ...host, createdAt };
  }

  getHost(hostId: string): HostRecord | undefined {
    assertId("hostId", hostId);
    const row = this.#database.prepare("SELECT * FROM slice_hosts WHERE host_id = ?").get(hostId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : {
      hostId: String(row.host_id),
      address: String(row.address),
      os: String(row.os) as HostRecord["os"],
      sshUser: String(row.ssh_user),
      runnerRoot: String(row.runner_root),
      createdAt: Number(row.created_at),
    };
  }

  listHosts(): HostRecord[] {
    return (this.#database.prepare("SELECT * FROM slice_hosts ORDER BY host_id").all() as Record<string, unknown>[])
      .map((row) => ({
        hostId: String(row.host_id),
        address: String(row.address),
        os: String(row.os) as HostRecord["os"],
        sshUser: String(row.ssh_user),
        runnerRoot: String(row.runner_root),
        createdAt: Number(row.created_at),
      }));
  }

  // ------------------------------------------------------------- projects

  createProject(project: {
    projectId: string;
    repoSlug: string;
    defaultBranch: string;
    hostId: string;
    buildProfile: BuildProfile;
    gitRemoteUrl?: string | null;
  }): ProjectRecord {
    assertId("projectId", project.projectId);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(project.repoSlug)) {
      throw new TypeError("Repository slugs must look like owner/repo");
    }
    if (!/^[A-Za-z0-9._/-]{1,100}$/.test(project.defaultBranch)) throw new TypeError("Default branches must be a plain ref name");
    if (this.getHost(project.hostId) === undefined) throw new Error(`Host ${project.hostId} is not registered`);
    validateBuildProfile(project.buildProfile);
    if (project.gitRemoteUrl !== undefined && project.gitRemoteUrl !== null) {
      if (!/^(https|file):\/\/[^\s]{1,300}$/.test(project.gitRemoteUrl) || /@/.test(project.gitRemoteUrl)) {
        throw new TypeError("Git remote URLs must be https:// or file:// without embedded credentials");
      }
    }
    const now = Date.now();
    this.#database
      .prepare(`INSERT INTO slice_projects
        (project_id, revision, git_provider, repo_slug, default_branch, host_id, build_profile_json, git_remote_url, status, created_at, updated_at)
        VALUES (?, 1, 'github', ?, ?, ?, ?, ?, 'active', ?, ?)`)
      .run(project.projectId, project.repoSlug, project.defaultBranch, project.hostId, JSON.stringify(project.buildProfile), project.gitRemoteUrl ?? null, now, now);
    return this.getProject(project.projectId)!;
  }

  getProject(projectId: string): ProjectRecord | undefined {
    assertId("projectId", projectId);
    const row = this.#database.prepare("SELECT * FROM slice_projects WHERE project_id = ?").get(projectId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toProject(row);
  }

  listProjects(includeRemoved: boolean): ProjectRecord[] {
    const rows = includeRemoved
      ? this.#database.prepare("SELECT * FROM slice_projects ORDER BY project_id").all()
      : this.#database.prepare("SELECT * FROM slice_projects WHERE status != 'removed' ORDER BY project_id").all();
    return (rows as Record<string, unknown>[]).map(toProject);
  }

  /** Status change bumps the profile revision so jobs can record which profile they used. */
  setProjectStatus(projectId: string, status: ProjectStatus): ProjectRecord | undefined {
    assertId("projectId", projectId);
    this.#database
      .prepare("UPDATE slice_projects SET status = ?, revision = revision + 1, updated_at = ? WHERE project_id = ?")
      .run(status, Date.now(), projectId);
    return this.getProject(projectId);
  }

  // ----------------------------------------------------------------- jobs

  /** Idempotent job creation: the same request ID with the same payload returns the same job. */
  createJob(input: {
    requestId: string;
    payloadHash: string;
    projectId: string;
    title: string;
    requestText: string;
    issue: IssueSnapshot | null;
  }): { job: JobRecord; reused: boolean } {
    assertId("requestId", input.requestId);
    assertId("projectId", input.projectId);
    const project = this.getProject(input.projectId);
    if (project === undefined) throw new Error(`Project ${input.projectId} is not registered`);
    if (project.status !== "active") throw new Error(`Project ${input.projectId} is ${project.status}; new work is stopped`);
    const title = input.title.trim();
    if (title.length === 0 || title.length > 200) throw new TypeError("Job titles must be 1-200 characters");
    const requestText = input.requestText;
    if (requestText.trim().length === 0 || requestText.length > 100_000) throw new TypeError("Job requests must be 1-100000 characters");

    const existing = this.#database
      .prepare("SELECT job_id, payload_hash FROM slice_request_jobs WHERE request_id = ?")
      .get(input.requestId) as { job_id: string; payload_hash: string } | undefined;
    if (existing !== undefined) {
      if (existing.payload_hash !== input.payloadHash) throw new IdempotencyConflictError();
      const job = this.getJob(existing.job_id);
      if (job === undefined) throw new Error("The request index points to a missing job");
      return { job, reused: true };
    }

    const jobId = `job-${input.requestId}`;
    assertId("jobId", jobId);
    if (this.getJob(jobId) !== undefined) throw new Error(`Job ${jobId} already exists`);
    const now = Date.now();
    const threadId = `thread-${jobId}`;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare(`INSERT INTO slice_jobs
          (job_id, project_id, profile_revision, title, request_text, thread_id, stage, run_state,
           command_revision, generation, requirements_revision, issue_json, reports_enabled, report_interval_minutes, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'requirements', 'running', 1, 1, 1, ?, 1, 10, ?, ?)`)
        .run(jobId, input.projectId, project.revision, title, requestText, threadId, input.issue === null ? null : JSON.stringify(input.issue), now, now);
      this.#database
        .prepare("INSERT INTO slice_request_jobs (request_id, payload_hash, job_id, created_at) VALUES (?, ?, ?, ?)")
        .run(input.requestId, input.payloadHash, jobId, now);
      if (input.issue !== null) {
        this.#database
          .prepare(`INSERT INTO slice_issue_links (provider, repo_slug, issue_number, issue_id, url, issue_updated_at, title, job_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(input.issue.provider, input.issue.repoSlug, input.issue.issueNumber, input.issue.issueId, input.issue.url, input.issue.issueUpdatedAt, input.issue.title, jobId, now);
      }
      this.#insertEvent(jobId, "job_created", { projectId: input.projectId, title, issue: input.issue }, now);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return { job: this.getJob(jobId)!, reused: false };
  }

  getJob(jobId: string): JobRecord | undefined {
    assertId("jobId", jobId);
    const row = this.#database.prepare("SELECT * FROM slice_jobs WHERE job_id = ?").get(jobId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toJob(row);
  }

  listJobs(): JobRecord[] {
    return (this.#database.prepare("SELECT * FROM slice_jobs ORDER BY created_at DESC").all() as Record<string, unknown>[]).map(toJob);
  }

  findJobForIssue(repoSlug: string, issueNumber: number): JobRecord | undefined {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repoSlug)) throw new TypeError("Repository slugs must look like owner/repo");
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new TypeError("Issue numbers must be positive integers");
    const row = this.#database
      .prepare("SELECT job_id FROM slice_issue_links WHERE provider = 'github' AND repo_slug = ? AND issue_number = ? ORDER BY created_at LIMIT 1")
      .get(repoSlug, issueNumber) as { job_id: string } | undefined;
    return row === undefined ? undefined : this.getJob(row.job_id);
  }

  /** Transition guarded by the caller's expected run state, so two coordinators cannot both advance a job. */
  setRunState(jobId: string, from: JobRunState[], to: JobRunState): JobRecord | undefined {
    assertId("jobId", jobId);
    if (from.length === 0) throw new TypeError("Guard states are required");
    const placeholders = from.map(() => "?").join(", ");
    const changed = this.#database
      .prepare(`UPDATE slice_jobs SET run_state = ?, updated_at = ? WHERE job_id = ? AND run_state IN (${placeholders})`)
      .run(to, Date.now(), jobId, ...from);
    // A guard that matches no row is a lost race, not a silent success.
    if (changed.changes === 0) return undefined;
    return this.getJob(jobId);
  }

  setStage(jobId: string, stage: JobStage): JobRecord | undefined {
    assertId("jobId", jobId);
    this.#database.prepare("UPDATE slice_jobs SET stage = ?, updated_at = ? WHERE job_id = ?").run(stage, Date.now(), jobId);
    return this.getJob(jobId);
  }

  /** Record the durable conversation once it exists, so a restart reuses it instead of creating another. */
  setThread(jobId: string, threadId: string): JobRecord | undefined {
    assertId("jobId", jobId);
    assertId("threadId", threadId);
    this.#database.prepare("UPDATE slice_jobs SET thread_id = ?, updated_at = ? WHERE job_id = ?").run(threadId, Date.now(), jobId);
    return this.getJob(jobId);
  }

  bumpCommandRevision(jobId: string): number {
    assertId("jobId", jobId);
    this.#database.prepare("UPDATE slice_jobs SET command_revision = command_revision + 1, updated_at = ? WHERE job_id = ?").run(Date.now(), jobId);
    return this.getJob(jobId)!.commandRevision;
  }

  setReportSettings(jobId: string, enabled: boolean, intervalMinutes: number): JobRecord | undefined {
    assertId("jobId", jobId);
    if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 60) {
      throw new TypeError("Report intervals must be between 1 and 60 minutes");
    }
    this.#database
      .prepare("UPDATE slice_jobs SET reports_enabled = ?, report_interval_minutes = ?, updated_at = ? WHERE job_id = ?")
      .run(enabled ? 1 : 0, intervalMinutes, Date.now(), jobId);
    return this.getJob(jobId);
  }

  // -------------------------------------------------------- event ledger

  appendEvent(jobId: string, type: string, payload: unknown): JobEvent {
    assertId("jobId", jobId);
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(type)) throw new TypeError("Event types must be 1-64 safe characters");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const event = this.#insertEvent(jobId, type, payload, Date.now());
      this.#database.exec("COMMIT");
      return event;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #insertEvent(jobId: string, type: string, payload: unknown, createdAt: number): JobEvent {
    const last = this.#database
      .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM slice_job_events WHERE job_id = ?")
      .get(jobId) as { seq: number };
    const seq = Number(last.seq) + 1;
    this.#database
      .prepare("INSERT INTO slice_job_events (job_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(jobId, seq, type, JSON.stringify(payload ?? null), createdAt);
    return { jobId, seq, type, payload, createdAt };
  }

  eventsAfter(jobId: string, cursor: number, limit = 200): JobEvent[] {
    assertId("jobId", jobId);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new TypeError("Event cursors must be non-negative integers");
    const rows = this.#database
      .prepare("SELECT * FROM slice_job_events WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?")
      .all(jobId, cursor, Math.min(Math.max(limit, 1), 1000)) as Record<string, unknown>[];
    return rows.map((row) => ({
      jobId: String(row.job_id),
      seq: Number(row.seq),
      type: String(row.type),
      payload: parseJson<unknown>(String(row.payload_json), null),
      createdAt: Number(row.created_at),
    }));
  }

  latestEventSeq(jobId: string): number {
    assertId("jobId", jobId);
    return Number((this.#database.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM slice_job_events WHERE job_id = ?").get(jobId) as { seq: number }).seq);
  }

  // --------------------------------------------------- requirements

  addQuestion(jobId: string, question: { questionId: string; question: string; choices: readonly string[] }): PendingQuestion {
    assertId("jobId", jobId);
    assertId("questionId", question.questionId);
    if (question.question.trim().length === 0 || question.question.length > 2_000) throw new TypeError("Questions must be 1-2000 characters");
    if (question.choices.length > 10 || question.choices.some((c) => c.length === 0 || c.length > 200)) {
      throw new TypeError("Questions carry at most 10 choices of at most 200 characters");
    }
    const job = this.getJob(jobId);
    if (job === undefined) throw new Error(`Job ${jobId} is not known`);
    const now = Date.now();
    this.#database
      .prepare(`INSERT INTO slice_pending_questions (job_id, question_id, revision, requirements_revision, question, choices_json, status, created_at)
        VALUES (?, ?, 1, ?, ?, ?, 'open', ?)`)
      .run(jobId, question.questionId, job.requirementsRevision, question.question, JSON.stringify(question.choices), now);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#insertEvent(jobId, "question_asked", { questionId: question.questionId, question: question.question, choices: question.choices }, now);
      // Only a running job moves to waiting_user; a blocked job stays blocked with its reason intact.
      this.#database.prepare("UPDATE slice_jobs SET run_state = 'waiting_user', updated_at = ? WHERE job_id = ? AND run_state = 'running'").run(now, jobId);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return this.getQuestion(jobId, question.questionId)!;
  }

  getQuestion(jobId: string, questionId: string): PendingQuestion | undefined {
    assertId("jobId", jobId);
    assertId("questionId", questionId);
    const row = this.#database.prepare("SELECT * FROM slice_pending_questions WHERE job_id = ? AND question_id = ?").get(jobId, questionId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toQuestion(row);
  }

  openQuestions(jobId: string): PendingQuestion[] {
    assertId("jobId", jobId);
    return (this.#database.prepare("SELECT * FROM slice_pending_questions WHERE job_id = ? AND status = 'open' ORDER BY created_at").all(jobId) as Record<string, unknown>[]).map(toQuestion);
  }

  /** Returns the answered question, or undefined when the question is stale or already answered. */
  answerQuestion(jobId: string, questionId: string, revision: number, answer: string): PendingQuestion | undefined {
    assertId("jobId", jobId);
    assertId("questionId", questionId);
    if (answer.trim().length === 0 || answer.length > 2_000) throw new TypeError("Answers must be 1-2000 characters");
    const question = this.getQuestion(jobId, questionId);
    if (question === undefined || question.status !== "open" || question.revision !== revision) return undefined;
    const now = Date.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.#database
        .prepare("UPDATE slice_pending_questions SET status = 'answered', answer = ?, revision = revision + 1 WHERE job_id = ? AND question_id = ? AND status = 'open' AND revision = ?")
        .run(answer, jobId, questionId, revision);
      if (changed.changes === 0) {
        this.#database.exec("ROLLBACK");
        return undefined;
      }
      this.#insertEvent(jobId, "question_answered", { questionId, answer }, now);
      const job = this.getJob(jobId)!;
      const stillOpen = this.openQuestions(jobId).length;
      if (stillOpen === 0 && job.runState === "waiting_user") {
        this.#database.prepare("UPDATE slice_jobs SET run_state = 'running', updated_at = ? WHERE job_id = ?").run(now, jobId);
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return this.getQuestion(jobId, questionId);
  }

  /** A new requirements revision makes earlier open questions stale; late answers cannot apply. */
  staleOpenQuestions(jobId: string): number {
    assertId("jobId", jobId);
    const now = Date.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare("UPDATE slice_pending_questions SET status = 'stale' WHERE job_id = ? AND status = 'open'")
        .run(jobId);
      const job = this.#database
        .prepare("UPDATE slice_jobs SET requirements_revision = requirements_revision + 1, updated_at = ? WHERE job_id = ?")
        .run(now, jobId);
      void job;
      const updated = this.getJob(jobId)!;
      this.#insertEvent(jobId, "requirements_revised", { requirementsRevision: updated.requirementsRevision }, now);
      this.#database.exec("COMMIT");
      return updated.requirementsRevision;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  // --------------------------------------------------------- steering

  recordSteering(jobId: string, input: { requestId: string; payloadHash: string; expectedCommandRevision: number; instruction: string }):
    { recorded: boolean; job: JobRecord; steering?: { commandRevision: number; createdAt: number } } {
    assertId("jobId", jobId);
    assertId("requestId", input.requestId);
    if (input.instruction.trim().length === 0 || input.instruction.length > 20_000) throw new TypeError("Steering instructions must be 1-20000 characters");
    const job = this.getJob(jobId);
    if (job === undefined) throw new Error(`Job ${jobId} is not known`);
    if (input.expectedCommandRevision !== job.commandRevision) {
      // Stale command: reject without applying, and let the caller return the current state.
      return { recorded: false, job };
    }
    const existing = this.#database
      .prepare("SELECT payload_hash, command_revision, created_at FROM slice_steering_events WHERE job_id = ? AND request_id = ?")
      .get(jobId, input.requestId) as { payload_hash: string; command_revision: number; created_at: number } | undefined;
    if (existing !== undefined) {
      if (existing.payload_hash !== input.payloadHash) throw new IdempotencyConflictError();
      return { recorded: true, job, steering: { commandRevision: existing.command_revision, createdAt: existing.created_at } };
    }
    const now = Date.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare("INSERT INTO slice_steering_events (job_id, request_id, payload_hash, command_revision, instruction, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(jobId, input.requestId, input.payloadHash, job.commandRevision, input.instruction, now);
      this.#database.prepare("UPDATE slice_jobs SET command_revision = command_revision + 1, updated_at = ? WHERE job_id = ?").run(now, jobId);
      this.#insertEvent(jobId, "steering_recorded", { requestId: input.requestId, instruction: input.instruction }, now);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return { recorded: true, job: this.getJob(jobId)!, steering: { commandRevision: job.commandRevision, createdAt: now } };
  }

  // ------------------------------------------------------- workspaces

  upsertWorkspace(workspace: Omit<WorkspaceRecord, "updatedAt">): WorkspaceRecord {
    assertId("jobId", workspace.jobId);
    for (const path of [workspace.repoPath, workspace.worktreePath]) {
      if (!/^\/[A-Za-z0-9._/-]{1,300}$/.test(path)) throw new TypeError("Workspace paths must be absolute POSIX paths without shell metacharacters");
    }
    if (!/^slice\/[A-Za-z0-9._-]{1,128}\/[A-Za-z0-9._-]{1,64}$/.test(workspace.branch)) throw new TypeError("Branches must match slice/<job>/<short-title>");
    if (!/^[0-9a-f]{7,40}$/.test(workspace.baseCommit)) throw new TypeError("Base commits must be hex object ids");
    const now = Date.now();
    this.#database
      .prepare(`INSERT INTO slice_workspaces (job_id, host_id, repo_path, worktree_path, branch, base_commit, lease_generation, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET host_id = excluded.host_id, repo_path = excluded.repo_path, worktree_path = excluded.worktree_path,
          branch = excluded.branch, base_commit = excluded.base_commit, lease_generation = excluded.lease_generation, updated_at = excluded.updated_at`)
      .run(workspace.jobId, workspace.hostId, workspace.repoPath, workspace.worktreePath, workspace.branch, workspace.baseCommit, workspace.leaseGeneration, now);
    return this.getWorkspace(workspace.jobId)!;
  }

  getWorkspace(jobId: string): WorkspaceRecord | undefined {
    assertId("jobId", jobId);
    const row = this.#database.prepare("SELECT * FROM slice_workspaces WHERE job_id = ?").get(jobId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : {
      jobId: String(row.job_id),
      hostId: String(row.host_id),
      repoPath: String(row.repo_path),
      worktreePath: String(row.worktree_path),
      branch: String(row.branch),
      baseCommit: String(row.base_commit),
      leaseGeneration: Number(row.lease_generation),
      updatedAt: Number(row.updated_at),
    };
  }

  // ------------------------------------------------- runner operations

  planOperation(operation: { operationId: string; jobId: string; leaseGeneration: number; intent: string }): RunnerOperationRecord {
    assertId("operationId", operation.operationId);
    assertId("jobId", operation.jobId);
    const now = Date.now();
    this.#database
      .prepare(`INSERT INTO slice_runner_operations (operation_id, job_id, lease_generation, intent, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'planned', ?, ?)`)
      .run(operation.operationId, operation.jobId, operation.leaseGeneration, operation.intent, now, now);
    return this.getOperation(operation.operationId)!;
  }

  getOperation(operationId: string): RunnerOperationRecord | undefined {
    assertId("operationId", operationId);
    const row = this.#database.prepare("SELECT * FROM slice_runner_operations WHERE operation_id = ?").get(operationId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : {
      operationId: String(row.operation_id),
      jobId: String(row.job_id),
      leaseGeneration: Number(row.lease_generation),
      intent: String(row.intent),
      status: String(row.status) as OperationStatus,
      observed: parseJson<unknown>(row.observed_json === null ? null : String(row.observed_json), null),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  setOperationStatus(operationId: string, status: OperationStatus, observed?: unknown): RunnerOperationRecord | undefined {
    assertId("operationId", operationId);
    this.#database
      .prepare("UPDATE slice_runner_operations SET status = ?, observed_json = ?, updated_at = ? WHERE operation_id = ?")
      .run(status, observed === undefined ? null : JSON.stringify(observed), Date.now(), operationId);
    return this.getOperation(operationId);
  }

  operationsForJob(jobId: string): RunnerOperationRecord[] {
    assertId("jobId", jobId);
    return (this.#database.prepare("SELECT * FROM slice_runner_operations WHERE job_id = ? ORDER BY created_at").all(jobId) as Record<string, unknown>[])
      .map((row) => ({
        operationId: String(row.operation_id),
        jobId: String(row.job_id),
        leaseGeneration: Number(row.lease_generation),
        intent: String(row.intent),
        status: String(row.status) as OperationStatus,
        observed: parseJson<unknown>(row.observed_json === null ? null : String(row.observed_json), null),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      }));
  }

  // ------------------------------------------------- owner credentials

  /** The owner password comes from the environment; only its scrypt derivation is stored. */
  storeOwnerPassword(password: string): void {
    if (password.length < 12 || password.length > 1_000) throw new TypeError("The owner password must be at least 12 characters");
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 64);
    this.#database
      .prepare(`INSERT INTO slice_owner_credentials (id, salt, hash, created_at) VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET salt = excluded.salt, hash = excluded.hash`)
      .run(salt.toString("base64"), hash.toString("base64"), Date.now());
  }

  hasOwnerPassword(): boolean {
    return this.#database.prepare("SELECT 1 AS present FROM slice_owner_credentials WHERE id = 1").get() !== undefined;
  }

  verifyOwnerPassword(password: string): boolean {
    const row = this.#database.prepare("SELECT salt, hash FROM slice_owner_credentials WHERE id = 1").get() as { salt: string; hash: string } | undefined;
    if (row === undefined) return false;
    const expected = Buffer.from(row.hash, "base64");
    const actual = scryptSync(password, Buffer.from(row.salt, "base64"), expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  // --------------------------------------------------------- sessions

  createSession(tokenHash: string, csrfHash: string, expiresAt: number): void {
    this.#database
      .prepare("INSERT INTO slice_sessions (token_hash, csrf_hash, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(tokenHash, csrfHash, Date.now(), expiresAt);
  }

  getSession(tokenHash: string): { tokenHash: string; csrfHash: string; expiresAt: number } | undefined {
    const row = this.#database
      .prepare("SELECT * FROM slice_sessions WHERE token_hash = ? AND expires_at > ?")
      .get(tokenHash, Date.now()) as { token_hash: string; csrf_hash: string; expires_at: number } | undefined;
    return row === undefined ? undefined : { tokenHash: row.token_hash, csrfHash: row.csrf_hash, expiresAt: row.expires_at };
  }

  endSession(tokenHash: string): void {
    this.#database.prepare("DELETE FROM slice_sessions WHERE token_hash = ?").run(tokenHash);
  }

  /** Shared database handle; the Phase 0 stores and Pi Durable use the same state file. */
  get database(): DatabaseSync {
    return this.#database;
  }

  // --------------------------------------------------------- retention

  /**
   * F7 carry-over: terminal request-index and operation rows older than the retention window are
   * pruned, but never the most recent floor rows, so recent idempotency protection survives.
   * Active ('running'/'uncertain') operations are never pruned: they still need reconciliation.
   */
  pruneExpired(retentionDays = RETENTION_DAYS, floorRows = RETENTION_FLOOR_ROWS): { submissions: number; operations: number } {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const submissions = this.#database.prepare(
      `DELETE FROM slice_submission_requests
       WHERE created_at < ? AND submission_id IS NOT NULL
         AND rowid NOT IN (SELECT rowid FROM slice_submission_requests ORDER BY created_at DESC LIMIT ?)`,
    ).run(cutoff, floorRows).changes;
    const operations = this.#database.prepare(
      `DELETE FROM slice_runner_operations
       WHERE updated_at < ? AND status IN ('succeeded', 'failed')
         AND rowid NOT IN (SELECT rowid FROM slice_runner_operations ORDER BY updated_at DESC LIMIT ?)`,
    ).run(cutoff, floorRows).changes;
    // Expired sessions are dead weight the moment they pass their expiry.
    this.#database.prepare("DELETE FROM slice_sessions WHERE expires_at < ?").run(Date.now());
    return { submissions: Number(submissions), operations: Number(operations) };
  }

  close(): void {
    this.#database.close();
  }
}

function validateBuildProfile(profile: BuildProfile): void {
  if (!Array.isArray(profile.setup) || profile.setup.length > 20) throw new TypeError("Build profiles carry at most 20 setup commands");
  if (!Array.isArray(profile.checks) || profile.checks.length === 0 || profile.checks.length > 20) {
    throw new TypeError("Build profiles carry between 1 and 20 checks");
  }
  const seen = new Set<string>();
  for (const check of profile.checks) {
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(check.id)) throw new TypeError("Check ids must be 1-64 safe characters");
    if (seen.has(check.id)) throw new TypeError("Check ids must be unique within a profile");
    seen.add(check.id);
    if (check.command.length === 0 || check.command.length > 500) throw new TypeError("Check commands must be 1-500 characters");
    // Fixed profile text only: no shell substitution that could read a credential or escape the workspace.
    if (/[<>$`&|;(){}\\\n\r]/.test(check.command)) throw new TypeError("Check commands must be a plain command without shell metacharacters");
  }
  for (const command of profile.setup) {
    if (command.length === 0 || command.length > 500) throw new TypeError("Setup commands must be 1-500 characters");
    if (/[<>$`&|;(){}\\\n\r]/.test(command)) throw new TypeError("Setup commands must be a plain command without shell metacharacters");
  }
}

function toProject(row: Record<string, unknown>): ProjectRecord {
  return {
    projectId: String(row.project_id),
    revision: Number(row.revision),
    gitProvider: "github",
    repoSlug: String(row.repo_slug),
    defaultBranch: String(row.default_branch),
    hostId: String(row.host_id),
    buildProfile: parseJson<BuildProfile>(String(row.build_profile_json), { setup: [], checks: [] }),
    gitRemoteUrl: row.git_remote_url === null || row.git_remote_url === undefined ? null : String(row.git_remote_url),
    status: String(row.status) as ProjectStatus,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toJob(row: Record<string, unknown>): JobRecord {
  return {
    jobId: String(row.job_id),
    projectId: String(row.project_id),
    profileRevision: Number(row.profile_revision),
    title: String(row.title),
    requestText: String(row.request_text),
    threadId: String(row.thread_id),
    stage: String(row.stage) as JobStage,
    runState: String(row.run_state) as JobRunState,
    commandRevision: Number(row.command_revision),
    generation: Number(row.generation),
    requirementsRevision: Number(row.requirements_revision),
    issue: parseJson<IssueSnapshot | null>(row.issue_json === null ? null : String(row.issue_json), null),
    reportsEnabled: Number(row.reports_enabled) === 1,
    reportIntervalMinutes: Number(row.report_interval_minutes),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toQuestion(row: Record<string, unknown>): PendingQuestion {
  return {
    jobId: String(row.job_id),
    questionId: String(row.question_id),
    revision: Number(row.revision),
    requirementsRevision: Number(row.requirements_revision),
    question: String(row.question),
    choices: parseJson<readonly string[]>(String(row.choices_json), []),
    status: String(row.status) as PendingQuestion["status"],
    answer: row.answer === null ? null : String(row.answer),
    createdAt: Number(row.created_at),
  };
}
