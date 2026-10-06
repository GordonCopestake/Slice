import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SingleOwnerLock } from "../../apps/server/src/state/single-owner-lock.js";

test("a second service process cannot acquire the same state lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slice-owner-lock-"));
  const path = join(directory, "owner.sqlite");
  const first = SingleOwnerLock.acquire(path);
  try {
    assert.throws(() => SingleOwnerLock.acquire(path), /already owns/);
  } finally {
    first.release();
  }
  const afterRelease = SingleOwnerLock.acquire(path);
  afterRelease.release();
  await rm(directory, { recursive: true, force: true });
});
