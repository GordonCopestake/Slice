import type { DeliveryStore } from "../records/delivery-store.js";
import type { JobRecord } from "../records/workflow-store.js";
import type { StatusStore } from "../records/status-store.js";
import type { EtaEstimate, ReportPlan, StatusReportRecord } from "../records/status-store.js";

export const REPORT_CONTENT_VERSION = "slice-report-v1";
export const DEFAULT_REPORT_INTERVAL_MINUTES = 10;

/**
 * Event types are translated into approved plain-language phrases. Unknown event types are
 * summarised as generic activity: raw payloads, commands, logs, and model text never enter a
 * routine report, and no LLM is asked to compose one.
 */
const APPROVED_PHRASES: Record<string, (payload: Record<string, unknown>) => string> = {
  author_round: (p) => `authoring round ${Number(p.round ?? "?")} started`,
  commit_recorded: () => "a candidate commit was recorded",
  head_check_result: (p) => `check ${String(p.checkId)} ${String(p.status)}`,
  review_recorded: (p) => `${String(p.role)} review verdict: ${String(p.verdict)}`,
  gate_evaluated: (p) => `readiness gate: ${String(p.verdict)}`,
  repair_round_scheduled: () => "a repair round was scheduled",
  requirements_ready: () => "requirements settled",
  question_asked: () => "a question is waiting for your answer",
  question_answered: () => "your answer was recorded",
  steering_recorded: () => "your instruction was applied",
  publication_pending: () => "publication is waiting on the git host",
  ready_for_owner: () => "the pull request is ready for your review",
  merge_observed: () => "the merge was confirmed",
  workspace_cleaned: () => "the job workspace was cleaned",
  blocked: () => "work is blocked",
  paused: () => "the job was paused",
  resumed: () => "the job was resumed",
  cancelled: () => "the job was cancelled",
};

export type StatusReportDeps = {
  workflows: import("../records/workflow-store.js").WorkflowStore;
  deliveryStore: DeliveryStore | null;
  status: StatusStore;
  /** Stage B hook: enqueue the report for channel delivery (web is implicit; Telegram later). */
  notify?: (jobId: string, kind: "report", dueAt: number) => void;
};

/**
 * Periodic progress reports, built only from committed workflow state. The scheduler coalesces
 * overdue ticks into one current report, keeps one record per job/generation/due time, and stops
 * periodic reports at ready, cancelled, terminal failure, or archive while recording a final
 * update. Estimates come from comparable completed jobs in the same project and stage.
 */
export class StatusReports {
  readonly #deps: StatusReportDeps;

  constructor(deps: StatusReportDeps) {
    this.#deps = deps;
  }

  onJobCreated(job: JobRecord): void {
    this.#deps.status.ensurePlan(job);
  }

  onSteering(jobId: string): void {
    this.#deps.status.bumpGeneration(jobId);
  }

  settingsChanged(jobId: string, enabled: boolean, intervalMinutes: number): ReportPlan {
    return this.#deps.status.setPlanSettings(jobId, enabled, intervalMinutes);
  }

  planFor(jobId: string): ReportPlan | undefined {
    return this.#deps.status.getPlan(jobId);
  }

  reportsFor(jobId: string): StatusReportRecord[] {
    return this.#deps.status.listReports(jobId);
  }

  /** Immediate final report for an owner-visible terminal action (cancel). */
  finalize(jobId: string, reason: string): void {
    const plan = this.#deps.status.getPlan(jobId);
    if (plan === undefined || plan.final) return;
    const job = this.#deps.workflows.getJob(jobId);
    if (job === undefined) {
      this.#deps.status.markFinal(jobId);
      return;
    }
    const now = Date.now();
    const report = this.#build(job, plan, now, true, reason);
    this.#deps.status.recordReport(jobId, plan.generation, now, REPORT_CONTENT_VERSION, true, report);
    this.#deps.status.markFinal(jobId);
  }

  /** One scheduler tick: coalesce overdue plans into one current report each. */
  tick(now: number): number {
    let produced = 0;
    for (const plan of this.#deps.status.duePlans(now)) {
      const job = this.#deps.workflows.getJob(plan.jobId);
      if (job === undefined) {
        this.#deps.status.markFinal(plan.jobId);
        continue;
      }
      const delivery = this.#deps.deliveryStore?.getDelivery(plan.jobId);
      const terminal = job.runState === "cancelled" || job.runState === "completed"
        || delivery?.archiveState === "archived" || delivery?.stage === "ready" || delivery?.stage === "finished";
      const dueAt = plan.nextReportAt ?? now;
      const report = this.#build(job, plan, now, terminal, null);
      const recorded = this.#deps.status.recordReport(plan.jobId, plan.generation, dueAt, REPORT_CONTENT_VERSION, terminal, report);
      if (recorded !== undefined) {
        produced += 1;
        this.#deps.notify?.(plan.jobId, "report", dueAt);
      }
      if (terminal) this.#deps.status.markFinal(plan.jobId);
      else this.#deps.status.scheduleNext(plan.jobId, now);
    }
    this.#recordCompletions();
    return produced;
  }

