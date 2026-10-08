# Slice

Slice is a small, self-hosted agent service. Its goal is to turn a plain-language change request into a tested and independently reviewed pull request. The user controls merge and deployment.

## Current state

Phase 0 is complete and signed off (2026-10-07). Phase 1 is implemented and synthetically verified; its live exit check has not been run (see [Phase 1 results](docs/phase1-results.md)). Phase 2 is implemented and synthetically verified: author, code-review, and security-review roles with distinct model identities, validated patches applied only by the runner, findings the author cannot close, at most four repair rounds, a deterministic readiness gate bound to verification keys, journal-backed publishing (push, draft PR, five `slice/*` checks, promotion) that becomes ready only on host acknowledgement, verified merge observation with archiving and idempotent workspace cleanup while evidence is retained, and a delivery panel in the web app. Its live exit check has not been run; see [Phase 2 results](docs/phase2-results.md). Phase 3 is implemented and synthetically verified (133 tests in total): durable calibrated status reports with a 10-minute default, a notification outbox with honest delivery states, Telegram alerts and code-based account linking, a searchable Active/Archived thread picker, archived result pages with linked follow-up jobs, evidence artifacts with retention states and safe digest-checked downloads, and runner-side isolated previews with baseline/after screenshot evidence. Its live exit check (phone/tablet/desktop assessment, real preview, linked Telegram) has not been run; see [Phase 3 results](docs/phase3-results.md). Phase 4 is implemented and synthetically verified (165 tests in total): host pools with capacity and enable/disable, placement by worker OS with stated reasons, per-project model and privacy rules enforced before any model sees the request or the patch, toolchain attestation that gates Windows work, a retry path for environment-blocked jobs, release records tied to retained bundles, staging rollback rehearsals, a readiness gate that demands rollback evidence for database-sensitive changes, and a cleanup recovery sweep across host outages. Its live exit check (a Windows project completing on a real Windows worker, a previous release restored in staging) has not been run; see [Phase 4 results](docs/phase4-results.md). Telegram commands, concurrent authors, scheduled requests, and further Git providers belong to Phase 5.

See [the build specification](docs/build-spec.md), [the spec review](docs/spec-review.md), [Phase 0 results](docs/phase0-results.md), the [Phase 0 security review](docs/phase0-security-review.md), [Phase 1 results](docs/phase1-results.md), [Phase 2 results](docs/phase2-results.md), [Phase 3 results](docs/phase3-results.md), and [Phase 4 results](docs/phase4-results.md).

## Run locally

Requirements: Node.js 22.19 or newer and npm.

```sh
npm ci
npm run check
npm start
```

The service stores state in `.slice/state.sqlite` and listens on `127.0.0.1:3000`. Set `SLICE_STATE_DIR` or `SLICE_PORT` to change these values. On Unix, an existing state directory must be owner-only (`0700`); startup refuses broader permissions without changing them. Only one process can own a state directory. Check it with:

```sh
curl http://127.0.0.1:3000/healthz
```

## Running the Phase 1 web app

```sh
export SLICE_OWNER_PASSWORD='a-long-owner-password'   # enables the API and the web app
export SLICE_REQUIREMENTS_PROVIDER=slice-local
export SLICE_REQUIREMENTS_MODEL_ID=your-model-id
export SLICE_RUNNER_MODE=local
export SLICE_RUNNER_ROOT=$PWD/.slice/runner-root
npm start
```

Open `http://127.0.0.1:3000/` and sign in. See [docs/phase1-results.md](docs/phase1-results.md) for the SSH runner setup, host key pinning, and the phase's limits.

## Test model endpoints

Live model checks are opt-in. They send one short prompt to the configured endpoint.

For an OpenAI-compatible local server:

```sh
export SLICE_LOCAL_BASE_URL=http://127.0.0.1:1234/v1
export SLICE_LOCAL_MODEL_ID=your-model-id
npm run smoke:local
```

Set `SLICE_LOCAL_API_KEY` only when the local endpoint checks an API key. A keyless endpoint is sent a non-secret placeholder, because the Pi AI client refuses to send a request with no API key at all.

`SLICE_LOCAL_CONTEXT_TOKENS` defaults to 262144 and `SLICE_LOCAL_OUTPUT_TOKENS` to 32768. Set both to match the model you select: a reply budget larger than the context window is rejected at startup, and a model with a smaller window than the default will reject an over-long request.

For OpenAI:

```sh
export OPENAI_API_KEY=your-key
export SLICE_OPENAI_MODEL_ID=your-model-id
npm run smoke:openai
```

For a ChatGPT Plus/Pro subscription instead of API billing, sign in once with the device-code flow (tokens are stored owner-only in the state directory and never printed), then run the check:

```sh
npm run auth:openai
export SLICE_PLUS_PRO=1   # optional: SLICE_PLUS_PRO_MODEL_ID, SLICE_PLUS_PRO_REASONING_EFFORT
npm run smoke:pluspro
```

`smoke:pluspro` reports `not_tested` and exits non-zero when the profile is off or no credential is stored; it never reports a pass without a live call.

Do not commit credentials. The tests in `npm run check` use only fake providers and fake external services.
