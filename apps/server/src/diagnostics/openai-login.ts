import { createInterface } from "node:readline/promises";
import { chmodSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { createModels } from "@earendil-works/pi-ai/models";
import { FileCredentialStore } from "../state/credential-store.js";
import { installationId } from "../state/installation-id.js";

/** Device-code login method ID chosen by the pinned client when the headless option is picked. */
const DEVICE_CODE_LOGIN_METHOD = "device_code";

/**
 * Sign in to ChatGPT Plus/Pro so the service uses the subscription instead of API billing. The pinned client owns the
 * OAuth exchange: it generates the PKCE verifier, serves the redirect on loopback, prints the authorize URL, and
 * returns the tokens. Nothing here reads or prints a token.
 */
export async function loginOpenAIPlusPro(): Promise<void> {
  process.umask(0o077);
  const stateDirectory = resolve(process.env.SLICE_STATE_DIR ?? ".slice");
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  chmodSync(stateDirectory, 0o700);

  const store = new FileCredentialStore(stateDirectory);
  const models = createModels({ credentials: store });
  models.setProvider(openaiCodexProvider());

  const abort = new AbortController();
  const onSignal = (): void => abort.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    const credential = await models.login("openai-codex", "oauth", interaction(abort.signal), {
      getDeviceId: () => installationId(stateDirectory),
    });
    process.stdout.write(
      `Signed in to ChatGPT Plus/Pro. Stored ${credential.type} credential for openai-codex in ${store.path}\n`,
    );
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

function interaction(signal: AbortSignal): AuthInteraction {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  return {
    signal,
    async prompt(request): Promise<string> {
      if (request.type === "select") {
        // The pinned client offers browser or device-code login. This service is headless, so the method comes from
        // the environment and the options are only printed when the owner asked to be asked.
        const configured = process.env.SLICE_OPENAI_LOGIN_METHOD;
        if (configured !== undefined && configured !== "ask") {
          process.stdout.write(`${request.message} using ${configured}\n`);
          return configured;
        }
        process.stdout.write(`${request.message}\n`);
        for (const option of request.options) {
          process.stdout.write(`  - ${option.label} (${option.id})\n`);
        }
        const answer = (await terminal.question(`> [${DEVICE_CODE_LOGIN_METHOD}] `)).trim();
        return answer.length === 0 ? DEVICE_CODE_LOGIN_METHOD : answer;
      }
      if (request.type === "secret") {
        throw new Error("Slice does not collect secrets at the terminal; complete sign-in in the browser");
      }
      const placeholder = request.type === "text" ? request.placeholder : undefined;
      process.stdout.write(`${request.message}${placeholder === undefined ? "" : ` [${placeholder}]`}\n`);
      const answer = await terminal.question("> ");
      if (answer.trim().length === 0) throw new Error("Login cancelled");
      return answer.trim();
    },
    notify(event): void {
      if (event.type === "device_code") {
        process.stdout.write(
          `\nEnter this code at ${event.verificationUri}\n\n    ${event.userCode}\n\n` +
            `Waiting for authorisation. This code expires in ${Math.round((event.expiresInSeconds ?? 0) / 60)} minutes.\n`,
        );
        return;
      }
      if (event.type === "auth_url") {
        process.stdout.write(`\nOpen this URL to authorise Slice:\n\n${event.url}\n\n`);
        if (event.instructions !== undefined) process.stdout.write(`${event.instructions}\n`);
        return;
      }
      if (event.type === "progress") process.stdout.write(`${event.message}\n`);
    },
  };
}

void loginOpenAIPlusPro().catch((error: unknown) => {
  process.stderr.write(`OpenAI sign-in failed: ${error instanceof Error ? error.message : "provider error"}\n`);
  process.exitCode = 1;
});