import { access, copyFile, mkdir, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join, resolve } from "node:path";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function assertDirectory(path: string, label: string): Promise<void> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new Error(`${label} not found: ${path}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`${label} is not a directory: ${path}`);
  }
}

async function main(): Promise<void> {
  const rawVaultPath = process.argv[2] ?? process.env.OBSIDIAN_VAULT_PATH;
  if (!rawVaultPath) {
    throw new Error(
      "Vault path required. Usage: npm run -w @obsync/plugin install:obsidian -- /absolute/path/to/vault"
    );
  }

  const pluginRoot = resolve(process.cwd());
  const vaultPath = resolve(rawVaultPath);

  await assertDirectory(vaultPath, "Vault directory");

  const buildDir = join(pluginRoot, "dist-obsidian");
  const mainSource = join(buildDir, "main.js");
  const manifestSource = join(buildDir, "manifest.json");

  if (!(await exists(mainSource)) || !(await exists(manifestSource))) {
    throw new Error("Build artifacts missing in dist-obsidian. Run build:obsidian first.");
  }

  const targetDir = join(vaultPath, ".obsidian", "plugins", "obsync");
  await mkdir(targetDir, { recursive: true });

  await copyFile(mainSource, join(targetDir, "main.js"));
  await copyFile(manifestSource, join(targetDir, "manifest.json"));

  console.log(`Installed Obsync plugin to: ${targetDir}`);
  console.log("In Obsidian: Settings -> Community Plugins -> Reload plugins, then enable Obsync.");
}

await main();
