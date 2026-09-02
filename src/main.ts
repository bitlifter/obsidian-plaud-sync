import { Plugin } from "obsidian";
import { PlaudPluginSettings, DEFAULT_SETTINGS } from "./types";
import { PlaudSyncEngine } from "./sync-engine";
import { PlaudSettingTab } from "./settings";

export default class PlaudPlugin extends Plugin {
  public settings: PlaudPluginSettings = DEFAULT_SETTINGS;
  public syncEngine: PlaudSyncEngine = null as any;
  private statusBarItem: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.syncEngine = new PlaudSyncEngine(
      this.app,
      this.settings,
      () => this.saveSettings()
    );

    // 1. Ribbon Icon (Left sidebar)
    this.addRibbonIcon("mic", "Plaud Sync: Sync Recordings", async () => {
      this.updateStatusBar("Syncing...");
      try {
        await this.syncEngine.syncRecordings();
      } finally {
        this.updateStatusBar();
      }
    });

    // 2. Command Palette Actions
    this.addCommand({
      id: "plaud-sync-new",
      name: "Sync new recordings from Plaud",
      callback: async () => {
        this.updateStatusBar("Syncing...");
        try {
          await this.syncEngine.syncRecordings();
        } finally {
          this.updateStatusBar();
        }
      }
    });

    this.addCommand({
      id: "plaud-sync-force",
      name: "Force re-sync all recordings from Plaud",
      callback: async () => {
        this.updateStatusBar("Syncing...");
        try {
          await this.syncEngine.syncRecordings({ force: true });
        } finally {
          this.updateStatusBar();
        }
      }
    });

    // 3. Settings Tab
    this.addSettingTab(new PlaudSettingTab(this.app, this));

    // 4. Status Bar
    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar();

    // 5. Auto-sync on startup if enabled
    if (this.settings.autoSyncOnStartup) {
      this.app.workspace.onLayoutReady(() => {
        setTimeout(async () => {
          try {
            await this.syncEngine.syncRecordings();
          } catch (err) {
            console.warn("Auto-sync on startup failed:", err);
          }
        }, 5000);
      });
    }
  }

  onunload(): void {
    if (this.statusBarItem) {
      this.statusBarItem.remove();
    }
  }

  public updateStatusBar(customText?: string): void {
    if (!this.statusBarItem) return;
    if (customText) {
      this.statusBarItem.setText(`🎙️ Plaud: ${customText}`);
    } else {
      const last = this.settings.lastSync ? new Date(this.settings.lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "Never";
      this.statusBarItem.setText(`🎙️ Plaud (Last: ${last})`);
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.updateStatusBar();
  }
}
