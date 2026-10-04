import {
  createProvider,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createModels } from "@earendil-works/pi-ai/models";

export type ModelEnvironment = {
  readonly SLICE_LOCAL_BASE_URL?: string;
  readonly SLICE_LOCAL_MODEL_ID?: string;
  readonly SLICE_LOCAL_CONTEXT_TOKENS?: string;
  readonly SLICE_LOCAL_OUTPUT_TOKENS?: string;
  readonly SLICE_LOCAL_API_KEY?: string;
  readonly SLICE_OPENAI_MODEL_ID?: string;
  readonly OPENAI_API_KEY?: string;
};

/** Sent to a local endpoint that does not check authorization; not a secret and not used as one. */
export const KEYLESS_PLACEHOLDER_API_KEY = "slice-local-no-auth";

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function createConfiguredModels(environment: ModelEnvironment = process.env): MutableModels {
  const models = createModels();
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
    // Read from the environment only. A key that carries a control character could inject request headers.
    const configuredApiKey = environment.SLICE_LOCAL_API_KEY;
    if (configuredApiKey !== undefined && /[\0-\x1f\x7f]/.test(configuredApiKey)) {
      throw new Error("SLICE_LOCAL_API_KEY must not contain control characters");
    }
    // The pinned OpenAI-compatible client refuses to send any request whose auth carries no API key, so a keyless
    // local server still needs a placeholder value. Servers that ignore authorization never read it.
    const localApiKey = configuredApiKey ?? KEYLESS_PLACEHOLDER_API_KEY;
    const localModel: Model<"openai-completions"> = {
      id: localModelId,
      name: `Local ${localModelId}`,
      api: "openai-completions",
      provider: "slice-local",
      baseUrl: localBaseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: positiveInteger(environment.SLICE_LOCAL_CONTEXT_TOKENS, 32_000, "SLICE_LOCAL_CONTEXT_TOKENS"),
      maxTokens: positiveInteger(environment.SLICE_LOCAL_OUTPUT_TOKENS, 4_096, "SLICE_LOCAL_OUTPUT_TOKENS"),
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
  return models;
}
