import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Could not select a test port");
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}

function startService(script: string, directory: string, port: number) {
  const env: NodeJS.ProcessEnv = { ...process.env, SLICE_STATE_DIR: directory, SLICE_PORT: String(port) };
  delete env.SLICE_LOCAL_BASE_URL;
  delete env.SLICE_LOCAL_MODEL_ID;
  delete env.SLICE_OPENAI_MODEL_ID;
  return spawn(process.execPath, [script], { env, stdio: "ignore" });
}

async function waitForHealth(port: number, child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Slice exited before health check (code ${child.exitCode}, signal ${child.signalCode})`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { service: "slice", status: "ready" });
      return;
    } catch {
      await delay(25);
    }
  }
  throw new Error("Slice did not become healthy in time");
}

async function stopService(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolveExit) => {
    child.once("exit", (exitCode, exitSignal) => resolveExit([exitCode, exitSignal]));
  });
  assert.equal(code, 0);
  assert.equal(signal, null);
}

test("service health works and the state lock releases after restart", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "slice-service-"));
  const firstPort = await unusedPort();
  const secondPort = await unusedPort();
  const script = fileURLToPath(new URL("../../apps/server/src/main.js", import.meta.url));
  let first: ReturnType<typeof spawn> | undefined;
  let restarted: ReturnType<typeof spawn> | undefined;
  try {
    first = startService(script, directory, firstPort);
    await waitForHealth(firstPort, first);
    const contender = startService(script, directory, secondPort);
    const [contenderCode] = await new Promise<[number | null, NodeJS.Signals | null]>((resolveExit, rejectExit) => {
      const timer = setTimeout(() => rejectExit(new Error("Second service did not fail fast")), 5_000);
      contender.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolveExit([code, signal]);
      });
    });
    assert.equal(contenderCode, 1);

    await stopService(first);
    first = undefined;
    restarted = startService(script, directory, secondPort);
    await waitForHealth(secondPort, restarted);
    await stopService(restarted);
    restarted = undefined;
  } finally {
    if (first !== undefined) await stopService(first);
    if (restarted !== undefined) await stopService(restarted);
    await rm(directory, { recursive: true, force: true });
  }
});
