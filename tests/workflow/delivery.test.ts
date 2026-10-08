import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { PiDurableAdapter } from "../../apps/server/src/adapters/pi-durable/pi-durable-adapter.js";
import { ApplicationStateStore } from "../../apps/server/src/state/application-state.js";
import { WorkflowStore } from "../../apps/server/src/records/workflow-store.js";
import { DeliveryStore } from "../../apps/server/src/records/delivery-store.js";
import { ExternalOperationJournal } from "../../apps/server/src/workflow/external-operation-journal.js";
import { JobCoordinator } from "../../apps/server/src/workflow/coordinator.js";
import { GATE_CHECK_CONTEXTS, DeliveryLoop, parseAuthorOutput, parseReviewOutput, validatePatch } from "../../apps/server/src/workflow/delivery.js";
import { roleProfiles } from "../../apps/server/src/workflow/role-config.js";
import { LocalRunnerTransport } from "../../apps/server/src/adapters/ssh-runner/runner-transport.js";
import { RunnerAdapter } from "../../apps/server/src/adapters/ssh-runner/runner-adapter.js";
import { GitBundlePublisher } from "../../apps/server/src/adapters/git/branch-publisher.js";
import type { GitHost, PullRequestInfo, StatusContext } from "../../apps/server/src/adapters/github/git-host.js";

const RUNNER_ENTRY = join(process.cwd(), "dist/runner/main.js");

const READY_JSON = '{"kind":"ready","summary":"Add a notes file.","criteria":[{"id":"c1","text":"notes.md exists with content"}]}';
const PASS_JSON = '{"verdict":"pass","scope":"the full patch and changed files","findings":[]}';
const FINDING_JSON = '{"verdict":"changes_required","scope":"the full patch","findings":[{"id":"f1","severity":"high","category":"correctness","file":"notes.md","claim":"the note is wrong","impact":"staff are misinformed","correction":"state the correct fact","verification":"re-read the file","status":"open"}]}';
const RESOLVED_JSON = '{"verdict":"pass","scope":"the new head","findings":[{"id":"f1","severity":"high","category":"correctness","file":"notes.md","claim":"the note is wrong","impact":"staff are misinformed","correction":"state the correct fact","verification":"re-read the file","status":"verified_fixed"}]}';

