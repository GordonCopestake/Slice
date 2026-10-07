import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Stable per-installation identifier. The ChatGPT sign-in flow sends this as the agent host ID, so it must be the same
 * on every run or the provider treats each sign-in as a different machine. It is not a secret, but it is a stable
 * installation identifier, so it is stored owner-only beside the credentials.
 */
export function installationId(stateDirectory: string): string {
  const path = join(stateDirectory, "installation-id");
  if (existsSync(path)) {
    const stored = readFileSync(path, "utf8").trim();
    if (UUID_PATTERN.test(stored)) return stored;
  }
  const created = randomUUID();
  writeFileSync(path, `${created}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return created;
}