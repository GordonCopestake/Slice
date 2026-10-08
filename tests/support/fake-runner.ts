import type { RunnerGateway } from "../../apps/server/src/adapters/ssh-runner/runner-adapter.js";

/** A runner that always succeeds, so workflow tests can watch the full delivery path. */
export function fakeRunner(overrides: Partial<RunnerGateway> = {}): RunnerGateway {
  const base: RunnerGateway = {
    prepareJob: async () => ({ baseCommit: "0123456789abcdef", repoPath: "/srv/slice/jobs/j/repo", worktreePath: "/srv/slice/jobs/j/author", reused: false }),
    runCheck: async () => ({ status: "succeeded", exitCode: 0, outputTail: "" }),
    applyChange: async (input) => ({ commit: `f${input.operationId.length}`.padEnd(40, "0").slice(0, 40), tree: "0123456789abcdef", parent: "0123456789abcdef" }),
    verifyHead: async () => ({ head: "0123456789abcdef", tree: "0123456789abcdef", branch: "slice/j/change", parent: "", clean: true }),
    readSource: async () => "file content",
    exportCommit: async () => Buffer.from("fake-bundle"),
    cleanupJob: async () => {},
    cancelRunning: async () => {},
    reconcile: async () => [],
  };
  return { ...base, ...overrides };
}