  /** When a job reaches ready, record its stage timeline once for future calibration. */
  #recordCompletions(): void {
    if (this.#deps.deliveryStore === null) return;
    for (const delivery of this.#deps.deliveryStore.listActiveDeliveries()) {
      if (delivery.stage !== "ready") continue;
      const job = this.#deps.workflows.getJob(delivery.jobId);
      if (job === undefined) continue;
      const readyEvent = this.#deps.workflows.eventsAfter(job.jobId, 0).find((event) => event.type === "ready_for_owner");
      const readyAt = readyEvent?.createdAt ?? job.updatedAt;
      const stageEntries = new Map<string, number>();
      for (const event of this.#deps.workflows.eventsAfter(job.jobId, 0)) {
        const stage = stageOfEvent(event.type);
        if (stage !== null && !stageEntries.has(stage)) stageEntries.set(stage, event.createdAt);
      }
      stageEntries.set("requirements", job.createdAt);
      this.#deps.status.recordCompletion(job.jobId, job.projectId, stageEntries, readyAt);
      this.#deps.status.markFinal(job.jobId);
    }
  }

  #build(job: JobRecord, plan: ReportPlan, now: number, terminal: boolean, terminalReason: string | null): Record<string, unknown> {
    const events = this.#deps.workflows.eventsAfter(job.jobId, 0);
    const since = plan.lastReportAt ?? job.createdAt - 1;
    const completedSince: string[] = [];
    let lastEventAt = job.createdAt;
    for (const event of events) {
      lastEventAt = Math.max(lastEventAt, event.createdAt);
      if (event.createdAt <= since) continue;
      const phrase = APPROVED_PHRASES[event.type];
      completedSince.push(phrase !== undefined ? phrase(event.payload as Record<string, unknown>) : "workflow activity was recorded");
    }

    const delivery = this.#deps.deliveryStore?.getDelivery(job.jobId);
    const stage = delivery?.stage ?? "requirements";
    const inProgress = delivery !== undefined
      ? `delivery stage ${stage}, round ${delivery.round}`
      : job.runState === "waiting_user" ? "requirements question-and-answer" : "requirements discovery";

    const blockers: string[] = [];
    if (job.runState === "paused") blockers.push("the job is paused; no active worker progress is claimed");
    if (job.runState === "waiting_user") blockers.push("waiting for your answer before continuing");
    if (job.runState === "blocked") {
      const reason = [...events].reverse().find((event) => event.type === "blocked");
      blockers.push(`blocked: ${String((reason?.payload as { reason?: string })?.reason ?? "see the thread")}`);
    }
    if (delivery !== undefined) {
      const findings = this.#deps.deliveryStore!.openBlockingFindings(job.jobId);
      for (const finding of findings) blockers.push(`open ${finding.severity} finding ${finding.id}`);
    }
    if (terminal) blockers.push(terminalReason ?? "the job reached a terminal state; no further periodic reports will be sent");

    const elapsedSeconds = Math.max(0, Math.round((now - job.createdAt) / 1000));
    const pausedSeconds = pairedSeconds(events, "paused", "resumed", now);
    const waitingSeconds = pairedSeconds(events, "question_asked", "question_answered", now);
    const activeSeconds = Math.max(0, elapsedSeconds - pausedSeconds - waitingSeconds);

    const eta = this.#eta(job, stage);

    return {
      contentVersion: REPORT_CONTENT_VERSION,
      jobId: job.jobId,
      project: job.projectId,
      generation: plan.generation,
      final: terminal,
      state: { runState: job.runState, stage, round: delivery?.round ?? null },
      completedSince: completedSince.slice(-25),
      inProgress,
      blockers,
      time: {
        elapsedSeconds,
        activeSeconds,
        pausedSeconds,
        waitingSeconds,
        heartbeatAgeSeconds: Math.max(0, Math.round((now - lastEventAt) / 1000)),
      },
      spend: { providerReported: null, note: "provider spend is not yet tracked for this job" },
      eta,
      nextReportAt: terminal ? null : now + plan.intervalMinutes * 60_000,
      threadLink: `/job/${job.jobId}`,
    };
  }

  #eta(job: JobRecord, stage: string): (EtaEstimate & { note: string }) | { note: string } {
    const estimate = this.#deps.status.etaFor(job.projectId, stage, Date.now());
    if (estimate === null) return { note: "the remaining time cannot yet be estimated: no comparable completed history for this stage" };
    const minutes = (seconds: number) => Math.max(1, Math.round(seconds / 60));
    const errorNote = estimate.meanAbsErrorSeconds === null
      ? "no estimate accuracy measured yet"
      : `past estimates for this project were off by about ${minutes(estimate.meanAbsErrorSeconds)} minute(s) on average`;
    return {
      ...estimate,
      note: `estimated ${minutes(estimate.minSeconds)}-${minutes(estimate.maxSeconds)} minutes from ${estimate.cohortSize} comparable job(s) in this project at the same stage; ${errorNote}`,
    };
  }
}

function stageOfEvent(type: string): string | null {
  switch (type) {
    case "author_round": return "authoring";
    case "head_check_result": return "checks";
    case "review_recorded": return "review";
    case "gate_evaluated": return "gate";
    case "publication_pending": case "ready_for_owner": return "publishing";
    default: return null;
  }
}

/** Time spent between an opening event and its closing event; open intervals count up to 'now'. */
function pairedSeconds(events: { type: string; createdAt: number }[], openType: string, closeType: string, now: number): number {
  let total = 0;
  let openedAt: number | null = null;
  for (const event of events) {
    if (event.type === openType) {
      if (openedAt === null) openedAt = event.createdAt;
    } else if (event.type === closeType || event.type === "cancelled") {
      if (openedAt !== null) {
        total += event.createdAt - openedAt;
        openedAt = null;
      }
    }
  }
  if (openedAt !== null) total += Math.max(0, now - openedAt);
  return Math.max(0, Math.round(total / 1000));
}
