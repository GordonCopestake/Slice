import type { ModelProfile } from "./coordinator.js";

export type RoleProfiles = {
  author: ModelProfile;
  codeReview: ModelProfile;
  securityReview: ModelProfile;
};

const ROLES = [
  { role: "author", provider: "SLICE_AUTHOR_PROVIDER", model: "SLICE_AUTHOR_MODEL_ID" },
  { role: "code-review", provider: "SLICE_CODE_REVIEW_PROVIDER", model: "SLICE_CODE_REVIEW_MODEL_ID" },
  { role: "security-review", provider: "SLICE_SECURITY_REVIEW_PROVIDER", model: "SLICE_SECURITY_REVIEW_MODEL_ID" },
] as const;

/**
 * The three delivery roles, or null when delivery is not configured. All three must be set
 * together, and the code reviewer and security reviewer must differ from each other and from the
 * author: the same model under another prompt does not satisfy independent review. A distinct
 * profile name over identical weights is rejected too, because the only identity signal available
 * at configuration time is provider plus model id.
 */
export function roleProfiles(environment: NodeJS.ProcessEnv): RoleProfiles | null {
  const present = ROLES.map((role) => ({
    role,
    provider: environment[role.provider],
    modelId: environment[role.model],
  }));
  const configured = present.filter((entry) => entry.provider !== undefined || entry.modelId !== undefined);
  if (configured.length === 0) return null;
  if (configured.length !== ROLES.length) {
    const missing = present.filter((entry) => entry.provider === undefined || entry.modelId === undefined).map((entry) => `${entry.role.role} (${entry.role.provider} and ${entry.role.model})`);
    throw new Error(`Delivery roles must be configured together; missing: ${missing.join(", ")}`);
  }
  const profiles: RoleProfiles = {
    author: { provider: environment[ROLES[0].provider]!, modelId: environment[ROLES[0].model]! },
    codeReview: { provider: environment[ROLES[1].provider]!, modelId: environment[ROLES[1].model]! },
    securityReview: { provider: environment[ROLES[2].provider]!, modelId: environment[ROLES[2].model]! },
  };
  for (const profile of [profiles.author, profiles.codeReview, profiles.securityReview]) {
    if (profile.provider.trim().length === 0 || profile.provider.length > 100) throw new TypeError("Role providers must be 1-100 characters");
    if (profile.modelId.trim().length === 0 || profile.modelId.length > 200) throw new TypeError("Role model ids must be 1-200 characters");
  }
  const identity = (profile: ModelProfile): string => `${profile.provider}/${profile.modelId}`;
  if (identity(profiles.codeReview) === identity(profiles.securityReview)) {
    throw new Error("The code reviewer and the security reviewer must use distinct model identities");
  }
  if (identity(profiles.author) === identity(profiles.codeReview)) {
    throw new Error("The author and the code reviewer must use distinct model identities");
  }
  if (identity(profiles.author) === identity(profiles.securityReview)) {
    throw new Error("The author and the security reviewer must use distinct model identities");
  }
  return profiles;
}
