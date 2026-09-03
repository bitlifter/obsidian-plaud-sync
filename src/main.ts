import { App, Modal, Plugin, TFile, Notice } from "obsidian";
import { PlaudPluginSettings, DEFAULT_SETTINGS } from "./types";
import { PlaudSyncEngine } from "./sync-engine";
import { PlaudSettingTab } from "./settings";

class SyncLogModal extends Modal {
  private logContent: string;

  constructor(app: App, logContent: string) {
    super(app);
    this.logContent = logContent;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "🎙️ Plaud Sync Log" });

    const pre = contentEl.createEl("pre", {
      text: this.logContent || "No logs recorded yet.",
      cls: "plaud-sync-log-viewer"
    });
    pre.style.maxHeight = "450px";
    pre.style.overflowY = "auto";
    pre.style.fontSize = "12px";
    pre.style.lineHeight = "1.5";
    pre.style.backgroundColor = "var(--background-secondary)";
    pre.style.padding = "12px";
    pre.style.borderRadius = "6px";
    pre.style.whiteSpace = "pre-wrap";
    pre.style.fontFamily = "var(--font-monospace)";

    setTimeout(() => {
      pre.scrollTop = pre.scrollHeight;
    }, 50);
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

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

    const onProgress = (cur: number, tot: number, title: string) => {
      const shortTitle = title.length > 22 ? title.slice(0, 22) + "..." : title;
      this.updateStatusBar(`[${cur}/${tot}] ${shortTitle}`);
    };

    // 1. Ribbon Icon (Left sidebar)
    this.addRibbonIcon("mic", "Plaud to Obsidian: Sync Recordings", async () => {
      this.updateStatusBar("Syncing...");
      try {
        await this.syncEngine.syncRecordings({ onProgress });
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
          await this.syncEngine.syncRecordings({ onProgress });
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
          await this.syncEngine.syncRecordings({ force: true, onProgress });
        } finally {
          this.updateStatusBar();
        }
      }
    });

    this.addCommand({
      id: "plaud-view-log",
      name: "View sync log",
      callback: async () => {
        const logs = await this.syncEngine.getRecentLogs();
        new SyncLogModal(this.app, logs).open();
      }
    });

    this.addCommand({
      id: "plaud-process-inbox",
      name: "Process local audio inbox (Whisper / Snapdragon NPU)",
      callback: async () => {
        await this.syncEngine.processLocalAudioInbox();
      }
    });

    this.addCommand({
      id: "plaud-process-inbox-npu",
      name: "Process local audio inbox with Snapdragon NPU (QNN)",
      callback: async () => {
        const prev = this.settings.transcriptionEngine;
        this.settings.transcriptionEngine = "qnn_npu";
        try {
          await this.syncEngine.processLocalAudioInbox();
        } finally {
          this.settings.transcriptionEngine = prev;
        }
      }
    });

    // File Context Menu: Transcribe any audio file
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFile && ["mp3", "wav", "m4a", "webm", "aac", "ogg"].includes(file.extension.toLowerCase())) {
          const isNpu = this.settings.transcriptionEngine === "qnn_npu";
          menu.addItem(item => {
            item
              .setTitle(isNpu ? "Transcribe with Snapdragon NPU (QNN)" : "Transcribe with Local Whisper")
              .setIcon(isNpu ? "zap" : "mic")
              .onClick(async () => {
                try {
                  await this.syncEngine.transcribeLocalAudioFile(file);
                } catch (e: any) {
                  new Notice(`Transcription failed: ${e.message}`, 6000);
                }
              });
          });
        }
      })
    );

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
