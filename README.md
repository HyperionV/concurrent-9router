# concurrent-9router

`concurrent-9router` is the custom Project Router fork of `9router`. It keeps the OpenAI-compatible router and dashboard shape from upstream, but the runtime is deliberately different: local state is SQLite-backed, Codex traffic can be dispatcher-managed, and Codex image generation has its own always-on image dispatcher.

This repository is the implementation target. The sibling `../9router` repository is the upstream reference used for feature inspection and selective migration.

## What This Fork Is For

- Run a local AI routing gateway at `http://localhost:20128`.
- Manage provider accounts, model aliases, API keys, proxy pools, combos, usage, quota, and dispatcher status from the dashboard.
- Serve OpenAI-compatible Responses requests at `/v1/responses`.
- Serve Codex text-to-image requests at `/v1/images/generations`.
- Preserve custom concurrency and dispatcher behavior while selectively porting useful upstream `9router` features.

This is not a clean upstream fork. Do not blindly copy upstream files over this tree.

## Runtime Architecture

```text
Client tool or script
  -> http://localhost:20128/v1/*
  -> Next.js API route
  -> src/sse handlers
  -> open-sse provider executors / handlers
  -> provider account selected from SQLite-backed local state
```

Important local differences:

- SQLite is the canonical runtime store at `${DATA_DIR}/state.sqlite`.
- Legacy JSON files are migration/import sources only, not active state.
- `better-sqlite3` is required at runtime.
- Dispatcher lifecycle ledgers are durable SQLite tables.
- In-memory dispatcher state is limited to live occupancy and path-health state.

## Core Features

### Dashboard

The dashboard runs at:

```text
http://localhost:20128/dashboard
```

Main sections include:

- Endpoint configuration and API key guidance
- Providers and provider connections
- Media Providers -> Text to Image -> Codex
- Dispatcher -> Text Dispatcher
- Dispatcher -> Image Dispatcher
- Proxy pools
- Combos
- Usage and quota views
- CLI tools and profile/settings

### Provider Scope

The current custom provider surface is intentionally narrower than upstream marketing copy:

- OAuth providers: Claude Code and OpenAI Codex
- API-key providers: OpenAI and Anthropic
- OpenAI-compatible and Anthropic-compatible provider nodes
- Codex supports both LLM and image service kinds

Model and provider metadata live primarily in:

- `src/shared/constants/providers.js`
- `src/shared/constants/models.js`
- `open-sse/config/providerModels.js`

### Text Dispatcher

The text dispatcher is the custom Codex admission system for chat traffic.

Key behavior:

- Codex-only managed admission
- Optional shadow mode for ledger-only tracking
- Per-API-key admission policy support
- Configurable text slots per connection
- Durable request, attempt, event, and affinity state in SQLite
- Conversation affinity for managed Codex flows

Key files:

- `src/lib/dispatcher/core.js`
- `src/lib/dispatcher/executeCodexAttempt.js`
- `src/lib/dispatcher/admissionPolicy.js`
- `src/lib/dispatcher/conversationAffinity.js`
- `src/lib/sqlite/dispatcherStore.js`
- `src/app/api/dispatcher/text/status/route.js`
- `src/app/api/dispatcher/text/settings/route.js`
- `src/app/(dashboard)/dashboard/dispatcher/text/page.js`

Compatibility aliases remain:

- `/api/dispatcher/status`
- `/api/dispatcher/settings`

Both alias the text dispatcher.

### Image Dispatcher

Codex image generation is routed through a separate always-on dispatcher.

Key behavior:

- Applies to `POST /v1/images/generations`
- Codex-only
- Always on; no enable/disable switch
- Fixed capacity of `1` active image request per active Codex account
- Image and text capacity are independent
- Separate SQLite tables:
  - `image_dispatch_requests`
  - `image_dispatch_attempts`
  - `image_dispatch_events`
- Lifecycle vocabulary is shared with the text dispatcher
- Preferred account via `x-connection-id` is honored only when that account's image slot is free
- SSE image completion/failure is finalized from inside the stream body, not when the outer `Response` is returned

Key files:

- `src/lib/dispatcher/imageCore.js`
- `src/lib/dispatcher/imageIndex.js`
- `src/lib/sqlite/imageDispatcherStore.js`
- `src/lib/sqlite/dispatchLedgerStoreFactory.js`
- `src/sse/handlers/imageGeneration.js`
- `open-sse/handlers/imageGenerationCore.js`
- `src/app/api/dispatcher/image/status/route.js`
- `src/app/(dashboard)/dashboard/dispatcher/image/page.js`

### Codex Text-to-Image

Endpoint:

```http
POST /v1/images/generations
```

Example:

