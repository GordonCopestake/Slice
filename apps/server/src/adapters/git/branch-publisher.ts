import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type PublishInput = {
  jobId: string;
  bundle: Buffer;
  remoteUrl: string;
  branch: string;
  expectedCommit: string;
  /** The remote head the push is allowed to fast-forward from; null means the branch must not exist yet. */
  expectedRemoteHead: string | null;
};

export interface BranchPublisher {
  publish(input: PublishInput): Promise<void>;
  remoteHead(input: { remoteUrl: string; branch: string }): Promise<string | null>;
}

const JOB_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const BRANCH_PATTERN = /^slice\/[A-Za-z0-9._-]{1,128}\/[A-Za-z0-9._-]{1,64}$/;
const SHA_PATTERN = /^[0-9a-f]{7,64}$/;

function gitRun(args: string[], cwd: string, env: NodeJS.ProcessEnv): { ok: boolean; status: number; output: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 120_000, env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" } });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { ok: result.status === 0, status: result.status ?? 1, output: output.slice(0, 2_000) };
}

/**
 * Pushes a runner-exported git bundle to the project's remote from the control host. Publishing
 * credentials never leave the control host: the token reaches git only through an askpass helper
 * reading an environment variable, never through argv, the bundle, or the runner.
 */
export class GitBundlePublisher implements BranchPublisher {
  readonly #stateDir: string;
  readonly #tokenEnvironment: string;

  constructor(stateDir: string, tokenEnvironment = "SLICE_GIT_PUSH_TOKEN") {
    this.#stateDir = stateDir;
    this.#tokenEnvironment = tokenEnvironment;
  }

  async remoteHead(input: { remoteUrl: string; branch: string }): Promise<string | null> {
    if (!BRANCH_PATTERN.test(input.branch)) throw new TypeError("Only slice/<job>/<title> branches may be inspected");
    const url = new URL(input.remoteUrl);
    if (url.protocol !== "https:" && url.protocol !== "file:") throw new Error("Only https:// or file:// git remotes are supported");
    if (url.username || url.password) throw new Error("Git remote URLs must not embed credentials");
    const env: NodeJS.ProcessEnv = {};
    if (url.protocol === "https:") {
      url.username = "x-access-token";
      env.GIT_ASKPASS = this.#askpassPath();
    }
    const ls = gitRun(["ls-remote", "--exit-code", url.toString(), `refs/heads/${input.branch}`], this.#stateDir, env);
    if (ls.status === 2) return null;
    if (ls.status !== 0) throw new Error(`ls-remote failed: ${ls.output}`);
    const head = ls.output.split("\t")[0]?.trim() ?? "";
    return head.length > 0 ? head : null;
  }

  #askpassPath(): string {
    mkdirSync(join(this.#stateDir, "git"), { recursive: true, mode: 0o700 });
    const askpass = join(this.#stateDir, "git", "askpass.sh");
    writeFileSync(askpass, `#!/bin/sh\nprintf '%s\\n' "$${this.#tokenEnvironment}"\n`, { mode: 0o700 });
    return askpass;
  }

  async publish(input: PublishInput): Promise<void> {
    if (!JOB_PATTERN.test(input.jobId)) throw new TypeError("jobId is invalid");
    if (!BRANCH_PATTERN.test(input.branch)) throw new TypeError("Only slice/<job>/<title> branches may be pushed");
    if (!SHA_PATTERN.test(input.expectedCommit)) throw new TypeError("expectedCommit must be a hex revision id");
    if (input.bundle.length === 0 || input.bundle.length > 32_000_000) throw new TypeError("Bundle size is invalid");
    const url = new URL(input.remoteUrl);
    if (url.protocol !== "https:" && url.protocol !== "file:") throw new Error("Only https:// or file:// git remotes are supported");
    if (url.username || url.password) throw new Error("Git remote URLs must not embed credentials");
    if (input.expectedRemoteHead !== null && !SHA_PATTERN.test(input.expectedRemoteHead)) throw new TypeError("expectedRemoteHead must be a hex revision id");

    const workDir = join(this.#stateDir, "push", input.jobId);
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(workDir, "repo"), { recursive: true, mode: 0o700 });
    const bundlePath = join(workDir, "branch.bundle");
    writeFileSync(bundlePath, input.bundle, { mode: 0o600 });

    const init = gitRun(["init", "--bare", "--quiet", "repo"], workDir, {});
    if (!init.ok) throw new Error(`git init failed: ${init.output}`);
    // git fetch needs a local repository context, so it runs inside the bare repo with the bundle as source.
    const fetched = gitRun(["fetch", "--quiet", "--no-tags", "../branch.bundle", `refs/heads/${input.branch}:refs/heads/${input.branch}`], join(workDir, "repo"), {});
    if (!fetched.ok) throw new Error(`bundle fetch failed: ${fetched.output}`);
    const head = gitRun(["-C", "repo", "rev-parse", `refs/heads/${input.branch}`], workDir, {});
    // The bundle is only trusted when it carries exactly the commit the gate reviewed.
    if (!head.ok || head.output !== input.expectedCommit) throw new Error("push_commit_mismatch: the bundle does not carry the reviewed commit");

    const remoteUrl = new URL(input.remoteUrl);
    const env: NodeJS.ProcessEnv = {};
    if (remoteUrl.protocol === "https:") {
      const token = process.env[this.#tokenEnvironment];
      if (token === undefined || token.trim().length === 0) throw new Error(`${this.#tokenEnvironment} is not configured; the branch cannot be pushed`);
      remoteUrl.username = "x-access-token";
      env.GIT_ASKPASS = this.#askpassPath();
    }

    const ls = gitRun(["ls-remote", "--exit-code", remoteUrl.toString(), `refs/heads/${input.branch}`], workDir, env);
    // ls-remote exits 2 when the ref is absent; any other non-zero status is a host we must not guess about.
    if (ls.status !== 0 && ls.status !== 2) throw new Error(`ls-remote failed: ${ls.output}`);
    const remoteHead = ls.output.split("\t")[0]?.trim() ?? "";
    const actualRemote = remoteHead.length > 0 ? remoteHead : null;
    if (actualRemote !== input.expectedRemoteHead) {
      throw new Error(`remote_head_mismatch: expected ${input.expectedRemoteHead ?? "absent"}, found ${actualRemote ?? "absent"}`);
    }
    const pushed = gitRun(["-C", "repo", "push", "--quiet", remoteUrl.toString(), `refs/heads/${input.branch}`], workDir, env);
    if (!pushed.ok) throw new Error(`git push failed: ${pushed.output}`);
  }
}
