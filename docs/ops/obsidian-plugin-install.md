# Obsidian Plugin Install and Smoke Test

## Build plugin artifacts

From repository root:

```bash
npm install
npm run -w @obsync/plugin build:obsidian
```

Build output:

- `apps/plugin/dist-obsidian/main.js`
- `apps/plugin/dist-obsidian/manifest.json`

## One-command install

From repository root:

```bash
npm run -w @obsync/plugin install:obsidian -- /absolute/path/to/your/vault
```

Alternative using env var:

```bash
OBSIDIAN_VAULT_PATH=/absolute/path/to/your/vault npm run -w @obsync/plugin install:obsidian
```

## Install into Obsidian

1. Open your vault folder.
2. Create plugin dir if needed:
   - `<vault>/.obsidian/plugins/obsync/`
3. Copy plugin artifacts:
   - `apps/plugin/dist-obsidian/main.js` -> `<vault>/.obsidian/plugins/obsync/main.js`
   - `apps/plugin/dist-obsidian/manifest.json` -> `<vault>/.obsidian/plugins/obsync/manifest.json`
4. In Obsidian:
   - Settings -> Community Plugins -> Reload plugins
   - Enable `Obsync`

## Configure plugin

In Settings -> Obsync:

1. `Base URL`: `http://localhost:8080`
2. `Vault ID`: use created vault id from API.
3. Choose auth mode:
   - `API Token`, or
   - `Email` + `Password`
4. Keep `Realtime` enabled for websocket sync.
5. Click `Connect`.

## Local smoke test (plugin runtime harness)

This smoke script modifies a markdown file and verifies push/pull through the same plugin sync engine modules:

```bash
npm run -w @obsync/plugin smoke
```

Optional overrides:

```bash
OBSYNC_BASE_URL=http://localhost:8080 \
OBSYNC_EMAIL=user@example.com \
OBSYNC_PASSWORD=secret \
OBSYNC_VAULT_ID=<vault-id> \
npm run -w @obsync/plugin smoke
```

Expected result:

- JSON output with `ok: true`
- `pulledOps >= 1`
- `lastOp.opType` equal to `md_update`
