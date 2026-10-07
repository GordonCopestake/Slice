import { resolve } from "node:path";
import { createConfiguredModels, plusProEnabled, plusProModelId, plusProReasoningEffort, PLUS_PRO_PROVIDER } from "../adapters/models/configured-models.js";
import { FileCredentialStore } from "../state/credential-store.js";

/**
 * Smoke test the ChatGPT Plus/Pro route with the stored OAuth credential, so the check uses the subscription rather than
 * API billing. Reports "not_tested" when the owner has not enabled the profile or has not signed in, never a pass.
 */
const environment = process.env;

if (!plusProEnabled(environment)) {
  process.stdout.write(
    `${JSON.stringify({
      status: "not_tested",
      provider: "pluspro",
      reason: "the ChatGPT Plus/Pro profile is not enabled; set SLICE_PLUS_PRO=1",
    })}\n`,
  );
  process.exitCode = 2;
} else {
  try {
    // Validate configuration first, so a wrong model or effort reports an error rather than looking untested.
    const modelId = plusProModelId(environment);
    const effort = plusProReasoningEffort(environment);
    const store = new FileCredentialStore(resolve(environment.SLICE_STATE_DIR ?? ".slice"));
    const models = createConfiguredModels(environment, { credentials: store });
    const model = models.getModel(PLUS_PRO_PROVIDER, modelId);
    if (model === undefined) throw new Error(`Configured model ${PLUS_PRO_PROVIDER}/${modelId} is not available`);
    const stored = await store.read(PLUS_PRO_PROVIDER);
    if (stored === undefined) {
      process.stdout.write(
        `${JSON.stringify({
          status: "not_tested",
          provider: "pluspro",
          reason: "no stored ChatGPT Plus/Pro credential; run npm run auth:openai",
        })}\n`,
      );
      process.exitCode = 2;
    } else {
      const response = await models.complete(
        model,
        { messages: [{ role: "user", content: "Reply with exactly: SLICE_PHASE0_MODEL_OK", timestamp: Date.now() }] },
        { signal: AbortSignal.timeout(120_000), reasoningEffort: effort },
      );
      const text = response.content.filter((block) => block.type === "text").map((block) => block.text).join("");
      if (response.stopReason === "error") {
        throw new Error(`The provider returned an error: ${response.errorMessage ?? "no reason given"}`);
      }
      if (text.trim().length === 0) {
        throw new Error("The provider returned no visible text; a reasoning model may need a larger output budget");
      }
      process.stdout.write(
        `${JSON.stringify({
          status: "passed",
          provider: PLUS_PRO_PROVIDER,
          model: model.id,
          stopReason: response.stopReason,
          reasoningEffort: effort,
          // Only the effort the provider reports back, never prompt or response text.
          reportedThinkingLevel: response.providerThinkingLevel ?? null,
        })}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`Plus/Pro smoke failed: ${error instanceof Error ? error.message : "provider error"}\n`);
    process.exitCode = 1;
  }
}