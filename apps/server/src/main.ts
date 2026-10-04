import { createServer } from "node:http";
import { chmodSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createRegistry } from "@earendil-works/pi-durable";
import { createConfiguredModels } from "./adapters/models/configured-models.js";
import { PiDurableAdapter } from "./adapters/pi-durable/pi-durable-adapter.js";
import { ApplicationStateStore } from "./state/application-state.js";
import { SingleOwnerLock } from "./state/single-owner-lock.js";

function configuredPort(value: string | undefined): number {
  const port = Number(value ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("SLICE_PORT must be between 1 and 65535");
  return port;
}

export async function startSlice(): Promise<void> {
  const stateDirectory = resolve(process.env.SLICE_STATE_DIR ?? ".slice");
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  chmodSync(stateDirectory, 0o700);
  const lock = SingleOwnerLock.acquire(join(stateDirectory, "owner.sqlite"));
  let state: ApplicationStateStore | undefined;
  let adapter: PiDurableAdapter | undefined;
  let server: ReturnType<typeof createServer> | undefined;

  try {
    const databasePath = join(stateDirectory, "state.sqlite");
    state = ApplicationStateStore.open(databasePath);
    adapter = await PiDurableAdapter.open({
      durableDatabasePath: databasePath,
      state,
      models: createConfiguredModels(process.env),
      registry: createRegistry(),
    });
    server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/healthz") {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ service: "slice", status: "ready" }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "not_found" }));
    });
    const port = configuredPort(process.env.SLICE_PORT);
    await new Promise<void>((resolveListen, rejectListen) => {
      server!.once("error", rejectListen);
      server!.listen(port, "127.0.0.1", () => resolveListen());
    });
    process.stdout.write(`Slice Phase 0 service listening on 127.0.0.1:${port}\n`);

    await new Promise<void>((resolveStop) => {
      const stop = (): void => resolveStop();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } finally {
    if (server?.listening) await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
    await adapter?.close();
    state?.close();
    lock.release();
  }
}

void startSlice().catch((error: unknown) => {
  process.stderr.write(`Slice failed to start: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
