import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import { AddressInfo } from "node:net";
import { test } from "node:test";
import {
  createConfiguredModels,
  KEYLESS_PLACEHOLDER_API_KEY,
} from "../../apps/server/src/adapters/models/configured-models.js";

/** The pinned client calls the streaming completions API, so the fake endpoint answers with SSE chunks. */
function streamChunks(): string {
  const chunk = { id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "test-model" };
  const frame = (choices: unknown[], usage?: unknown): string =>
    `data: ${JSON.stringify({ ...chunk, choices, ...(usage === undefined ? {} : { usage }) })}\n\n`;
  return [
    frame([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]),
    frame([{ index: 0, delta: { content: "SLICE_PHASE0_MODEL_OK" }, finish_reason: null }]),
    frame([{ index: 0, delta: {}, finish_reason: "stop" }], { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    "data: [DONE]\n\n",
  ].join("");
}

/** A loopback endpoint that records the request path and authorization header, then answers one completion. */
async function startRecordingEndpoint(): Promise<{ baseUrl: string; seen: IncomingMessage[]; close: () => Promise<void> }> {
  const seen: IncomingMessage[] = [];
  const server: Server = createServer((request, response) => {
    seen.push(request);
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.end(streamChunks());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    seen,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

test("a local model endpoint without a configured key receives a placeholder", async () => {
  const endpoint = await startRecordingEndpoint();
  try {
    const models = createConfiguredModels({ SLICE_LOCAL_BASE_URL: endpoint.baseUrl, SLICE_LOCAL_MODEL_ID: "test-model" });
    const model = models.getModel("slice-local", "test-model");
    assert.ok(model);
    const response = await models.complete(model, { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] });
    // The pinned client refuses to send a request with no API key at all, so a keyless server still needs one.
    assert.equal(response.stopReason, "stop");
    assert.equal(endpoint.seen.length, 1);
    assert.equal(endpoint.seen[0]?.headers.authorization, `Bearer ${KEYLESS_PLACEHOLDER_API_KEY}`);
  } finally {
    await endpoint.close();
  }
});

test("a local model endpoint receives the configured API key", async () => {
  const endpoint = await startRecordingEndpoint();
  try {
    const models = createConfiguredModels({
      SLICE_LOCAL_BASE_URL: endpoint.baseUrl,
      SLICE_LOCAL_MODEL_ID: "test-model",
      SLICE_LOCAL_API_KEY: "local-test-key",
    });
    const model = models.getModel("slice-local", "test-model");
    assert.ok(model);
    const response = await models.complete(model, { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] });
    assert.equal(
      response.content.filter((block) => block.type === "text").map((block) => block.text).join(""),
      "SLICE_PHASE0_MODEL_OK",
    );
    assert.equal(endpoint.seen.length, 1);
    assert.equal(endpoint.seen[0]?.url, "/v1/chat/completions");
    assert.equal(endpoint.seen[0]?.headers.authorization, "Bearer local-test-key");
  } finally {
    await endpoint.close();
  }
});

test("local model token limits default to a 32k reply inside a 256k window", () => {
  const models = createConfiguredModels({ SLICE_LOCAL_BASE_URL: "http://127.0.0.1:1/v1", SLICE_LOCAL_MODEL_ID: "m" });
  const model = models.getModel("slice-local", "m");
  assert.ok(model);
  assert.equal(model.maxTokens, 32_768);
  assert.equal(model.contextWindow, 262_144);
  assert.ok(model.contextWindow > model.maxTokens, "the reply budget must fit inside the context window");
});

test("the local model reply budget is configurable", () => {
  const models = createConfiguredModels({
    SLICE_LOCAL_BASE_URL: "http://127.0.0.1:1/v1",
    SLICE_LOCAL_MODEL_ID: "m",
    SLICE_LOCAL_OUTPUT_TOKENS: "65536",
    SLICE_LOCAL_CONTEXT_TOKENS: "200000",
  });
  const model = models.getModel("slice-local", "m");
  assert.ok(model);
  assert.equal(model.maxTokens, 65_536);
  assert.equal(model.contextWindow, 200_000);
});

test("local model configuration rejects unsafe values", () => {
  assert.throws(
    () => createConfiguredModels({ SLICE_LOCAL_BASE_URL: "http://user:pw@127.0.0.1:1/v1", SLICE_LOCAL_MODEL_ID: "m" }),
    /Do not put credentials in SLICE_LOCAL_BASE_URL/,
  );
  assert.throws(
    () => createConfiguredModels({ SLICE_LOCAL_BASE_URL: "file:///etc/passwd", SLICE_LOCAL_MODEL_ID: "m" }),
    /must use HTTP or HTTPS/,
  );
  assert.throws(
    () => createConfiguredModels({ SLICE_LOCAL_BASE_URL: "http://169.254.169.254/v1", SLICE_LOCAL_MODEL_ID: "m" }),
    /must not be a link-local or metadata address/,
  );
  assert.throws(
    () => createConfiguredModels({ SLICE_LOCAL_BASE_URL: "http://[fe80::1]/v1", SLICE_LOCAL_MODEL_ID: "m" }),
    /must not be a link-local or metadata address/,
  );
  // A model server on the local network stays reachable.
  assert.doesNotThrow(() =>
    createConfiguredModels({ SLICE_LOCAL_BASE_URL: "http://192.168.1.20:8080/v1", SLICE_LOCAL_MODEL_ID: "m" }),
  );
  assert.doesNotThrow(() =>
    createConfiguredModels({ SLICE_LOCAL_BASE_URL: "http://127.0.0.1:1234/v1", SLICE_LOCAL_MODEL_ID: "m" }),
  );
  assert.throws(
    () => createConfiguredModels({ SLICE_LOCAL_BASE_URL: "http://127.0.0.1:1/v1", SLICE_LOCAL_MODEL_ID: "m", SLICE_LOCAL_API_KEY: "key\r\nX-Injected: 1" }),
    /must not contain control characters/,
  );
  assert.throws(
    () => createConfiguredModels({ SLICE_LOCAL_BASE_URL: "http://127.0.0.1:1/v1" }),
    /Set both SLICE_LOCAL_BASE_URL and SLICE_LOCAL_MODEL_ID/,
  );
  assert.throws(
    () => createConfiguredModels({ SLICE_LOCAL_BASE_URL: "http://127.0.0.1:1/v1", SLICE_LOCAL_MODEL_ID: "m", SLICE_LOCAL_OUTPUT_TOKENS: "0" }),
    /must be a positive integer/,
  );
  assert.throws(
    () => createConfiguredModels({ SLICE_LOCAL_BASE_URL: "http://127.0.0.1:1/v1", SLICE_LOCAL_MODEL_ID: "m", SLICE_LOCAL_OUTPUT_TOKENS: "900000", SLICE_LOCAL_CONTEXT_TOKENS: "1000" }),
    /must not exceed SLICE_LOCAL_CONTEXT_TOKENS/,
  );
});