# Obsync

Self-hosted realtime sync for Obsidian vaults.

## Monorepo Layout

- `apps/server`: HTTP + WebSocket sync API.
- `apps/plugin`: Obsidian plugin sync engine modules.
- `packages/shared`: shared types, schemas, crypto/chunk helpers.
- `docs`: architecture, OpenAPI, JSON schemas, ops, LLM/OpenClaw guides.
- `infra`: observability configs.

## Quick Start

1. Copy `.env.example` to `.env` and adjust values.
2. Start infrastructure:
   - `docker compose up -d`
3. Install dependencies:
   - `npm install`
4. Start server:
   - `npm run dev`

## API Contract

- OpenAPI: `docs/api/openapi.yaml`
- JSON Schemas: `docs/schemas/`
- Examples: `docs/examples/`

## Obsidian Plugin

- Build plugin bundle: `npm run -w @obsync/plugin build:obsidian`
- One-command install: `npm run -w @obsync/plugin install:obsidian -- /absolute/path/to/vault`
- Install + smoke instructions: `docs/ops/obsidian-plugin-install.md`
