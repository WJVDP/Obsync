# Obsidian Plugin Install and Configuration

This guide is the plugin-specific reference. For full stack onboarding, start at [README.md](../../README.md).

## Build and Install

From repo root:

```bash
npm install
npm run -w @obsync/plugin build:obsidian
npm run -w @obsync/plugin install:obsidian -- "/absolute/path/to/your/vault"
```

Installed plugin directory:

- `<vault>/.obsidian/plugins/obsync/`

Required files:

- `main.js`
- `manifest.json`

## Enable in Obsidian

1. Open Obsidian vault.
2. Go to Settings -> Community Plugins.
3. Click `Reload plugins`.
4. Enable `Obsync`.

## Plugin Settings

Required:

1. `Base URL`: `http://<server-host>:8080`
2. `Vault ID`: UUID returned by `POST /v1/vaults`

Authentication:

1. `API Token` (recommended for automation and long-lived setups), or
2. `Email` + `Password` for user login

Connection toggles:

1. `Realtime`: websocket stream
2. `Auto connect on load`: connects when Obsidian starts

## Connection Status Signals

Obsync surfaces status in:

1. Status bar text (`Live`, `Polling`, `Reconnecting`, `Error`)
2. Ribbon icon state
3. Top of plugin settings page (`Connection: ...`)

Expected steady states:

1. `Live`: websocket active
2. `Polling`: fallback pull mode

## Files Used by Plugin

1. Main settings file:
   - `<vault>/.obsidian/plugins/obsync/settings.json`
2. Fallback settings path:
   - `<vault>/.obsync/settings.json`
3. Sync state (outbox/cursors/key cache):
   - `<vault>/.obsidian/plugins/obsync/data.json`

## Quick Smoke Test

1. Connect plugin.
2. Create `obsync-local-test.md` on this machine.
3. Verify sync on other device.
4. Rename and delete it from the other device and confirm this vault converges.

## Common Failures

### Connect fails with 401/403

1. Verify token or credentials.
2. If using API key, verify scope includes `read` and `write`.

### `Vault not found`

1. Check `Vault ID` exactly matches server value.
2. Ensure token belongs to vault owner account.

### Realtime reconnect loop

1. Confirm `/v1/admin/health` is `ok`.
2. Inspect server logs for websocket auth/scope errors.
3. Confirm network path from client to `:8080` is reachable.

### Settings reset after reload

1. Confirm plugin can write to vault `.obsidian` directory.
2. Check presence of `settings.json` in one of the configured settings paths.
