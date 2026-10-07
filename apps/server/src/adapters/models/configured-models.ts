import {
  createProvider,
  type CredentialStore,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { createModels } from "@earendil-works/pi-ai/models";

export type ModelEnvironment = {
  readonly SLICE_LOCAL_BASE_URL?: string;
  readonly SLICE_LOCAL_MODEL_ID?: string;
  readonly SLICE_LOCAL_CONTEXT_TOKENS?: string;
  readonly SLICE_LOCAL_OUTPUT_TOKENS?: string;
  readonly SLICE_LOCAL_API_KEY?: string;
  readonly SLICE_OPENAI_MODEL_ID?: string;
  readonly OPENAI_API_KEY?: string;
  readonly SLICE_PLUS_PRO?: string;
  readonly SLICE_PLUS_PRO_MODEL_ID?: string;
  readonly SLICE_PLUS_PRO_REASONING_EFFORT?: string;
};

/** Provider ID of the ChatGPT Plus/Pro route in the pinned Pi AI catalog. */
export const PLUS_PRO_PROVIDER = "openai-codex";

export type ConfiguredModelsOptions = {
  /** Where the stored subscription credential is read from. Required by the Plus/Pro profile. */
  readonly credentials?: CredentialStore;
};

/** Sent to a local endpoint that does not check authorization; not a secret and not used as one. */
export const KEYLESS_PLACEHOLDER_API_KEY = "slice-local-no-auth";

/** Default room for one reply. Reasoning models spend part of this before any visible text appears. */
const DEFAULT_LOCAL_OUTPUT_TOKENS = 32_768;

/**
 * Default prompt window. 256k matches the context length the local test endpoint advertises for its models; a model
 * with a smaller window must set SLICE_LOCAL_CONTEXT_TOKENS, because a request is rejected rather than truncated.
 */
const DEFAULT_LOCAL_CONTEXT_TOKENS = 262_144;

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

/**
 * A local endpoint must not be written as a link-local or metadata address. Loopback and private LAN addresses stay
 * allowed, so a model server on the local network keeps working. This checks the literal only; resolving a name at
 * startup would add a blocking network call, and the value is operator configuration rather than request input.
 */
function assertNotLinkLocal(hostname: string): void {
  const address = hostname.replace(/^\[|\]$/g, "");
  if (address.startsWith("169.254.") || address === "0.0.0.0" || address.toLowerCase().startsWith("fe80:")) {
    throw new Error("A local model endpoint must not be a link-local or metadata address");
  }
}

/** Default ChatGPT Plus/Pro model. Reasoning level defaults to its maximum; both are configurable. */
export const DEFAULT_PLUS_PRO_MODEL_ID = "gpt-6-luna";
const DEFAULT_PLUS_PRO_THINKING_LEVEL = "max";

export function createConfiguredModels(
  environment: ModelEnvironment = process.env,
  options: ConfiguredModelsOptions = {},
): MutableModels {
  const models = createModels(options.credentials === undefined ? {} : { credentials: options.credentials });
  const localBaseUrl = environment.SLICE_LOCAL_BASE_URL;
  const localModelId = environment.SLICE_LOCAL_MODEL_ID;
  if ((localBaseUrl === undefined) !== (localModelId === undefined)) {
    throw new Error("Set both SLICE_LOCAL_BASE_URL and SLICE_LOCAL_MODEL_ID for a local model");
  }

  if (localBaseUrl !== undefined && localModelId !== undefined) {
    const endpoint = new URL(localBaseUrl);
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
      throw new Error("A local model endpoint must use HTTP or HTTPS");
    }
    if (endpoint.username.length > 0 || endpoint.password.length > 0) {
      throw new Error("Do not put credentials in SLICE_LOCAL_BASE_URL");
    }
    assertNotLinkLocal(endpoint.hostname);
    // Read from the environment only. A key that carries a control character could inject request headers.
    const configuredApiKey = environment.SLICE_LOCAL_API_KEY;
    if (configuredApiKey !== undefined && /[\0-\x1f\x7f]/.test(configuredApiKey)) {
      throw new Error("SLICE_LOCAL_API_KEY must not contain control characters");
    }
    // The pinned OpenAI-compatible client refuses to send any request whose auth carries no API key, so a keyless
    // local server still needs a placeholder value. Servers that ignore authorization never read it.
    const localApiKey = configuredApiKey ?? KEYLESS_PLACEHOLDER_API_KEY;
    const contextTokens = positiveInteger(
      environment.SLICE_LOCAL_CONTEXT_TOKENS,
      DEFAULT_LOCAL_CONTEXT_TOKENS,
      "SLICE_LOCAL_CONTEXT_TOKENS",
    );
    const outputTokens = positiveInteger(
      environment.SLICE_LOCAL_OUTPUT_TOKENS,
      DEFAULT_LOCAL_OUTPUT_TOKENS,
      "SLICE_LOCAL_OUTPUT_TOKENS",
    );
    if (outputTokens > contextTokens) {
      throw new Error("SLICE_LOCAL_OUTPUT_TOKENS must not exceed SLICE_LOCAL_CONTEXT_TOKENS");
    }
    const localModel: Model<"openai-completions"> = {
      id: localModelId,
      name: `Local ${localModelId}`,
      api: "openai-completions",
      provider: "slice-local",
      baseUrl: localBaseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: contextTokens,
      maxTokens: outputTokens,
    };
    models.setProvider(
      createProvider({
        id: "slice-local",
        name: "Slice local OpenAI-compatible endpoint",
        baseUrl: localBaseUrl,
        // A keyless local server receives a placeholder; an endpoint that checks a key gets one from the environment.
        auth: {
          apiKey: {
            name: "Local model endpoint",
            resolve: async () => ({ auth: { apiKey: localApiKey } }),
          },
        },
        models: [localModel],
        api: openAICompletionsApi(),
      }),
    );
  }

  if (environment.SLICE_OPENAI_MODEL_ID !== undefined) {
    if (environment.OPENAI_API_KEY === undefined || environment.OPENAI_API_KEY.length === 0) {
      throw new Error("Set OPENAI_API_KEY before configuring SLICE_OPENAI_MODEL_ID");
    }
    models.setProvider(openaiProvider());
    if (models.getModel("openai", environment.SLICE_OPENAI_MODEL_ID) === undefined) {
      throw new Error("SLICE_OPENAI_MODEL_ID is not present in the pinned Pi AI OpenAI catalog");
    }
  }

  if (plusProEnabled(environment)) {
    if (options.credentials === undefined) {
      throw new Error("The ChatGPT Plus/Pro profile needs the state directory so the stored credential can be read");
    }
    models.setProvider(openaiCodexProvider());
    const modelId = environment.SLICE_PLUS_PRO_MODEL_ID ?? DEFAULT_PLUS_PRO_MODEL_ID;
    if (models.getModel(PLUS_PRO_PROVIDER, modelId) === undefined) {
      throw new Error(
        `SLICE_PLUS_PRO_MODEL_ID ${modelId} is not in the pinned Pi AI ChatGPT Plus/Pro catalog; it offers gpt-6-luna`,
      );
    }
  }
  return models;
}

