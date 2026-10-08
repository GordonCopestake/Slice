import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunnerGateway } from "../adapters/ssh-runner/runner-adapter.js";
import type { DeliveryStore } from "../records/delivery-store.js";
import type { ReleaseRecord, ReleaseStore, RehearsalRecord } from "../records/release-store.js";
import { rehearsalId as makeRehearsalId, releaseId as makeReleaseId } from "../records/release-store.js";
import type { WorkflowStore } from "../records/workflow-store.js";

/** How long restored staging work keeps its evidence. */
const EVIDENCE_DAYS = 90;

export type ReleaseDeps = {
  workflows: WorkflowStore;
  releases: ReleaseStore;
  delivery: DeliveryStore;
  runner: RunnerGateway;
  artifactsDir: string;
};

export type RestoreResult = {
  rehearsal: RehearsalRecord;
  release: ReleaseRecord;
  checks: { checkId: string; status: string; exitCode: number | null; outputTail: string }[];
};

/**
 * Release tracking and rollback rehearsal.
 *
 * A rehearsal restores a recorded release into a staging workspace Slice owns on the project's
 * registered worker, from the retained bundle artifact, and runs the project's own checks against
 * it. It never touches a user checkout, never merges, and never holds a production credential: the
 * only thing it can do is prove that an earlier release can actually be put back and still pass.
 */
export class ReleaseService {
  readonly #deps: ReleaseDeps;

  constructor(deps: ReleaseDeps) {
    this.#deps = deps;
  }

  listReleases(projectId: string): ReleaseRecord[] {
    return this.#deps.releases.listReleases(projectId);
  }

  listRehearsals(projectId: string): RehearsalRecord[] {
    return this.#deps.releases.listRehearsals(projectId);
  }

  /** Releases whose retained artifact is still readable and unexpired. */
  restorableReleases(projectId: string): ReleaseRecord[] {
    return this.#deps.releases.listReleases(projectId).filter((release) => this.#artifactBytes(release) !== null);
  }

