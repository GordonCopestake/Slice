import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { WorkflowStore, type BuildProfile, type ProjectRecord } from "../../apps/server/src/records/workflow-store.js";
import { modelPolicy, modelPolicyViolation } from "../../apps/server/src/workflow/model-policy.js";

const PROFILE: BuildProfile = { setup: [], checks: [{ id: "test", command: "npm test" }] };

function newStore(): { store: WorkflowStore; database: DatabaseSync; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), "slice-placement-"));
  const database = new DatabaseSync(join(directory, "state.sqlite"));
  return { store: WorkflowStore.open(database), database, directory };
}

function project(store: WorkflowStore, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  store.createProject({
    projectId: overrides.projectId ?? "demo",
    repoSlug: "owner/demo",
    defaultBranch: "main",
    hostId: overrides.hostId ?? "linux-a",
    ...(overrides.poolId === undefined ? {} : { poolId: overrides.poolId }),
    ...(overrides.requiredOs === undefined ? {} : { requiredOs: overrides.requiredOs }),
    ...(overrides.toolchain === undefined || overrides.toolchain.length === 0 ? {} : { toolchain: overrides.toolchain }),
    buildProfile: PROFILE,
  });
  return store.getProject(overrides.projectId ?? "demo")!;
}

test("placement needs a registered host and states why when there is none", () => {
  const { store, directory } = newStore();
  try {
    store.registerHost({ hostId: "linux-a", address: "a.internal", os: "linux", sshUser: "slice", runnerRoot: "/srv/slice" });
    const demo = project(store);
    assert.deepEqual(store.chooseHost(demo), { host: store.getHost("linux-a") });

    const orphan = project(store, { projectId: "orphan", hostId: "linux-a" });
    store.registerHost({ hostId: "linux-b", address: "b.internal", os: "linux", sshUser: "slice", runnerRoot: "/srv/slice" });
    // A pool that does not exist is refused at project creation, never silently ignored.
    assert.throws(() => store.createProject({ projectId: "bad", repoSlug: "owner/bad", defaultBranch: "main", hostId: "linux-a", poolId: "nope", buildProfile: PROFILE }), /not registered/);
    assert.equal(orphan.projectId, "orphan");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a Windows project waits when no Windows worker is registered", () => {
  const { store, directory } = newStore();
  try {
    store.registerHost({ hostId: "linux-a", address: "a.internal", os: "linux", sshUser: "slice", runnerRoot: "/srv/slice" });
    store.registerHost({ hostId: "win-a", address: "w.internal", os: "windows", sshUser: "slice", runnerRoot: "D:/slice" });
    store.registerPool({ poolId: "pool-1", hosts: ["linux-a", "win-a"] });
    const win = project(store, { projectId: "win", requiredOs: "windows", poolId: "pool-1", toolchain: [{ id: "node", command: "node --version" }] });

    // While only the Linux worker is usable, the Windows project waits with a stated reason.
    store.setHostEnabled("win-a", false);
    const placement = store.chooseHost(win);
    assert.equal("reason" in placement, true);
    assert.equal((placement as { reason: string }).reason, "no_matching_host_os");
    assert.ok((placement as { detail: string }).detail.includes("linux-a (linux)"), "the reason names what is registered");

    store.setHostEnabled("win-a", true);
    assert.equal((store.chooseHost(win) as { host: { hostId: string } }).host.hostId, "win-a", "the Windows project lands on the Windows worker");

    const linux = project(store, { projectId: "linux", poolId: "pool-1" });
    assert.equal((store.chooseHost(linux) as { host: { hostId: string } }).host.hostId, "linux-a", "the Linux project never lands on the Windows worker");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a disabled host keeps its work but takes no new job", () => {
  const { store, directory } = newStore();
  try {
    store.registerHost({ hostId: "linux-a", address: "a.internal", os: "linux", sshUser: "slice", runnerRoot: "/srv/slice" });
    const demo = project(store);
    store.setHostEnabled("linux-a", false);
    const placement = store.chooseHost(demo);
    assert.equal((placement as { reason: string }).reason, "host_disabled");
    store.setHostEnabled("linux-a", true);
    assert.equal((store.chooseHost(demo) as { host: { hostId: string } }).host.hostId, "linux-a");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a pool places jobs on hosts with free capacity and refuses when every host is full", () => {
  const { store, directory } = newStore();
  try {
    store.registerHost({ hostId: "linux-a", address: "a.internal", os: "linux", sshUser: "slice", runnerRoot: "/srv/slice", capacity: 1 });
    store.registerHost({ hostId: "linux-b", address: "b.internal", os: "linux", sshUser: "slice", runnerRoot: "/srv/slice", capacity: 2 });
    store.registerPool({ poolId: "pool-1", hosts: ["linux-a", "linux-b"] });
    const demo = project(store, { poolId: "pool-1" });

    const occupy = (index: number, hostId: string): string => {
      const job = store.createJob({ requestId: `r${index}`, payloadHash: `h${index}`, projectId: "demo", title: `Job ${index}`, requestText: "work", issue: null }).job;
      store.upsertWorkspace({ jobId: job.jobId, hostId, repoPath: `/srv/slice/${job.jobId}/repo`, worktreePath: `/srv/slice/${job.jobId}/author`, branch: `slice/${job.jobId}/x`, baseCommit: "abc1234", leaseGeneration: 1 });
      return job.jobId;
    };

    // Job 1 takes the first host with room.
    assert.equal((store.chooseHost(demo, "job-1") as { host: { hostId: string } }).host.hostId, "linux-a");
    const first = occupy(1, "linux-a");

    // Job 2 cannot use the full host and takes the next one.
    assert.equal((store.chooseHost(demo, "job-2") as { host: { hostId: string } }).host.hostId, "linux-b");
    occupy(2, "linux-b");
    occupy(3, "linux-b");
    const full = store.chooseHost(demo, "job-4");
    assert.equal((full as { reason: string }).reason, "no_host_capacity");
    assert.ok((full as { detail: string }).detail.includes("linux-b 2/2"), "the reason reports the actual occupancy");

    // A job's own workspace never blocks its own re-placement (delivery re-runs on the same host).
    assert.equal((store.chooseHost(demo, first) as { host: { hostId: string } }).host.hostId, "linux-a");

    // Capacity is only handed back once cleanup is confirmed.
    store.releaseWorkspace(first);
    assert.equal(store.activeHostCount("linux-a"), 0);
    assert.equal((store.chooseHost(demo, "job-4") as { host: { hostId: string } }).host.hostId, "linux-a");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a cancelled job releases its host slot without any cleanup", () => {
  const { store, directory } = newStore();
  try {
    store.registerHost({ hostId: "linux-a", address: "a.internal", os: "linux", sshUser: "slice", runnerRoot: "/srv/slice", capacity: 1 });
    const demo = project(store);
    store.createJob({ requestId: "r1", payloadHash: "h1", projectId: "demo", title: "One", requestText: "one", issue: null });
    const job = store.listJobs()[0]!;
    store.upsertWorkspace({ jobId: job.jobId, hostId: "linux-a", repoPath: "/srv/slice/repo", worktreePath: "/srv/slice/author", branch: "slice/x/y", baseCommit: "abc1234", leaseGeneration: 1 });
    assert.equal(store.activeHostCount("linux-a"), 1);
    store.setRunState(job.jobId, ["running"], "cancelled");
    assert.equal(store.activeHostCount("linux-a"), 0, "a cancelled job does not hold a worker slot");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("project model rules refuse a provider the project does not allow", () => {
  const { store, directory } = newStore();
  try {
    store.registerHost({ hostId: "linux-a", address: "a.internal", os: "linux", sshUser: "slice", runnerRoot: "/srv/slice" });
    store.createProject({
      projectId: "private", repoSlug: "owner/private", defaultBranch: "main", hostId: "linux-a", buildProfile: PROFILE,
      modelRules: { allowedProviders: ["ollama"], allowCloud: false },
    });
    const privateProject = store.getProject("private")!;
    assert.deepEqual(privateProject.modelRules, { allowedProviders: ["ollama"], allowedModelIds: [], allowCloud: false, localOnlyRoles: [] });

    assert.equal(modelPolicyViolation(privateProject, "author", { provider: "ollama", modelId: "llama-3" }, { localProviders: ["ollama"] }), null);
    const violation = modelPolicyViolation(privateProject, "author", { provider: "openai-codex", modelId: "gpt-6-luna" }, { localProviders: ["ollama"] });
    assert.ok(violation !== null && violation.includes("allows providers ollama"), violation ?? "no violation stated");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("forbidding cloud models with no local provider configured is refused, not guessed", () => {
  const { store, directory } = newStore();
  try {
    store.registerHost({ hostId: "linux-a", address: "a.internal", os: "linux", sshUser: "slice", runnerRoot: "/srv/slice" });
    store.createProject({ projectId: "private", repoSlug: "owner/private", defaultBranch: "main", hostId: "linux-a", buildProfile: PROFILE, modelRules: { allowCloud: false } });
    const violation = modelPolicyViolation(store.getProject("private")!, "code-review", { provider: "openai-codex", modelId: "gpt-6-luna" }, modelPolicy({}));
    assert.ok(violation !== null && violation.includes("forbids cloud providers") && violation.includes("SLICE_LOCAL_PROVIDERS"), violation ?? "no violation stated");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a role listed as local-only is checked even when cloud is allowed", () => {
  const { store, directory } = newStore();
  try {
    store.registerHost({ hostId: "linux-a", address: "a.internal", os: "linux", sshUser: "slice", runnerRoot: "/srv/slice" });
    store.createProject({ projectId: "mixed", repoSlug: "owner/mixed", defaultBranch: "main", hostId: "linux-a", buildProfile: PROFILE, modelRules: { localOnlyRoles: ["security-review"] } });
    const mixed = store.getProject("mixed")!;
    const policy = modelPolicy({ SLICE_LOCAL_PROVIDERS: "ollama, llama.cpp" });
    assert.equal(modelPolicyViolation(mixed, "author", { provider: "openai-codex", modelId: "gpt-6-luna" }, policy), null);
    const violation = modelPolicyViolation(mixed, "security-review", { provider: "openai-codex", modelId: "gpt-6-luna" }, policy);
    assert.ok(violation !== null && violation.includes("requires the security-review role to run locally"), violation ?? "no violation stated");
    assert.equal(modelPolicyViolation(mixed, "security-review", { provider: "llama.cpp", modelId: "local-1" }, policy), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("model rules are normalised so a malformed rule never reaches a role conversation", () => {
  const { store, directory } = newStore();
  try {
    store.registerHost({ hostId: "linux-a", address: "a.internal", os: "linux", sshUser: "slice", runnerRoot: "/srv/slice" });
    store.createProject({
      projectId: "odd", repoSlug: "owner/odd", defaultBranch: "main", hostId: "linux-a", buildProfile: PROFILE,
      // Deliberately hostile: wrong types, oversized lists, a path-shaped name, and mixed case.
      modelRules: { allowedProviders: ["OpenAI-Codex", 42, "../secrets", "x".repeat(200)] as unknown as string[], allowedModelIds: "not-an-array" as unknown as string[], allowCloud: "yes" as unknown as boolean },
    });
    const rules = store.getProject("odd")!.modelRules;
    assert.deepEqual(rules.allowedProviders, ["openai-codex"], "only well-formed names survive, lowercased");
    assert.deepEqual(rules.allowedModelIds, []);
    assert.equal(rules.allowCloud, true, "a non-boolean is not a refusal");
    assert.equal(modelPolicyViolation(store.getProject("odd")!, "author", { provider: "openai-codex", modelId: "any" }, { localProviders: [] }), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a declared toolchain is only satisfied by an attestation that actually passed on that host", () => {
  const { store, directory } = newStore();
  try {
    store.registerHost({ hostId: "win-a", address: "w.internal", os: "windows", sshUser: "slice", runnerRoot: "D:/slice" });
    const win = project(store, { projectId: "win", requiredOs: "windows", hostId: "win-a", toolchain: [{ id: "node", command: "node --version" }, { id: "git", command: "git --version" }] });
    assert.deepEqual(win.toolchain, [{ id: "node", command: "node --version" }, { id: "git", command: "git --version" }]);

    // Nothing has been probed yet: the project is not ready, and the reason says so.
    const missing = store.toolchainReady(win, "win-a");
    assert.equal(missing.ready, false);
    assert.ok(!missing.ready && missing.reason.includes("no toolchain attestation"), missing.reason);

    store.recordAttestation({ hostId: "win-a", projectId: "win", profileRevision: win.revision, passed: false, tools: [
      { id: "node", command: "node --version", exitCode: 1, version: null, outputTail: "not found" },
    ] });
    const failed = store.toolchainReady(win, "win-a");
    assert.equal(failed.ready, false);
    assert.ok(!failed.ready && failed.reason.includes("failed"), failed.reason);

    store.recordAttestation({ hostId: "win-a", projectId: "win", profileRevision: win.revision, passed: true, tools: [
      { id: "node", command: "node --version", exitCode: 0, version: "v22.19.0", outputTail: "" },
    ] });
    const partial = store.toolchainReady(win, "win-a");
    assert.equal(partial.ready, false);
    assert.ok(!partial.ready && partial.reason.includes("git was never probed"), partial.reason);

    store.recordAttestation({ hostId: "win-a", projectId: "win", profileRevision: win.revision, passed: true, tools: [
      { id: "node", command: "node --version", exitCode: 0, version: "v22.19.0", outputTail: "" },
      { id: "git", command: "git --version", exitCode: 0, version: "git version 2.47.0", outputTail: "" },
    ] });
    assert.deepEqual(store.toolchainReady(win, "win-a"), { ready: true });

    // A different host is not covered by this host's attestation.
    store.registerHost({ hostId: "win-b", address: "w2.internal", os: "windows", sshUser: "slice", runnerRoot: "D:/slice2" });
    assert.equal(store.toolchainReady(win, "win-b").ready, false, "attestations are per host");

    // Changing the project bumps its revision and invalidates the attestation.
    const bumped = store.setProjectStatus("win", "paused")!;
    assert.notEqual(bumped.revision, win.revision);
    const stale = store.toolchainReady(bumped, "win-a");
    assert.equal(stale.ready, false);
    assert.ok(!stale.ready && stale.reason.includes("profile revision"), stale.reason);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an attestation cannot smuggle a command the project did not declare", () => {
  const { store, directory } = newStore();
  try {
    store.registerHost({ hostId: "win-a", address: "w.internal", os: "windows", sshUser: "slice", runnerRoot: "D:/slice" });
    const win = project(store, { projectId: "win", requiredOs: "windows", hostId: "win-a", toolchain: [{ id: "node", command: "node --version" }] });
    store.recordAttestation({ hostId: "win-a", projectId: "win", profileRevision: win.revision, passed: true, tools: [
      // Same tool id, different command: the probe that ran is not the probe the project asked for.
      { id: "node", command: "node -e process.exit(0)", exitCode: 0, version: "v22.19.0", outputTail: "" },
    ] });
    const result = store.toolchainReady(win, "win-a");
    assert.equal(result.ready, false);
    assert.ok(!result.ready && result.reason.includes("different command"), result.reason);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a Windows project cannot be created without a toolchain, and hostile tool entries are dropped", () => {
  const { store, directory } = newStore();
  try {
    store.registerHost({ hostId: "win-a", address: "w.internal", os: "windows", sshUser: "slice", runnerRoot: "D:/slice" });
    assert.throws(() => store.createProject({ projectId: "bad", repoSlug: "owner/bad", defaultBranch: "main", hostId: "win-a", requiredOs: "windows", buildProfile: PROFILE }),
      /must declare the toolchain/);
    store.createProject({
      projectId: "odd", repoSlug: "owner/odd", defaultBranch: "main", hostId: "win-a", requiredOs: "windows", buildProfile: PROFILE,
      toolchain: [
        { id: "node", command: "node --version" },
        { id: "evil", command: "node --version && calc.exe" },
        { id: "../escape", command: "node --version" },
        { id: "pipe", command: "node --version | head" },
      ],
    });
    assert.deepEqual(store.getProject("odd")!.toolchain, [{ id: "node", command: "node --version" }], "only a plain argv probe with a safe id survives");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
