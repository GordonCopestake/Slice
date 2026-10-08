import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { PiDurableAdapter } from "../../apps/server/src/adapters/pi-durable/pi-durable-adapter.js";
import { ApplicationStateStore } from "../../apps/server/src/state/application-state.js";
import { WorkflowStore } from "../../apps/server/src/records/workflow-store.js";
import { DeliveryStore } from "../../apps/server/src/records/delivery-store.js";
import { ReleaseStore } from "../../apps/server/src/records/release-store.js";
import { ReleaseService } from "../../apps/server/src/workflow/releases.js";
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
    // A squash merge lands the reviewed head itself. The merged revision must be a real commit or a
    // rollback rehearsal against it could never restore anything.
    pr.mergedRevision = this.remoteHead(pr.head) ?? "";
    if (pr.mergedRevision.length === 0) throw new Error(`PR ${prNumber} has no pushed head to merge`);
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
  releases: ReleaseStore;
  releaseService: ReleaseService;
  runner: RunnerAdapter;
  workflows: WorkflowStore;
  gitHost: FakeGitHost;
  originDir: string;
  runnerRoot: string;
  artifactsDir: string;
  scriptResponses: (scripts: Record<string, string[]>) => void;
  close: () => Promise<void>;
};

async function newHarness(options: { preview?: boolean; policy?: { localProviders: string[] } } = {}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "slice-delivery-"));
  const source = makeSourceRepo(directory);
  let allowedBrowser: string | undefined;
  if (options.preview === true) {
    // A preview server in the source, and a registered fake browser that writes a PNG.
    writeFileSync(join(source, "preview-server.js"), "const http = require('node:http');\nconst port = Number(process.argv[2]);\nhttp.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<h1>preview</h1>'); }).listen(port, '127.0.0.1');\n");
    git(["add", "-A"], source);
    git([...gitConfig(), "commit", "-q", "-m", "preview server"], source);
    allowedBrowser = join(directory, "fake-browser.sh");
    writeFileSync(allowedBrowser, "#!/bin/sh\nfor arg in \"$@\"; do case \"$arg\" in --screenshot=*) printf '\\x89PNG fake' > \"${arg#--screenshot=}\";; esac; done\nexit 0\n", { mode: 0o755 });
  }
  const originDir = join(directory, "origin.git");
  git(["clone", "--bare", "-q", source, originDir]);
  git(["-C", originDir, "symbolic-ref", "HEAD", "refs/heads/main"]);
  const originUrl = `file://${originDir}`;

  const runnerRoot = join(directory, "runner-root");
  mkdirSync(runnerRoot, { mode: 0o700 });
  writeFileSync(join(runnerRoot, ".runner.json"), JSON.stringify({ allowedSources: [originUrl], ...(allowedBrowser === undefined ? {} : { allowedBrowser }) }));
  const transport = new LocalRunnerTransport(RUNNER_ENTRY, runnerRoot);

  const state = ApplicationStateStore.open(join(directory, "state.sqlite"));
  const workflows = WorkflowStore.open(state.database);
  const deliveryStore = DeliveryStore.open(state.database);
  const releaseStore = ReleaseStore.open(state.database);
  const journal = new ExternalOperationJournal(state.database);
  const runner = new RunnerAdapter(journal, () => transport, { pollIntervalMs: 100, pollLimitMs: 30_000 });

  // Capacity 2: a rollback rehearsal occupies a real worker slot, and these tests run one alongside
  // a job workspace that has not been reclaimed yet.
  workflows.registerHost({ hostId: "runner-a", address: "localhost", os: "linux", sshUser: "slice", runnerRoot, capacity: 2 });
  workflows.createProject({
    projectId: "demo",
    repoSlug: "owner/demo",
    defaultBranch: "main",
    hostId: "runner-a",
    buildProfile: { setup: [], checks: [{ id: "test", command: "node check.js" }] },
    gitRemoteUrl: originUrl,
    ...(options.preview === true ? { preview: { command: "node preview-server.js 8321", port: 8321, scenarios: [{ id: "home", route: "/", width: 800, height: 600 }] } } : {}),
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
  const releaseService = new ReleaseService({ workflows, releases: releaseStore, delivery: deliveryStore, runner, artifactsDir });
  const delivery = new DeliveryLoop({
    adapter,
    workflows,
    delivery: deliveryStore,
    runner,
    gitHost,
    releases: releaseStore,
    publisher: new GitBundlePublisher(directory),
    journal,
    profiles: {
      author: { provider: "faux", modelId: "author-1" },
      codeReview: { provider: "faux", modelId: "review-1" },
      securityReview: { provider: "faux", modelId: "security-1" },
    },
    artifactsDir,
    policy: options.policy ?? { localProviders: [] },
  });
  const coordinator = new JobCoordinator(adapter, workflows, { provider: "faux", modelId: "req-1" }, runner, delivery, options.policy ?? { localProviders: [] });

  return {
    coordinator,
    delivery,
    deliveryStore,
    releases: releaseStore,
    releaseService,
    runner,
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

test("two roles reporting the same finding id keep both findings", () => {
  const dir = mkdtempSync(join(tmpdir(), "slice-store-"));
  const database = new DatabaseSync(join(dir, "store.sqlite"));
  try {
    const store = DeliveryStore.open(database);
    store.ensureDelivery("job-ns", "abc1234");
    const base = { jobId: "job-ns", headCommit: "abc1234", requirementsRevision: 1, profileRevision: 1, repoSlug: "o/r", baseCommit: "abc1234", policyVersion: "p" };
    const finding = (severity: "low" | "critical") => ({ id: "F1", severity, category: "c", file: "f", claim: "a", impact: "i", correction: "x", verification: "v", status: "open" as const });
    store.recordReviewReport({ ...base, role: "code-review", verdict: "pass", provider: "p1", modelId: "m1", scope: "s", findings: [finding("low")] });
    store.recordReviewReport({ ...base, role: "security-review", verdict: "changes_required", provider: "p2", modelId: "m2", scope: "s", findings: [finding("critical")] });
    // A later report resolves using the namespaced id shown in its context; the id is not doubled.
    store.recordReviewReport({ ...base, role: "code-review", verdict: "pass", provider: "p1", modelId: "m1", scope: "s", findings: [{ ...finding("low"), id: "code-review:F1", status: "verified_fixed" as const }] });
    const findings = store.listFindings("job-ns");
    assert.equal(findings.length, 2, "a name collision must not swallow the security finding");
    assert.equal(findings.find((f) => f.id === "code-review:F1")?.status, "verified_fixed");
    assert.equal(store.openBlockingFindings("job-ns").length, 1);
  } finally {
    database.close();
    rmSync(dir, { recursive: true, force: true });
  }
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

test("preview evidence: baseline and after screenshots come from the running preview and survive cleanup", async () => {
  const h = await newHarness({ preview: true });
  try {
    const patch = makePatch(h.originDir, h.artifactsDir, (work) => writeFileSync(join(work, "notes.md"), "office notes\n"));
    const jobId = await createReadyJob(h, "req9", [patch]);

    const artifacts = h.deliveryStore.listArtifacts(jobId);
    const baseline = artifacts.find((artifact) => artifact.kind === "screenshot-baseline");
    const after = artifacts.find((artifact) => artifact.kind === "screenshot-after");
    assert.ok(baseline !== undefined && after !== undefined, "both phases captured");
    assert.equal(readFileSync(baseline.path).subarray(0, 4).toString("hex"), "89504e47", "the baseline PNG is the real capture");
    const meta = artifacts.find((artifact) => artifact.kind === "screenshot-meta");
    assert.ok(meta !== undefined);
    const metaJson = JSON.parse(readFileSync(meta.path, "utf8")) as { scenario: string; viewport: { width: number }; commit: string; phase: string };
    assert.equal(metaJson.scenario, "home");
    assert.equal(metaJson.viewport.width, 800);

    const events = h.workflows.eventsAfter(jobId, 0);
    const captures = events.filter((event) => event.type === "screenshot_captured");
    assert.ok(captures.some((event) => (event.payload as { phase: string }).phase === "baseline"));
    assert.ok(captures.some((event) => (event.payload as { phase: string }).phase === "after"));
    // Baseline and after are captured at different commits.
    const commits = new Set(captures.map((event) => (event.payload as { commit: string }).commit));
    assert.equal(commits.size, 2);

    const merged = h.gitHost.ownerMerge(h.deliveryStore.getDelivery(jobId)!.prNumber!);
    void merged;
    assert.equal(await h.delivery.observeMerge(jobId), "merged");
    assert.equal(existsSync(join(h.runnerRoot, jobId)), false, "the preview and workspace are cleaned");
    const kept = h.deliveryStore.listArtifacts(jobId);
    assert.ok(kept.some((artifact) => artifact.kind === "screenshot-baseline" && existsSync(artifact.path)), "screenshot evidence survives cleanup");
  } finally {
    await h.close();
  }
});

test("a project with no preview states screenshots are not applicable", async () => {
  const h = await newHarness();
  try {
    const patch = makePatch(h.originDir, h.artifactsDir, (work) => writeFileSync(join(work, "notes.md"), "office notes\n"));
    const jobId = await createReadyJob(h, "req10", [patch]);
    const events = h.workflows.eventsAfter(jobId, 0);
    const stated = events.find((event) => event.type === "screenshots_not_applicable");
    assert.ok(stated !== undefined, "no UI: the reason is stated, not faked with an image");
    assert.equal(h.deliveryStore.listArtifacts(jobId).some((artifact) => artifact.kind.startsWith("screenshot")), false);
  } finally {
    await h.close();
  }
});

test("a verified merge records a release that can be restored from its retained artifact", async () => {
  const h = await newHarness();
  try {
    const patch = makePatch(h.originDir, h.artifactsDir, (work) => writeFileSync(join(work, "notes.md"), "office notes\n"));
    const jobId = await createReadyJob(h, "rel1", [patch]);
    const before = h.deliveryStore.getDelivery(jobId)!;
    const mergedRevision = h.gitHost.ownerMerge(before.prNumber!);
    assert.equal(await h.delivery.observeMerge(jobId), "merged");

    const release = h.releases.currentRelease("demo");
    assert.notEqual(release, undefined);
    assert.equal(release!.commitSha, mergedRevision);
    assert.equal(release!.jobId, jobId);
    assert.equal(release!.prNumber, before.prNumber);
    assert.equal(release!.hostId, "runner-a");
    assert.notEqual(release!.artifactId, null, "the release carries the bundle that restores it");
    const bundle = h.deliveryStore.getArtifact(jobId, release!.artifactId!);
    assert.notEqual(bundle, undefined);
    assert.equal(release!.artifactDigest, bundle!.digest);
    assert.ok(existsSync(bundle!.path), "the retained bundle survives workspace cleanup");
    assert.deepEqual(h.releases.restorableReleases("demo", new Set([release!.artifactId!])), [release!]);
    assert.ok(h.workflows.eventsAfter(jobId, 0).some((event) => event.type === "release_recorded"));
  } finally { await h.close(); }
});

test("a database-sensitive change cannot pass the gate without rollback evidence, then passes after a rehearsal", async () => {
  const h = await newHarness();
  try {
    const plain = makePatch(h.originDir, h.artifactsDir, (work) => writeFileSync(join(work, "notes.md"), "first\n"));
    const dbPatch = makePatch(h.originDir, h.artifactsDir, (work) => {
      mkdirSync(join(work, "migrations"), { recursive: true });
      writeFileSync(join(work, "migrations", "001_add_column.sql"), "ALTER TABLE orders ADD COLUMN goods TEXT;\n");
    });
    const followPatch = makePatch(h.originDir, h.artifactsDir, (work) => {
      writeFileSync(join(work, "migrations", "002_add_index.sql"), "CREATE INDEX idx_orders_goods ON orders (goods);\n");
    }, (work) => {
      mkdirSync(join(work, "migrations"), { recursive: true });
      writeFileSync(join(work, "migrations", "001_add_column.sql"), "ALTER TABLE orders ADD COLUMN goods TEXT;\n");
    });
    h.scriptResponses({
      "req-1": [READY_JSON, READY_JSON, READY_JSON],
      "author-1": [patchJson(plain), patchJson(dbPatch), patchJson(followPatch)],
      "review-1": [PASS_JSON, PASS_JSON, PASS_JSON],
      "security-1": [PASS_JSON, PASS_JSON, PASS_JSON],
    });

    // First release: an ordinary change, merged and recorded as restorable.
    const firstJob = await h.coordinator.createJob({ requestId: "rel2a", payloadHash: "hash-rel2a", projectId: "demo", title: "Add notes", requestText: "Add a notes file", issue: null });
    const mergedRevision = h.gitHost.ownerMerge(h.deliveryStore.getDelivery(firstJob.jobId)!.prNumber!);
    assert.equal(await h.delivery.observeMerge(firstJob.jobId), "merged");
    const target = h.releases.rollbackTarget("demo");
    assert.notEqual(target, undefined);
    assert.equal(target!.commitSha, mergedRevision);

    // Second change touches a migration path. The gate must not accept "trust me".
    const dbJob = await h.coordinator.createJob({ requestId: "rel2b", payloadHash: "hash-rel2b", projectId: "demo", title: "Add column", requestText: "Add a database column", issue: null });
    const blocked = h.deliveryStore.getDelivery(dbJob.jobId)!;
    assert.notEqual(blocked.stage, "ready", "a database-sensitive change does not reach ready on assertion");
    assert.equal(blocked.gateVerdict, "blocked");
    const gateEvent = h.workflows.eventsAfter(dbJob.jobId, 0).filter((event) => event.type === "gate_evaluated").at(-1)!;
    assert.ok(JSON.stringify(gateEvent.payload).includes("database paths"), JSON.stringify(gateEvent.payload));
    const blockedRecord = h.deliveryStore.getGateRecord(dbJob.jobId) as { rollbackCompatibility: { required: boolean; satisfied: boolean; paths: string[] } };
    assert.equal(blockedRecord.rollbackCompatibility.required, true);
    assert.equal(blockedRecord.rollbackCompatibility.satisfied, false);
    assert.ok(blockedRecord.rollbackCompatibility.paths.some((path) => path.includes("migrations/")));

    // The owner rehearses restoring the release a rollback would return to. It passes.
    const rehearsal = await h.releaseService.restoreStaging("demo", target!.releaseId);
    assert.equal(rehearsal.rehearsal.outcome, "passed", JSON.stringify(rehearsal.checks));
    assert.notEqual(rehearsal.rehearsal.evidenceArtifactId, null);
    assert.ok(rehearsal.checks.length > 0 && rehearsal.checks.every((check) => check.status === "succeeded"));

    // Steering a blocked job records the instruction but deliberately does not resume blocked work;
    // the owner retries the job, which re-enters the same gate with the evidence now present.
    const steered = await h.coordinator.steer(dbJob.jobId, "steer-rel2b", "hash-steer-rel2b", dbJob.commandRevision, "Proceed; the rollback rehearsal has been run.");
    assert.equal(steered.recorded, true);
    await h.coordinator.retryBlocked(dbJob.jobId);
    const settled = h.deliveryStore.getDelivery(dbJob.jobId)!;
    assert.equal(settled.stage, "ready", JSON.stringify(h.deliveryStore.getGateRecord(dbJob.jobId)));
    assert.equal(settled.gateVerdict, "pass");
    const finalRecord = h.deliveryStore.getGateRecord(dbJob.jobId) as { rollbackCompatibility: { satisfied: boolean; rehearsalId: string | null; paths: string[] } };
    assert.equal(finalRecord.rollbackCompatibility.satisfied, true);
    assert.equal(finalRecord.rollbackCompatibility.rehearsalId, rehearsal.rehearsal.rehearsalId);
    assert.ok(finalRecord.rollbackCompatibility.paths.some((path) => path.includes("migrations/")));
  } finally { await h.close(); }
});

test("a rehearsal that fails against the restored release is recorded as failed, not hidden", async () => {
  const h = await newHarness();
  try {
    const patch = makePatch(h.originDir, h.artifactsDir, (work) => {
      // The release itself carries a failing check, so restoring it cannot report a pass.
      writeFileSync(join(work, "check.js"), "console.error('release check broken'); process.exit(4);\n");
    });
    const jobId = await createReadyJob(h, "rel3", [patch]);
    const delivery = h.deliveryStore.getDelivery(jobId)!;
    assert.notEqual(delivery.stage, "ready", "a change whose checks fail never reaches publishing");
    // Record the release directly: the rehearsal path is what is under test here.
    // Retain the release's bundle the way a published release would, then rehearse against it.
    const bundle = await h.runner.exportCommit({ jobId, hostId: "runner-a", commit: delivery.headCommit });
    const bundlePath = join(h.artifactsDir, jobId, `bundle-${delivery.headCommit.slice(0, 12)}`);
    mkdirSync(join(h.artifactsDir, jobId), { recursive: true });
    writeFileSync(bundlePath, bundle, { mode: 0o600 });
    h.deliveryStore.recordArtifact({ jobId, id: `bundle-${delivery.headCommit.slice(0, 12)}`, kind: "bundle", digest: createHash("sha256").update(bundle).digest("hex"), sizeBytes: bundle.length, path: bundlePath, verificationKey: "rehearsal-fixture", expiresAt: Date.now() + 86_400_000 });
    const release = h.releases.recordRelease({ projectId: "demo", jobId, commitSha: delivery.headCommit, branch: "slice/demo/x", prNumber: null, hostId: "runner-a", artifactId: `bundle-${delivery.headCommit.slice(0, 12)}`, artifactDigest: createHash("sha256").update(bundle).digest("hex") });
    const rehearsal = await h.releaseService.restoreStaging("demo", release.releaseId);
    assert.equal(rehearsal.rehearsal.outcome, "failed", rehearsal.rehearsal.reason ?? "");
    assert.ok(rehearsal.checks.some((check) => check.status !== "succeeded"));
    assert.equal(rehearsal.rehearsal.reason, "one or more project checks failed against the restored release");
  } finally { await h.close(); }
});

test("a release whose retained artifact is gone is not restorable, and the rehearsal says so", async () => {
  const h = await newHarness();
  try {
    const patch = makePatch(h.originDir, h.artifactsDir, (work) => writeFileSync(join(work, "notes.md"), "notes\n"));
    const jobId = await createReadyJob(h, "rel4", [patch]);
    const mergedRevision = h.gitHost.ownerMerge(h.deliveryStore.getDelivery(jobId)!.prNumber!);
    assert.equal(await h.delivery.observeMerge(jobId), "merged");
    const release = h.releases.rollbackTarget("demo")!;
    assert.equal(release.commitSha, mergedRevision);

    const bundle = h.deliveryStore.getArtifact(jobId, release.artifactId!)!;
    rmSync(bundle.path, { force: true });
    assert.deepEqual(h.releaseService.restorableReleases("demo"), [], "an unreadable artifact is not restorable");

    const rehearsal = await h.releaseService.restoreStaging("demo", release.releaseId);
    assert.equal(rehearsal.rehearsal.outcome, "uncertain");
    assert.match(rehearsal.rehearsal.reason ?? "", /retained artifact/);
    assert.equal(rehearsal.rehearsal.evidenceArtifactId, null);
  } finally { await h.close(); }
});

test("two rehearsals for one project cannot share a staging workspace", async () => {
  const h = await newHarness();
  try {
    const patch = makePatch(h.originDir, h.artifactsDir, (work) => writeFileSync(join(work, "notes.md"), "notes\n"));
    const jobId = await createReadyJob(h, "rel5", [patch]);
    h.gitHost.ownerMerge(h.deliveryStore.getDelivery(jobId)!.prNumber!);
    assert.equal(await h.delivery.observeMerge(jobId), "merged");
    const release = h.releases.rollbackTarget("demo")!;
    const first = h.releaseService.restoreStaging("demo", release.releaseId);
    // The second request arrives while the first is still running on the same worker.
    await assert.rejects(() => h.releaseService.restoreStaging("demo", release.releaseId), /rehearsal_in_progress/);
    const settled = await first;
    assert.equal(settled.rehearsal.outcome, "passed", settled.rehearsal.reason ?? "");
    // The guard releases: a later rehearsal is allowed.
    const second = await h.releaseService.restoreStaging("demo", release.releaseId);
    assert.equal(second.rehearsal.outcome, "passed", second.rehearsal.reason ?? "");
    assert.equal(h.releases.listRehearsals("demo").length, 2, "each attempt is its own record");
  } finally { await h.close(); }
});

test("tightening a project's model rules stops further role work at the next step", async () => {
  const h = await newHarness();
  try {
    const failing = makePatch(h.originDir, h.artifactsDir, (work) => writeFileSync(join(work, "check.js"), "process.exit(9);\n"));
    h.scriptResponses({
      "req-1": [READY_JSON, READY_JSON],
      "author-1": [patchJson(failing)],
      "review-1": [PASS_JSON],
      "security-1": [PASS_JSON],
    });
    const job = await h.coordinator.createJob({ requestId: "pol1", payloadHash: "hash-pol1", projectId: "demo", title: "Break", requestText: "Break the check", issue: null });
    assert.equal(h.workflows.getJob(job.jobId)!.runState, "blocked", "failing checks exhaust the rounds and block");

    // The owner then forbids the provider this project's roles use. Further work must stop on the
    // next step, not continue because the rules were satisfied when the workspace was prepared.
    h.workflows.setProjectModelRules("demo", { allowedProviders: ["not-faux"] });
    await h.delivery.advance(job.jobId);
    const events = h.workflows.eventsAfter(job.jobId, 0);
    assert.ok(events.some((event) => event.type === "blocked" && JSON.stringify(event.payload).includes("model_policy")), JSON.stringify(events.map((event) => event.type)));
    assert.equal(h.workflows.getJob(job.jobId)!.runState, "blocked");
  } finally { await h.close(); }
});

test("a later failed rehearsal outranks an earlier pass as rollback evidence", async () => {
  const h = await newHarness();
  try {
    const plain = makePatch(h.originDir, h.artifactsDir, (work) => writeFileSync(join(work, "notes.md"), "first\n"));
    const dbPatch = makePatch(h.originDir, h.artifactsDir, (work) => {
      mkdirSync(join(work, "migrations"), { recursive: true });
      writeFileSync(join(work, "migrations", "001_add.sql"), "ALTER TABLE t ADD COLUMN c TEXT;\n");
    });
    const followPatch = makePatch(h.originDir, h.artifactsDir, (work) => {
      writeFileSync(join(work, "migrations", "002.sql"), "CREATE INDEX i ON t (c);\n");
    }, (work) => {
      mkdirSync(join(work, "migrations"), { recursive: true });
      writeFileSync(join(work, "migrations", "001_add.sql"), "ALTER TABLE t ADD COLUMN c TEXT;\n");
    });
    const followPatch2 = makePatch(h.originDir, h.artifactsDir, (work) => {
      writeFileSync(join(work, "migrations", "003.sql"), "CREATE TABLE IF NOT EXISTS audit (id INTEGER);\n");
    }, (work) => {
      mkdirSync(join(work, "migrations"), { recursive: true });
      writeFileSync(join(work, "migrations", "001_add.sql"), "ALTER TABLE t ADD COLUMN c TEXT;\n");
      writeFileSync(join(work, "migrations", "002.sql"), "CREATE INDEX i ON t (c);\n");
    });
    h.scriptResponses({
      "req-1": [READY_JSON, READY_JSON, READY_JSON, READY_JSON],
      "author-1": [patchJson(plain), patchJson(dbPatch), patchJson(followPatch), patchJson(followPatch2)],
      "review-1": [PASS_JSON, PASS_JSON, PASS_JSON, PASS_JSON],
      "security-1": [PASS_JSON, PASS_JSON, PASS_JSON, PASS_JSON],
    });
    const firstJob = await h.coordinator.createJob({ requestId: "rb1a", payloadHash: "h-rb1a", projectId: "demo", title: "Notes", requestText: "Add notes", issue: null });
    h.gitHost.ownerMerge(h.deliveryStore.getDelivery(firstJob.jobId)!.prNumber!);
    await h.delivery.observeMerge(firstJob.jobId);
    const target = h.releases.rollbackTarget("demo")!;

    const dbJob = await h.coordinator.createJob({ requestId: "rb1b", payloadHash: "h-rb1b", projectId: "demo", title: "Column", requestText: "Add a column", issue: null });
    const rehearsal = await h.releaseService.restoreStaging("demo", target.releaseId);
    assert.equal(rehearsal.rehearsal.outcome, "passed");
    await h.coordinator.steer(dbJob.jobId, "steer-rb1b", "h-steer-rb1b", dbJob.commandRevision, "Proceed");
    await h.coordinator.retryBlocked(dbJob.jobId);
    assert.equal(h.deliveryStore.getDelivery(dbJob.jobId)!.stage, "ready", "the passing rehearsal satisfies the gate");

    // A later rehearsal of the same release fails. The older pass no longer stands.
    h.releases.recordRehearsal({
      rehearsalId: "reh-later-failed", projectId: "demo", releaseId: target.releaseId, hostId: "runner-a",
      headCommit: target.commitSha, outcome: "failed", checks: [{ checkId: "test", status: "failed", exitCode: 1, outputTail: "" }],
      evidenceArtifactId: "later-evidence", reason: "the restored release no longer passes its checks",
    });
    const job = h.workflows.getJob(dbJob.jobId)!;
    await h.coordinator.steer(dbJob.jobId, "steer-rb1c", "h-steer-rb1c", job.commandRevision, "Re-check the rollback evidence");
    await h.coordinator.retryBlocked(dbJob.jobId);
    const settled = h.deliveryStore.getDelivery(dbJob.jobId)!;
    assert.notEqual(settled.stage, "ready", "a failed latest rehearsal withdraws the claim");
    const record = h.deliveryStore.getGateRecord(dbJob.jobId) as { reasons: string[]; rollbackCompatibility: { satisfied: boolean } };
    assert.equal(record.rollbackCompatibility.satisfied, false);
    assert.ok(record.reasons.some((reason) => reason.includes("is failed, not a pass")), JSON.stringify(record.reasons));
  } finally { await h.close(); }
});
