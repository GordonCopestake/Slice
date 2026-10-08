import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { JsonValue } from "../../state/application-state.js";

export type RunnerResponse = { ok: boolean; error?: string; [key: string]: unknown };

export interface RunnerTransport {
  /** One typed JSON request/response exchange. Transport failure is an error, never a fake response. */
  request(payload: JsonValue): Promise<RunnerResponse>;
}

function spawnCollect(command: string, args: string[], stdinJson: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveSpawn, rejectSpawn) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectSpawn(new Error("runner request timed out"));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    // A child that dies before the write lands must not turn that write into an unhandled error.
    child.stdin.on("error", () => { /* surfaced through the exit code below */ });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectSpawn(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveSpawn({ code: code ?? -1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
    child.stdin.write(stdinJson);
    child.stdin.end();
  });
}

/** Runs the runner as a local subprocess. Used by tests and by a control host that is also the runner. */
export class LocalRunnerTransport implements RunnerTransport {
  constructor(
    private readonly entryPath: string,
    private readonly runnerRoot: string,
    private readonly nodeCommand: string = process.execPath,
  ) {}

  async request(payload: JsonValue): Promise<RunnerResponse> {
    const result = await spawnCollect(this.nodeCommand, [this.entryPath, "--root", this.runnerRoot], JSON.stringify(payload), 120_000);
    try {
      return JSON.parse(result.stdout.trim()) as RunnerResponse;
    } catch {
      // Stderr can carry git noise; keep only a bounded tail and never echo credentials from it.
      throw new Error(`runner returned no response (exit ${result.code}): ${result.stderr.slice(-200)}`);
    }
  }
}

export type SshRunnerOptions = {
  address: string;
  sshUser: string;
  runnerRoot: string;
  /** Absolute path to the remote runner entry script on the host. */
  remoteEntryPath: string;
  /** Pinned known_hosts file for this host; a changed host key makes ssh refuse the connection. */
  knownHostsFile: string;
  identityFilePath?: string;
  /** Injectable for tests; production uses the system ssh. */
  sshCommand?: string;
  timeoutMs?: number;
};

/**
 * SSH transport. Batch mode, strict host key checking against a pinned known_hosts file, and no
 * host-key updates: a changed key fails the request instead of silently trusting a new host.
 * No shell text is built from request data; the remote command is a fixed argv.
 */
export class SshRunnerTransport implements RunnerTransport {
  readonly #options: SshRunnerOptions;

  constructor(options: SshRunnerOptions) {
    this.#options = options;
  }

  async request(payload: JsonValue): Promise<RunnerResponse> {
    if (!existsSync(this.#options.knownHostsFile)) {
      throw new Error(`host key pin missing for ${this.#options.address}; onboard the host explicitly`);
    }
    const args = [
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "UpdateHostKeys=no",
      "-o", `UserKnownHostsFile=${this.#options.knownHostsFile}`,
    ];
    if (this.#options.identityFilePath !== undefined) args.push("-i", this.#options.identityFilePath);
    args.push(`${this.#options.sshUser}@${this.#options.address}`, "node", this.#options.remoteEntryPath, "--root", this.#options.runnerRoot);
    const result = await spawnCollect(this.#options.sshCommand ?? "ssh", args, JSON.stringify(payload), this.#options.timeoutMs ?? 60_000);
    let response: RunnerResponse;
    try {
      response = JSON.parse(result.stdout.trim()) as RunnerResponse;
    } catch {
      throw new Error(`ssh runner request failed (exit ${result.code}): ${result.stderr.slice(-200)}`);
    }
    if (result.code !== 0 && response.ok !== true) {
      throw new Error(`ssh runner exited ${result.code}: ${String(response.error ?? result.stderr.slice(-200))}`);
    }
    return response;
  }
}