  #stagingJobId(projectId: string): string {
    return `staging-${projectId}`;
  }

  /** Read a release's retained bundle, verifying its digest. A missing or expired artifact yields null. */
  #artifactBytes(release: ReleaseRecord): Buffer | null {
    if (release.artifactId === null || release.artifactDigest === null) return null;
    const artifact = this.#deps.delivery.getArtifact(release.jobId, release.artifactId);
    if (artifact === undefined || artifact.expiresAt < Date.now()) return null;
    let bytes: Buffer;
    try {
      bytes = readFileSync(artifact.path);
    } catch {
      return null;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== artifact.digest) return null;
    return bytes;
  }

  /**
   * Restore a previous release in staging and run the project's checks against it.
   *
   * The outcome is what the checks actually reported. An unreachable host or a failed restore is
   * recorded as uncertain or failed - never as a silent absence, and never as a pass.
   */
  async restoreStaging(projectId: string, targetReleaseId: string): Promise<RestoreResult> {
    const project = this.#deps.workflows.getProject(projectId);
    if (project === undefined) throw new Error("project_not_found");
    const release = this.#deps.releases.getRelease(targetReleaseId);
    if (release === undefined || release.projectId !== projectId) throw new Error("release_not_found");

    const bundle = this.#artifactBytes(release);
    if (bundle === null) {
      const rehearsal = this.#deps.releases.recordRehearsal({
        rehearsalId: makeRehearsalId(targetReleaseId, 1),
        projectId, releaseId: targetReleaseId, hostId: release.hostId, headCommit: release.commitSha,
        outcome: "uncertain", checks: [], evidenceArtifactId: null,
        reason: "the retained artifact for this release is missing, expired, or does not match its recorded digest",
      });
      return { rehearsal, release, checks: [] };
    }

    const placement = this.#deps.workflows.chooseHost(project);
    if ("reason" in placement) {
      const rehearsal = this.#deps.releases.recordRehearsal({
        rehearsalId: makeRehearsalId(targetReleaseId, 1),
        projectId, releaseId: targetReleaseId, hostId: release.hostId, headCommit: release.commitSha,
        outcome: "uncertain", checks: [], evidenceArtifactId: null,
        reason: `no worker is available for the rehearsal: ${placement.detail}`,
      });
      return { rehearsal, release, checks: [] };
    }
    const host = placement.host;
    const stagingJobId = this.#stagingJobId(projectId);
    const attempt = this.#deps.releases.listRehearsals(projectId).filter((entry) => entry.releaseId === targetReleaseId).length + 1;
    const id = makeRehearsalId(targetReleaseId, attempt);
    const checks: { checkId: string; status: string; exitCode: number | null; outputTail: string }[] = [];

    try {
      await this.#deps.runner.prepareJob({
        jobId: stagingJobId,
        hostId: host.hostId,
        source: project.gitRemoteUrl ?? `https://github.com/${project.repoSlug}.git`,
        branch: `slice/${stagingJobId}/staging`,
        leaseGeneration: 1,
      });
      await this.#deps.runner.restoreBundle({
        jobId: stagingJobId,
        hostId: host.hostId,
        operationId: `${stagingJobId}:${targetReleaseId}`,
        leaseGeneration: 1,
        bundle,
        expectedCommit: release.commitSha,
      });
      for (const check of project.buildProfile.checks) {
        const result = await this.#deps.runner.runCheck({ jobId: stagingJobId, hostId: host.hostId, leaseGeneration: 1, checkId: check.id, command: check.command });
        checks.push({ checkId: check.id, status: result.status, exitCode: result.exitCode, outputTail: result.outputTail.slice(-2_000) });
      }
      const allPassed = project.buildProfile.checks.length > 0 && checks.length === project.buildProfile.checks.length && checks.every((check) => check.status === "succeeded");
      const evidenceId = `rehearsal-${targetReleaseId}`;
      const evidence = {
        releaseId: targetReleaseId,
        commitSha: release.commitSha,
        hostId: host.hostId,
        stagingJobId,
        checks,
        outcome: allPassed ? "passed" : "failed",
        recordedAt: Date.now(),
      };
      const evidenceArtifactId = this.#writeEvidence(stagingJobId, evidenceId, evidence, release);
      const rehearsal = this.#deps.releases.recordRehearsal({
        rehearsalId: id,
        projectId,
        releaseId: targetReleaseId,
        hostId: host.hostId,
        headCommit: release.commitSha,
        outcome: allPassed ? "passed" : "failed",
        checks,
        evidenceArtifactId,
        reason: allPassed ? null : "one or more project checks failed against the restored release",
      });
      this.#deps.workflows.appendEvent(stagingJobId, "rehearsal_recorded", { releaseId: targetReleaseId, outcome: rehearsal.outcome, hostId: host.hostId });
      return { rehearsal, release, checks };
    } catch (error) {
      const rehearsal = this.#deps.releases.recordRehearsal({
        rehearsalId: id,
        projectId,
        releaseId: targetReleaseId,
        hostId: host.hostId,
        headCommit: release.commitSha,
        outcome: "uncertain",
        checks,
        evidenceArtifactId: null,
        reason: error instanceof Error ? error.message.slice(0, 300) : "rehearsal failed",
      });
      return { rehearsal, release, checks };
    } finally {
      try {
        await this.#deps.runner.cleanupJob({ jobId: stagingJobId, hostId: host.hostId });
      } catch { /* staging workspaces are reclaimed on the next attempt */ }
    }
  }

  #writeEvidence(stagingJobId: string, artifactId: string, evidence: unknown, release: ReleaseRecord): string {
    const dir = join(this.#deps.artifactsDir, stagingJobId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${artifactId}.json`);
    const content = JSON.stringify(evidence, null, 2);
    writeFileSync(path, content, { mode: 0o600 });
    const digest = createHash("sha256").update(content).digest("hex");
    this.#deps.delivery.recordArtifact({
      jobId: stagingJobId,
      id: artifactId,
      kind: "rollback-rehearsal",
      digest,
      sizeBytes: Buffer.byteLength(content),
      path,
      verificationKey: makeReleaseId(release.projectId, release.commitSha),
      expiresAt: Date.now() + EVIDENCE_DAYS * 86_400_000,
    });
    return artifactId;
  }

  /** Projects with staging workspaces left behind by an outage or an interrupted rehearsal. */
  stagingProjects(): string[] {
    const projects = new Set<string>();
    for (const workspace of this.#deps.workflows.stagingWorkspaces()) {
      const projectId = workspace.jobId.slice("staging-".length);
      if (projectId.length > 0) projects.add(projectId);
    }
    return [...projects];
  }

  /**
   * Retry cleanup for staging workspaces left behind by an outage. Staging work is Slice's own, so
   * reclaiming it is safe; the retained artifacts live outside the workspace.
   */
  async reclaimStaging(projectId: string): Promise<boolean> {
    const project = this.#deps.workflows.getProject(projectId);
    if (project === undefined) return false;
    const stagingJobId = this.#stagingJobId(projectId);
    const workspace = this.#deps.workflows.getWorkspace(stagingJobId);
    if (workspace === undefined || workspace.released) return false;
    try {
      await this.#deps.runner.cleanupJob({ jobId: stagingJobId, hostId: workspace.hostId });
      this.#deps.workflows.releaseWorkspace(stagingJobId);
      return true;
    } catch {
      return false;
    }
  }
}
