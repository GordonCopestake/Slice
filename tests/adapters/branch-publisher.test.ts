import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitBundlePublisher } from "../../apps/server/src/adapters/git/branch-publisher.js";

function git(args: string[], cwd?: string): string {
  const result = spawnSync("git", cwd === undefined ? args : ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

type Fixture = { directory: string; originDir: string; originUrl: string; commit: string; bundle: Buffer; branch: string };

function newFixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "slice-publish-"));
  const work = join(directory, "work");
  mkdirSync(work);
  git(["init", "-q", "-b", "slice-main", work]);
  writeFileSync(join(work, "f.txt"), "x\n");
  git(["add", "-A"], work);
  git(["-c", "user.email=s@example.invalid", "-c", "user.name=t", "commit", "-q", "-m", "c"], work);
  const branch = "slice/job-1/change";
  git(["branch", branch], work);
  const originDir = join(directory, "origin.git");
  git(["clone", "--bare", "-q", work, originDir]);
  git(["-C", originDir, "branch", "-d", branch]); // the feature branch is not on the remote until it is pushed
  const commit = git(["-C", work, "rev-parse", branch]).trim();
  const bundlePath = join(directory, "branch.bundle");
  git(["-C", work, "bundle", "create", bundlePath, branch]);
  return { directory, originDir, originUrl: `file://${originDir}`, commit, bundle: readFileSync(bundlePath), branch };
}

test("a bundle carrying the reviewed commit pushes to the registered remote", async () => {
  const f = newFixture();
  try {
    const publisher = new GitBundlePublisher(f.directory);
    await publisher.publish({ jobId: "job-1", bundle: f.bundle, remoteUrl: f.originUrl, branch: f.branch, expectedCommit: f.commit, expectedRemoteHead: null });
    const ls = spawnSync("git", ["ls-remote", f.originUrl, `refs/heads/${f.branch}`], { encoding: "utf8" });
    assert.ok(ls.stdout.includes(f.commit), "the remote now carries the reviewed commit");
    const head = await publisher.remoteHead({ remoteUrl: f.originUrl, branch: f.branch });
    assert.equal(head, f.commit);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("a bundle that does not carry the reviewed commit is refused", async () => {
  const f = newFixture();
  try {
    const publisher = new GitBundlePublisher(f.directory);
    await assert.rejects(
      () => publisher.publish({ jobId: "job-1", bundle: f.bundle, remoteUrl: f.originUrl, branch: f.branch, expectedCommit: "0123456789abcdef0123456789abcdef01234567", expectedRemoteHead: null }),
      /push_commit_mismatch/,
    );
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("a remote head outside the expected lineage blocks the push", async () => {
  const f = newFixture();
  try {
    const publisher = new GitBundlePublisher(f.directory);
    await assert.rejects(
      () => publisher.publish({ jobId: "job-1", bundle: f.bundle, remoteUrl: f.originUrl, branch: f.branch, expectedCommit: f.commit, expectedRemoteHead: "0123456789abcdef0123456789abcdef01234567" }),
      /remote_head_mismatch/,
      "the push only fast-forwards from the recorded parent",
    );
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("https pushes require the token environment and never accept embedded credentials", async () => {
  const f = newFixture();
  try {
    const publisher = new GitBundlePublisher(f.directory);
    await assert.rejects(
      () => publisher.publish({ jobId: "job-1", bundle: f.bundle, remoteUrl: "https://github.example/owner/demo.git", branch: f.branch, expectedCommit: f.commit, expectedRemoteHead: null }),
      /SLICE_GIT_PUSH_TOKEN is not configured/,
    );
    await assert.rejects(
      () => publisher.publish({ jobId: "job-1", bundle: f.bundle, remoteUrl: "https://user:secret@github.example/owner/demo.git", branch: f.branch, expectedCommit: f.commit, expectedRemoteHead: null }),
      /must not embed credentials/,
    );
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
