import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import PlaudPlugin from "./main";

export class PlaudSettingTab extends PluginSettingTab {
  private plugin: PlaudPlugin;

  constructor(app: App, plugin: PlaudPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async display(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Plaud to Obsidian Settings" });

    // 1. Account & Connection Status
    containerEl.createEl("h3", { text: "Authentication" });

    const hasTokens = await this.plugin.syncEngine.getApiClient().hasLocalTokens();

    const authSetting = new Setting(containerEl)
      .setName("Plaud Account Status")
      .setDesc(
        hasTokens
          ? "Connected via ~/.plaud/tokens-mcp.json"
          : "Not connected. Link your Plaud account using OAuth."
      );

    const badge = authSetting.controlEl.createEl("span", {
      text: hasTokens ? "Connected" : "Disconnected",
      cls: `plaud-auth-status ${hasTokens ? "plaud-auth-connected" : "plaud-auth-disconnected"}`
    });

    authSetting.addButton(btn => {
      btn.setButtonText(hasTokens ? "Re-authenticate" : "Connect Account");
      if (!hasTokens) {
        btn.setCta();
      }
      btn.onClick(async () => {
          new Notice(
            "To connect your Plaud account, run 'npx -y @plaud-ai/mcp install' in your terminal or use 'plaud-export login'.",
            8000
          );
        });
    });

    // 2. Folder Configuration
    containerEl.createEl("h3", { text: "Vault Storage Paths" });

    new Setting(containerEl)
      .setName("Notes Folder")
      .setDesc("Folder where meeting markdown notes will be saved.")
      .addText(text =>
        text
          .setPlaceholder("Notes")
          .setValue(this.plugin.settings.targetNotesFolder)
          .onChange(async val => {
            this.plugin.settings.targetNotesFolder = val.trim() || "Notes";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Audio Attachments Folder")
      .setDesc("Folder where .mp3 recording files will be stored.")
      .addText(text =>
        text
          .setPlaceholder("Attachments")
          .setValue(this.plugin.settings.targetAttachmentsFolder)
          .onChange(async val => {
            this.plugin.settings.targetAttachmentsFolder = val.trim() || "Attachments";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Download Master Audio (.mp3)")
      .setDesc("Save original audio recordings and embed an inline player in each note.")
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.downloadAudio)
          .onChange(async val => {
            this.plugin.settings.downloadAudio = val;
            await this.plugin.saveSettings();
          })
      );

    // 3. AI Speaker & Entity Resolution
    containerEl.createEl("h3", { text: "AI Speaker & Entity Enrichment" });

    new Setting(containerEl)
      .setName("Gemini API Key")
      .setDesc("Optional: Google AI Studio key for Gemini speaker disambiguation and entity extraction.")
      .addText(text => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("AIzaSy...")
          .setValue(this.plugin.settings.geminiApiKey)
          .onChange(async val => {
            this.plugin.settings.geminiApiKey = val.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Gemini Model")
      .setDesc("Model used for speaker diarization, attendee detection, and transcription fallback.")
      .addDropdown(drop => {
        drop
          .addOption("gemini-3.6-flash", "Gemini 3.6 Flash (Recommended - fast, high precision, ~$0.0002/note)")
          .addOption("gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite (Ultra low cost, ~$0.00007/note)")
          .addOption("gemini-2.5-flash", "Gemini 2.5 Flash (Legacy stable)")
          .addOption("gemini-3.5-transcribe", "Gemini 3.5 Transcribe (Audio transcription specialized)")
          .setValue(this.plugin.settings.geminiModel || "gemini-3.6-flash")
          .onChange(async val => {
            this.plugin.settings.geminiModel = val;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Confidence Threshold")
      .setDesc("If offline heuristic confidence falls below this value (0.1 to 1.0), Gemini will be invoked.")
      .addSlider(slider =>
        slider
          .setLimits(0.1, 1.0, 0.05)
          .setValue(this.plugin.settings.minConfidence)
          .setDynamicTooltip()
          .onChange(async val => {
            this.plugin.settings.minConfidence = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Force Cloud Enrichment")
      .setDesc("Always invoke Gemini 3.6 Flash for all meetings with transcript data.")
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.forceCloud)
          .onChange(async val => {
            this.plugin.settings.forceCloud = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Custom Organizations")
      .setDesc("Comma-separated list of companies and clients to prioritize in entity detection.")
      .addText(text =>
        text
          .setPlaceholder("Acme Corp, Initech, Globex")
          .setValue(this.plugin.settings.customOrgs)
          .onChange(async val => {
            this.plugin.settings.customOrgs = val.trim();
            await this.plugin.saveSettings();
          })
      );

    // 4. Automation & Actions
    containerEl.createEl("h3", { text: "Automation & Manual Sync" });

    new Setting(containerEl)
      .setName("Auto-sync on Startup")
      .setDesc("Automatically check for and download new recordings when Obsidian starts up.")
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.autoSyncOnStartup)
          .onChange(async val => {
            this.plugin.settings.autoSyncOnStartup = val;
            await this.plugin.saveSettings();
          })
      );

    const lastSyncStr = this.plugin.settings.lastSync
      ? new Date(this.plugin.settings.lastSync).toLocaleString()
      : "Never";

    const onProgress = (cur: number, tot: number, title: string) => {
      const shortTitle = title.length > 22 ? title.slice(0, 22) + "..." : title;
      this.plugin.updateStatusBar(`[${cur}/${tot}] ${shortTitle}`);
    };

    new Setting(containerEl)
      .setName("Sync Operations")
      .setDesc(`Last successful sync: ${lastSyncStr}`)
      .addButton(btn =>
        btn
          .setButtonText("Sync New Recordings")
          .setCta()
          .onClick(async () => {
            btn.setDisabled(true);
            try {
              await this.plugin.syncEngine.syncRecordings({ onProgress });
            } finally {
              btn.setDisabled(false);
              await this.display();
            }
          })
      )
      .addButton(btn =>
        btn
          .setButtonText("Force Full Re-sync")
          .setWarning()
          .onClick(async () => {
            btn.setDisabled(true);
            try {
              await this.plugin.syncEngine.syncRecordings({ force: true, onProgress });
            } finally {
              btn.setDisabled(false);
              await this.display();
            }
          })
      )
      .addButton(btn =>
        btn
          .setButtonText("View Sync Log")
          .onClick(() => {
            (this.app as any).commands?.executeCommandById("plaud-to-obsidian:plaud-view-log");
          })
      );
  }
}
