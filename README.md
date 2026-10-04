# Slice

Slice is a small, self-hosted agent service. Its goal is to turn a plain-language change request into a tested and independently reviewed pull request. The user controls merge and deployment.

## Current state

Phase 0 is in progress. This repository has a compiled TypeScript service, a typed Pi Durable adapter, a single-owner SQLite store, durable request deduplication, and crash-recovery tests. The HTTP service currently exposes only `GET /healthz`. It does not yet accept change requests or connect to GitHub repositories, SSH runners, Telegram, or deployment systems.

See [the build specification](docs/build-spec.md), [the spec review](docs/spec-review.md), and [Phase 0 results](docs/phase0-results.md).

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

## Test model endpoints

Live model checks are opt-in. They send one short prompt to the configured endpoint.

For an OpenAI-compatible local server:

```sh
export SLICE_LOCAL_BASE_URL=http://127.0.0.1:1234/v1
export SLICE_LOCAL_MODEL_ID=your-model-id
npm run smoke:local
```

Set `SLICE_LOCAL_API_KEY` only when the local endpoint checks an API key. A keyless endpoint is sent a non-secret placeholder, because the Pi AI client refuses to send a request with no API key at all.

For OpenAI:

```sh
export OPENAI_API_KEY=your-key
export SLICE_OPENAI_MODEL_ID=your-model-id
npm run smoke:openai
```

Do not commit credentials. The tests in `npm run check` use only fake providers and fake external services.
