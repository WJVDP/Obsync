import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  normalizePath
} from "obsidian";
import { v4 as uuidv4 } from "uuid";
import { VaultEventCapture, type VaultEvent } from "./event-capture/vaultEventCapture.js";
import { YjsMarkdownEngine } from "./crdt-engine/yjsEngine.js";
import { SyncTransport } from "./transport/syncTransport.js";
import { SyncStateStore, type SyncStatePersistence, type SyncStateSnapshot } from "./state-store/stateStore.js";
import { SyncEngine } from "./syncEngine.js";
import { TelemetryClient } from "./telemetry/telemetryClient.js";

interface ObsyncPluginSettings {
  baseUrl: string;
  email: string;
  password: string;
  apiToken: string;
  vaultId: string;
  deviceId: string;
  telemetryEnabled: boolean;
  autoConnectOnLoad: boolean;
  realtimeEnabled: boolean;
}

interface ObsyncPluginData {
  settings?: Partial<ObsyncPluginSettings>;
  syncState?: SyncStateSnapshot;
}

type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected_live"
  | "connected_polling"
  | "reconnecting"
  | "syncing"
  | "error";

const DEFAULT_SETTINGS: ObsyncPluginSettings = {
  baseUrl: "http://localhost:8080",
  email: "",
  password: "",
  apiToken: "",
  vaultId: "",
  deviceId: "",
  telemetryEnabled: false,
  autoConnectOnLoad: false,
  realtimeEnabled: true
};

const PERIODIC_PULL_INTERVAL_MS = 30_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

class ObsidianPluginDataPersistence implements SyncStatePersistence {
  constructor(private readonly plugin: ObsyncPlugin) {}

  async load(): Promise<SyncStateSnapshot | null> {
    const data = await this.plugin.readPluginData();
    return data.syncState ?? null;
  }

  async save(snapshot: SyncStateSnapshot): Promise<void> {
    const data = await this.plugin.readPluginData();
    data.syncState = snapshot;
    await this.plugin.writePluginData(data);
  }
}

export default class ObsyncPlugin extends Plugin {
  settings: ObsyncPluginSettings = DEFAULT_SETTINGS;

  private readonly eventCapture = new VaultEventCapture();
  private captureUnsubscribe: (() => void) | null = null;
  private syncEngine: SyncEngine | null = null;
  private readonly suppressedPaths = new Map<string, number>();

  private statusBarEl: HTMLElement | null = null;
  private currentStatus: ConnectionStatus = "disconnected";

  private periodicPullTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private shouldReconnectRealtime = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    if (!this.settings.deviceId) {
      this.settings.deviceId = uuidv4();
      await this.saveSettings();
    }

    this.statusBarEl = this.addStatusBarItem();
    this.setConnectionStatus("disconnected");

    this.captureUnsubscribe = this.eventCapture.onEvent((event) => {
      void this.onCapturedEvent(event);
    });

    this.registerVaultEventHandlers();
    this.addSettingTab(new ObsyncSettingTab(this.app, this));

    this.addCommand({
      id: "obsync-connect",
      name: "Obsync: Connect",
      callback: () => {
        void this.connectAndStart();
      }
    });

    this.addCommand({
      id: "obsync-sync-now",
      name: "Obsync: Sync Now",
      callback: () => {
        void this.syncNow();
      }
    });

    this.addCommand({
      id: "obsync-disconnect",
      name: "Obsync: Disconnect",
      callback: () => {
        this.disconnect();
      }
    });

