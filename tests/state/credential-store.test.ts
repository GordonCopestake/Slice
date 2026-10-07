import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Credential } from "@earendil-works/pi-ai";
import { FileCredentialStore } from "../../apps/server/src/state/credential-store.js";

/** Same shape the ChatGPT Plus/Pro login stores; the values are synthetic and never real tokens. */
function oauthCredential(access: string): Credential {
  return { type: "oauth", access, refresh: `refresh-${access}`, expires: 4_102_444_800 };
}

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), "slice-credential-store-"));
}

test("the credential file is created and replaced with owner-only mode", async () => {
  const directory = tempStateDir();
  const store = new FileCredentialStore(directory);
  await store.modify("openai-codex", async () => oauthCredential("access-1"));
  const mode = statSync(store.path).mode & 0o777;
  assert.equal(mode, 0o600, "a credential file must not be readable by group or other");

  // Replacing an existing file must not inherit a looser mode from the previous inode.
  chmodSync(store.path, 0o644);
  await store.modify("openai-codex", async () => oauthCredential("access-2"));
  assert.equal(statSync(store.path).mode & 0o777, 0o600);

  // Writes go through a temporary file that is renamed away, so no partial file is left behind.
  assert.equal(existsSync(`${store.path}.tmp`), false);
  assert.deepEqual(readdirSync(directory).filter((name) => name.startsWith("credentials.json")), ["credentials.json"]);
});

test("the state directory is created owner-only when it does not exist", async () => {
  const directory = join(tempStateDir(), "nested", "state");
  const store = new FileCredentialStore(directory);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  // The constructor only prepares the directory; the file appears on the first write, still owner-only.
  await store.modify("openai-codex", async () => oauthCredential("access-1"));
  assert.equal(statSync(store.path).mode & 0o777, 0o600);
});

test("list returns metadata only and never exposes a token", async () => {
  const store = new FileCredentialStore(tempStateDir());
  await store.modify("openai-codex", async () => oauthCredential("super-secret-access"));
  await store.modify("openai", async () => ({ type: "api_key", key: "sk-should-not-appear" }));
  const listed = await store.list();
  assert.deepEqual(
    [...listed].sort((a, b) => a.providerId.localeCompare(b.providerId)),
    [{ providerId: "openai", type: "api_key" }, { providerId: "openai-codex", type: "oauth" }],
  );
  const dump = JSON.stringify(listed);
  assert.equal(dump.includes("super-secret-access"), false);
  assert.equal(dump.includes("sk-should-not-appear"), false);
  assert.equal(dump.includes("refresh-"), false);
});

test("delete removes the credential and read resolves undefined for a missing entry", async () => {
  const store = new FileCredentialStore(tempStateDir());
  await store.modify("openai-codex", async () => oauthCredential("access-1"));
  await store.delete("openai-codex");
  assert.equal(await store.read("openai-codex"), undefined);
  assert.equal(await store.read("never-stored"), undefined);
  assert.deepEqual(await store.list(), []);
});

test("a corrupt or foreign credential file reads as no credentials, not as a crash", async () => {
  const directory = tempStateDir();
  const store = new FileCredentialStore(directory);
  writeFileSync(join(directory, "credentials.json"), "this is not json", { mode: 0o600 });
  assert.equal(await store.read("openai-codex"), undefined);
  assert.deepEqual(await store.list(), []);
  // A later login still writes a valid file over the garbage.
  await store.modify("openai-codex", async () => oauthCredential("access-1"));
  assert.equal((await store.read("openai-codex"))?.type, "oauth");
});

test("concurrent modifications of one provider serialise and no write is lost", async () => {
  const store = new FileCredentialStore(tempStateDir());
  // Each writer appends to the key it sees, so a lost update would show as a shorter final key.
  const writers = Array.from({ length: 5 }, () =>
    store.modify("openai-codex", async (current) => ({
      type: "api_key",
      key: `${current === undefined || current.type !== "api_key" ? "" : current.key}x`,
    })),
  );
  const results = await Promise.all(writers);
  assert.equal(results.at(-1)?.type, "api_key");
  if (results.at(-1)?.type !== "api_key") throw new Error("expected an api_key credential");
  assert.equal(results.at(-1)?.key, "xxxxx");
  const stored = JSON.parse(readFileSync(store.path, "utf8")) as Record<string, { key?: string }>;
  assert.equal(stored["openai-codex"]?.key, "xxxxx");
});

test("a failing change does not block later writes to the same provider", async () => {
  const store = new FileCredentialStore(tempStateDir());
  await assert.rejects(store.modify("openai-codex", async () => {
    throw new Error("provider exchange failed");
  }), /provider exchange failed/);
  await store.modify("openai-codex", async () => oauthCredential("access-after-failure"));
  assert.equal((await store.read("openai-codex"))?.type, "oauth");
});

test("destroy removes stored credentials and any leftover temporary file", async () => {
  const directory = tempStateDir();
  const store = new FileCredentialStore(directory);
  await store.modify("openai-codex", async () => oauthCredential("access-1"));
  store.destroy();
  assert.equal(existsSync(store.path), false);
  assert.equal(await store.read("openai-codex"), undefined);
  // A fresh store over the same directory sees nothing left behind.
  const reopened = new FileCredentialStore(directory);
  assert.deepEqual(await reopened.list(), []);
});
