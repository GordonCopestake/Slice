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
import { randomUUID } from "node:crypto";
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
const DEFAULT_TIMEOUT_MS = 600_000;

type Request =
  | { op: "health" }
  | { op: "prepare_job"; jobId: string; source: string; branch: string; leaseGeneration: number }
  | { op: "run_check"; jobId: string; operationId: string; leaseGeneration: number; checkId: string; command: string; timeoutMs?: number }
  | { op: "get_process_status"; jobId: string; operationId: string }
  | { op: "cancel_process"; jobId: string; operationId: string }
  | { op: "reconcile"; jobId: string }
  | { op: "inspect_job"; jobId: string }
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

function readConfig(root: string): { allowedSources: string[] } {
  try {
    const parsed = JSON.parse(readFileSync(join(root, ".runner.json"), "utf8")) as { allowedSources?: unknown };
    if (!Array.isArray(parsed.allowedSources) || parsed.allowedSources.some((s) => typeof s !== "string" || s.length === 0)) {
      throw new Error("missing allowedSources");
    }
    return { allowedSources: parsed.allowedSources as string[] };
  } catch {
    // With no explicit allowlist the runner accepts nothing; registration is deliberate.
    return { allowedSources: [] };
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

function handleReconcile(journal: Journal, request: Extract<Request, { op: "reconcile" }>): Response {
  assertId(request.jobId, "jobId");
  // Reconciliation re-resolves uncertain rows too: an exit file that appears later settles them.
  const results = journal.runningFor(request.jobId).map((row) => {
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
      case "get_process_status":
        response = handleStatus(journal, request);
        break;
      case "cancel_process":
        response = handleCancel(journal, request);
        break;
      case "reconcile":
        response = handleReconcile(journal, request);
        break;
      case "inspect_job":
        response = handleInspect(journal, root, request);
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