```bash
curl http://localhost:20128/v1/images/generations \
  -H "Authorization: Bearer <router-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codex/gpt-5.5-image",
    "prompt": "A small orange router floating in a glass data center",
    "size": "1024x1024"
  }'
```

Notes:

- Codex image generation requires an eligible ChatGPT account, typically Plus or higher.
- Custom image models can be added from the Codex image provider page.
- Binary output is available with `?response_format=binary`.
- SSE clients can request `Accept: text/event-stream`.
- Account fallback is not transparent after SSE bytes have been sent to the client.

### Proxy Pools

Proxy behavior follows the account/provider configuration. If an account is assigned an active proxy pool, requests for that account use the pool. The dispatcher does not add a separate proxy policy.

Supported proxy configuration is handled by:

- `src/lib/network/connectionProxy.js`
- `open-sse/utils/proxyFetch.js`
- dashboard proxy pool routes under `src/app/api/proxy-pools/`

## Local Development

Use Node.js compatible with `better-sqlite3` native builds.

Install dependencies:

```bash
npm install
```

Create an environment file:

```bash
cp .env.example .env
```

Run development server:

```bash
npm run dev
```

Default development URLs:

```text
Dashboard: http://localhost:20128/dashboard
OpenAI-compatible API: http://localhost:20128/v1
```

Production build:

```bash
npm run build
```

Production start:

```bash
PORT=20128 HOSTNAME=0.0.0.0 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run start
```

On PowerShell, set environment variables separately:

```powershell
$env:PORT="20128"
$env:HOSTNAME="0.0.0.0"
$env:NEXT_PUBLIC_BASE_URL="http://localhost:20128"
npm run start
```

## Environment

Important variables from `.env.example`:

```text
JWT_SECRET=change-me-to-a-long-random-secret
INITIAL_PASSWORD=change-me
DATA_DIR=/var/lib/9router
PORT=20128
API_KEY_SECRET=endpoint-proxy-api-key-secret
MACHINE_ID_SALT=endpoint-proxy-salt
REQUIRE_API_KEY=false
BASE_URL=http://localhost:20128
NEXT_PUBLIC_BASE_URL=http://localhost:20128
```

`DATA_DIR` is especially important because SQLite runtime state is stored in:

```text
${DATA_DIR}/state.sqlite
```

## API Surface

Primary OpenAI-compatible endpoints:

- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/images/generations`

Dispatcher status and settings:

- `GET /api/dispatcher/text/status`
- `GET /api/dispatcher/text/settings`
- `PATCH /api/dispatcher/text/settings`
- `GET /api/dispatcher/image/status`
- `GET /api/dispatcher/status` compatibility alias
- `GET /api/dispatcher/settings` compatibility alias
- `PATCH /api/dispatcher/settings` compatibility alias

Management API areas:

- `/api/providers/*`
- `/api/provider-nodes/*`
- `/api/models/*`
- `/api/keys/*`
- `/api/combos/*`
- `/api/proxy-pools/*`
- `/api/settings/*`
- `/api/usage/*`

## Testing

Focused image dispatcher and image generation tests:

```bash
node --loader ./tests/dispatcher/alias-loader.mjs --test tests/image/*.test.mjs
```

Text dispatcher tests:

```bash
npm run test:dispatcher
```

Build validation:

```bash
npm run build
```

Current package scripts:

```bash
npm run dev
npm run build
npm run start
npm run test:dispatcher
```

## Migration Workflow

This project exists to selectively migrate upstream `9router` features into the custom fork.

Recommended workflow:

1. Inspect upstream behavior in `../9router`.
2. Inspect the corresponding custom implementation in `concurrent-9router`.
3. Identify whether the upstream feature should be migrated, adapted, or rejected.
4. Preserve custom SQLite, dispatcher, auth, proxy, usage, and dashboard invariants.
5. Add focused tests around the migrated behavior.
6. Run focused tests first, then broader dispatcher/build checks for shared paths.

High-risk areas:

- `src/sse/handlers/chat.js`
- `src/sse/handlers/imageGeneration.js`
- `open-sse/handlers/chatCore.js`
- `open-sse/handlers/imageGenerationCore.js`
- `src/lib/dispatcher/*`
- `src/lib/sqlite/*`
- `src/lib/localDb.js`
- `src/lib/usageDb.js`
- API key, OAuth, provider, proxy, usage, and request detail routes

## Repository Notes

- The package is private and source-first: `npm install -g 9router` is not the expected workflow for this repo.
- Do not edit `../9router` unless explicitly requested.
- Do not reintroduce JSON files as active runtime state.
- Do not make image dispatcher settings inherit text dispatcher settings.
- Do not add fallback or compatibility layers for retired paths unless explicitly requested.
- Keep README claims tied to behavior present in this fork.
