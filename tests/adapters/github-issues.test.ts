import assert from "node:assert/strict";
import { test } from "node:test";
import { listGithubIssues } from "../../apps/server/src/adapters/github/github-issues.js";

const originalFetch = globalThis.fetch;

function stubFetch(payload: unknown): { url: string; auth: string | undefined } {
  const seen: { url: string; auth: string | undefined } = { url: "", auth: undefined };
  globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    seen.url = String(input);
    seen.auth = init?.headers?.authorization;
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return seen;
}

test("issue reads refuse anything that is not a registered owner/repo slug", async () => {
  for (const slug of ["owner", "owner/repo/extra", "../secrets", "owner/re po", ""]) {
    await assert.rejects(listGithubIssues(slug), /registered owner\/repo slug/);
  }
});

test("pull requests are excluded from the issue picker and text is bounded", async () => {
  const seen = stubFetch([
    { number: 1, id: 101, title: "Real issue", body: "x".repeat(50_000), html_url: "https://github.com/o/r/issues/1", state: "open", labels: [{ name: "bug" }], updated_at: "2026-10-07T10:00:00Z" },
    { number: 2, id: 102, title: "A pull request", body: "", html_url: "https://github.com/o/r/pull/2", state: "open", pull_request: { url: "x" }, updated_at: "2026-10-07T10:00:00Z" },
    { number: 3, id: 103, title: null, body: null, html_url: "https://github.com/o/r/issues/3", state: "open", updated_at: "2026-10-07T10:00:00Z" },
  ]);
  try {
    const issues = await listGithubIssues("owner/repo", {});
    assert.deepEqual(issues.map((issue) => issue.number), [1, 3], "GitHub counts pull requests as issues; the picker excludes them");
    assert.ok(issues[0]!.body.length <= 20_001, "issue bodies are captured but bounded");
    assert.equal(issues[0]!.labels[0], "bug");
    assert.equal(issues[1]!.title, "", "missing titles become empty text, never a crash");
    assert.ok(seen.url === "https://api.github.com/repos/owner/repo/issues?state=open&per_page=30&sort=updated");
    assert.equal(seen.auth, undefined, "no token, no authorization header");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a token is read from the environment only and sent as a bearer header", async () => {
  const seen = stubFetch([]);
  try {
    await listGithubIssues("owner/repo", { SLICE_GITHUB_TOKEN: "gh-test-token" });
    assert.equal(seen.auth, "Bearer gh-test-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a non-OK GitHub response is an error, not an empty list", async () => {
  globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
  try {
    await assert.rejects(listGithubIssues("owner/repo", {}), /GitHub issue read failed: 404/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
