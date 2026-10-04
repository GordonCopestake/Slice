import { createConfiguredModels } from "../adapters/models/configured-models.js";

const profile = process.argv[2];
if (profile !== "local" && profile !== "openai") {
  process.stderr.write("Usage: npm run smoke:model -- local|openai\n");
  process.exitCode = 2;
} else {
  try {
    const hasLocalEndpoint = Boolean(process.env.SLICE_LOCAL_BASE_URL && process.env.SLICE_LOCAL_MODEL_ID);
    const hasOpenAiProfile = Boolean(process.env.SLICE_OPENAI_MODEL_ID && process.env.OPENAI_API_KEY);
    if ((profile === "local" && !hasLocalEndpoint) || (profile === "openai" && !hasOpenAiProfile)) {
      const reason = profile === "local" ? "local endpoint or model ID is not configured" : "OpenAI model ID or API key is not configured";
      process.stdout.write(`${JSON.stringify({ status: "not_tested", provider: profile, reason })}\n`);
      process.exitCode = 2;
    } else {
    const models = createConfiguredModels(process.env);
    const provider = profile === "local" ? "slice-local" : "openai";
    const modelId = profile === "local" ? process.env.SLICE_LOCAL_MODEL_ID : process.env.SLICE_OPENAI_MODEL_ID;
    if (modelId === undefined) throw new Error(`The ${profile} model profile is not configured`);
    const model = models.getModel(provider, modelId);
    if (model === undefined) throw new Error(`Configured model ${provider}/${modelId} is not available`);
    const response = await models.complete(
      model,
      { messages: [{ role: "user", content: "Reply with exactly: SLICE_PHASE0_MODEL_OK", timestamp: Date.now() }] },
      { signal: AbortSignal.timeout(60_000) },
    );
    const text = response.content.filter((block) => block.type === "text").map((block) => block.text).join("");
    if (response.stopReason === "error" || text.trim().length === 0) {
      throw new Error("The provider returned no usable text response");
    }
    process.stdout.write(
      `${JSON.stringify({ status: "passed", provider, model: model.id, stopReason: response.stopReason })}\n`,
    );
    }
  } catch (error) {
    process.stderr.write(`Model smoke failed: ${error instanceof Error ? error.message : "provider error"}\n`);
    process.exitCode = 1;
  }
}
