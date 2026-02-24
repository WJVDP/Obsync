import { App, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile } from "obsidian";
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

  async onload(): Promise<void> {
    await this.loadSettings();

    if (!this.settings.deviceId) {
      this.settings.deviceId = uuidv4();
      await this.saveSettings();
    }

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

    if (this.settings.autoConnectOnLoad) {
      void this.connectAndStart();
    }
  }

  onunload(): void {
    this.captureUnsubscribe?.();
    this.captureUnsubscribe = null;
    this.syncEngine?.stopRealtime();
  }

  async connectAndStart(): Promise<void> {
    if (!this.settings.vaultId) {
      new Notice("Obsync: Set Vault ID in settings first");
      return;
    }

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
          deviceId: this.settings.deviceId
        },
        transport,
        stateStore,
        new YjsMarkdownEngine(),
        telemetry
      );

      await this.syncEngine.initialize();
      await this.syncEngine.pullOnce();

      if (this.settings.realtimeEnabled) {
        this.syncEngine.startRealtime();
      }

      new Notice("Obsync connected");
    } catch (error) {
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

    try {
      await this.syncEngine.flushOutbox();
      await this.syncEngine.pullOnce();
      new Notice("Obsync sync complete");
    } catch (error) {
      new Notice(`Obsync sync failed: ${String(error)}`);
    }
  }

  async loadSettings(): Promise<void> {
    const loaded = await this.readPluginData();
    const rootSettings = loaded.settings ?? loaded;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(rootSettings as Partial<ObsyncPluginSettings>)
    };
  }

  async saveSettings(): Promise<void> {
    const data = await this.readPluginData();
    data.settings = this.settings;
    await this.writePluginData(data);
  }

  private async onCapturedEvent(event: VaultEvent): Promise<void> {
    if (!this.syncEngine) {
      return;
    }

    try {
      await this.syncEngine.handleVaultEvent(event);
    } catch (error) {
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
