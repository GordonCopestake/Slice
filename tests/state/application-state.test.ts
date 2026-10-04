import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ApplicationStateStore, hashJson } from "../../apps/server/src/state/application-state.js";

const builtModule = fileURLToPath(new URL("../../apps/server/src/state/application-state.js", import.meta.url));

test("the payload hash does not depend on the host locale", () => {
  // A fixed key set whose keys collate differently under different locales: code-unit order is the only stable choice.
  const payload = { i: 1, I: 2, ä: 3, ß: 4, a: 5, b: 6 };
  const read = (locale: string): string => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { hashJson } from ${JSON.stringify(builtModule)};
         process.stdout.write(hashJson(${JSON.stringify(payload)}));`,
      ],
      { env: { ...process.env, LANG: locale, LC_ALL: locale }, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const reference = read("en_US.UTF-8");
  assert.match(reference, /^[0-9a-f]{64}$/);
  for (const locale of ["de_DE.UTF-8", "sv_SE.UTF-8", "tr_TR.UTF-8"]) {
    assert.equal(read(locale), reference, `hash changed under ${locale}`);
  }
});

test("key order in the payload does not change the hash", () => {
  assert.equal(hashJson({ a: 1, b: 2 }), hashJson({ b: 2, a: 1 }));
});

test("payload hashing rejects values nested past the depth limit", () => {
  let deep: unknown = "leaf";
  for (let index = 0; index < 200; index += 1) deep = { nested: deep };
  assert.throws(() => hashJson(deep as never), /must not nest deeper than 64 levels/);
});

test("payload hashing rejects non-finite numbers", () => {
  assert.throws(() => hashJson({ value: Number.NaN }), /finite numbers/);
  assert.throws(() => hashJson({ value: Number.POSITIVE_INFINITY }), /finite numbers/);
});

test("a request ID is rejected when reused with different input", () => {
  const directory = `/tmp/slice-state-test-${process.pid}-${Date.now()}`;
  const state = ApplicationStateStore.open(`${directory}/state.sqlite`);
  try {
    assert.equal(state.reserveSubmission("thread-1", "req-1", { content: "hello" }), undefined);
    assert.equal(state.reserveSubmission("thread-1", "req-1", { content: "hello" }), undefined);
    assert.throws(
      () => state.reserveSubmission("thread-1", "req-1", { content: "changed" }),
      /already used with different input/,
    );
    assert.throws(() => state.reserveSubmission("thread-1", "bad request id", { content: "hello" }), /Request IDs must be/);
  } finally {
    state.close();
  }
});

test("a thread ID is validated like a request ID", () => {
  const directory = `/tmp/slice-state-test-${process.pid}-${Date.now()}`;
  const state = ApplicationStateStore.open(`${directory}/state.sqlite`);
  try {
    assert.throws(
      () => state.reserveSubmission("thread with spaces", "req-1", { content: "hello" }),
      /Thread IDs must be/,
    );
    assert.throws(
      () => state.reserveSubmission("thread with spaces", "req-1", { content: "hello" }),
      /Thread IDs must be/,
    );
  } finally {
    state.close();
  }
});