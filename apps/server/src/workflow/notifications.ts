import { randomBytes } from "node:crypto";
import type { NotificationStore } from "../records/notification-store.js";
import type { StatusStore } from "../records/status-store.js";
import type { WorkflowStore } from "../records/workflow-store.js";
import type { TelegramGateway } from "../adapters/telegram/telegram.js";

const ALERT_TEXT: Record<string, string> = {
  question_asked: "Slice is waiting for your answer.",
  blocked: "Slice work is blocked; the thread states the reason.",
  author_task_failed: "A model task failed; the thread states the state.",
  patch_rejected: "A proposed patch was rejected by policy.",
  ready_for_owner: "Your pull request is ready for review.",
  merge_observed: "The merge was confirmed and the thread archived.",
  cleanup_pending: "Workspace cleanup is pending; the archived thread and evidence are intact.",
};

const REPORT_EXPIRY_MS = 24 * 3_600_000;

export type NotificationDeps = {
  workflows: WorkflowStore;
  notifications: NotificationStore;
  status: StatusStore;
  telegram: TelegramGateway | null;
};

/**
 * The outbox side of Phase 3 reporting: enqueue (deduplicated), scan the event ledger for alert
 * events, deliver due notifications with re-checks (link present, generation current, not expired),
 * and run the Telegram account-linking flow. Notification failure never stops workflow progress.
 */
export class NotificationService {
  readonly #deps: NotificationDeps;

  constructor(deps: NotificationDeps) {
    this.#deps = deps;
  }

  telegramStatus(): { botConfigured: boolean; linked: boolean; periodicEnabled: boolean; linkPending: boolean } {
    const state = this.#deps.notifications.getTelegram();
    return {
      botConfigured: this.#deps.telegram !== null,
      linked: state.chatId !== null,
      periodicEnabled: state.periodicEnabled,
      linkPending: state.linkCode !== null && (state.linkCodeExpiresAt ?? 0) > Date.now(),
    };
  }

  /** A fresh single-use linking code; the old one stops working immediately. */
  startLinkCode(): string {
    const code = randomBytes(6).toString("hex");
    this.#deps.notifications.startLinkCode(code);
    return code;
  }

  unlinkTelegram(): void {
    this.#deps.notifications.unlinkTelegram();
  }

  setPeriodicReports(enabled: boolean): void {
    this.#deps.notifications.setPeriodicEnabled(enabled);
  }

  notificationsFor(jobId: string) {
    return this.#deps.notifications.listForJob(jobId);
  }

