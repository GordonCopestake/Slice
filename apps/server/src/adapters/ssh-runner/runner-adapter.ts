import { setTimeout as delay } from "node:timers/promises";
import type { JsonValue } from "../../state/application-state.js";
import { ExternalOperationJournal } from "../../workflow/external-operation-journal.js";
import type { RunnerTransport } from "./runner-transport.js";

export type PreparedWorkspace = {
  baseCommit: string;
  repoPath: string;
  worktreePath: string;
  reused: boolean;
};

export type CheckRunResult = {
  status: "succeeded" | "failed" | "uncertain";
  exitCode: number | null;
  outputTail: string;
};

/** What the workflow coordinator needs from a runner; a fake can stand in for tests. */
export interface RunnerGateway {
  prepareJob(input: { jobId: string; hostId: string; source: string; branch: string; leaseGeneration: number }): Promise<PreparedWorkspace>;
  runCheck(input: { jobId: string; hostId: string; leaseGeneration: number; checkId: string; command: string }): Promise<CheckRunResult>;
  cancelRunning(input: { jobId: string; hostId: string }): Promise<void>;
  reconcile(input: { jobId: string; hostId: string }): Promise<{ operationId: string; status: string }[]>;
}

function okOrThrow(response: { ok: boolean; error?: string; [key: string]: unknown }, what: string): void {
  if (response.ok !== true) throw new Error(`${what} failed: ${String(response.error ?? "unknown")}`);
}

/**
 * Runner calls go through the Phase 0 external-operation journal: stable operation IDs, at-most-once
 * dispatch, and reconciliation instead of blind replay. A check that was already started on the host
 * is reattached by operation ID, never started a second time.
 */
export class RunnerAdapter implements RunnerGateway {
  readonly #journal: ExternalOperationJournal;
  readonly #transportFor: (hostId: string) => RunnerTransport;
  readonly #pollIntervalMs: number;
  readonly #pollLimitMs: number;

  constructor(
    journal: ExternalOperationJournal,
    transportFor: (hostId: string) => RunnerTransport,
    options: { pollIntervalMs?: number; pollLimitMs?: number } = {},
  ) {
    this.#journal = journal;
    this.#transportFor = transportFor;
    this.#pollIntervalMs = options.pollIntervalMs ?? 500;
    this.#pollLimitMs = options.pollLimitMs ?? 600_000;
  }

  async prepareJob(input: { jobId: string; hostId: string; source: string; branch: string; leaseGeneration: number }): Promise<PreparedWorkspace> {
    const operationId = `${input.jobId}:prepare`;
    const payload = { op: "prepare_job", ...input } satisfies JsonValue;
    return this.#journal.run(operationId, payload, {
      execute: async (): Promise<PreparedWorkspace> => {
        const response = await this.#transportFor(input.hostId).request(payload);
        okOrThrow(response, "prepare_job");
        return {
          baseCommit: String(response.baseCommit ?? ""),
          repoPath: String(response.repoPath ?? ""),
          worktreePath: String(response.worktreePath ?? ""),
          reused: response.reused === true,
        };
      },
      reconcile: async (): Promise<{ status: "completed"; result: PreparedWorkspace } | { status: "not_started" } | { status: "unknown"; reason: string }> => {
        // A previous process may have created the job directory and died before recording it.
        const inspection = await this.#transportFor(input.hostId).request({ op: "inspect_job", jobId: input.jobId });
        if (inspection.ok !== true) return { status: "unknown", reason: "inspect_job did not answer" };
        if (inspection.exists !== true) return { status: "not_started" };
        const marker = inspection.marker as { baseCommit?: string } | null;
        if (marker === null || typeof marker.baseCommit !== "string") return { status: "unknown", reason: "job marker is unreadable" };
        return {
          status: "completed",
          result: { baseCommit: marker.baseCommit, repoPath: "", worktreePath: "", reused: true },
        };
      },
    });
  }

  async runCheck(input: { jobId: string; hostId: string; leaseGeneration: number; checkId: string; command: string }): Promise<CheckRunResult> {
    const operationId = `${input.jobId}:check:${input.checkId}`;
    const payload = { op: "run_check", jobId: input.jobId, operationId, leaseGeneration: input.leaseGeneration, checkId: input.checkId, command: input.command } satisfies JsonValue;
    const transport = this.#transportFor(input.hostId);
    return this.#journal.run(operationId, payload, {
      execute: async () => {
        const started = await transport.request(payload);
        okOrThrow(started, "run_check");
        return this.#awaitCheck(transport, input.jobId, operationId);
      },
      reconcile: async () => {
        // Reattach first: the operation may still be running on the host.
        const status = await transport.request({ op: "get_process_status", jobId: input.jobId, operationId });
        if (status.ok !== true) return { status: "unknown", reason: "the runner did not answer for this operation" };
        if (status.status === "running") {
          const settled = await this.#awaitCheck(transport, input.jobId, operationId);
          return { status: "completed", result: settled };
        }
        if (status.status === "uncertain") return { status: "unknown", reason: "the remote process outcome is unknown" };
        return {
          status: "completed",
          result: { status: status.status as "succeeded" | "failed", exitCode: status.exitCode === null || status.exitCode === undefined ? null : Number(status.exitCode), outputTail: String(status.outputTail ?? "") },
        };
      },
    });
  }

  async #awaitCheck(transport: { request(payload: JsonValue): Promise<{ ok: boolean; error?: string; [key: string]: unknown }> }, jobId: string, operationId: string): Promise<CheckRunResult> {
    const deadline = Date.now() + this.#pollLimitMs;
    while (Date.now() < deadline) {
      const status = await transport.request({ op: "get_process_status", jobId, operationId });
      if (status.ok !== true) throw new Error(`check status failed: ${String(status.error ?? "unknown")}`);
      if (status.status === "succeeded" || status.status === "failed") {
        return {
          status: status.status,
          exitCode: status.exitCode === null || status.exitCode === undefined ? null : Number(status.exitCode),
          outputTail: String(status.outputTail ?? ""),
        };
      }
      if (status.status === "uncertain") throw new Error("the remote check outcome is uncertain");
      await delay(this.#pollIntervalMs);
    }
    throw new Error("the remote check exceeded the poll limit");
  }

  async cancelRunning(input: { jobId: string; hostId: string }): Promise<void> {
    const transport = this.#transportFor(input.hostId);
    const running = await transport.request({ op: "reconcile", jobId: input.jobId });
    if (running.ok !== true) throw new Error(`runner reconcile failed: ${String(running.error ?? "unknown")}`);
    const operations = Array.isArray(running.operations) ? running.operations as { operation_id?: string; operationId?: string; status: string }[] : [];
    for (const operation of operations) {
      if (operation.status !== "running") continue;
      const operationId = operation.operationId ?? operation.operation_id ?? "";
      await transport.request({ op: "cancel_process", jobId: input.jobId, operationId });
    }
  }

  async reconcile(input: { jobId: string; hostId: string }): Promise<{ operationId: string; status: string }[]> {
    const response = await this.#transportFor(input.hostId).request({ op: "reconcile", jobId: input.jobId });
    if (response.ok !== true) throw new Error(`runner reconcile failed: ${String(response.error ?? "unknown")}`);
    const rows = Array.isArray(response.operations) ? response.operations as { operationId?: string; operation_id?: string; status: string }[] : [];
    return rows.map((row) => ({ operationId: String(row.operationId ?? row.operation_id ?? ""), status: row.status }));
  }
}