/** True when the owner asked for the subscription route instead of API billing. */
export function plusProEnabled(environment: ModelEnvironment = process.env): boolean {
  if (environment.SLICE_PLUS_PRO === "0" || environment.SLICE_PLUS_PRO === "false") return false;
  return environment.SLICE_PLUS_PRO === "1" || environment.SLICE_PLUS_PRO === "true"
    || environment.SLICE_PLUS_PRO_MODEL_ID !== undefined;
}

/** Reasoning effort sent with each Plus/Pro request. The model's own maximum unless configured otherwise. */
export function plusProReasoningEffort(
  environment: ModelEnvironment = process.env,
): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
  const configured = environment.SLICE_PLUS_PRO_REASONING_EFFORT ?? DEFAULT_PLUS_PRO_THINKING_LEVEL;
  const allowed = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
  if (!allowed.includes(configured as (typeof allowed)[number])) {
    throw new Error(`SLICE_PLUS_PRO_REASONING_EFFORT must be one of ${allowed.join(", ")}`);
  }
  return configured as (typeof allowed)[number];
}

export function plusProModelId(environment: ModelEnvironment = process.env): string {
  return environment.SLICE_PLUS_PRO_MODEL_ID ?? DEFAULT_PLUS_PRO_MODEL_ID;
}
