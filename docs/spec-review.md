# Build specification review

Reviewed 4 October 2026 against the draft build specification at PR head `a5579f0e9e8630a8aa99acc476958d65850e8a08`.

## Decision

The design is ready to start Phase 0. The reviewed specification now separates application policy from Pi Durable, closes the major readiness and permission gaps, and sets explicit recovery and evidence rules. It keeps the first delivery small: one TypeScript service, one SQLite owner, one demo runner, and a minimal mobile web app.

The draft PR contains design documents and images only. No Slice application code has been implemented. The design and its acceptance tests have not been run against real model providers, SSH hosts, or the GitHub protection settings for a registered repository. Phase 0 and the disposable-repository tests are required before production use.

## Findings and changes

| Finding | Risk before review | Change in version 1.2 |
|---|---|---|
| Readiness could never pass | The gate required a non-draft PR and passing Slice checks before the service had published or acknowledged them. | Separate prerequisite evidence, candidate eligibility, check publication, draft promotion, and final `ready` confirmation. Keep the task in `publishing` through outages and retries. |
| Service identity could merge | GitHub's merge endpoint requires `Contents: write`; a token with that permission could merge an all-green PR despite the app exposing no merge tool. | Separate the feature-branch SSH key, the PR App with only `Pull requests: write`, and the check publisher. Verify denied direct pushes and denied merges when every check and approval passes. GitHub documents the merge permission requirement in its [pull request REST API](https://docs.github.com/en/rest/pulls/pulls). |
| Reviews could cite altered or untrusted source | A writable test checkout could be changed after its commit was recorded, leaving evidence attached to the wrong source. Repository-controlled URLs could also redirect fetches or expose credentials. | Record Git, submodule, LFS, and approved-input identities. Fetch only from project-approved hosts without forwarding repository credentials. Freeze review inputs, keep generated data separate, and compare source digests around checks. |
| Remote work could be duplicated after restart | A control-service restart or a crash before PID recording could leave a build running on an SSH host. A missing PID was not a safe retry signal. | Add supervised operation IDs, persistent runner journals, lease generations, fencing, and reconciliation before retry or replacement. |
| Merge and cleanup were coupled | Waiting for conversations or an unavailable runner could hide an already merged thread or delay release work. Cleanup omitted temporary check and preview resources. | Archive on verified merge; track cleanup and release separately. Export and verify retained evidence before deleting all job-owned workspaces and resources. |
| Model labels could overstate reviewer independence | Two aliases or proxy profiles could resolve to the same weights. | Record resolved model and endpoint identity for every attempt. Check diversity against every model that wrote the current change, including repair and fallback attempts. |
| Budget limits could be exceeded | Parallel requests, retries, compaction, and unknown provider usage were not admitted against one shared cap. | Reserve conservative token and cost limits before each request; settle reported usage, account for uncertainty, and block unbounded paid requests. |
| ETA threshold implied confidence | Ten completed tasks do not show that the estimate is calibrated for a particular project or workflow. | Show remaining time as unknown until comparable held-out history supports a calibrated range. Keep stage estimates separate from whole-job estimates. |
| Mutations had no valid creation revision | Requiring an expected job revision at job creation made the API contract impossible. Telemetry could also stale an owner's form. | Use request IDs and payload hashes for creates, resource revisions for updates, and question revisions for answers. Keep command revisions separate from status telemetry. |
| Exception policy was ambiguous | The old rules could allow an owner exception to conflict with review verdicts or failure results. | Keep exceptions disabled by default. Block critical, high, and medium findings and non-waivable identity, provenance, evidence, and isolation failures. Bind any permitted low-risk or pre-existing-check exception to a recorded verification key and keep the underlying result visible. |
| Mobile UI lacked a concrete direction | The user-facing pages were described in prose without a visual reference or a clear separation between progress, evidence, and code. | Add a pinned pi-mobile desktop reference plus labelled Slice mock-ups for threads, status, and the review-ready result. The mock-ups contain example data; they are not product screenshots or test evidence. |

## First implementation boundary

Implement and test Phase 0 before connecting a production repository. Then prove one complete change in a disposable repository: requirements, isolated worktree, authoring, separate validation and reviews, readiness publication, user merge, archive, cleanup, and retained evidence. Run the GitHub permissions test with all checks and required approval satisfied. Keep real release credentials and production deployment outside the worker.

Repository and host addresses, SSH credentials, model identities, privacy rules, budget caps, build profiles, and the existing release/rollback controls are project onboarding data. They do not block the Phase 0 runtime spike. A project must pass its actual GitHub permission and toolchain checks before it can accept unattended work.

The token allocation in the spec dedicates 80% to validation, code review, security review, and final evidence, with 20% for requirements, planning, and implementation. Treat this as a budget target, not a quality metric. Do not add reviewers only to meet the percentage.

## References

- [Pi Durable](https://earendil.com/posts/pi-durable/): durable tasks, conversations, replay, and background-task lifecycle.
- [GitHub pull request REST API](https://docs.github.com/en/rest/pulls/pulls): merge endpoint permissions and merge result semantics.
- [GitHub ruleset rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets): branch update and required-check controls.
- [p1rallels/pi-mobile](https://github.com/p1rallels/pi-mobile/tree/4cc9b712254d84c90a00373c972c8a417fd26fb9): Pi mobile-web UI and replay fixture. Its screenshot is licensed under MIT; the copyright and license notice are included with the image. Mario Zechner's Pi SDK is the upstream agent runtime.