/** Git with a normalized diff format: the host user's global diff settings must not leak into fixtures. */
function git(args: string[], cwd?: string): string {
  const base = ["-c", "diff.mnemonicprefix=false", "-c", "diff.noprefix=false", "-c", "diff.algorithm=histogram"];
  const result = spawnSync("git", cwd === undefined ? [...base, ...args] : ["-C", cwd, ...base, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function makeSourceRepo(directory: string): string {
  const source = join(directory, "source");
  mkdirSync(source);
  git(["init", "-q", "-b", "main", source]);
  writeFileSync(join(source, "check.js"), "const fs = require('node:fs');\nif (fs.existsSync('check-expect.txt') && fs.readFileSync('check-expect.txt','utf8').trim() !== 'ok') process.exit(1);\nconsole.log('check ok');\n");
  git(["add", "-A"], source);
  git(["-c", "user.email=slice@example.invalid", "-c", "user.name=Slice Test", "commit", "-q", "-m", "demo baseline"], source);
  return source;
}

function gitConfig(): string[] {
  return ["-c", "user.email=slice@example.invalid", "-c", "user.name=Slice Test"];
}

let patchWorkIndex = 0;

/** Build a real, applyable git patch by mutating a scratch clone; prep commits the simulated prior round. */
function makePatch(sourceDir: string, tmpDir: string, mutate: (work: string) => void, prep?: (work: string) => void): string {
  const work = join(tmpDir, `patchwork-${patchWorkIndex++}`);
  git(["clone", "-q", sourceDir, work]);
  if (prep !== undefined) {
    prep(work);
    git(["add", "-A"], work);
    git([...gitConfig(), "commit", "-q", "-m", "simulated prior round"], work);
  }
  mutate(work);
  git(["add", "-A"], work);
  return git(["diff", "--cached", "--no-color"], work);
}

function patchJson(patch: string): string {
  return JSON.stringify({ kind: "patch", summary: "slice change", patch });
}

type FakePr = {
  number: number;
  head: string;
  base: string;
  title: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  mergedRevision: string | null;
  statuses: Map<string, Map<string, "success" | "failure" | "pending">>;
};

/** An in-memory stand-in for GitHub with the same capability surface: no merge method exists. */
class FakeGitHost implements GitHost {
  readonly prs: FakePr[] = [];
  createAttempts = 0;
  /** Simulates the host accepting a PR while the service crashes before recording it. */
  throwAfterCreate = 0;
  #nextNumber = 1;

  constructor(readonly originDir: string) {}

  remoteHead(branch: string): string | null {
    const out = spawnSync("git", ["ls-remote", "--exit-code", this.originDir, `refs/heads/${branch}`], { encoding: "utf8" });
    if (out.status === 2) return null;
    if (out.status !== 0) throw new Error(`ls-remote failed: ${out.stderr}`);
    const sha = out.stdout.split("\t")[0]?.trim() ?? "";
    return sha.length > 0 ? sha : null;
  }

  #dto(pr: FakePr): PullRequestInfo {
    return {
      number: pr.number,
      url: `https://github.example/pull/${pr.number}`,
      title: pr.title,
      state: pr.state,
      draft: pr.draft,
      headSha: this.remoteHead(pr.head) ?? "",
      baseSha: "0123456789abcdef0123456789abcdef01234567",
      mergedRevision: pr.mergedRevision,
    };
  }

  async findPrByHeadBranch(_repoSlug: string, branch: string): Promise<PullRequestInfo | null> {
    const pr = this.prs.find((entry) => entry.head === branch);
    return pr === undefined ? null : this.#dto(pr);
  }

  async createDraftPr(_repoSlug: string, input: { title: string; head: string; base: string; body: string }): Promise<PullRequestInfo> {
    this.createAttempts += 1;
    const pr: FakePr = { number: this.#nextNumber++, head: input.head, base: input.base, title: input.title, state: "open", draft: true, mergedRevision: null, statuses: new Map() };
    this.prs.push(pr);
    if (this.throwAfterCreate > 0) {
      this.throwAfterCreate -= 1;
      throw new Error("simulated outage after the host accepted the PR");
    }
    return this.#dto(pr);
  }

  async setDraft(_repoSlug: string, prNumber: number, draft: boolean): Promise<PullRequestInfo> {
    const pr = this.prs.find((entry) => entry.number === prNumber);
    if (pr === undefined) throw new Error(`PR ${prNumber} not found`);
    pr.draft = draft;
    return this.#dto(pr);
  }

  async getPr(_repoSlug: string, prNumber: number): Promise<PullRequestInfo | null> {
    const pr = this.prs.find((entry) => entry.number === prNumber);
    return pr === undefined ? null : this.#dto(pr);
  }

  async publishStatus(_repoSlug: string, commitSha: string, context: string, state: StatusContext["state"], _description: string): Promise<void> {
    const pr = this.prs.at(-1);
    if (pr === undefined) throw new Error("no PR to publish against");
    const byContext = pr.statuses.get(commitSha) ?? new Map<string, "success" | "failure" | "pending">();
    byContext.set(context, state);
    pr.statuses.set(commitSha, byContext);
  }

  async listStatuses(_repoSlug: string, commitSha: string): Promise<StatusContext[]> {
    const out: StatusContext[] = [];
    for (const pr of this.prs) {
      const byContext = pr.statuses.get(commitSha);
      if (byContext === undefined) continue;
      for (const [context, state] of byContext) out.push({ context, state, description: "" });
    }
    return out;
  }

  // Test-only helpers: the owner's actions on the host, never callable from the service.
  ownerMerge(prNumber: number): string {
    const pr = this.prs.find((entry) => entry.number === prNumber);
    if (pr === undefined) throw new Error(`PR ${prNumber} not found`);
    pr.state = "merged";
    pr.mergedRevision = "deadbeef0123456789abcdef0123456789abcd";
    return pr.mergedRevision;
  }

  ownerClose(prNumber: number): void {
    const pr = this.prs.find((entry) => entry.number === prNumber);
    if (pr !== undefined) pr.state = "closed";
  }
}

type Harness = {
  coordinator: JobCoordinator;
  delivery: DeliveryLoop;
  deliveryStore: DeliveryStore;
  workflows: WorkflowStore;
  gitHost: FakeGitHost;
  originDir: string;
  runnerRoot: string;
  artifactsDir: string;
  scriptResponses: (scripts: Record<string, string[]>) => void;
  close: () => Promise<void>;
};

async function newHarness(): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "slice-delivery-"));
  const source = makeSourceRepo(directory);
  const originDir = join(directory, "origin.git");
  git(["clone", "--bare", "-q", source, originDir]);
  git(["-C", originDir, "symbolic-ref", "HEAD", "refs/heads/main"]);
  const originUrl = `file://${originDir}`;

  const runnerRoot = join(directory, "runner-root");
  mkdirSync(runnerRoot, { mode: 0o700 });
  writeFileSync(join(runnerRoot, ".runner.json"), JSON.stringify({ allowedSources: [originUrl] }));
  const transport = new LocalRunnerTransport(RUNNER_ENTRY, runnerRoot);

  const state = ApplicationStateStore.open(join(directory, "state.sqlite"));
  const workflows = WorkflowStore.open(state.database);
  const deliveryStore = DeliveryStore.open(state.database);
  const journal = new ExternalOperationJournal(state.database);
  const runner = new RunnerAdapter(journal, () => transport, { pollIntervalMs: 100, pollLimitMs: 30_000 });

  workflows.registerHost({ hostId: "runner-a", address: "localhost", os: "linux", sshUser: "slice", runnerRoot });
  workflows.createProject({
    projectId: "demo",
    repoSlug: "owner/demo",
    defaultBranch: "main",
    hostId: "runner-a",
    buildProfile: { setup: [], checks: [{ id: "test", command: "node check.js" }] },
    gitRemoteUrl: originUrl,
  });

  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "req-1" }, { id: "author-1" }, { id: "review-1" }, { id: "security-1" }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const adapter = await PiDurableAdapter.open({
    durableDatabasePath: join(directory, "state.sqlite"),
    state,
    models,
    registry: createRegistry(),
  });

  const gitHost = new FakeGitHost(originDir);
  const artifactsDir = join(directory, "artifacts");
  const delivery = new DeliveryLoop({
    adapter,
    workflows,
    delivery: deliveryStore,
    runner,
    gitHost,
    publisher: new GitBundlePublisher(directory),
    journal,
    profiles: {
      author: { provider: "faux", modelId: "author-1" },
      codeReview: { provider: "faux", modelId: "review-1" },
      securityReview: { provider: "faux", modelId: "security-1" },
    },
    artifactsDir,
  });
  const coordinator = new JobCoordinator(adapter, workflows, { provider: "faux", modelId: "req-1" }, runner, delivery);

  return {
    coordinator,
    delivery,
    deliveryStore,
    workflows,
    gitHost,
    originDir,
    runnerRoot,
    artifactsDir,
    scriptResponses: (scripts) => {
      const calls: Record<string, number> = {};
      const step: FauxResponseStep = (_context, _options, _state, model) => {
        const index = calls[model.id] ?? 0;
        calls[model.id] = index + 1;
        const list = scripts[model.id] ?? [];
        const text = list[Math.min(index, Math.max(list.length - 1, 0))];
        // An exhausted script blocks visibly; tests never pass by accident.
        return fauxAssistantMessage(text ?? '{"kind":"blocked","reason":"script exhausted"}');
      };
      faux.setResponses(Array.from({ length: 60 }, () => step));
    },
    close: async () => {
      await adapter.close();
      state.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function createReadyJob(h: Harness, requestId: string, authorPatches: string[]): Promise<string> {
  h.scriptResponses({
    "req-1": [READY_JSON],
    "author-1": authorPatches.map(patchJson),
    "review-1": [PASS_JSON],
    "security-1": [PASS_JSON],
  });
  const job = await h.coordinator.createJob({ requestId, payloadHash: `hash-${requestId}`, projectId: "demo", title: "Add notes", requestText: "Add a notes file", issue: null });
  return job.jobId;
}

test("a clean change runs author, checks, dual review, the gate, and publishing to ready", async () => {
  const h = await newHarness();
  try {
    const patch = makePatch(h.originDir, h.artifactsDir, (work) => writeFileSync(join(work, "notes.md"), "office notes\n"));
    const jobId = await createReadyJob(h, "req1", [patch]);
    const delivery = h.deliveryStore.getDelivery(jobId)!;
    assert.equal(delivery.stage, "ready");
    assert.equal(delivery.gateVerdict, "pass");
    assert.equal(delivery.prState, "ready");
    assert.equal(delivery.prNumber, 1);
    assert.equal(h.gitHost.createAttempts, 1);

    const branch = h.workflows.getWorkspace(jobId)!.branch;
    const remoteHead = h.gitHost.remoteHead(branch);
    assert.equal(remoteHead, delivery.headCommit, "the pushed branch head is the reviewed commit");

    const statuses = await h.gitHost.listStatuses("owner/demo", delivery.headCommit);
    for (const context of GATE_CHECK_CONTEXTS) {
      assert.ok(statuses.some((status) => status.context === context && status.state === "success"), `${context} was published`);
    }

    const reviews = h.deliveryStore.listReviewReports(jobId);
    assert.deepEqual(reviews.map((report) => report.role), ["code-review", "security-review"]);
    assert.notEqual(reviews[0]!.modelId, reviews[1]!.modelId, "the two reviewers used distinct model identities");
    assert.equal(h.deliveryStore.listArtifacts(jobId).some((artifact) => artifact.kind === "patch"), true);
  } finally {
    await h.close();
  }
});

test("a blocking review finding blocks the gate, is repaired, and both reviews re-run on the new commit", async () => {
  const h = await newHarness();
  try {
    const patch1 = makePatch(h.originDir, h.artifactsDir, (work) => writeFileSync(join(work, "notes.md"), "wrong note\n"));
    const patch2 = makePatch(h.originDir, h.artifactsDir, (work) => writeFileSync(join(work, "notes.md"), "correct note\n"), (work) => writeFileSync(join(work, "notes.md"), "wrong note\n"));
    h.scriptResponses({
      "req-1": [READY_JSON],
      "author-1": [patchJson(patch1), patchJson(patch2)],
      "review-1": [FINDING_JSON, RESOLVED_JSON],
      "security-1": [PASS_JSON, PASS_JSON],
    });
    const job = await h.coordinator.createJob({ requestId: "req2", payloadHash: "hash-req2", projectId: "demo", title: "Add notes", requestText: "Add a notes file", issue: null });
    const delivery = h.deliveryStore.getDelivery(job.jobId);
    assert.equal(delivery!.stage, "ready");
    assert.equal(delivery!.round, 2, "the finding forced a second authoring round");

    const gateEvents = h.workflows.eventsAfter(job.jobId, 0).filter((event) => event.type === "gate_evaluated");
    assert.deepEqual(gateEvents.map((event) => (event.payload as { verdict: string }).verdict), ["blocked", "pass"]);

    const findings = h.deliveryStore.listFindings(job.jobId);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.status, "verified_fixed");
    assert.ok(findings[0]!.resolvedBy!.includes("code-review"), "only the originating role resolved its finding");

    const reviews = h.deliveryStore.listReviewReports(job.jobId);
    assert.equal(reviews.length, 4, "both reviews re-ran on the new head");
    assert.notEqual(reviews[0]!.verificationKey, reviews[2]!.verificationKey, "the round-1 approvals are bound to the old head");
    assert.equal(delivery!.headCommit, h.gitHost.remoteHead(h.workflows.getWorkspace(job.jobId)!.branch));
  } finally {
    await h.close();
  }
});

test("an intentionally faulty author output fails the checks, is fixed, and only then reaches ready", async () => {
  const h = await newHarness();
  try {
    const broken = makePatch(h.originDir, h.artifactsDir, (work) => {
      writeFileSync(join(work, "notes.md"), "note\n");
      writeFileSync(join(work, "check-expect.txt"), "broken\n");
    });
    const fixed = makePatch(h.originDir, h.artifactsDir, (work) => writeFileSync(join(work, "check-expect.txt"), "ok\n"), (work) => {
      writeFileSync(join(work, "notes.md"), "note\n");
      writeFileSync(join(work, "check-expect.txt"), "broken\n");
    });
    const jobId = await createReadyJob(h, "req3", [broken, fixed]);
    const delivery = h.deliveryStore.getDelivery(jobId);
    assert.equal(delivery!.round, 2);
    assert.equal(delivery!.stage, "ready");
    const events = h.workflows.eventsAfter(jobId, 0).map((event) => event.type);
    assert.ok(events.includes("checks_failed"), "the faulty round is recorded, not hidden");
    assert.ok(events.includes("ready_for_owner"));
  } finally {
    await h.close();
  }
});

test("the round limit blocks the job instead of forcing agreement", async () => {
  const h = await newHarness();
  try {
    // Four distinct faulty patches, each applicable to the previous round's head.
    const broken = [1, 2, 3, 4].map((n) => makePatch(
      h.originDir,
      h.artifactsDir,
      (work) => writeFileSync(join(work, "check-expect.txt"), `broken ${n}\n`),
      n === 1 ? undefined : (work) => writeFileSync(join(work, "check-expect.txt"), `broken ${n - 1}\n`),
    ));
    const jobId = await createReadyJob(h, "req4", broken);
    const delivery = h.deliveryStore.getDelivery(jobId);
    const job = h.workflows.getJob(jobId)!;
    assert.equal(job.runState, "blocked");
    assert.equal(delivery!.round, 4, "at most four review and repair rounds");
    assert.equal(delivery!.gateVerdict, "blocked");
    assert.equal(delivery!.stage, "gate");
    assert.equal(delivery!.prNumber, null, "nothing is published for a job that never passed the gate");
  } finally {
    await h.close();
  }
});

test("a verified merge archives the job, cleans only its workspace, and keeps evidence", async () => {
  const h = await newHarness();
  try {
    const patch = makePatch(h.originDir, h.artifactsDir, (work) => writeFileSync(join(work, "notes.md"), "office notes\n"));
    const jobId = await createReadyJob(h, "req5", [patch]);
    const before = h.deliveryStore.getDelivery(jobId)!;
    const mergedRevision = h.gitHost.ownerMerge(before.prNumber!);

    const outcome = await h.delivery.observeMerge(jobId);
    assert.equal(outcome, "merged");
    const delivery = h.deliveryStore.getDelivery(jobId)!;
    assert.equal(delivery.archiveState, "archived");
    assert.equal(delivery.mergedRevision, mergedRevision);
    assert.equal(delivery.cleanupState, "cleaned");
    assert.equal(h.workflows.getJob(jobId)!.runState, "completed", "a merged thread is finished, not waiting");
    assert.equal(existsSync(join(h.runnerRoot, jobId)), false, "the job workspace is gone");
    assert.equal(existsSync(join(h.runnerRoot, "job-other")), false);

    const packet = h.deliveryStore.getArtifact(jobId, "final-packet")!;
    assert.ok(existsSync(packet.path), "the final packet survives workspace cleanup");
    const content = JSON.parse(readFileSync(packet.path, "utf8")) as { reviews: unknown[]; checks: unknown[]; pr: { mergedRevision: string | null } };
    assert.equal(content.reviews.length, 2);
    assert.ok(content.checks.length >= 2, "baseline plus head checks are retained");
    assert.equal(content.pr.mergedRevision, mergedRevision);
    assert.ok(h.deliveryStore.listArtifacts(jobId).some((artifact) => artifact.kind === "patch"));
  } finally {
    await h.close();
  }
});

test("a PR closed without a merge does not archive the job or clean the workspace", async () => {
  const h = await newHarness();
  try {
    const patch = makePatch(h.originDir, h.artifactsDir, (work) => writeFileSync(join(work, "notes.md"), "office notes\n"));
    const jobId = await createReadyJob(h, "req6", [patch]);
    h.gitHost.ownerClose(1);
    const outcome = await h.delivery.observeMerge(jobId);
    assert.equal(outcome, "closed");
    const delivery = h.deliveryStore.getDelivery(jobId)!;
    assert.equal(delivery.archiveState, "active", "a closed PR is not merge confirmation");
    assert.equal(delivery.cleanupState, "available");
    assert.equal(existsSync(join(h.runnerRoot, jobId)), true);
  } finally {
    await h.close();
  }
});

test("an outage after the host accepted the PR finds the existing PR instead of creating a second", async () => {
  const h = await newHarness();
  try {
    const patch = makePatch(h.originDir, h.artifactsDir, (work) => writeFileSync(join(work, "notes.md"), "office notes\n"));
    h.gitHost.throwAfterCreate = 1;
    const jobId = await createReadyJob(h, "req7", [patch]);
    let delivery = h.deliveryStore.getDelivery(jobId)!;
    assert.equal(delivery.stage, "publishing", "the outage leaves the job in publishing, not failed");

    await h.delivery.advance(jobId);
    delivery = h.deliveryStore.getDelivery(jobId)!;
    assert.equal(delivery.stage, "ready");
    assert.equal(h.gitHost.createAttempts, 1, "the recorded PR was found, not recreated");
    assert.equal(h.gitHost.prs.length, 1);
  } finally {
    await h.close();
  }
});

test("steering a ready job withdraws readiness, returns the PR to draft, and re-runs the full gate", async () => {
  const h = await newHarness();
  try {
    const patch1 = makePatch(h.originDir, h.artifactsDir, (work) => writeFileSync(join(work, "notes.md"), "first note\n"));
    const patch2 = makePatch(h.originDir, h.artifactsDir, (work) => writeFileSync(join(work, "notes.md"), "second note\n"), (work) => writeFileSync(join(work, "notes.md"), "first note\n"));
    h.scriptResponses({
      "req-1": [READY_JSON, READY_JSON],
      "author-1": [patchJson(patch1), patchJson(patch2)],
      "review-1": [PASS_JSON, PASS_JSON],
      "security-1": [PASS_JSON, PASS_JSON],
    });
    const job = await h.coordinator.createJob({ requestId: "req8", payloadHash: "hash-req8", projectId: "demo", title: "Add notes", requestText: "Add a notes file", issue: null });
    const firstHead = h.deliveryStore.getDelivery(job.jobId)!.headCommit;
    h.deliveryStore.recordAcceptance(job.jobId, "some-key");

    const steered = await h.coordinator.steer(job.jobId, "steer-1", "hash-s1", job.commandRevision, "change the note wording");
    assert.equal(steered.recorded, true);
    const delivery = h.deliveryStore.getDelivery(job.jobId)!;
    assert.notEqual(delivery.headCommit, firstHead, "the instruction produced a new head");
    assert.equal(delivery.stage, "ready", "the new revision passed the full gate again");
    const events = h.workflows.eventsAfter(job.jobId, 0).map((event) => event.type);
    assert.ok(events.includes("readiness_withdrawn"));
    assert.equal(h.deliveryStore.getAcceptance(job.jobId)!.stale, true, "acceptance of the old result is stale");
    assert.equal(h.gitHost.prs.length, 1, "the follow-up reused the same PR");
  } finally {
    await h.close();
  }
});

test("patch validation refuses protected areas, escapes, and non-diffs", () => {
  assert.equal(validatePatch("not a diff").ok, false);
  assert.equal(validatePatch("").ok, false);
  const protectedPatch = "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\n--- a/.github/workflows/ci.yml\n+++ b/.github/workflows/ci.yml\n@@ -1 +1 @@\n-x\n+y\n";
  const r1 = validatePatch(protectedPatch);
  assert.equal(r1.ok, false, "the author cannot edit its own gate");
  const escape = "diff --git a/../../etc/passwd b/../../etc/passwd\n--- a/../../etc/passwd\n+++ b/../../etc/passwd\n@@ -1 +1 @@\n-x\n+y\n";
  assert.equal(validatePatch(escape).ok, false);
  const absolute = "diff --git a/x b/x\n--- a//etc/passwd\n+++ b/x\n@@ -1 +1 @@\n-x\n+y\n";
  const r3 = validatePatch(absolute);
  assert.equal(r3.ok, false, "absolute source paths are refused");
  const ok = "diff --git a/notes.md b/notes.md\n--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n-x\n+y\n";
  const r4 = validatePatch(ok);
  assert.equal(r4.ok, true);
  if (r4.ok) assert.deepEqual(r4.files, ["notes.md"]);
});

test("author and review contracts reject everything outside their shapes", () => {
  assert.equal(parseAuthorOutput('{"kind":"patch","summary":"x"}'), null, "a patch without the diff is a failed task");
  assert.equal(parseAuthorOutput('{"kind":"approve","summary":"x","patch":"diff --git a/x b/x"}'), null);
  assert.equal(parseReviewOutput('{"verdict":"approve","scope":"x","findings":[]}'), null, "unknown verdicts are rejected");
  assert.equal(parseReviewOutput('{"verdict":"pass","scope":"x","findings":[{"id":"f1","severity":"blocking","category":"c","file":"f","claim":"c","impact":"i","correction":"c","verification":"v","status":"open"}]}'), null, "unknown severities are rejected");
});

test("role configuration refuses reviewers that are not distinct from the author", () => {
  const base = { SLICE_AUTHOR_PROVIDER: "p", SLICE_AUTHOR_MODEL_ID: "m1" };
  assert.throws(() => roleProfiles({
    ...base,
    SLICE_CODE_REVIEW_PROVIDER: "p", SLICE_CODE_REVIEW_MODEL_ID: "m1",
    SLICE_SECURITY_REVIEW_PROVIDER: "p", SLICE_SECURITY_REVIEW_MODEL_ID: "m2",
  }), /distinct/);
  assert.throws(() => roleProfiles({ ...base }), /configured together/);
  const ok = roleProfiles({
    ...base,
    SLICE_CODE_REVIEW_PROVIDER: "p", SLICE_CODE_REVIEW_MODEL_ID: "m2",
    SLICE_SECURITY_REVIEW_PROVIDER: "q", SLICE_SECURITY_REVIEW_MODEL_ID: "m1",
  });
  assert.ok(ok !== null);
});