  /** A produced report is queued for Telegram only when that channel is linked and opted in. */
  enqueueReport(jobId: string, dueAt: number): void {
    const plan = this.#deps.status.getPlan(jobId);
    if (plan === undefined) return;
    const telegram = this.#deps.notifications.getTelegram();
    if (telegram.chatId === null || !telegram.periodicEnabled) return;
    this.#deps.notifications.enqueue({
      notificationId: `report:${jobId}:${plan.generation}:${dueAt}`,
      jobId,
      kind: "report",
      generation: plan.generation,
      channel: "telegram",
      recipientRef: telegram.chatId,
      payload: { dueAt },
      expiresAt: dueAt + REPORT_EXPIRY_MS,
    });
  }

  /** Alert-worthy events are found from the durable ledger, so a restart never loses one. */
  scanAlerts(): void {
    for (const job of this.#deps.workflows.listJobs()) {
      const lastSeq = this.#deps.notifications.getLastSeq(job.jobId);
      const events = this.#deps.workflows.eventsAfter(job.jobId, lastSeq);
      let maxSeq = lastSeq;
      const telegram = this.#deps.notifications.getTelegram();
      for (const event of events) {
        maxSeq = Math.max(maxSeq, event.seq);
        if (ALERT_TEXT[event.type] === undefined || telegram.chatId === null) continue;
        this.#deps.notifications.enqueue({
          notificationId: `alert:${job.jobId}:${event.seq}`,
          jobId: job.jobId,
          kind: "alert",
          generation: this.#deps.status.getPlan(job.jobId)?.generation ?? 1,
          channel: "telegram",
          recipientRef: telegram.chatId,
          payload: { type: event.type },
          expiresAt: Date.now() + REPORT_EXPIRY_MS,
        });
      }
      if (maxSeq > lastSeq) this.#deps.notifications.setLastSeq(job.jobId, maxSeq);
    }
  }

  /** Deliver due notifications, re-checking link, generation, and expiry before each send. */
  async deliverDue(now: number): Promise<number> {
    if (this.#deps.telegram === null) return 0;
    let delivered = 0;
    const telegram = this.#deps.notifications.getTelegram();
    for (const notification of this.#deps.notifications.dueNotifications(now)) {
      if (notification.expiresAt < now) {
        this.#deps.notifications.markSuppressed(notification.notificationId);
        continue;
      }
      if (telegram.chatId === null || telegram.chatId !== notification.recipientRef) {
        // The channel disappeared after enqueueing; suppressing beats silently retrying forever.
        this.#deps.notifications.markSuppressed(notification.notificationId);
        continue;
      }
      if (notification.kind === "report") {
        const plan = this.#deps.status.getPlan(notification.jobId);
        if (plan === undefined || plan.generation !== notification.generation) {
          this.#deps.notifications.markSuppressed(notification.notificationId);
          continue;
        }
      }
      const text = this.#render(notification.jobId, notification.kind, notification.payload);
      if (text === null) {
        this.#deps.notifications.markSuppressed(notification.notificationId);
        continue;
      }
      const outcome = await this.#deps.telegram.sendMessage(telegram.chatId, text);
      if (outcome.status === "sent") {
        this.#deps.notifications.markSent(notification.notificationId);
        delivered += 1;
      } else if (outcome.status === "failed") {
        this.#deps.notifications.markFailed(notification.notificationId);
      } else {
        this.#deps.notifications.markUncertain(notification.notificationId);
      }
    }
    return delivered;
  }

  /** The linking flow: a user sends '/link <code>' to the bot; the code is single-use and expires. */
  async pollLink(): Promise<boolean> {
    if (this.#deps.telegram === null) return false;
    const state = this.#deps.notifications.getTelegram();
    const messages = await this.#deps.telegram.getUpdates(state.updateOffset);
    let linked = false;
    let offset = state.updateOffset;
    for (const message of messages) {
      offset = Math.max(offset, message.messageId);
      const match = /^\/link\s+([A-Za-z0-9]{6,16})$/u.exec(message.text.trim());
      if (match !== null && this.#deps.notifications.confirmLink(message.chatId, match[1] ?? "")) linked = true;
    }
    if (offset !== state.updateOffset) this.#deps.notifications.setUpdateOffset(offset);
    return linked;
  }

  #render(jobId: string, kind: string, payload: Record<string, unknown>): string | null {
    const job = this.#deps.workflows.getJob(jobId);
    if (job === undefined) return null;
    if (kind === "alert") {
      const type = String(payload.type ?? "");
      return ALERT_TEXT[type] === undefined ? null : `Slice — ${job.title}: ${ALERT_TEXT[type]}`;
    }
    const dueAt = Number(payload.dueAt ?? 0);
    const plan = this.#deps.status.getPlan(jobId);
    if (plan === undefined) return null;
    const [report] = this.#deps.status.listReports(jobId, 50).filter((entry) => entry.dueAt === dueAt && entry.generation === plan.generation);
    if (report === undefined) return null;
    const content = report.report as { inProgress?: string; eta?: { note?: string }; state?: { runState?: string; stage?: string } };
    const lines = [
      `Slice status — ${job.title}`,
      `state: ${content.state?.runState ?? "?"} / ${content.state?.stage ?? "?"}`,
      `in progress: ${content.inProgress ?? ""}`,
      content.eta?.note !== undefined ? `estimate: ${content.eta.note}` : "",
      "Open the Slice thread for the approved detail.",
    ].filter((line) => line.length > 0);
    return lines.join("\n");
  }
}
