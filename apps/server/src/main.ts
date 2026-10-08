import { createServer } from "node:http";
import { lstatSync, mkdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { createRegistry } from "@earendil-works/pi-durable";
import { SliceApi } from "./api/http-api.js";
import { OwnerAuth } from "./auth/owner-auth.js";
import { createConfiguredModels } from "./adapters/models/configured-models.js";
import { PiDurableAdapter } from "./adapters/pi-durable/pi-durable-adapter.js";
import { GithubClient } from "./adapters/github/git-host.js";
import { GitBundlePublisher } from "./adapters/git/branch-publisher.js";
import { RunnerAdapter } from "./adapters/ssh-runner/runner-adapter.js";
import { LocalRunnerTransport, SshRunnerTransport } from "./adapters/ssh-runner/runner-transport.js";
import { WorkflowStore } from "./records/workflow-store.js";
import { DeliveryStore } from "./records/delivery-store.js";
import { ReleaseStore } from "./records/release-store.js";
import { StatusStore } from "./records/status-store.js";
import { NotificationStore } from "./records/notification-store.js";
import { NotificationService } from "./workflow/notifications.js";
import { TelegramClient } from "./adapters/telegram/telegram.js";
import { ApplicationStateStore } from "./state/application-state.js";
import { FileCredentialStore } from "./state/credential-store.js";
import { SingleOwnerLock } from "./state/single-owner-lock.js";
import { ExternalOperationJournal } from "./workflow/external-operation-journal.js";
import { DeliveryLoop } from "./workflow/delivery.js";
import { ReleaseService } from "./workflow/releases.js";
import { JobCoordinator, type ModelProfile } from "./workflow/coordinator.js";
import { StatusReports } from "./workflow/status-reports.js";
import { roleProfiles } from "./workflow/role-config.js";
import { modelPolicy } from "./workflow/model-policy.js";

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

/**
 * Phase 2 delivery wiring. It needs a runner, the three distinct role profiles, and a GitHub token.
 * Without any of them the job stops after its workspace with a stated reason instead of pretending
 * delivery started.
 */
function buildDelivery(
  adapter: PiDurableAdapter,
  workflows: WorkflowStore,
  state: ApplicationStateStore,
  stateDirectory: string,
  runner: RunnerAdapter | null,
): DeliveryLoop | null {
  const profiles = roleProfiles(process.env);
  const token = process.env.SLICE_GITHUB_TOKEN;
  if (profiles === null || runner === null || token === undefined) return null;
  return new DeliveryLoop({
    adapter,
    workflows,
    delivery: DeliveryStore.open(state.database),
    runner,
    gitHost: new GithubClient({ token }),
    publisher: new GitBundlePublisher(stateDirectory),
    journal: new ExternalOperationJournal(state.database),
    releases: ReleaseStore.open(state.database),
    profiles,
    policy: modelPolicy(process.env),
    artifactsDir: join(stateDirectory, "artifacts"),
  });
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
  let mergePoller: NodeJS.Timeout | undefined;
  let cleanupTimer: NodeJS.Timeout | undefined;
  let reportTimer: NodeJS.Timeout | undefined;
  let notifyTimer: NodeJS.Timeout | undefined;

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
    const runner = buildRunner(workflows, state, stateDirectory);
    const delivery = buildDelivery(adapter, workflows, state, stateDirectory, runner);
    const coordinator = new JobCoordinator(adapter, workflows, requirementsProfile(process.env), runner, delivery, modelPolicy(process.env));
    const statusStore = StatusStore.open(state.database);
    const notificationStore = NotificationStore.open(state.database);
    const telegramToken = process.env.SLICE_TELEGRAM_BOT_TOKEN;
    const telegramClient = telegramToken !== undefined && telegramToken.trim().length > 0 ? new TelegramClient({ token: telegramToken }) : null;
    const notifications = new NotificationService({ workflows, notifications: notificationStore, status: statusStore, telegram: telegramClient });
    const statusReports = new StatusReports({ workflows, deliveryStore: DeliveryStore.open(state.database), status: statusStore, notify: (jobId, kind, dueAt) => notifications.enqueueReport(jobId, dueAt) });
    const releases = runner === null ? null : new ReleaseService({
      workflows,
      releases: ReleaseStore.open(state.database),
      delivery: DeliveryStore.open(state.database),
      runner,
      artifactsDir: join(stateDirectory, "artifacts"),
    });
    const api = new SliceApi({ auth, workflows, coordinator, webDirectory: resolve(process.env.SLICE_WEB_DIR ?? "apps/web/public"), deliveryStore: DeliveryStore.open(state.database), delivery, status: statusReports, notifications, releases });
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
    process.stdout.write(`Slice service listening on 127.0.0.1:${port}\n`);

    // Restart recovery: resume delivery where the recorded stage left off, and re-check merges.
    if (delivery !== null) {
      const activeWorkflows = workflows!;
      void resumeDelivery(delivery, activeWorkflows).catch((error: unknown) => {
        process.stderr.write(`Delivery resume failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
      });
      mergePoller = setInterval(() => {
        void pollMerges(delivery, activeWorkflows).catch(() => { /* the next tick retries */ });
      }, 60_000);
      mergePoller.unref();
    }

    // Cleanup recovery: an archived thread whose workspace deletion failed (offline host, refused
    // deletion, uncertain operation) is retried on a schedule. Evidence is never touched by this sweep.
    if (delivery !== null) {
      cleanupTimer = setInterval(() => {
        void retryFailedCleanups(delivery, releases).catch(() => { /* the next tick retries */ });
      }, 300_000);
      cleanupTimer.unref();
    }

    // Periodic status reports: overdue ticks coalesce into one current report per job.
    reportTimer = setInterval(() => {
      try {
        statusReports.tick(Date.now());
      } catch { /* the next tick retries */ }
    }, 30_000);
    reportTimer.unref();

    // Outbox delivery, alert scan, and the Telegram linking poll. Failure here never stops work.
    if (telegramClient !== null) {
      notifyTimer = setInterval(() => {
        const now = Date.now();
        try {
          notifications.scanAlerts();
        } catch { /* the next tick retries */ }
        void notifications.deliverDue(now).catch(() => { /* the next tick retries */ });
        void notifications.pollLink().catch(() => { /* the next tick retries */ });
      }, 15_000);
      notifyTimer.unref();
    }

    await new Promise<void>((resolveStop) => {
      const stop = (): void => resolveStop();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } finally {
    if (retentionTimer !== undefined) clearInterval(retentionTimer);
    if (mergePoller !== undefined) clearInterval(mergePoller);
    if (cleanupTimer !== undefined) clearInterval(cleanupTimer);
    if (reportTimer !== undefined) clearInterval(reportTimer);
    if (notifyTimer !== undefined) clearInterval(notifyTimer);
    await shutdown(server, adapter, state, lock);
  }
}

/** Resume in-flight delivery work; durable submissions and journals make the replay safe. */
async function resumeDelivery(delivery: DeliveryLoop, workflows: WorkflowStore): Promise<void> {
  for (const record of delivery.activeDeliveries()) {
    const job = workflows.getJob(record.jobId);
    if (job === undefined) continue;
    if (record.archiveState === "archived") {
      if (record.cleanupState === "pending" || record.cleanupState === "failed") await delivery.retryCleanup(record.jobId);
      continue;
    }
    if (record.stage === "ready") {
      await delivery.observeMerge(record.jobId);
      continue;
    }
    if (job.runState === "running") await delivery.advance(record.jobId);
  }
}

/** Periodic reconciliation: check merges for ready jobs and nudge publishing jobs stuck on an outage. */
/**
 * Cleanup recovery across host outages. An archived thread whose deletion failed stays retryable:
 * the sweep re-attempts it on the host the workspace is recorded against. Evidence, the release
 * record, and the archived thread are never touched here - only the workspace.
 */
async function retryFailedCleanups(delivery: DeliveryLoop, releases: ReleaseService | null): Promise<void> {
  for (const record of delivery.unfinishedCleanups()) {
    await delivery.retryCleanup(record.jobId);
  }
  if (releases !== null) {
    for (const project of releases.stagingProjects()) {
      await releases.reclaimStaging(project);
    }
  }
}

async function pollMerges(delivery: DeliveryLoop, workflows: WorkflowStore): Promise<void> {
  for (const record of delivery.activeDeliveries()) {
    const job = workflows.getJob(record.jobId);
    if (job === undefined || job.runState === "cancelled") continue;
    if (record.stage === "ready" && record.prNumber !== null) {
      await delivery.observeMerge(record.jobId);
      continue;
    }
    if (record.stage === "publishing" && job.runState === "running") await delivery.advance(record.jobId);
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