    if (this.settings.autoConnectOnLoad) {
      void this.connectAndStart();
    }
  }

  onunload(): void {
    this.captureUnsubscribe?.();
    this.captureUnsubscribe = null;
    this.disconnect();
  }

  async connectAndStart(): Promise<void> {
    if (!this.settings.vaultId) {
      new Notice("Obsync: Set Vault ID in settings first");
      return;
    }

    this.disconnect();
    this.setConnectionStatus("connecting");

    try {
      const token = await this.resolveToken();
      const stateStore = new SyncStateStore(new ObsidianPluginDataPersistence(this));
      const transport = new SyncTransport({
        baseUrl: this.settings.baseUrl,
        token
      });
      const telemetry = new TelemetryClient(this.settings.telemetryEnabled);

      this.syncEngine = new SyncEngine(
        {
          vaultId: this.settings.vaultId,
          deviceId: this.settings.deviceId,
          onRemoteMarkdown: async (path, content) => {
            await this.applyRemoteMarkdown(path, content);
          },
          onRealtimeOpen: () => {
            this.reconnectAttempt = 0;
            this.clearReconnectTimer();
            this.setConnectionStatus("connected_live");
          },
          onRealtimeClose: () => {
            if (this.shouldReconnectRealtime) {
              this.scheduleRealtimeReconnect("socket closed");
            }
          },
          onRealtimeError: () => {
            if (this.shouldReconnectRealtime) {
              this.scheduleRealtimeReconnect("socket error");
            }
          }
        },
        transport,
        stateStore,
        new YjsMarkdownEngine(),
        telemetry
      );

      await this.syncEngine.initialize();
      await this.syncEngine.flushOutbox();
      await this.syncEngine.pullOnce();

      this.startPeriodicPullLoop();

      if (this.settings.realtimeEnabled) {
        this.shouldReconnectRealtime = true;
        this.startRealtime();
      } else {
        this.setConnectionStatus("connected_polling");
      }

      new Notice("Obsync connected");
    } catch (error) {
      this.setConnectionStatus("error", String(error));
      new Notice(`Obsync connect failed: ${String(error)}`);
    }
  }

  async syncNow(): Promise<void> {
    if (!this.syncEngine) {
      await this.connectAndStart();
    }

    if (!this.syncEngine) {
      return;
    }

    this.setConnectionStatus("syncing");
    try {
      await this.syncEngine.flushOutbox();
      await this.syncEngine.pullOnce();
      this.refreshSteadyStateStatus();
      new Notice("Obsync sync complete");
    } catch (error) {
      this.setConnectionStatus("error", String(error));
      new Notice(`Obsync sync failed: ${String(error)}`);
    }
  }

  disconnect(): void {
    this.shouldReconnectRealtime = false;
    this.clearReconnectTimer();
    this.clearPeriodicPullLoop();
    this.syncEngine?.stopRealtime();
    this.syncEngine = null;
    this.reconnectAttempt = 0;
    this.setConnectionStatus("disconnected");
  }

  async loadSettings(): Promise<void> {
    const fileSettings = await this.readSettingsFile();
    if (fileSettings) {
      this.settings = {
        ...DEFAULT_SETTINGS,
        ...fileSettings
      };
      return;
    }

    // Backward compatibility with previous settings storage in data.json.
    const loaded = await this.readPluginData();
    const rootSettings = loaded.settings ?? loaded;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(rootSettings as Partial<ObsyncPluginSettings>)
    };

    // Migrate to dedicated settings file once loaded.
    await this.saveSettings();
  }

  async saveSettings(): Promise<void> {
    await this.writeSettingsFile(this.settings);
  }

  private async onCapturedEvent(event: VaultEvent): Promise<void> {
    if (!this.syncEngine) {
      return;
    }

    if (this.shouldSuppressLocalEvent(event.path)) {
      return;
    }

    try {
      await this.syncEngine.handleVaultEvent(event);
    } catch (error) {
      this.setConnectionStatus("error", String(error));
      new Notice(`Obsync event sync failed: ${String(error)}`);
    }
  }

  private registerVaultEventHandlers(): void {
    this.registerEvent(
      this.app.vault.on("create", async (file: TAbstractFile) => {
        if (!(file instanceof TFile)) {
          return;
        }

        const content = await this.readMarkdown(file);
        this.eventCapture.emit({
          type: "create",
          path: file.path,
          timestamp: new Date().toISOString(),
          content
        });
      })
    );

    this.registerEvent(
      this.app.vault.on("modify", async (file: TAbstractFile) => {
        if (!(file instanceof TFile)) {
          return;
        }

        const content = await this.readMarkdown(file);
        this.eventCapture.emit({
          type: "modify",
          path: file.path,
          timestamp: new Date().toISOString(),
          content
        });
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) => {
        this.eventCapture.emit({
          type: "delete",
          path: file.path,
          timestamp: new Date().toISOString()
        });
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", async (file: TAbstractFile, oldPath: string) => {
        const content = file instanceof TFile ? await this.readMarkdown(file) : undefined;
        this.eventCapture.emit({
          type: "rename",
          path: file.path,
          oldPath,
          timestamp: new Date().toISOString(),
          content
        });
      })
    );
  }

  private async resolveToken(): Promise<string> {
    if (this.settings.apiToken.trim()) {
      return this.settings.apiToken.trim();
    }

    if (!this.settings.email || !this.settings.password) {
      throw new Error("Either API token or email/password must be configured");
    }

    const response = await fetch(`${this.settings.baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: this.settings.email,
        password: this.settings.password
      })
    });

    if (!response.ok) {
      throw new Error(`Login failed (${response.status})`);
    }

    const data = (await response.json()) as { token?: string };
    if (!data.token) {
      throw new Error("Login response missing token");
    }

    return data.token;
  }

  private async readMarkdown(file: TFile): Promise<string | undefined> {
    if (file.extension !== "md") {
      return undefined;
    }

    try {
      return await this.app.vault.cachedRead(file);
    } catch {
      return undefined;
    }
  }

  private shouldSuppressLocalEvent(path: string): boolean {
    const expiresAt = this.suppressedPaths.get(path);
    if (!expiresAt) {
      return false;
    }

    if (Date.now() > expiresAt) {
      this.suppressedPaths.delete(path);
      return false;
    }

    return true;
  }

  private markPathSuppressed(path: string): void {
    this.suppressedPaths.set(path, Date.now() + 4000);
  }

  private async applyRemoteMarkdown(path: string, content: string): Promise<void> {
    this.markPathSuppressed(path);
    await this.ensureFolderForPath(path);

    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
      return;
    }

    await this.app.vault.create(path, content);
  }

  private async ensureFolderForPath(path: string): Promise<void> {
    const segments = path.split("/").slice(0, -1).filter(Boolean);
    if (segments.length === 0) {
      return;
    }

    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private startRealtime(): void {
    if (!this.syncEngine) {
      return;
    }

    const label = this.reconnectAttempt > 0 ? "reconnecting" : "connecting";
    this.setConnectionStatus(label, this.reconnectAttempt > 0 ? `attempt ${this.reconnectAttempt}` : undefined);
    this.syncEngine.startRealtime();
  }

  private scheduleRealtimeReconnect(reason: string): void {
    if (!this.syncEngine || !this.shouldReconnectRealtime) {
      return;
    }

    if (this.reconnectTimer) {
      return;
    }

    const exponential = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** this.reconnectAttempt);
    const jitter = Math.floor(Math.random() * 300);
    const delayMs = exponential + jitter;

    this.reconnectAttempt += 1;
    this.setConnectionStatus("reconnecting", `${Math.ceil(delayMs / 1000)}s (${reason})`);

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.syncEngine || !this.shouldReconnectRealtime) {
        return;
      }
      this.startRealtime();
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startPeriodicPullLoop(): void {
    this.clearPeriodicPullLoop();
    this.periodicPullTimer = window.setInterval(() => {
      void this.periodicPullTick();
    }, PERIODIC_PULL_INTERVAL_MS);
  }

  private clearPeriodicPullLoop(): void {
    if (this.periodicPullTimer) {
      window.clearInterval(this.periodicPullTimer);
      this.periodicPullTimer = null;
    }
  }

  private async periodicPullTick(): Promise<void> {
    if (!this.syncEngine) {
      return;
    }

    try {
      await this.syncEngine.flushOutbox();
      await this.syncEngine.pullOnce();

      if (!this.syncEngine.isRealtimeConnected()) {
        this.setConnectionStatus("connected_polling", "fallback pull");
      }
    } catch (error) {
      this.setConnectionStatus("error", `poll failed: ${String(error)}`);
    }
  }

  private refreshSteadyStateStatus(): void {
    if (!this.syncEngine) {
      this.setConnectionStatus("disconnected");
      return;
    }

    if (this.settings.realtimeEnabled && this.syncEngine.isRealtimeConnected()) {
      this.setConnectionStatus("connected_live");
      return;
    }

    this.setConnectionStatus("connected_polling");
  }

  private setConnectionStatus(status: ConnectionStatus, detail?: string): void {
    this.currentStatus = status;

    if (!this.statusBarEl) {
      return;
    }

    const label =
      status === "disconnected"
        ? "Disconnected"
        : status === "connecting"
          ? "Connecting"
          : status === "connected_live"
            ? "Live"
            : status === "connected_polling"
              ? "Polling"
              : status === "reconnecting"
                ? "Reconnecting"
                : status === "syncing"
                  ? "Syncing"
                  : "Error";

    this.statusBarEl.setText(`Obsync: ${label}${detail ? ` (${detail})` : ""}`);
  }

  private getSettingsPath(): string {
    return normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}/settings.json`);
  }

  private getSettingsDirPath(): string {
    return normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
  }

  private async readSettingsFile(): Promise<Partial<ObsyncPluginSettings> | null> {
    const path = this.getSettingsPath();
    try {
      const exists = await this.app.vault.adapter.exists(path);
      if (!exists) {
        return null;
      }

      const raw = await this.app.vault.adapter.read(path);
      return JSON.parse(raw) as Partial<ObsyncPluginSettings>;
    } catch {
      return null;
    }
  }

  private async writeSettingsFile(settings: ObsyncPluginSettings): Promise<void> {
    const dir = this.getSettingsDirPath();
    const path = this.getSettingsPath();
    const dirExists = await this.app.vault.adapter.exists(dir);
    if (!dirExists) {
      await this.app.vault.adapter.mkdir(dir);
    }
    await this.app.vault.adapter.write(path, JSON.stringify(settings, null, 2));
  }

  async readPluginData(): Promise<ObsyncPluginData> {
    return ((await this.loadData()) ?? {}) as ObsyncPluginData;
  }

  async writePluginData(data: ObsyncPluginData): Promise<void> {
    await this.saveData(data);
  }
}

class ObsyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ObsyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Obsync" });

    new Setting(containerEl)
      .setName("Base URL")
      .setDesc("Obsync API base URL")
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:8080")
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.baseUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Vault ID")
      .setDesc("Server vault id")
      .addText((text) =>
        text.setValue(this.plugin.settings.vaultId).onChange(async (value) => {
          this.plugin.settings.vaultId = value.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Device ID")
      .setDesc("Stable device identifier")
      .addText((text) =>
        text.setValue(this.plugin.settings.deviceId).onChange(async (value) => {
          this.plugin.settings.deviceId = value.trim() || uuidv4();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("API Token")
      .setDesc("Preferred auth for automation")
      .addText((text) =>
        text.setValue(this.plugin.settings.apiToken).onChange(async (value) => {
          this.plugin.settings.apiToken = value.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Email")
      .setDesc("Used when API token is empty")
      .addText((text) =>
        text.setValue(this.plugin.settings.email).onChange(async (value) => {
          this.plugin.settings.email = value.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Password")
      .setDesc("Used when API token is empty")
      .addText((text) => {
        text.inputEl.type = "password";
        return text.setValue(this.plugin.settings.password).onChange(async (value) => {
          this.plugin.settings.password = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Realtime")
      .setDesc("Open websocket stream after connect")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.realtimeEnabled).onChange(async (value) => {
          this.plugin.settings.realtimeEnabled = value;
          await this.plugin.saveSettings();
          if (value) {
            await this.plugin.connectAndStart();
          }
        })
      );

    new Setting(containerEl)
      .setName("Auto connect on load")
      .setDesc("Connect when Obsidian starts")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoConnectOnLoad).onChange(async (value) => {
          this.plugin.settings.autoConnectOnLoad = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Connect now")
      .setDesc("Validate config and start sync")
      .addButton((button) =>
        button.setButtonText("Connect").onClick(async () => {
          await this.plugin.connectAndStart();
        })
      )
      .addButton((button) =>
        button.setButtonText("Sync now").onClick(async () => {
          await this.plugin.syncNow();
        })
      );
  }
}
