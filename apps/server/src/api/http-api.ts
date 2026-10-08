import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { OwnerAuth } from "../auth/owner-auth.js";
import { hashJson, IdempotencyConflictError, type JsonValue } from "../state/application-state.js";
import type { IssueSnapshot, WorkflowStore } from "../records/workflow-store.js";
import type { DeliveryStore } from "../records/delivery-store.js";
import { verificationKey } from "../records/delivery-store.js";
import { JobCoordinator, JobStateConflictError } from "../workflow/coordinator.js";
import { POLICY_VERSION, type DeliveryLoop } from "../workflow/delivery.js";
import type { StatusReports } from "../workflow/status-reports.js";
import type { NotificationService } from "../workflow/notifications.js";
import { listGithubIssues } from "../adapters/github/github-issues.js";

export type ApiDependencies = {
  auth: OwnerAuth;
  workflows: WorkflowStore;
  coordinator: JobCoordinator;
  webDirectory: string;
  deliveryStore?: DeliveryStore;
  delivery?: DeliveryLoop | null;
  status?: StatusReports | null;
  notifications?: NotificationService | null;
};

const MAX_BODY_BYTES = 1_048_576;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

async function readBody(request: IncomingMessage): Promise<JsonValue> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new RangeError("Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text) as JsonValue;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function asObject(value: JsonValue): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected a JSON object");
  return value as Record<string, JsonValue>;
}

function requiredString(body: Record<string, JsonValue>, name: string, maxLength = 20_000): string {
  const value = body[name];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new TypeError(`${name} must be a string of 1-${maxLength} characters`);
  }
  return value;
}

function requiredId(body: Record<string, JsonValue>, name: string): string {
  const value = requiredString(body, name, 128);
  if (!ID_PATTERN.test(value)) throw new TypeError(`${name} must be 1-128 letters, numbers, dots, underscores, colons, or hyphens`);
  return value;
}

/** A failed login counter per process; it slows guessing but is not a substitute for rate limiting at the proxy. */
class LoginGuard {
  #failures = 0;
  #blockedUntil = 0;

  get blocked(): boolean {
    return Date.now() < this.#blockedUntil;
  }

  recordFailure(): void {
    this.#failures += 1;
    if (this.#failures >= 5) {
      this.#blockedUntil = Date.now() + 30_000;
      this.#failures = 0;
    }
  }

  reset(): void {
    this.#failures = 0;
    this.#blockedUntil = 0;
  }
}

class GithubReadError extends Error {}

const WEB_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
};

export class SliceApi {
  readonly #deps: ApiDependencies;
  readonly #loginGuard = new LoginGuard();

