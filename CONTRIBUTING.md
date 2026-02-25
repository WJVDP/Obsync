# Contributing

Thanks for contributing to Obsync.

## Development Setup

Prerequisites:

1. Node.js 20+
2. npm 10+
3. Docker Engine with `docker compose`

Setup:

```bash
npm install
cp .env.example .env
```

Optional local stack:

```bash
docker compose up -d
```

## Build and Test

Run these before opening a PR:

```bash
npm run typecheck
npm run test
npm run validate:openapi
```

## Code and PR Expectations

1. Keep changes scoped to a clear problem.
2. Add or update tests for behavior changes.
3. Keep API and schema changes synchronized with docs in `docs/api` and `docs/schemas`.
4. Include a short PR summary with:
   - Problem statement
   - Approach
   - Validation performed
   - Follow-up risks or TODOs

## Commit Guidelines

- Use clear, descriptive commit messages.
- Prefer small logical commits over large mixed changes.

## Reporting Bugs and Requesting Features

- Use GitHub Issues.
- For security-sensitive issues, follow `SECURITY.md`.
