#!/usr/bin/env node
/**
 * Slice SSH runner. One invocation per operation: typed JSON on stdin, one JSON response on
 * stdout. The journal lives outside disposable job directories so builds survive control-service
 * restarts. Commands are fixed build-profile text split into argv; no shell is ever involved.
 *
 *   node main.js --root <runnerRoot>                 (serve one request from stdin)
 *   node main.js --supervise <journalDir> <worktree> <operationId> <timeoutMs> <command...>
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const BRANCH_PATTERN = /^slice\/[A-Za-z0-9._-]{1,128}\/[A-Za-z0-9._-]{1,64}$/;
const COMMAND_PATTERN = /^[A-Za-z0-9._/@-]{1,128}(\s+[A-Za-z0-9._/@:=,+.-]{1,256})*$/;
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/;
const DEFAULT_TIMEOUT_MS = 600_000;
/** Largest patch the runner accepts, in bytes of unified diff text. */
const MAX_PATCH_BYTES = 512_000;
/** Largest bundle the runner exports, in bytes. */
const MAX_BUNDLE_BYTES = 32_000_000;

type Request =
  | { op: "health" }
  | { op: "prepare_job"; jobId: string; source: string; branch: string; leaseGeneration: number }
  | { op: "run_check"; jobId: string; operationId: string; leaseGeneration: number; checkId: string; command: string; timeoutMs?: number }
  | { op: "apply_change"; jobId: string; operationId: string; leaseGeneration: number; patch: string; commitMessage: string; expectedParent: string }
  | { op: "get_process_status"; jobId: string; operationId: string }
  | { op: "cancel_process"; jobId: string; operationId: string }
  | { op: "reconcile"; jobId: string }
  | { op: "inspect_job"; jobId: string }
  | { op: "verify_head"; jobId: string }
  | { op: "reconcile_apply"; jobId: string; operationId: string }
  | { op: "read_source"; jobId: string; path: string }
  | { op: "export_commit"; jobId: string; commit: string }
  | { op: "start_preview"; jobId: string; operationId: string; leaseGeneration: number; command: string; port: number; ttlMs?: number }
  | { op: "preview_status"; jobId: string }
  | { op: "capture_screenshot"; jobId: string; scenarioId: string; route: string; commit: string; width: number; height: number }
  | { op: "stop_preview"; jobId: string }
  | { op: "cleanup_job"; jobId: string };

type Response =
  | { ok: true; [key: string]: unknown }
  | { ok: false; error: string };

function fail(error: string): Response {
  return { ok: false, error };
}

function assertId(value: string, name: string): void {
  if (!ID_PATTERN.test(value)) throw new TypeError(`${name} is invalid`);
}

class Journal {
  readonly #db: DatabaseSync;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, "pids"), { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, "out"), { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, "exit"), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(join(dir, "journal.sqlite"));
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS leases (job_id TEXT PRIMARY KEY, generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        lease_generation INTEGER NOT NULL,
        op TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'uncertain')),
        exit_code INTEGER,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  lease(jobId: string, requested: number): { allowed: boolean; reason?: string } {
    const row = this.#db.prepare("SELECT generation FROM leases WHERE job_id = ?").get(jobId) as { generation: number } | undefined;
    if (row === undefined) {
      this.#db.prepare("INSERT INTO leases (job_id, generation) VALUES (?, ?)").run(jobId, requested);
      return { allowed: true };
    }
    if (requested === row.generation) return { allowed: true };
    if (requested < row.generation) return { allowed: false, reason: "lease_revoked" };
    // A replacement lease is only granted after the previous generation's work is settled.
    if (this.unsettledFor(jobId) > 0) return { allowed: false, reason: "reconcile_required" };
    this.#db.prepare("UPDATE leases SET generation = ? WHERE job_id = ?").run(requested, jobId);
    return { allowed: true };
  }

  currentLease(jobId: string): number | undefined {
    const row = this.#db.prepare("SELECT generation FROM leases WHERE job_id = ?").get(jobId) as { generation: number } | undefined;
    return row?.generation;
  }

  plan(operationId: string, jobId: string, lease: number, op: string): void {
    const existing = this.get(operationId);
    // A settled or in-flight operation ID is never silently re-planned; only an explicit failure may be retried.
    if (existing !== undefined && existing.status !== "failed") throw new Error(`operation_${existing.status}_cannot_replan`);
    if (existing !== undefined) {
      this.#db
        .prepare("UPDATE operations SET status = 'running', exit_code = NULL, started_at = ?, updated_at = ? WHERE operation_id = ?")
        .run(Date.now(), Date.now(), operationId);
      return;
    }
    this.#db
      .prepare("INSERT INTO operations (operation_id, job_id, lease_generation, op, status, started_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?)")
      .run(operationId, jobId, lease, op, Date.now(), Date.now());
  }

  get(operationId: string): { operation_id: string; job_id: string; status: string; exit_code: number | null } | undefined {
    return this.#db.prepare("SELECT operation_id, job_id, status, exit_code FROM operations WHERE operation_id = ?").get(operationId) as never;
  }

  setStatus(operationId: string, status: "succeeded" | "failed" | "uncertain", exitCode?: number): void {
    this.#db
      .prepare("UPDATE operations SET status = ?, exit_code = ?, updated_at = ? WHERE operation_id = ?")
      .run(status, exitCode ?? null, Date.now(), operationId);
  }

  runningFor(jobId: string): { operation_id: string; op: string }[] {
    return this.#db.prepare("SELECT operation_id, op FROM operations WHERE job_id = ? AND status IN ('running', 'uncertain')").all(jobId) as never;
  }

  /** Operations whose outcome is still running or uncertain: cleanup must wait for confirmation. */
  unsettledFor(jobId: string): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM operations WHERE job_id = ? AND status IN ('running', 'uncertain')").get(jobId) as { n: number };
    return Number(row.n);
  }

  removeJob(jobId: string): void {
    this.#db.prepare("DELETE FROM operations WHERE job_id = ?").run(jobId);
    this.#db.prepare("DELETE FROM leases WHERE job_id = ?").run(jobId);
  }

  pidFile(operationId: string): string {
    return join(this.dir, "pids", operationId);
  }

  exitFile(operationId: string): string {
    return join(this.dir, "exit", operationId);
  }

  outFile(operationId: string): string {
    return join(this.dir, "out", operationId);
  }

  close(): void {
    this.#db.close();
  }
}

