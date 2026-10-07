/**
 * GitHub issue reads for registered projects. Only the project's own registered slug is ever
 * requested; the caller cannot point this at an arbitrary repository. Issue text is untrusted data:
 * it is captured for the job record and never interpreted as policy.
 */

export type GithubIssue = {
  number: number;
  id: number;
  title: string;
  body: string;
  url: string;
  state: string;
  labels: readonly string[];
  updatedAt: string;
};

const GITHUB_API = "https://api.github.com";

function safeSlug(repoSlug: string): boolean {
  // Segments must start alphanumeric, so "../x" style traversal can never reach the API path.
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repoSlug);
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export async function listGithubIssues(repoSlug: string, environment: NodeJS.ProcessEnv = process.env): Promise<GithubIssue[]> {
  if (!safeSlug(repoSlug)) throw new TypeError("Issue reads require a registered owner/repo slug");
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "slice-agent/0.1",
  };
  // An optional token is read from the environment only and never logged.
  const token = environment.SLICE_GITHUB_TOKEN;
  if (token !== undefined && token.length > 0) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${GITHUB_API}/repos/${repoSlug}/issues?state=open&per_page=30&sort=updated`, { headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`GitHub issue read failed: ${response.status}`);
  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new Error("GitHub returned an unexpected issue payload");
  const issues: GithubIssue[] = [];
  for (const item of body) {
    if (item === null || typeof item !== "object") continue;
    const issue = item as Record<string, unknown>;
    // GitHub counts pull requests as issues; the picker must exclude them. [S6]
    if (issue.pull_request !== undefined) continue;
    if (typeof issue.number !== "number" || typeof issue.id !== "number") continue;
    issues.push({
      number: issue.number,
      id: issue.id,
      title: boundedText(issue.title, 300),
      body: boundedText(issue.body, 20_000),
      url: boundedText(issue.html_url, 500),
      state: boundedText(issue.state, 20),
      labels: Array.isArray(issue.labels)
        ? issue.labels.map((label) => (label !== null && typeof label === "object" ? boundedText((label as Record<string, unknown>).name, 50) : "")).filter((name) => name.length > 0)
        : [],
      updatedAt: boundedText(issue.updated_at, 40),
    });
  }
  return issues;
}
