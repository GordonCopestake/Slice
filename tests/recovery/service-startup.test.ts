import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connect } from "node:net";
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
  delete env.SLICE_OWNER_PASSWORD;
  delete env.SLICE_REQUIREMENTS_PROVIDER;
  delete env.SLICE_REQUIREMENTS_MODEL_ID;
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
      assert.deepEqual(await response.json(), { service: "slice", status: "ready", auth: "not_configured" });
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

test("service refuses an empty, symlinked, or non-private state directory", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "slice-service-guard-"));
  const script = fileURLToPath(new URL("../../apps/server/src/main.js", import.meta.url));

  const runUntilExit = async (env: NodeJS.ProcessEnv): Promise<number | null> => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, SLICE_PORT: String(await unusedPort()), ...env },
      stdio: "ignore",
    });
    return new Promise<number | null>((resolveExit, rejectExit) => {
      const timer = setTimeout(() => rejectExit(new Error("Service did not exit as expected")), 5_000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolveExit(code);
      });
    });
  };

  try {
    // An empty value must not resolve to the working directory.
    assert.equal(await runUntilExit({ SLICE_STATE_DIR: "" }), 1);
    assert.equal(await runUntilExit({ SLICE_STATE_DIR: "   " }), 1);

    // A symlinked state directory would redirect the whole store into a directory the owner of the link controls.
    const target = await mkdtemp(join(tmpdir(), "slice-service-target-"));
    await chmod(target, 0o700);
    const link = join(directory, "linked");
    await symlink(target, link);
    assert.equal(await runUntilExit({ SLICE_STATE_DIR: link }), 1);
    assert.equal((await readdir(target)).length, 0, "a refused symlinked directory must not receive state");
    await rm(target, { recursive: true, force: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("state files are created private to their owner", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "slice-service-mode-"));
  const script = fileURLToPath(new URL("../../apps/server/src/main.js", import.meta.url));
  const port = await unusedPort();
  const child = startService(script, directory, port);
  try {
    await waitForHealth(port, child);
    for (const name of ["state.sqlite", "owner.sqlite"]) {
      const mode = (await stat(join(directory, name))).mode & 0o777;
      assert.equal(mode & 0o077, 0, `${name} must not be readable by group or other (saw ${mode.toString(8)})`);
    }
  } finally {
    await stopService(child);
    await rm(directory, { recursive: true, force: true });
  }
});

/** `fetch` refuses to set Host, so the header is written on a raw socket. */
function rawStatus(port: number, host: string): Promise<number> {
  return new Promise<number>((resolveStatus, rejectStatus) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`GET /healthz HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      received += chunk;
    });
    socket.on("end", () => resolveStatus(Number(/^HTTP\/1\.1 (\d{3})/.exec(received)?.[1] ?? 0)));
    socket.on("error", rejectStatus);
  });
}

test("the listener refuses an unknown Host header", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "slice-service-host-"));
  const script = fileURLToPath(new URL("../../apps/server/src/main.js", import.meta.url));
  const port = await unusedPort();
  const child = startService(script, directory, port);
  try {
    await waitForHealth(port, child);
    assert.equal(await rawStatus(port, "evil.example"), 421, "a rebound DNS name must not reach the listener");
    assert.equal(await rawStatus(port, `127.0.0.1:${port}`), 200);
    assert.equal(await rawStatus(port, `localhost:${port}`), 200);
  } finally {
    await stopService(child);
    await rm(directory, { recursive: true, force: true });
  }
});

test("service health works and the state lock releases after restart", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "slice-service-"));
  const script = fileURLToPath(new URL("../../apps/server/src/main.js", import.meta.url));
  let first: ReturnType<typeof spawn> | undefined;
  let restarted: ReturnType<typeof spawn> | undefined;
  try {
    await chmod(directory, 0o755);
    const rejected = startService(script, directory, await unusedPort());
    const [rejectedCode] = await new Promise<[number | null, NodeJS.Signals | null]>((resolveExit, rejectExit) => {
      const timer = setTimeout(() => rejectExit(new Error("Service did not reject a non-private state directory")), 5_000);
      rejected.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolveExit([code, signal]);
      });
    });
    assert.equal(rejectedCode, 1);
    assert.equal((await stat(directory)).mode & 0o777, 0o755, "unsafe directory permissions are not changed");

    await chmod(directory, 0o700);
    const firstPort = await unusedPort();
    const secondPort = await unusedPort();
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
