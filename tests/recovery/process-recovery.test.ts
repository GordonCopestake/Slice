import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

async function waitForFile(path: string, child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Worker exited before writing its recovery marker (code ${child.exitCode}, signal ${child.signalCode})`);
    }
    try {
      await readFile(path);
      return;
    } catch {
      await delay(20);
    }
  }
  throw new Error(`Timed out waiting for worker marker ${path}`);
}

function spawnWorker(script: string, args: string[]) {
  return spawn(process.execPath, [script, ...args], { stdio: "ignore" });
}

test("SIGKILL during a replay-safe tool resumes without duplicating its effect", { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "slice-replay-"));
  const statePath = join(directory, "state.sqlite");
  const durablePath = statePath;
  const remotePath = join(directory, "remote.sqlite");
  const threadPath = join(directory, "thread-id");
  const gatePath = join(directory, "tool-entered");
  const resultPath = join(directory, "result");
  const script = fileURLToPath(new URL("./fixtures/replay-worker.js", import.meta.url));
  const common = [durablePath, statePath, remotePath, threadPath, gatePath, resultPath];
  try {
    const first = spawnWorker(script, ["start", ...common]);
    await waitForFile(gatePath, first);
    first.kill("SIGKILL");
    const [exitCode, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolveExit) => {
      first.once("exit", (code, exitSignal) => resolveExit([code, exitSignal]));
    });
    assert.equal(exitCode, null);
    assert.equal(signal, "SIGKILL");

    const resumed = spawnWorker(script, ["resume", ...common]);
    const [resumedCode, resumedSignal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolveExit, rejectExit) => {
      const stderr: Buffer[] = [];
      resumed.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      resumed.once("error", rejectExit);
      resumed.once("exit", (code, exitSignal) => {
        if (code !== 0) rejectExit(new Error(Buffer.concat(stderr).toString("utf8") || `Worker exit: ${exitSignal ?? code}`));
        else resolveExit([code, exitSignal]);
      });
    });
    assert.equal(resumedCode, 0);
    assert.equal(resumedSignal, null);
    assert.equal(await readFile(resultPath, "utf8"), "done");

    const { DatabaseSync } = await import("node:sqlite");
    const remote = new DatabaseSync(remotePath);
    const effects = remote.prepare("SELECT COUNT(*) AS count FROM marker_effects").get() as { count: number };
    const attempts = remote.prepare("SELECT COUNT(*) AS count FROM marker_attempts").get() as { count: number };
    remote.close();
    assert.equal(effects.count, 1, "the idempotent remote effect occurs once");
    assert.equal(attempts.count, 2, "Pi Durable replays the interrupted safe tool call");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SIGKILL after an external effect is reconciled without a second dispatch", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "slice-operation-"));
  const statePath = join(directory, "application.sqlite");
  const remotePath = join(directory, "remote.sqlite");
  const gatePath = join(directory, "operation-entered");
  const resultPath = join(directory, "result");
  const script = fileURLToPath(new URL("./fixtures/operation-worker.js", import.meta.url));
  const common = [statePath, remotePath, gatePath, resultPath];
  try {
    const first = spawnWorker(script, ["start", ...common]);
    await waitForFile(gatePath, first);
    first.kill("SIGKILL");
    const [exitCode, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolveExit) => {
      first.once("exit", (code, exitSignal) => resolveExit([code, exitSignal]));
    });
    assert.equal(exitCode, null);
    assert.equal(signal, "SIGKILL");

    const resumed = spawnWorker(script, ["resume", ...common]);
    const [resumedCode] = await new Promise<[number | null, NodeJS.Signals | null]>((resolveExit, rejectExit) => {
      const stderr: Buffer[] = [];
      resumed.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      resumed.once("error", rejectExit);
      resumed.once("exit", (code, exitSignal) => {
        if (code !== 0) rejectExit(new Error(Buffer.concat(stderr).toString("utf8") || `Worker exit: ${exitSignal ?? code}`));
        else resolveExit([code, exitSignal]);
      });
    });
    assert.equal(resumedCode, 0);
    assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), { receipt: "receipt:external:test-1" });

    const { DatabaseSync } = await import("node:sqlite");
    const remote = new DatabaseSync(remotePath);
    const effects = remote.prepare("SELECT COUNT(*) AS count FROM external_effects").get() as { count: number };
    remote.close();
    assert.equal(effects.count, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