  constructor(deps: ApiDependencies) {
    this.#deps = deps;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const method = request.method ?? "GET";
    try {
      if (method === "GET" && Object.hasOwn(WEB_FILES, url.pathname)) {
        this.#serveWeb(response, url.pathname);
        return;
      }
      if (!url.pathname.startsWith("/api/")) {
        json(response, 404, { error: "not_found" });
        return;
      }
      await this.#handleApi(request, response, method, url);
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error instanceof IdempotencyConflictError) {
        json(response, 409, { error: "idempotency_conflict", message: "This request ID was already used with different input" });
        return;
      }
      if (error instanceof GithubReadError) {
        json(response, 502, { error: "github_read_failed", message: error.message });
        return;
      }
      if (error instanceof JobStateConflictError) {
        json(response, 409, { error: "job_state_conflict", message: error.message });
        return;
      }
      const status = error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError ? 400 : 500;
      const message = error instanceof Error ? error.message : "internal error";
      // Never echo request bodies or secrets; type errors carry field names, not values.
      json(response, status, { error: status === 500 ? "internal_error" : "invalid_request", message: status === 500 ? "" : message });
    }
  }

  #serveWeb(response: ServerResponse, pathname: string): void {
    const entry = Object.hasOwn(WEB_FILES, pathname) ? WEB_FILES[pathname] : undefined;
    if (entry === undefined) {
      // A name that exists only on Object's prototype is not a route.
      json(response, 404, { error: "not_found" });
      return;
    }
    try {
      const body = readFileSync(join(this.#deps.webDirectory, entry.file));
      response.writeHead(200, { "content-type": entry.type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
      response.end(body);
    } catch {
      json(response, 404, { error: "web_asset_missing" });
    }
  }

  /** A GitHub read failure is a gateway problem, never an internal-error mystery and never a silent empty list. */
  async #github<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      throw new GithubReadError(error instanceof Error ? error.message.slice(0, 120) : "unknown");
    }
  }

  async #handleApi(request: IncomingMessage, response: ServerResponse, method: string, url: URL): Promise<void> {
    const path = url.pathname;

    if (method === "POST" && path === "/api/session") {
      if (!this.#deps.auth.enabled) {
        json(response, 503, { error: "auth_not_configured", message: "set SLICE_OWNER_PASSWORD to enable the owner API" });
        return;
      }
      if (this.#loginGuard.blocked) {
        json(response, 429, { error: "too_many_attempts" });
        return;
      }
      const body = asObject(await readBody(request));
      const password = typeof body.password === "string" ? body.password : "";
      const session = this.#deps.auth.login(password);
      if (session === null) {
        this.#loginGuard.recordFailure();
        json(response, 401, { error: "invalid_credentials" });
        return;
      }
      this.#loginGuard.reset();
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "set-cookie": this.#deps.auth.sessionCookie(session),
      });
      response.end(JSON.stringify({ authenticated: true, csrfToken: session.csrfToken }));
      return;
    }

    // Everything below the session route is owner-only.
    const authed = this.#deps.auth.readSession(request);
    if (authed === null) {
      json(response, 401, { error: "authentication_required" });
      return;
    }
    if (method !== "GET" && !this.#deps.auth.verifyCsrf(authed.csrfHash, header(request, "x-csrf-token"))) {
      json(response, 403, { error: "csrf_token_missing" });
      return;
    }

    if (method === "POST" && path === "/api/session/end") {
      this.#deps.auth.endSession(authed.session.token);
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "set-cookie": this.#deps.auth.clearSessionCookie() });
      response.end(JSON.stringify({ authenticated: false }));
      return;
    }
    if (method === "GET" && path === "/api/session") {
      json(response, 200, { authenticated: true });
      return;
    }

    if (path === "/api/telegram" || path.startsWith("/api/telegram/")) {
      if (this.#deps.notifications === undefined || this.#deps.notifications === null) {
        json(response, 404, { error: "notifications_not_configured" });
        return;
      }
      const rest = path.slice("/api/telegram".length);
      if (method === "GET" && rest === "") {
        json(response, 200, { telegram: this.#deps.notifications.telegramStatus() });
        return;
      }
      if (method === "POST" && rest === "/link-code") {
        const code = this.#deps.notifications.startLinkCode();
        json(response, 200, { code, instructions: `Send "/link ${code}" to your Slice bot. The code works once and expires in 15 minutes.` });
        return;
      }
      if (method === "POST" && rest === "/unlink") {
        this.#deps.notifications.unlinkTelegram();
        json(response, 200, { telegram: this.#deps.notifications.telegramStatus() });
        return;
      }
      if (method === "POST" && rest === "/periodic") {
        const body = asObject(await readBody(request));
        if (typeof body.enabled !== "boolean") throw new TypeError("enabled must be a boolean");
        this.#deps.notifications.setPeriodicReports(body.enabled);
        json(response, 200, { telegram: this.#deps.notifications.telegramStatus() });
        return;
      }
      json(response, 404, { error: "not_found" });
      return;
    }

    if (method === "GET" && path === "/api/hosts") {
      json(response, 200, { hosts: this.#deps.workflows.listHosts() });
      return;
    }
    if (method === "POST" && path === "/api/hosts") {
      const body = asObject(await readBody(request));
      const host = this.#deps.workflows.registerHost({
        hostId: requiredId(body, "hostId"),
        address: requiredString(body, "address", 253),
        os: body.os === "linux" || body.os === "windows" ? body.os : (() => { throw new TypeError("os must be linux or windows"); })(),
        sshUser: requiredString(body, "sshUser", 64),
        runnerRoot: requiredString(body, "runnerRoot", 200),
      });
      json(response, 201, { host });
      return;
    }

    if (method === "GET" && path === "/api/projects") {
      json(response, 200, { projects: this.#deps.workflows.listProjects(false) });
      return;
    }
    if (method === "POST" && path === "/api/projects") {
      const body = asObject(await readBody(request));
      const buildProfile = body.buildProfile;
      if (buildProfile === null || typeof buildProfile !== "object" || Array.isArray(buildProfile)) throw new TypeError("buildProfile must be an object");
      const profile = buildProfile as Record<string, JsonValue>;
      const project = this.#deps.workflows.createProject({
        projectId: requiredId(body, "projectId"),
        repoSlug: requiredString(body, "repoSlug", 202),
        defaultBranch: requiredString(body, "defaultBranch", 100),
        hostId: requiredId(body, "hostId"),
        buildProfile: {
          setup: Array.isArray(profile.setup) ? profile.setup.map((item) => { if (typeof item !== "string") throw new TypeError("setup commands must be strings"); return item; }) : [],
          checks: Array.isArray(profile.checks)
            ? profile.checks.map((item) => {
                if (item === null || typeof item !== "object" || Array.isArray(item)) throw new TypeError("checks entries must be objects");
                const check = item as Record<string, unknown>;
                return { id: String(check.id ?? ""), command: String(check.command ?? "") };
              })
            : [],
        },
        ...(typeof body.gitRemoteUrl === "string" ? { gitRemoteUrl: body.gitRemoteUrl } : {}),
      });
      json(response, 201, { project });
      return;
    }

    const projectStatus = /^\/api\/projects\/([A-Za-z0-9._:-]{1,128})\/status$/.exec(path);
    if (method === "POST" && projectStatus !== null) {
      const body = asObject(await readBody(request));
      const status = body.status;
      if (status !== "active" && status !== "paused" && status !== "removed") throw new TypeError("status must be active, paused, or removed");
      const project = this.#deps.workflows.setProjectStatus(projectStatus[1]!, status);
      if (project === undefined) {
        json(response, 404, { error: "project_not_found" });
        return;
      }
      json(response, 200, { project });
      return;
    }

    const projectIssues = /^\/api\/projects\/([A-Za-z0-9._:-]{1,128})\/issues$/.exec(path);
    if (method === "GET" && projectIssues !== null) {
      const project = this.#deps.workflows.getProject(projectIssues[1]!);
      if (project === undefined) {
        json(response, 404, { error: "project_not_found" });
        return;
      }
      const issues = await this.#github(() => listGithubIssues(project.repoSlug));
      json(response, 200, { issues });
      return;
    }

    if (method === "GET" && path === "/api/jobs") {
      json(response, 200, { jobs: this.#deps.workflows.listJobs().map(publicJob) });
      return;
    }
    if (method === "POST" && path === "/api/jobs") {
      const body = asObject(await readBody(request));
      const requestId = requiredId(body, "requestId");
      const projectId = requiredId(body, "projectId");
      const project = this.#deps.workflows.getProject(projectId);
      if (project === undefined) {
        json(response, 404, { error: "project_not_found" });
        return;
      }
      if (project.status !== "active") {
        json(response, 409, { error: "project_not_active", message: `Project ${projectId} is ${project.status}; new work is stopped` });
        return;
      }
      const title = requiredString(body, "title", 200);
      const requestText = requiredString(body, "request", 100_000);
      // The issue link must name the project's own registered repository, not any repository.
      const issue = issueFromBody(body.issue, project.repoSlug);
      const payloadHash = hashJson({ projectId, title, request: requestText, issue: body.issue ?? null });
      const job = await this.#deps.coordinator.createJob({ requestId, payloadHash, projectId, title, requestText, issue });
      this.#deps.status?.onJobCreated(job);
      json(response, 201, { job: publicJob(job) });
      return;
    }

    if (method === "POST" && path === "/api/jobs/from-issue") {
      const body = asObject(await readBody(request));
      const requestId = requiredId(body, "requestId");
      const projectId = requiredId(body, "projectId");
      const project = this.#deps.workflows.getProject(projectId);
      if (project === undefined) {
        json(response, 404, { error: "project_not_found" });
        return;
      }
      const issueNumber = body.issueNumber;
      if (typeof issueNumber !== "number" || !Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new TypeError("issueNumber must be a positive integer");
      const existing = this.#deps.workflows.findJobForIssue(project.repoSlug, issueNumber);
      if (existing !== undefined && body.allowNewLinkedJob !== true) {
        // The spec requires showing existing work instead of silently starting a duplicate.
        json(response, 200, { job: publicJob(existing), existing: true });
        return;
      }
      const issues = await this.#github(() => listGithubIssues(project.repoSlug));
      const selected = issues.find((issue) => issue.number === issueNumber);
      if (selected === undefined) {
        json(response, 404, { error: "issue_not_found" });
        return;
      }
      const snapshot: IssueSnapshot = {
        provider: "github",
        repoSlug: project.repoSlug,
        issueNumber: selected.number,
        issueId: selected.id,
        url: selected.url,
        title: selected.title,
        issueUpdatedAt: selected.updatedAt,
      };
      const requestText = `Start from GitHub issue #${selected.number}: ${selected.title}\n\n${selected.body}`;
      const payloadHash = hashJson({ projectId, issue: snapshot, request: requestText });
      // A GitHub title is untrusted and can outgrow the job title limit; it is trimmed, not rejected.
      const job = await this.#deps.coordinator.createJob({ requestId, payloadHash, projectId, title: selected.title.slice(0, 200) || `Issue #${selected.number}`, requestText, issue: snapshot });
      this.#deps.status?.onJobCreated(job);
      json(response, 201, { job: publicJob(job), existing: false });
      return;
    }

    const jobMatch = /^\/api\/jobs\/([A-Za-z0-9._:-]{1,128})(\/.*)?$/.exec(path);
    if (jobMatch !== null) {
      const jobId = jobMatch[1]!;
      const rest = jobMatch[2] ?? "";
      const job = this.#deps.workflows.getJob(jobId);
      if (job === undefined) {
        json(response, 404, { error: "job_not_found" });
        return;
      }
      if (method === "GET" && rest === "") {
        json(response, 200, {
          job: publicJob(job),
          questions: this.#deps.workflows.openQuestions(jobId),
          events: this.#deps.workflows.eventsAfter(jobId, Math.max(this.#deps.workflows.latestEventSeq(jobId) - 50, 0)),
          workspace: this.#deps.workflows.getWorkspace(jobId) ?? null,
        });
        return;
      }
      if (method === "GET" && rest === "/events") {
        await this.#streamEvents(request, response, jobId);
        return;
      }
      if (method === "POST" && rest === "/pause") {
        json(response, 200, { job: publicJob(this.#deps.coordinator.pause(jobId)) });
        return;
      }
      if (method === "POST" && rest === "/resume") {
        json(response, 200, { job: publicJob(this.#deps.coordinator.resume(jobId)) });
        return;
      }
      if (method === "POST" && rest === "/cancel") {
        const job = await this.#deps.coordinator.cancel(jobId);
        // A cancelled job records one final status and stops its periodic reports.
        this.#deps.status?.finalize(jobId, "the job was cancelled; no further periodic reports will be sent");
        json(response, 200, { job: publicJob(job) });
        return;
      }
      if (method === "POST" && rest === "/steer") {
        if (this.#deps.deliveryStore?.getDelivery(jobId)?.archiveState === "archived") {
          // A merged thread is history; follow-up work is a new linked job, never a reopened branch.
          json(response, 409, { error: "job_archived", message: "This thread is merged and archived; start a linked follow-up job instead." });
          return;
        }
        const body = asObject(await readBody(request));
        const requestId = requiredId(body, "requestId");
        const instruction = requiredString(body, "instruction", 20_000);
        const expected = body.expectedCommandRevision;
        if (typeof expected !== "number" || !Number.isSafeInteger(expected)) throw new TypeError("expectedCommandRevision must be an integer");
        const payloadHash = hashJson({ jobId, instruction, expectedCommandRevision: expected });
        const result = await this.#deps.coordinator.steer(jobId, requestId, payloadHash, expected, instruction);
        if (result.recorded) this.#deps.status?.onSteering(jobId);
        // A stale command revision returns the current state without applying the instruction.
        json(response, result.recorded ? 200 : 409, { job: publicJob(result.job), recorded: result.recorded });
        return;
      }
      if (method === "GET" && rest === "/notifications") {
        if (this.#deps.notifications === undefined || this.#deps.notifications === null) {
          json(response, 404, { error: "notifications_not_configured" });
          return;
        }
        json(response, 200, { notifications: this.#deps.notifications.notificationsFor(jobId) });
        return;
      }
      if (method === "GET" && rest === "/status-reports") {
        if (this.#deps.status === undefined || this.#deps.status === null) {
          json(response, 404, { error: "reports_not_configured" });
          return;
        }
        const plan = this.#deps.workflows.getJob(jobId) === undefined ? undefined : this.#deps.status.planFor(jobId);
        if (plan === undefined) {
          json(response, 404, { error: "job_not_found" });
          return;
        }
        json(response, 200, { plan, reports: this.#deps.status.reportsFor(jobId) });
        return;
      }
      if (method === "POST" && rest === "/report-settings") {
        if (this.#deps.status === undefined || this.#deps.status === null) {
          json(response, 404, { error: "reports_not_configured" });
          return;
        }
        const body = asObject(await readBody(request));
        const enabled = body.enabled;
        const intervalMinutes = body.intervalMinutes;
        if (typeof enabled !== "boolean") throw new TypeError("enabled must be a boolean");
        if (typeof intervalMinutes !== "number" || !Number.isSafeInteger(intervalMinutes)) throw new TypeError("intervalMinutes must be an integer");
        if (intervalMinutes < 1 || intervalMinutes > 60) {
          // Rejected without changing the saved interval, per the verification table.
          json(response, 400, { error: "interval_out_of_range", message: "Report intervals must be between 1 and 60 minutes; the saved interval is unchanged" });
          return;
        }
        const job = this.#deps.workflows.setReportSettings(jobId, enabled, intervalMinutes);
        if (job === undefined) {
          json(response, 404, { error: "job_not_found" });
          return;
        }
        const plan = this.#deps.status.settingsChanged(jobId, enabled, intervalMinutes);
        json(response, 200, { job: publicJob(job), plan });
        return;
      }
      if (method === "POST" && rest === "/requirements/answers") {
        const body = asObject(await readBody(request));
        const questionId = requiredId(body, "questionId");
        const answer = requiredString(body, "answer", 2_000);
        const revision = body.revision;
        if (typeof revision !== "number" || !Number.isSafeInteger(revision)) throw new TypeError("revision must be an integer");
        const result = await this.#deps.coordinator.answerQuestion(jobId, questionId, revision, answer);
        json(response, result.accepted ? 200 : 409, { job: publicJob(result.job), accepted: result.accepted });
        return;
      }
      if (method === "GET" && rest === "/delivery") {
        if (this.#deps.deliveryStore === undefined) {
          json(response, 404, { error: "delivery_not_configured" });
          return;
        }
        json(response, 200, publicDelivery(this.#deps.deliveryStore, jobId));
        return;
      }
      if (method === "POST" && rest === "/accept") {
        if (this.#deps.deliveryStore === undefined) {
          json(response, 404, { error: "delivery_not_configured" });
          return;
        }
        const delivery = this.#deps.deliveryStore.getDelivery(jobId);
        if (delivery === undefined || delivery.stage !== "ready" || delivery.gateVerdict !== "pass") {
          json(response, 409, { error: "not_ready_to_accept", message: "Only a gate-passed, published job can be accepted." });
          return;
        }
        const project = this.#deps.workflows.getProject(job.projectId);
        if (project === undefined) throw new Error("the job's project is no longer registered");
        this.#deps.deliveryStore.recordAcceptance(jobId, verificationKey({
          repoSlug: project.repoSlug,
          baseCommit: delivery.baseCommit,
          headCommit: delivery.headCommit,
          requirementsRevision: job.requirementsRevision,
          profileRevision: job.profileRevision,
          policyVersion: POLICY_VERSION,
        }));
        this.#deps.workflows.appendEvent(jobId, "result_accepted", { verificationKey: "recorded" });
        json(response, 200, { acceptance: this.#deps.deliveryStore.getAcceptance(jobId) });
        return;
      }
      if (method === "POST" && rest === "/observe-merge") {
        if (this.#deps.delivery === null || this.#deps.delivery === undefined) {
          json(response, 404, { error: "delivery_not_configured" });
          return;
        }
        const outcome = await this.#deps.delivery.observeMerge(jobId);
        json(response, 200, { outcome, delivery: this.#deps.deliveryStore?.getDelivery(jobId) ?? null });
        return;
      }
      if (method === "POST" && rest === "/cleanup-retry") {
        if (this.#deps.delivery === null || this.#deps.delivery === undefined) {
          json(response, 404, { error: "delivery_not_configured" });
          return;
        }
        await this.#deps.delivery.retryCleanup(jobId);
        json(response, 200, { delivery: this.#deps.deliveryStore?.getDelivery(jobId) ?? null });
        return;
      }
      if (method === "PATCH" && rest === "/status-settings") {
        const body = asObject(await readBody(request));
        const enabled = body.reportsEnabled;
        if (typeof enabled !== "boolean") throw new TypeError("reportsEnabled must be a boolean");
        const interval = body.intervalMinutes;
        if (typeof interval !== "number" || !Number.isSafeInteger(interval) || interval < 1 || interval > 60) {
          // Rejected without changing the saved interval.
          json(response, 400, { error: "invalid_interval", job: publicJob(job) });
          return;
        }
        const updated = this.#deps.workflows.setReportSettings(jobId, enabled, interval);
        json(response, 200, { job: publicJob(updated!) });
        return;
      }
    }

    json(response, 404, { error: "not_found" });
  }

  /** Snapshot first, then the ledger from the cursor; a reconnecting browser never misses events. */
  async #streamEvents(request: IncomingMessage, response: ServerResponse, jobId: string): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const cursorParam = Number(url.searchParams.get("cursor") ?? "0");
    let cursor = Number.isSafeInteger(cursorParam) && cursorParam >= 0 ? cursorParam : 0;
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    // A stream that dies mid-write must not surface an unhandled socket error.
    response.on("error", () => { /* the loop exits through the close handler */ });
    const send = (event: string, data: unknown): void => {
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const job = this.#deps.workflows.getJob(jobId);
    if (job === undefined) {
      response.end();
      return;
    }
    send("snapshot", {
      job: publicJob(job),
      questions: this.#deps.workflows.openQuestions(jobId),
      cursor: this.#deps.workflows.latestEventSeq(jobId),
    });
    const closed = new Promise<void>((resolveClose) => {
      request.on("close", () => resolveClose());
    });
    let closedFlag = false;
    void closed.then(() => {
      closedFlag = true;
    });
    let lastPing = Date.now();
    while (!response.writableEnded && !closedFlag) {
      for (const event of this.#deps.workflows.eventsAfter(jobId, cursor)) {
        cursor = event.seq;
        send("event", event);
      }
      if (Date.now() - lastPing >= 15_000) {
        lastPing = Date.now();
        response.write(": ping\n\n");
      }
      await Promise.race([new Promise<void>((resolveTick) => setTimeout(resolveTick, 400)), closed]);
      if (request.destroyed || closedFlag) break;
    }
    response.end();
  }
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function issueFromBody(value: JsonValue | undefined, registeredRepoSlug: string): IssueSnapshot | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("issue must be an object");
  const issue = value as Record<string, unknown>;
  if (typeof issue.repoSlug !== "string" || typeof issue.url !== "string" || typeof issue.title !== "string") throw new TypeError("issue requires repoSlug, url, and title");
  if (issue.repoSlug !== registeredRepoSlug) throw new TypeError("issue links must name the project's registered repository");
  if (issue.title.length > 300 || issue.url.length > 500 || typeof issue.updatedAt !== "string" || issue.updatedAt.length > 40) {
    throw new TypeError("issue title, url, and updatedAt exceed the allowed sizes");
  }
  if (typeof issue.number !== "number" || typeof issue.id !== "number" || !Number.isSafeInteger(issue.number) || !Number.isSafeInteger(issue.id)) {
    throw new TypeError("issue number and id must be integers");
  }
  return {
    provider: "github",
    repoSlug: issue.repoSlug,
    issueNumber: issue.number,
    issueId: issue.id,
    url: issue.url,
    title: issue.title,
    issueUpdatedAt: issue.updatedAt,
  };
}

function publicDelivery(store: DeliveryStore, jobId: string): Record<string, unknown> {
  const delivery = store.getDelivery(jobId);
  if (delivery === undefined) return { delivery: null };
  return {
    delivery,
    commits: store.listCommits(jobId),
    checks: store.listCheckResults(jobId).map((result) => ({
      checkId: result.checkId,
      headCommit: result.headCommit,
      status: result.status,
      exitCode: result.exitCode,
      command: result.command,
      environment: result.environment,
      sourceDigest: result.sourceDigest,
      verificationKey: result.verificationKey,
      outputTail: result.outputTail.slice(-2_000),
      createdAt: result.createdAt,
    })),
    reviews: store.listReviewReports(jobId).map((report) => ({
      role: report.role,
      headCommit: report.headCommit,
      verdict: report.verdict,
      scope: report.scope,
      model: `${report.provider}/${report.modelId}`,
      verificationKey: report.verificationKey,
      createdAt: report.createdAt,
    })),
    findings: store.listFindings(jobId),
    artifacts: store.listArtifacts(jobId).map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      digest: artifact.digest,
      sizeBytes: artifact.sizeBytes,
      expiresAt: artifact.expiresAt,
      expired: artifact.expiresAt < Date.now(),
    })),
    acceptance: store.getAcceptance(jobId) ?? null,
  };
}

/** The browser-facing job shape: workflow state, never internal references or credentials. */
function publicJob(job: { projectId: string; jobId: string; title: string; stage: string; runState: string; commandRevision: number; generation: number; requirementsRevision: number; profileRevision: number; issue: IssueSnapshot | null; reportsEnabled: boolean; reportIntervalMinutes: number; createdAt: number; updatedAt: number }): Record<string, unknown> {
  return {
    jobId: job.jobId,
    projectId: job.projectId,
    title: job.title,
    stage: job.stage,
    runState: job.runState,
    commandRevision: job.commandRevision,
    requirementsRevision: job.requirementsRevision,
    profileRevision: job.profileRevision,
    issue: job.issue,
    reportsEnabled: job.reportsEnabled,
    reportIntervalMinutes: job.reportIntervalMinutes,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}
