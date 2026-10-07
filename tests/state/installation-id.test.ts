import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installationId } from "../../apps/server/src/state/installation-id.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("the installation id is stable across calls and stored owner-only", () => {
  const directory = mkdtempSync(join(tmpdir(), "slice-installation-id-"));
  const first = installationId(directory);
  const second = installationId(directory);
  assert.match(first, UUID_PATTERN);
  assert.equal(first, second, "the provider treats a changing host id as a different machine");
  const path = join(directory, "installation-id");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, "utf8").trim(), first);
});

test("a corrupt installation id is replaced with a valid one", () => {
  const directory = mkdtempSync(join(tmpdir(), "slice-installation-id-"));
  writeFileSync(join(directory, "installation-id"), "not-a-uuid\n", { mode: 0o600 });
  const created = installationId(directory);
  assert.match(created, UUID_PATTERN);
  assert.equal(installationId(directory), created);
});
