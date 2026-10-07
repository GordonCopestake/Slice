import { createServer } from "node:http";
import { lstatSync, mkdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { createRegistry } from "@earendil-works/pi-durable";
import { SliceApi } from "./api/http-api.js";
import { OwnerAuth } from "./auth/owner-auth.js";
import { createConfiguredModels } from "./adapters/models/configured-models.js";
import { PiDurableAdapter } from "./adapters/pi-durable/pi-durable-adapter.js";
import { RunnerAdapter } from "./adapters/ssh-runner/runner-adapter.js";
import { LocalRunnerTransport, SshRunnerTransport } from "./adapters/ssh-runner/runner-transport.js";
import { WorkflowStore } from "./records/workflow-store.js";
import { ApplicationStateStore } from "./state/application-state.js";
import { FileCredentialStore } from "./state/credential-store.js";
import { SingleOwnerLock } from "./state/single-owner-lock.js";
import { ExternalOperationJournal } from "./workflow/external-operation-journal.js";
import { JobCoordinator, type ModelProfile } from "./workflow/coordinator.js";

/** Only these Host header values are served, so a rebound DNS name cannot reach the loopback listener. */
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A shutdown must release the owner lock, so it never waits on a peer longer than this. */
const SHUTDOWN_BUDGET_MS = 5_000;

function configuredPort(value: string | undefined): number {
  const port = Number(value ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("SLICE_PORT must be between 1 and 65535");
  return port;
}

function configuredStateDirectory(): string {
  const configured = process.env.SLICE_STATE_DIR;
  // `??` would let an empty string through, and resolve("") is the working directory.
  if (configured !== undefined && configured.trim().length === 0) {
    throw new Error("SLICE_STATE_DIR must not be empty");
  }
  const directory = resolve(configured ?? ".slice");
  // A symlink would let anyone who can write the parent redirect the whole store into a directory they own.
  if (lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error("SLICE_STATE_DIR must not be a symbolic link");
  }
  return directory;
}

function assertPrivateStateDirectory(directory: string): void {
  if (process.platform === "win32") {
    throw new Error("SLICE_STATE_DIR privacy cannot be verified on Windows; use a Linux or macOS host");
  }
  if ((statSync(directory).mode & 0o077) !== 0) {
    throw new Error("SLICE_STATE_DIR must be private to its owner (mode 0700)");
  }
}

function requirementsProfile(environment: NodeJS.ProcessEnv): ModelProfile | null {
  const provider = environment.SLICE_REQUIREMENTS_PROVIDER;
  const modelId = environment.SLICE_REQUIREMENTS_MODEL_ID;
  if ((provider === undefined) !== (modelId === undefined)) {
    throw new Error("Set both SLICE_REQUIREMENTS_PROVIDER and SLICE_REQUIREMENTS_MODEL_ID, or neither");
  }
  if (provider === undefined || modelId === undefined) return null;
  return { provider, modelId };
}

/**
 * Runner wiring. `SLICE_RUNNER_MODE=local` runs the bundled runner on this host (single-machine
 * demo); `ssh` invokes it through pinned-host-key SSH. No mode means no runner: jobs settle their
 * requirements and then block with a stated reason rather than pretending work started.
 */
function buildRunner(workflows: WorkflowStore, state: ApplicationStateStore, stateDirectory: string): RunnerAdapter | null {
  const mode = process.env.SLICE_RUNNER_MODE;
  const journal = new ExternalOperationJournal(state.database);
  if (mode === undefined) return null;
  if (mode === "local") {
    const root = process.env.SLICE_RUNNER_ROOT;
    if (root === undefined || root.trim().length === 0) throw new Error("SLICE_RUNNER_MODE=local requires SLICE_RUNNER_ROOT");
    const entry = resolve(process.env.SLICE_RUNNER_ENTRY ?? "dist/runner/main.js");
    return new RunnerAdapter(journal, () => new LocalRunnerTransport(entry, resolve(root)));
  }
  if (mode === "ssh") {
    const remoteEntry = process.env.SLICE_RUNNER_ENTRY ?? "/usr/local/slice/runner/main.js";
    return new RunnerAdapter(journal, (hostId) => {
      const host = workflows.getHost(hostId);
      if (host === undefined) throw new Error(`Host ${hostId} is not registered`);
      return new SshRunnerTransport({
        address: host.address,
        sshUser: host.sshUser,
        runnerRoot: host.runnerRoot,
        remoteEntryPath: remoteEntry,
        knownHostsFile: join(stateDirectory, "known_hosts", hostId),
        ...(process.env.SLICE_SSH_IDENTITY_FILE === undefined ? {} : { identityFilePath: process.env.SLICE_SSH_IDENTITY_FILE }),
      });
    });
  }
  throw new Error("SLICE_RUNNER_MODE must be local or ssh");
}

export async function startSlice(): Promise<void> {
  // Tighten every file this process creates, including the SQLite database and its write-ahead log.
  process.umask(0o077);
  const stateDirectory = configuredStateDirectory();
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  assertPrivateStateDirectory(stateDirectory);
  const lock = SingleOwnerLock.acquire(join(stateDirectory, "owner.sqlite"));
  let state: ApplicationStateStore | undefined;
  let adapter: PiDurableAdapter | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let workflows: WorkflowStore | undefined;
  let retentionTimer: NodeJS.Timeout | undefined;

  try {
    const databasePath = join(stateDirectory, "state.sqlite");
    state = ApplicationStateStore.open(databasePath);
    workflows = WorkflowStore.open(state.database);
    adapter = await PiDurableAdapter.open({
      durableDatabasePath: databasePath,
      state,
      models: createConfiguredModels(process.env, { credentials: new FileCredentialStore(stateDirectory) }),
      registry: createRegistry(),
    });
    const auth = new OwnerAuth(workflows, process.env);
    const coordinator = new JobCoordinator(adapter, workflows, requirementsProfile(process.env), buildRunner(workflows, state, stateDirectory));
    const api = new SliceApi({ auth, workflows, coordinator, webDirectory: resolve(process.env.SLICE_WEB_DIR ?? "apps/web/public") });
    // F7 carry-over: terminal request-index and operation rows are pruned on a schedule.
    workflows.pruneExpired();
    retentionTimer = setInterval(() => workflows?.pruneExpired(), 3_600_000);
    retentionTimer.unref();
    server = createServer((request, response) => {
      const host = request.headers.host?.replace(/:\d+$/, "") ?? "";
      if (!ALLOWED_HOSTS.has(host)) {
        response.writeHead(421, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: "unknown_host" }));
        return;
      }
      const pathname = (request.url ?? "/").split("?")[0] ?? "/";
      if (request.method === "GET" && pathname === "/healthz") {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ service: "slice", status: "ready", auth: auth.enabled ? "configured" : "not_configured" }));
        return;
      }
      void api.handle(request, response);
    });
    const port = configuredPort(process.env.SLICE_PORT);
    await new Promise<void>((resolveListen, rejectListen) => {
      server!.once("error", rejectListen);
      server!.listen(port, "127.0.0.1", () => resolveListen());
    });
    // Past this point a later server error must not disappear into a listener that already settled.
    server.removeAllListeners("error");
    server.on("error", (error: Error) => {
      process.stderr.write(`Slice server error: ${error.message}\n`);
    });
    process.stdout.write(`Slice Phase 1 service listening on 127.0.0.1:${port}\n`);

    await new Promise<void>((resolveStop) => {
      const stop = (): void => resolveStop();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } finally {
    if (retentionTimer !== undefined) clearInterval(retentionTimer);
    await shutdown(server, adapter, state, lock);
  }
}

/** Release the listener, then the adapter, state, and owner lock. The lock is never held by a waiting peer. */
async function shutdown(
  server: ReturnType<typeof createServer> | undefined,
  adapter: PiDurableAdapter | undefined,
  state: ApplicationStateStore | undefined,
  lock: SingleOwnerLock,
): Promise<void> {
  if (server?.listening) {
    // A trickled request must not hold the owner lock open past the budget.
    server.closeAllConnections();
    await Promise.race([
      new Promise<void>((resolveClose) => server!.close(() => resolveClose())),
      new Promise<void>((resolveBudget) => setTimeout(resolveBudget, SHUTDOWN_BUDGET_MS).unref()),
    ]);
  }
  try {
    await adapter?.close();
    state?.close();
  } finally {
    lock.release();
  }
}

void startSlice().catch((error: unknown) => {
  process.stderr.write(`Slice failed to start: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
