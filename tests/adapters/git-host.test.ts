import assert from "node:assert/strict";
import { test } from "node:test";
import { GithubClient } from "../../apps/server/src/adapters/github/git-host.js";

type Recorded = { path: string; method: string; body?: Record<string, unknown> };

function stubFetch(records: Recorded[], responses: Record<string, { status: number; json: unknown }>) {
  return (async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>;
    records.push({ path, method: init.method ?? "GET", ...(body === undefined ? {} : { body }) });
    const key = `${init.method ?? "GET"} ${path.split("?")[0]}`;
    const canned = responses[key] ?? { status: 404, json: null };
    return new Response(JSON.stringify(canned.json), { status: canned.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const OPEN_PR = { number: 7, html_url: "https://github.example/pull/7", title: "t", state: "open", draft: true, merged: false, head: { sha: "a".repeat(40), ref: "slice/job-1/x" }, base: { sha: "b".repeat(40) }, merge_commit_sha: "c".repeat(40) };

test("the git host client has no merge capability at all", () => {
  const client = new GithubClient({ token: "t", fetchImpl: stubFetch([], {}) });
  const capabilities = Object.getOwnPropertyNames(Object.getPrototypeOf(client));
  assert.equal(capabilities.includes("merge"), false, "the publishing identity cannot merge");
  assert.equal(capabilities.includes("mergePr"), false);
  assert.equal(capabilities.includes("push"), false);
  assert.equal(capabilities.includes("deleteBranch"), false);
});

test("draft creation, promotion, and status publication use the registered shapes", async () => {
  const records: Recorded[] = [];
  const client = new GithubClient({
    token: "t",
    fetchImpl: stubFetch(records, {
      "POST /repos/owner/demo/pulls": { status: 201, json: OPEN_PR },
      "PATCH /repos/owner/demo/pulls/7": { status: 200, json: { ...OPEN_PR, draft: false } },
      ["POST /repos/owner/demo/statuses/" + "a".repeat(40)]: { status: 201, json: {} },
    }),
  });
  const created = await client.createDraftPr("owner/demo", { title: "Add notes", head: "slice/job-1/x", base: "main", body: "evidence" });
  assert.equal(created.draft, true);
  assert.equal(records[0]!.body!.draft, true, "PRs start as drafts");

  const promoted = await client.setDraft("owner/demo", 7, false);
  assert.equal(promoted.draft, false);

  await client.publishStatus("owner/demo", "a".repeat(40), "slice/code-review", "success", "passed");
  assert.equal(records[2]!.body!.context, "slice/code-review");

  await assert.rejects(() => client.publishStatus("owner/demo", "a".repeat(40), "ci/anything", "success", ""), TypeError, "only slice/<name> contexts may be published");
  await assert.rejects(() => client.createDraftPr("owner/demo", { title: "x", head: "main", base: "main", body: "" }), TypeError, "only slice branches may open PRs");
});

test("a merge_commit_sha on an unmerged PR is never read as a merge", async () => {
  const client = new GithubClient({ token: "t", fetchImpl: stubFetch([], { "GET /repos/owner/demo/pulls/7": { status: 200, json: OPEN_PR } }) });
  const pr = await client.getPr("owner/demo", 7);
  assert.ok(pr !== null);
  assert.equal(pr.state, "open");
  assert.equal(pr.mergedRevision, null, "a test-merge hint is not merge confirmation");

  const mergedClient = new GithubClient({
    token: "t",
    fetchImpl: stubFetch([], { "GET /repos/owner/demo/pulls/7": { status: 200, json: { ...OPEN_PR, state: "closed", merged: true, draft: false } } }),
  });
  const merged = await mergedClient.getPr("owner/demo", 7);
  assert.ok(merged !== null);
  assert.equal(merged.state, "merged");
  assert.equal(merged.mergedRevision, "c".repeat(40));
});

test("stale lookups and unknown shapes are refused, not guessed", async () => {
  const client = new GithubClient({ token: "t", fetchImpl: stubFetch([], {}) });
  await assert.rejects(() => client.findPrByHeadBranch("owner/demo", "feature/random"), TypeError);
  await assert.rejects(() => client.findPrByHeadBranch("evil/../../", "slice/job-1/x"), TypeError);
  const missing = await client.getPr("owner/demo", 99);
  assert.equal(missing, null);
});
