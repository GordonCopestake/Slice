export type PullRequestInfo = {
  number: number;
  url: string;
  title: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  headSha: string;
  baseSha: string;
  mergedRevision: string | null;
};

export type StatusContext = { context: string; state: "success" | "failure" | "pending"; description: string };

/**
 * The only git-host capabilities the delivery loop may use. There is deliberately no merge,
 * no branch write, and no protection-change method: the publishing identity creates, promotes, and
 * annotates pull requests, and the owner merges through the host under their own identity.
 */
export interface GitHost {
  findPrByHeadBranch(repoSlug: string, branch: string): Promise<PullRequestInfo | null>;
  createDraftPr(repoSlug: string, input: { title: string; head: string; base: string; body: string }): Promise<PullRequestInfo>;
  setDraft(repoSlug: string, prNumber: number, draft: boolean): Promise<PullRequestInfo>;
  getPr(repoSlug: string, prNumber: number): Promise<PullRequestInfo | null>;
  publishStatus(repoSlug: string, commitSha: string, context: string, state: StatusContext["state"], description: string): Promise<void>;
  listStatuses(repoSlug: string, commitSha: string): Promise<StatusContext[]>;
}

const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const BRANCH_PATTERN = /^slice\/[A-Za-z0-9._-]{1,128}\/[A-Za-z0-9._-]{1,64}$/;
const SHA_PATTERN = /^[0-9a-f]{7,64}$/;

function assertSlug(repoSlug: string): void {
  if (!SLUG_PATTERN.test(repoSlug)) throw new TypeError("Repository slugs must look like owner/repo");
}

type GithubPullDto = {
  number?: number;
  html_url?: string;
  title?: string;
  state?: string;
  draft?: boolean;
  merged?: boolean;
  head?: { sha?: string; ref?: string };
  base?: { sha?: string; ref?: string };
  merge_commit_sha?: string | null;
};

function toPr(dto: GithubPullDto): PullRequestInfo | null {
  if (typeof dto.number !== "number" || typeof dto.head?.sha !== "string" || typeof dto.base?.sha !== "string") return null;
  const state = dto.merged === true ? "merged" : dto.state === "open" ? "open" : dto.state === "closed" ? "closed" : null;
  if (state === null) return null;
  return {
    number: dto.number,
    url: String(dto.html_url ?? ""),
    title: String(dto.title ?? ""),
    state,
    draft: dto.draft === true,
    headSha: dto.head.sha,
    baseSha: dto.base.sha,
    // A non-null merge_commit_sha on an unmerged PR is a test-merge hint, never merge confirmation.
    mergedRevision: state === "merged" && typeof dto.merge_commit_sha === "string" ? dto.merge_commit_sha : null,
  };
}

export type GithubClientOptions = {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

/** GitHub over REST with a single token. The client has no merge call to make; the capability is absent. */
export class GithubClient implements GitHost {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: GithubClientOptions) {
    if (options.token.trim().length === 0) throw new TypeError("A GitHub token is required");
    this.#token = options.token;
    this.#baseUrl = options.baseUrl ?? "https://api.github.com";
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async #request(path: string, init: { method: string; body?: unknown }): Promise<{ status: number; json: unknown }> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { status: response.status, json };
  }

  async findPrByHeadBranch(repoSlug: string, branch: string): Promise<PullRequestInfo | null> {
    assertSlug(repoSlug);
    if (!BRANCH_PATTERN.test(branch)) throw new TypeError("Only slice/<job>/<title> branches may be looked up");
    const result = await this.#request(`/repos/${repoSlug}/pulls?state=all&per_page=50`, { method: "GET" });
    if (result.status !== 200 || !Array.isArray(result.json)) return null;
    for (const item of result.json as GithubPullDto[]) {
      if (item.head?.ref === branch) {
        const pr = toPr(item);
        if (pr !== null) return pr;
      }
    }
    return null;
  }

  async createDraftPr(repoSlug: string, input: { title: string; head: string; base: string; body: string }): Promise<PullRequestInfo> {
    assertSlug(repoSlug);
    if (!BRANCH_PATTERN.test(input.head)) throw new TypeError("Only slice/<job>/<title> branches may open pull requests");
    if (input.title.length === 0 || input.title.length > 200) throw new TypeError("PR titles must be 1-200 characters");
    if (input.body.length > 20_000) throw new TypeError("PR bodies are limited to 20000 characters");
    const result = await this.#request(`/repos/${repoSlug}/pulls`, {
      method: "POST",
      body: { title: input.title, head: input.head, base: input.base, body: input.body, draft: true },
    });
    const pr = result.status === 201 ? toPr((result.json ?? {}) as GithubPullDto) : null;
    if (pr === null) throw new Error(`createDraftPr failed: HTTP ${result.status}`);
    return pr;
  }

  async setDraft(repoSlug: string, prNumber: number, draft: boolean): Promise<PullRequestInfo> {
    assertSlug(repoSlug);
    if (!Number.isSafeInteger(prNumber) || prNumber <= 0) throw new TypeError("PR numbers must be positive integers");
    const result = await this.#request(`/repos/${repoSlug}/pulls/${prNumber}`, { method: "PATCH", body: { draft } });
    const pr = result.status === 200 ? toPr((result.json ?? {}) as GithubPullDto) : null;
    if (pr === null) throw new Error(`setDraft failed: HTTP ${result.status}`);
    return pr;
  }

  async getPr(repoSlug: string, prNumber: number): Promise<PullRequestInfo | null> {
    assertSlug(repoSlug);
    if (!Number.isSafeInteger(prNumber) || prNumber <= 0) throw new TypeError("PR numbers must be positive integers");
    const result = await this.#request(`/repos/${repoSlug}/pulls/${prNumber}`, { method: "GET" });
    if (result.status === 404) return null;
    if (result.status !== 200) throw new Error(`getPr failed: HTTP ${result.status}`);
    return toPr((result.json ?? {}) as GithubPullDto);
  }

  async publishStatus(repoSlug: string, commitSha: string, context: string, state: StatusContext["state"], description: string): Promise<void> {
    assertSlug(repoSlug);
    if (!SHA_PATTERN.test(commitSha)) throw new TypeError("Status commits must be hex revision ids");
    if (!/^slice\/[a-z-]{1,40}$/.test(context)) throw new TypeError("Only slice/<name> status contexts may be published");
    const result = await this.#request(`/repos/${repoSlug}/statuses/${commitSha}`, {
      method: "POST",
      body: { state, context, description: description.slice(0, 140) },
    });
    if (result.status !== 201) throw new Error(`publishStatus failed: HTTP ${result.status}`);
  }

  async listStatuses(repoSlug: string, commitSha: string): Promise<StatusContext[]> {
    assertSlug(repoSlug);
    if (!SHA_PATTERN.test(commitSha)) throw new TypeError("Status commits must be hex revision ids");
    const result = await this.#request(`/repos/${repoSlug}/commits/${commitSha}/statuses`, { method: "GET" });
    if (result.status !== 200 || !Array.isArray(result.json)) return [];
    const seen = new Map<string, StatusContext>();
    for (const item of result.json as { context?: string; state?: string; description?: string }[]) {
      if (typeof item.context !== "string" || (item.state !== "success" && item.state !== "failure" && item.state !== "pending")) continue;
      seen.set(item.context, { context: item.context, state: item.state, description: String(item.description ?? "") });
    }
    return [...seen.values()];
  }
}