function git(args: string[]): { ok: boolean; output: string } {
  const result = spawnSync("git", args, { encoding: "utf8", timeout: 120_000 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { ok: result.status === 0, output: output.slice(0, 4_000) };
}

function readConfig(root: string): { allowedSources: string[]; allowedBrowser: string | null } {
  try {
    const parsed = JSON.parse(readFileSync(join(root, ".runner.json"), "utf8")) as { allowedSources?: unknown; allowedBrowser?: unknown };
    if (!Array.isArray(parsed.allowedSources) || parsed.allowedSources.some((s) => typeof s !== "string" || s.length === 0)) {
      throw new Error("missing allowedSources");
    }
    // The screenshot browser is a registered absolute path, never a model-supplied command.
    const browser = typeof parsed.allowedBrowser === "string" && parsed.allowedBrowser.startsWith("/") ? parsed.allowedBrowser : null;
    return { allowedSources: parsed.allowedSources as string[], allowedBrowser: browser };
  } catch {
    // With no explicit allowlist the runner accepts nothing; registration is deliberate.
    return { allowedSources: [], allowedBrowser: null };
  }
}

function jobMarker(jobDir: string): { jobId: string; branch: string; baseCommit: string } | undefined {
  try {
    return JSON.parse(readFileSync(join(jobDir, ".job.json"), "utf8")) as { jobId: string; branch: string; baseCommit: string };
  } catch {
    return undefined;
  }
}

function handlePrepare(journal: Journal, root: string, request: Extract<Request, { op: "prepare_job" }>): Response {
  assertId(request.jobId, "jobId");
  if (!BRANCH_PATTERN.test(request.branch)) return fail("invalid_branch");
  const config = readConfig(root);
  if (!config.allowedSources.some((prefix) => request.source.startsWith(prefix))) return fail("source_not_allowed");
  // A leading dash would be read by git as an option, and metacharacters have no place in a source.
  if (request.source.startsWith("-") || /[<>$`&|;(){}\\\n\r]/.test(request.source)) return fail("source_invalid");
  const lease = journal.lease(request.jobId, request.leaseGeneration);
  if (!lease.allowed) return fail(lease.reason ?? "lease_denied");

  const jobDir = join(root, request.jobId);
  const repoPath = join(jobDir, "repo");
  const worktreePath = join(jobDir, "author");
  const marker = jobMarker(jobDir);
  if (marker !== undefined) {
    // Recovery rule: reuse only when the marker, branch, and base all match the request.
    if (marker.jobId === request.jobId && marker.branch === request.branch) {
      return { ok: true, baseCommit: marker.baseCommit, repoPath, worktreePath, reused: true };
    }
    return fail("job_marker_mismatch");
  }

  mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  const clone = git(["clone", "--quiet", request.source, repoPath]);
  if (!clone.ok) return fail(`clone_failed: ${clone.output}`);
  const head = git(["-C", repoPath, "rev-parse", "HEAD"]);
  if (!head.ok) return fail("base_lookup_failed");
  const worktree = git(["-C", repoPath, "worktree", "add", "-b", request.branch, worktreePath, head.output]);
  if (!worktree.ok) return fail(`worktree_failed: ${worktree.output}`);
  writeFileSync(join(jobDir, ".job.json"), JSON.stringify({ jobId: request.jobId, branch: request.branch, baseCommit: head.output }), { mode: 0o600 });
  return { ok: true, baseCommit: head.output, repoPath, worktreePath, reused: false };
}

function handleRunCheck(journal: Journal, root: string, request: Extract<Request, { op: "run_check" }>): Response {
  assertId(request.jobId, "jobId");
  assertId(request.operationId, "operationId");
  assertId(request.checkId, "checkId");
  if (!COMMAND_PATTERN.test(request.command)) return fail("command_not_allowed");
  const lease = journal.lease(request.jobId, request.leaseGeneration);
  if (!lease.allowed) return fail(lease.reason ?? "lease_denied");

  const worktreePath = join(root, request.jobId, "author");
  if (!existsSync(worktreePath)) return fail("workspace_missing");

  // Intent is recorded before the spawn, so a crash between the two is reconcilable.
  journal.plan(request.operationId, request.jobId, request.leaseGeneration, `check:${request.checkId}`);
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const child = spawn(process.execPath, [
    process.argv[1] ?? "main.js", "--supervise", journal.dir, worktreePath, request.operationId, String(timeoutMs), ...request.command.split(/\s+/),
  ], { detached: true, stdio: "ignore" });
  if (child.pid === undefined) {
    journal.setStatus(request.operationId, "failed");
    return fail("spawn_failed");
  }
  // The supervisor also writes this file first thing; writing here too narrows the crash window.
  try {
    writeFileSync(journal.pidFile(request.operationId), String(child.pid), { mode: 0o600 });
  } catch { /* the supervisor's own write still stands */ }
  child.unref();
  return { ok: true, status: "running" };
}

/**
 * apply_change: the only way source reaches the worktree. The patch was validated by the control
 * service; git apply --check is the runner-side gate, and the commit carries an operation marker so
 * a crash between apply and record is reconcilable. The runner owns the authoritative Git metadata;
 * the author role never commits.
 */
function handleApplyChange(journal: Journal, root: string, request: Extract<Request, { op: "apply_change" }>): Response {
  assertId(request.jobId, "jobId");
  assertId(request.operationId, "operationId");
  if (!COMMIT_PATTERN.test(request.expectedParent)) return fail("expected_parent_invalid");
  if (typeof request.patch !== "string" || request.patch.length === 0 || request.patch.length > MAX_PATCH_BYTES) return fail("patch_size_invalid");
  const lease = journal.lease(request.jobId, request.leaseGeneration);
  if (!lease.allowed) return fail(lease.reason ?? "lease_denied");
  const jobDir = join(root, request.jobId);
  const worktreePath = join(jobDir, "author");
  if (!existsSync(worktreePath)) return fail("workspace_missing");
  const marker = jobMarker(jobDir);
  if (marker === undefined || marker.jobId !== request.jobId) return fail("manifest_mismatch");

  const head = git(["-C", worktreePath, "rev-parse", "HEAD"]);
  if (!head.ok) return fail("head_lookup_failed");
  // The expected parent guard is what makes a replayed or racing apply fail loudly instead of stacking.
  if (head.output !== request.expectedParent) return fail("parent_mismatch");

  const patchDir = join(jobDir, ".patches");
  mkdirSync(patchDir, { recursive: true, mode: 0o700 });
  const patchPath = join(patchDir, `${request.operationId}.patch`);
  // git apply requires a trailing newline; model output often omits the final one.
  const patchText = request.patch.endsWith("\n") ? request.patch : `${request.patch}\n`;
  writeFileSync(patchPath, patchText, { mode: 0o600 });

  journal.plan(request.operationId, request.jobId, request.leaseGeneration, "apply_change");
  const check = git(["-C", worktreePath, "apply", "--check", patchPath]);
  if (!check.ok) {
    journal.setStatus(request.operationId, "failed");
    return fail(`patch_rejected: ${check.output}`);
  }
  const applied = git(["-C", worktreePath, "apply", "--index", patchPath]);
  if (!applied.ok) {
    // Undo the partial application so the worktree is never left half-patched. 'checkout -- .' would
    // restore from the index, which apply --index has already modified; reset --hard clears both.
    git(["-C", worktreePath, "reset", "--hard", "HEAD"]);
    git(["-C", worktreePath, "clean", "-fd"]);
    journal.setStatus(request.operationId, "failed");
    return fail(`patch_apply_failed: ${applied.output}`);
  }
  const message = `${String(request.commitMessage ?? "").replace(/\s+/g, " ").slice(0, 200) || "slice change"}\n\nslice-op:${request.operationId}`;
  const committed = git(["-C", worktreePath, "-c", "user.name=Slice Author", "-c", "user.email=author@slice.local", "commit", "-m", message]);
  if (!committed.ok) {
    git(["-C", worktreePath, "reset", "--hard", "HEAD"]);
    git(["-C", worktreePath, "clean", "-fd"]);
    journal.setStatus(request.operationId, "failed");
    return fail(`commit_failed: ${committed.output}`);
  }
  const commit = git(["-C", worktreePath, "rev-parse", "HEAD"]);
  const tree = git(["-C", worktreePath, "rev-parse", "HEAD^{tree}"]);
  if (!commit.ok || !tree.ok) return fail("commit_lookup_failed");
  journal.setStatus(request.operationId, "succeeded", 0);
  return { ok: true, commit: commit.output, tree: tree.output, parent: request.expectedParent };
}

/** Reconciliation for an apply_change left 'running' by a crash: the marker commit decides. */
function reconcileApplyChange(root: string, jobId: string, operationId: string): { status: "succeeded" | "failed"; commit?: string } {
  const worktreePath = join(root, jobId, "author");
  if (!existsSync(worktreePath)) return { status: "failed" };
  const found = git(["-C", worktreePath, "log", "--fixed-strings", `--grep=slice-op:${operationId}`, "--format=%H", "-n", "1"]);
  if (found.ok && /^[0-9a-f]{7,64}$/.test(found.output)) return { status: "succeeded", commit: found.output };
  // No marker commit: the worktree is disposable, so reset index and worktree to HEAD and call the attempt failed.
  git(["-C", worktreePath, "reset", "--hard", "HEAD"]);
  git(["-C", worktreePath, "clean", "-fd"]);
  return { status: "failed" };
}

function handleVerifyHead(root: string, request: Extract<Request, { op: "verify_head" }>): Response {
  assertId(request.jobId, "jobId");
  const marker = jobMarker(join(root, request.jobId));
  if (marker === undefined || marker.jobId !== request.jobId) return fail("manifest_mismatch");
  const worktreePath = join(root, request.jobId, "author");
  const head = git(["-C", worktreePath, "rev-parse", "HEAD"]);
  const tree = git(["-C", worktreePath, "rev-parse", "HEAD^{tree}"]);
  const branch = git(["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"]);
  const parent = git(["-C", worktreePath, "rev-parse", "HEAD^"]);
  if (!head.ok || !tree.ok || !branch.ok) return fail("head_lookup_failed");
  const dirty = git(["-C", worktreePath, "status", "--porcelain"]);
  if (!dirty.ok) return fail("status_lookup_failed");
  return { ok: true, head: head.output, tree: tree.output, branch: branch.output, parent: parent.ok ? parent.output : "", clean: dirty.output.length === 0 };
}

/** Targeted reconciliation of one apply_change operation, including ones already settled. */
function handleReconcileApply(journal: Journal, root: string, request: Extract<Request, { op: "reconcile_apply" }>): Response {
  assertId(request.jobId, "jobId");
  assertId(request.operationId, "operationId");
  const row = journal.get(request.operationId);
  if (row === undefined) return { ok: true, status: "not_started" };
  // An operation belongs to exactly one job; another job's ID cannot resolve it.
  if (row.job_id !== request.jobId) return fail("operation_not_for_job");
  if (row.status === "succeeded" || row.status === "failed") return { ok: true, status: row.status };
  const resolved = reconcileApplyChange(root, request.jobId, request.operationId);
  journal.setStatus(request.operationId, resolved.status, resolved.status === "succeeded" ? 0 : 1);
  return { ok: true, status: resolved.status, commit: resolved.commit ?? null };
}

/** Read-only source inspection for review context; containment and size are enforced here. */
function handleReadSource(root: string, request: Extract<Request, { op: "read_source" }>): Response {
  assertId(request.jobId, "jobId");
  if (typeof request.path !== "string" || request.path.length === 0 || request.path.length > 300) return fail("path_invalid");
  if (request.path.startsWith("/") || request.path.startsWith("-") || request.path.split("/").some((part) => part === ".." || part === "")) return fail("path_invalid");
  const marker = jobMarker(join(root, request.jobId));
  if (marker === undefined || marker.jobId !== request.jobId) return fail("manifest_mismatch");
  const worktreePath = join(root, request.jobId, "author");
  const target = join(worktreePath, request.path);
  if (!target.startsWith(worktreePath + "/")) return fail("path_outside_worktree");
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    return fail("file_missing");
  }
  if (!real.startsWith(worktreePath + "/")) return fail("path_outside_worktree");
  const content = readFileSync(real);
  if (content.length > 256_000) return fail("file_too_large");
  return { ok: true, content: content.toString("utf8").slice(0, 256_000) };
}

/**
 * export_commit: the branch state leaves the runner as a verified git bundle. Publishing
 * credentials stay on the control host; the runner never sees them.
 */
function handleExportCommit(root: string, request: Extract<Request, { op: "export_commit" }>): Response {
  assertId(request.jobId, "jobId");
  if (!COMMIT_PATTERN.test(request.commit)) return fail("commit_invalid");
  const jobDir = join(root, request.jobId);
  const marker = jobMarker(jobDir);
  if (marker === undefined || marker.jobId !== request.jobId) return fail("manifest_mismatch");
  const exportDir = join(jobDir, "export");
  mkdirSync(exportDir, { recursive: true, mode: 0o700 });
  const bundlePath = join(exportDir, `${request.commit}.bundle`);
  // The bundle must carry the branch ref, and its head must be exactly the requested commit.
  const branchHead = git(["-C", join(jobDir, "repo"), "rev-parse", `refs/heads/${marker.branch}`]);
  if (!branchHead.ok || branchHead.output !== request.commit) return fail("commit_not_branch_head");
  const bundled = git(["-C", join(jobDir, "repo"), "bundle", "create", bundlePath, `refs/heads/${marker.branch}`]);
  if (!bundled.ok) return fail(`bundle_failed: ${bundled.output}`);
  const bytes = readFileSync(bundlePath);
  if (bytes.length > MAX_BUNDLE_BYTES) return fail("bundle_too_large");
  return { ok: true, bundleBase64: bytes.toString("base64"), bytes: bytes.length };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveRunning(journal: Journal, operationId: string): { status: string; exitCode?: number } {
  const exitPath = journal.exitFile(operationId);
  if (existsSync(exitPath)) {
    const exitCode = Number(readFileSync(exitPath, "utf8").trim());
    return { status: Number.isInteger(exitCode) && exitCode === 0 ? "succeeded" : "failed", exitCode };
  }
  const pidPath = journal.pidFile(operationId);
  if (existsSync(pidPath)) {
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    if (pidAlive(pid)) return { status: "running" };
    // The supervisor exited without recording an exit code; the outcome is unknown, not failed.
    return { status: "uncertain" };
  }
  // A missing PID alone is not permission to start a duplicate.
  return { status: "uncertain" };
}

function handleStatus(journal: Journal, request: Extract<Request, { op: "get_process_status" }>): Response {
  assertId(request.operationId, "operationId");
  const row = journal.get(request.operationId);
  if (row === undefined) return fail("operation_not_found");
  const tailOf = (): string =>
    existsSync(journal.outFile(request.operationId)) ? readFileSync(journal.outFile(request.operationId), "utf8").slice(-4_000) : "";
  if (row.status !== "running") {
    return { ok: true, status: row.status, exitCode: row.exit_code ?? null, outputTail: tailOf() };
  }
  const resolved = resolveRunning(journal, request.operationId);
  if (resolved.status === "running") return { ok: true, status: "running", exitCode: null };
  journal.setStatus(request.operationId, resolved.status as "succeeded" | "failed" | "uncertain", resolved.exitCode);
  return { ok: true, status: resolved.status, exitCode: resolved.exitCode ?? null, outputTail: tailOf() };
}

function handleCancel(journal: Journal, request: Extract<Request, { op: "cancel_process" }>): Response {
  assertId(request.operationId, "operationId");
  const row = journal.get(request.operationId);
  if (row === undefined) return fail("operation_not_found");
  if (row.status !== "running") return { ok: true, status: row.status };
  const pidPath = journal.pidFile(request.operationId);
  if (!existsSync(pidPath)) return { ok: true, status: "uncertain", reason: "no_pid_record" };
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  try {
    // The supervisor leads its own process group, so the command tree dies with it.
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return { ok: true, status: "not_running" };
    }
  }
  return { ok: true, status: "cancel_signalled" };
}

function handleReconcile(journal: Journal, root: string, request: Extract<Request, { op: "reconcile" }>): Response {
  assertId(request.jobId, "jobId");
  // Reconciliation re-resolves uncertain rows too: an exit file that appears later settles them.
  const results = journal.runningFor(request.jobId).map((row) => {
    if (row.op === "apply_change") {
      // An interrupted patch is settled by the marker commit, never by blind replay of the patch.
      const resolved = reconcileApplyChange(root, request.jobId, row.operation_id);
      journal.setStatus(row.operation_id, resolved.status, resolved.status === "succeeded" ? 0 : 1);
      return { operationId: row.operation_id, status: resolved.status };
    }
    const resolved = resolveRunning(journal, row.operation_id);
    if (resolved.status !== "running") journal.setStatus(row.operation_id, resolved.status as "succeeded" | "failed" | "uncertain", resolved.exitCode);
    return { operationId: row.operation_id, status: resolved.status };
  });
  return { ok: true, operations: results };
}

function handleInspect(journal: Journal, root: string, request: Extract<Request, { op: "inspect_job" }>): Response {
  assertId(request.jobId, "jobId");
  const marker = jobMarker(join(root, request.jobId));
  return { ok: true, exists: marker !== undefined, marker: marker ?? null, lease: journal.currentLease(request.jobId) ?? null };
}

function handleCleanup(journal: Journal, root: string, request: Extract<Request, { op: "cleanup_job" }>): Response {
  assertId(request.jobId, "jobId");
  const jobDir = join(root, request.jobId);
  // Path containment: the resolved directory must sit directly under the configured root.
  const realRoot = realpathSync(root);
  let realJob: string;
  try {
    realJob = realpathSync(jobDir);
  } catch {
    journal.removeJob(request.jobId);
    return { ok: true, removed: true, note: "already_absent" };
  }
  if (!realJob.startsWith(realRoot + "/") || realJob === realRoot) return fail("path_outside_job_root");
  const marker = jobMarker(jobDir);
  if (marker === undefined || marker.jobId !== request.jobId) return fail("manifest_mismatch");
  const running = journal.runningFor(request.jobId);
  for (const row of running) {
    const resolved = resolveRunning(journal, row.operation_id);
    if (resolved.status !== "running") journal.setStatus(row.operation_id, resolved.status as "succeeded" | "failed" | "uncertain", resolved.exitCode);
  }
  // Deletion needs confirmed stop. 'uncertain' means the outcome is unknown, which is not confirmation;
  // the job stays cleanup-pending until reconciliation resolves every operation.
  if (journal.unsettledFor(request.jobId) > 0) return fail("processes_not_confirmed_stopped");
  // The worktree first, then the disposable repository; the journal rows go last.
  git(["-C", join(jobDir, "repo"), "worktree", "remove", "--force", join(jobDir, "author")]);
  rmSync(realJob, { recursive: true, force: true });
  journal.removeJob(request.jobId);
  return { ok: true, removed: true };
}

/**
 * Previews are long-lived supervised processes on the runner, bound by the application itself to
 * the host's loopback. The control service exposes them only as a stated URL; closing a preview
 * page in a browser never touches the job. The preview process is a journaled operation, so
 * cancellation, reconciliation, and cleanup treat it exactly like any other supervised work.
 */
function handleStartPreview(journal: Journal, root: string, request: Extract<Request, { op: "start_preview" }>): Response {
  assertId(request.jobId, "jobId");
  assertId(request.operationId, "operationId");
  if (!COMMAND_PATTERN.test(request.command)) return fail("command_not_allowed");
  if (!Number.isSafeInteger(request.port) || request.port < 1024 || request.port > 65_535) return fail("preview_port_invalid");
  const jobDir = join(root, request.jobId);
  const worktreePath = join(jobDir, "author");
  if (!existsSync(worktreePath)) return fail("workspace_missing");
  const lease = journal.lease(request.jobId, request.leaseGeneration);
  if (!lease.allowed) return fail(lease.reason ?? "lease_denied");

  const recordPath = join(jobDir, ".preview.json");
  const existing = readPreviewRecord(recordPath);
  if (existing !== undefined) {
    if (pidAliveOf(journal, existing.operationId)) return { ok: true, status: "running", reused: true, port: existing.port };
    // A dead preview must be reconciled to a settled state before a new one is planned; the old
    // operation id stays settled and a fresh id (chosen by the caller) plans cleanly.
    const resolved = resolveRunning(journal, existing.operationId);
    journal.setStatus(existing.operationId, resolved.status as "succeeded" | "failed" | "uncertain", resolved.exitCode);
    try {
      rmSync(recordPath, { force: true });
    } catch { /* the record is disposable */ }
  }

  journal.plan(request.operationId, request.jobId, request.leaseGeneration, "preview");
  const ttlMs = request.ttlMs ?? 2 * 3_600_000;
  const child = spawn(process.execPath, [
    process.argv[1] ?? "main.js", "--supervise", journal.dir, worktreePath, request.operationId, String(ttlMs), ...request.command.split(/\s+/),
  ], { detached: true, stdio: "ignore" });
  if (child.pid === undefined) {
    journal.setStatus(request.operationId, "failed");
    return fail("spawn_failed");
  }
  try {
    writeFileSync(journal.pidFile(request.operationId), String(child.pid), { mode: 0o600 });
    writeFileSync(recordPath, JSON.stringify({ operationId: request.operationId, port: request.port }), { mode: 0o600 });
  } catch { /* the supervisor's own pid write still stands */ }
  child.unref();
  return { ok: true, status: "running", port: request.port };
}

function readPreviewRecord(recordPath: string): { operationId: string; port: number } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(recordPath, "utf8")) as { operationId?: unknown; port?: unknown };
    if (typeof parsed.operationId !== "string" || typeof parsed.port !== "number") return undefined;
    return { operationId: parsed.operationId, port: parsed.port };
  } catch {
    return undefined;
  }
}

function pidAliveOf(journal: Journal, operationId: string): boolean {
  try {
    const pid = Number(readFileSync(journal.pidFile(operationId), "utf8").trim());
    return Number.isInteger(pid) && pidAlive(pid);
  } catch {
    return false;
  }
}

function handlePreviewStatus(journal: Journal, root: string, request: Extract<Request, { op: "preview_status" }>): Response {
  assertId(request.jobId, "jobId");
  const record = readPreviewRecord(join(root, request.jobId, ".preview.json"));
  if (record === undefined) return { ok: true, status: "absent" };
  if (pidAliveOf(journal, record.operationId)) return { ok: true, status: "running", port: record.port };
  return { ok: true, status: "stopped", port: record.port };
}

/**
 * capture_screenshot runs the registered headless browser against the job's own preview on the
 * runner loopback. The browser path comes from the runner configuration, never from a model; the
 * route is a path on the preview, never an arbitrary URL. Output is bounded to 8 MiB.
 */
function handleCaptureScreenshot(journal: Journal, root: string, request: Extract<Request, { op: "capture_screenshot" }>): Response {
  assertId(request.jobId, "jobId");
  assertId(request.scenarioId, "scenarioId");
  if (!/^[0-9a-f]{7,64}$/.test(request.commit)) return fail("commit_invalid");
  if (!/^\/[A-Za-z0-9._/?=&%-]{0,200}$/.test(request.route)) return fail("route_invalid");
  if (!Number.isSafeInteger(request.width) || request.width < 320 || request.width > 2000) return fail("viewport_invalid");
  if (!Number.isSafeInteger(request.height) || request.height < 320 || request.height > 2000) return fail("viewport_invalid");
  const config = readConfig(root);
  if (config.allowedBrowser === null) return fail("browser_not_configured");
  const record = readPreviewRecord(join(root, request.jobId, ".preview.json"));
  if (record === undefined || !pidAliveOf(journal, record.operationId)) return fail("preview_not_running");

  const shotsDir = join(root, request.jobId, "shots");
  mkdirSync(shotsDir, { recursive: true, mode: 0o700 });
  const outPath = join(shotsDir, `${request.scenarioId}-${request.commit.slice(0, 12)}.png`);
  const result = spawnSync(config.allowedBrowser, [
    "--headless", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
    `--window-size=${request.width},${request.height}`,
    "--virtual-time-budget=6000",
    `--screenshot=${outPath}`,
    `http://127.0.0.1:${record.port}${request.route}`,
  ], { timeout: 45_000, encoding: "buffer" });
  if (result.status !== 0 || !existsSync(outPath)) return fail(`capture_failed: ${String(result.stderr ?? "").slice(0, 300) || "no output file"}`);
  const bytes = readFileSync(outPath);
  if (bytes.length === 0 || bytes.length > 8_000_000) return fail("screenshot_size_invalid");
  return { ok: true, pngBase64: bytes.toString("base64"), byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function handleStopPreview(journal: Journal, root: string, request: Extract<Request, { op: "stop_preview" }>): Response {
  assertId(request.jobId, "jobId");
  const recordPath = join(root, request.jobId, ".preview.json");
  const record = readPreviewRecord(recordPath);
  if (record === undefined) return { ok: true, status: "absent" };
  const cancelled = handleCancel(journal, { op: "cancel_process", jobId: request.jobId, operationId: record.operationId });
  if (!cancelled.ok) return cancelled;
  journal.setStatus(record.operationId, "succeeded", 0);
  try {
    rmSync(recordPath, { force: true });
  } catch { /* the record is disposable */ }
  return { ok: true, status: "stopped" };
}

function runSupervisor(argv: string[]): void {
  // --supervise <journalDir> <worktree> <operationId> <timeoutMs> <command...>
  const [journalDir, worktree, operationId, timeoutRaw, ...command] = argv;
  if (journalDir === undefined || worktree === undefined || operationId === undefined || timeoutRaw === undefined || command.length === 0) {
    process.exitCode = 2;
    return;
  }
  const dir = resolve(journalDir);
  mkdirSync(join(dir, "pids"), { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, "out"), { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, "exit"), { recursive: true, mode: 0o700 });
  // First act of the supervisor: publish its own pid so a runner that died after spawn is still reconcilable.
  writeFileSync(join(dir, "pids", operationId), String(process.pid), { mode: 0o600 });
  const outPath = join(dir, "out", operationId);
  const outFd = openSync(outPath, "a", 0o600);
  const child = spawn(command[0]!, command.slice(1), { cwd: worktree, stdio: ["ignore", outFd, outFd] });
  const timeout = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch { /* already gone */ }
  }, Number(timeoutRaw) || DEFAULT_TIMEOUT_MS);
  timeout.unref();
  // A cancellation reaches the supervisor first. It forwards the signal and still records the outcome,
  // so a stopped job leaves a definite record rather than a gap.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      try {
        child.kill(signal);
      } catch { /* already gone */ }
    });
  }
  child.on("exit", (code, signal) => {
    closeSync(outFd);
    const exitCode = signal !== null ? 128 : code ?? 127;
    writeFileSync(join(dir, "exit", operationId), String(exitCode), { mode: 0o600 });
    process.exitCode = exitCode === 0 ? 0 : 1;
  });
  child.on("error", () => {
    closeSync(outFd);
    writeFileSync(join(dir, "exit", operationId), "127", { mode: 0o600 });
    process.exitCode = 1;
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--supervise") {
    runSupervisor(argv.slice(1));
    return;
  }
  const rootIndex = argv.indexOf("--root");
  if (rootIndex < 0 || argv[rootIndex + 1] === undefined) {
    process.stdout.write(`${JSON.stringify(fail("root_required"))}\n`);
    process.exitCode = 2;
    return;
  }
  const root = resolve(argv[rootIndex + 1]!);
  if (!resolve(root).startsWith("/") || !existsSync(root)) {
    process.stdout.write(`${JSON.stringify(fail("root_invalid"))}\n`);
    process.exitCode = 2;
    return;
  }
  const journal = new Journal(join(root, ".journal"));
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += (chunk as Buffer).length;
    // A runner request is a small typed record; anything enormous is refused rather than buffered.
    if (size > 1_048_576) {
      process.stdout.write(`${JSON.stringify(fail("request_too_large"))}\n`);
      process.exitCode = 2;
      journal.close();
      return;
    }
    chunks.push(chunk as Buffer);
  }
  let request: Request;
  try {
    request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Request;
  } catch {
    process.stdout.write(`${JSON.stringify(fail("invalid_request"))}\n`);
    process.exitCode = 2;
    return;
  }
  let response: Response;
  try {
    switch (request.op) {
      case "health":
        response = { ok: true, runnerId: randomUUID().slice(0, 8) };
        break;
      case "prepare_job":
        response = handlePrepare(journal, root, request);
        break;
      case "run_check":
        response = handleRunCheck(journal, root, request);
        break;
      case "apply_change":
        response = handleApplyChange(journal, root, request);
        break;
      case "get_process_status":
        response = handleStatus(journal, request);
        break;
      case "cancel_process":
        response = handleCancel(journal, request);
        break;
      case "reconcile":
        response = handleReconcile(journal, root, request);
        break;
      case "inspect_job":
        response = handleInspect(journal, root, request);
        break;
      case "verify_head":
        response = handleVerifyHead(root, request);
        break;
      case "reconcile_apply":
        response = handleReconcileApply(journal, root, request);
        break;
      case "read_source":
        response = handleReadSource(root, request);
        break;
      case "export_commit":
        response = handleExportCommit(root, request);
        break;
      case "start_preview":
        response = handleStartPreview(journal, root, request);
        break;
      case "preview_status":
        response = handlePreviewStatus(journal, root, request);
        break;
      case "capture_screenshot":
        response = handleCaptureScreenshot(journal, root, request);
        break;
      case "stop_preview":
        response = handleStopPreview(journal, root, request);
        break;
      case "cleanup_job":
        response = handleCleanup(journal, root, request);
        break;
      default:
        response = fail("unknown_op");
    }
  } catch (error) {
    response = fail(error instanceof Error ? error.message.slice(0, 200) : "runner_error");
  }
  journal.close();
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

void main().catch(() => {
  process.stdout.write(`${JSON.stringify(fail("runner_crash"))}\n`);
  process.exitCode = 1;
});
