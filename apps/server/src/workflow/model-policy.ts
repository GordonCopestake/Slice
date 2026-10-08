import type { ProjectRecord } from "../records/workflow-store.js";
import type { ModelProfile } from "./coordinator.js";

/**
 * Per-project model and privacy policy.
 *
 * A project may restrict which providers and model ids its role conversations may use, and may
 * require that no cloud provider is used at all. "Local" is not inferred from a name: the owner
 * lists the providers they consider local in SLICE_LOCAL_PROVIDERS. A project that forbids cloud
 * models with no local provider configured is refused rather than quietly run on a cloud model.
 */
export type ModelPolicy = {
  /** Providers the owner treats as running on their own infrastructure. */
  localProviders: string[];
};

export function modelPolicy(environment: NodeJS.ProcessEnv): ModelPolicy {
  const raw = environment["SLICE_LOCAL_PROVIDERS"] ?? "";
  const localProviders = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^[a-z0-9._-]{1,64}$/.test(value));
  return { localProviders: [...new Set(localProviders)] };
}

/**
 * Returns a stated reason the model may not be used for this role on this project, or null when the
 * project's rules allow it. Rules are checked against the resolved profile, never against a prompt.
 */
export function modelPolicyViolation(
  project: ProjectRecord,
  role: string,
  profile: ModelProfile,
  policy: ModelPolicy,
): string | null {
  const provider = profile.provider.toLowerCase();
  const modelId = profile.modelId.toLowerCase();
  const rules = project.modelRules;

  if (rules.allowedProviders.length > 0 && !rules.allowedProviders.includes(provider)) {
    return `project ${project.projectId} allows providers ${rules.allowedProviders.join(", ")}; ${role} would use ${provider}`;
  }
  if (rules.allowedModelIds.length > 0 && !rules.allowedModelIds.includes(modelId)) {
    return `project ${project.projectId} allows models ${rules.allowedModelIds.join(", ")}; ${role} would use ${modelId}`;
  }
  const mustRunLocal = !rules.allowCloud || rules.localOnlyRoles.includes(role);
  if (mustRunLocal && !policy.localProviders.includes(provider)) {
    const why = !rules.allowCloud ? `project ${project.projectId} forbids cloud providers` : `project ${project.projectId} requires the ${role} role to run locally`;
    return `${why}; ${provider} is not listed in SLICE_LOCAL_PROVIDERS`;
  }
  return null;
}
