import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import PlaudPlugin from "./main";
import { testGeminiConnection, testOpenAIConnection } from "./enricher";
import {
  checkWhisperBinary,
  checkWhisperModel,
  downloadAndInstallWhisperEngine,
  downloadWhisperModel,
  WHISPER_MODELS
} from "./whisper-engine";
import {
  detectSnapdragonHardware,
  checkQnnBinary,
  checkQnnModel,
  downloadAndInstallQnnRunner,
  downloadQnnModel,
  QNN_MODELS
} from "./qnn-engine";

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

    // 3. Offline Speech-to-Text (Whisper & Snapdragon NPU)
    containerEl.createEl("h3", { text: "Offline Speech-to-Text (Whisper & Snapdragon NPU)" });

    const hw = detectSnapdragonHardware();
    const hwEl = containerEl.createDiv({ cls: "setting-item-description" });
    hwEl.style.padding = "10px 14px";
    hwEl.style.marginBottom = "14px";
    hwEl.style.borderRadius = "6px";
    if (hw.isSnapdragon) {
      hwEl.style.backgroundColor = "rgba(46, 204, 113, 0.15)";
      hwEl.style.border = "1px solid rgba(46, 204, 113, 0.4)";
      hwEl.innerHTML = `<strong>⚡ Hardware Detected:</strong> ${hw.processorName} (${hw.npuTops} TOPS Hexagon NPU)<br><span style="color: var(--text-muted); font-size: 0.85em;">${hw.recommendation}</span>`;
    } else {
      hwEl.style.backgroundColor = "rgba(52, 152, 219, 0.1)";
      hwEl.style.border = "1px solid rgba(52, 152, 219, 0.3)";
      hwEl.innerHTML = `<strong>💻 Architecture Detected:</strong> ${hw.processorName} (${process.arch})<br><span style="color: var(--text-muted); font-size: 0.85em;">${hw.recommendation}</span>`;
    }

    new Setting(containerEl)
      .setName("Transcription Engine")
      .setDesc("Choose whether to use Plaud Cloud, local whisper.cpp (CPU), or Snapdragon NPU (Qualcomm QNN).")
      .addDropdown(drop => {
        drop
          .addOption("plaud_cloud", "Plaud Cloud (Default)")
          .addOption("whisper_cpp", "Local Whisper.cpp (CPU / Standard)")
          .addOption("qnn_npu", "Snapdragon NPU (Qualcomm QNN - Hardware Accelerated)")
          .setValue(this.plugin.settings.transcriptionEngine || "plaud_cloud")
          .onChange(async val => {
            this.plugin.settings.transcriptionEngine = val as any;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    new Setting(containerEl)
      .setName("Local Audio Inbox Folder")
      .setDesc("Vault folder where local recordings (.mp3, .wav, .m4a) are placed for offline processing.")
      .addText(text =>
        text
          .setPlaceholder("Attachments/Inbox")
          .setValue(this.plugin.settings.localAudioFolder || "Attachments/Inbox")
          .onChange(async val => {
            this.plugin.settings.localAudioFolder = val.trim() || "Attachments/Inbox";
            await this.plugin.saveSettings();
          })
      );

    const pluginDir = this.plugin.syncEngine.getPluginDir();

    // Render Snapdragon NPU (QNN) Configuration
    if (this.plugin.settings.transcriptionEngine === "qnn_npu") {
      new Setting(containerEl)
        .setName("Snapdragon NPU Model")
        .setDesc("Select the ONNX Whisper model optimized for Snapdragon Hexagon NPU inference.")
        .addDropdown(drop => {
          for (const [key, info] of Object.entries(QNN_MODELS)) {
            drop.addOption(key, info.name);
          }
          drop
            .setValue(this.plugin.settings.qnnModel || "base.en")
            .onChange(async val => {
              this.plugin.settings.qnnModel = val as any;
              await this.plugin.saveSettings();
              this.display();
            });
        });

      new Setting(containerEl)
        .setName("NPU Power Mode")
        .setDesc("Configure Qualcomm Hexagon NPU power profile (Burst is fastest; High Performance recommended).")
        .addDropdown(drop => {
          drop
            .addOption("burst", "Burst (Fastest Batch)")
            .addOption("high_performance", "High Performance (Recommended)")
            .addOption("balanced", "Balanced (Low Power)")
            .addOption("low_power", "Power Saver")
            .setValue(this.plugin.settings.qnnPowerMode || "high_performance")
            .onChange(async val => {
              this.plugin.settings.qnnPowerMode = val as any;
              await this.plugin.saveSettings();
            });
        });

      const qnnBinInfo = checkQnnBinary(pluginDir, this.plugin.settings.customQnnBinaryPath);
      const qnnModelInfo = checkQnnModel(
        this.plugin.settings.qnnModel || "base.en",
        pluginDir,
        this.plugin.settings.customQnnModelPath
      );

      const qnnStatusDesc = [
        `QNN Runner: ${qnnBinInfo.exists ? `✓ Installed (${qnnBinInfo.path})` : "✗ Not installed"}`,
        `QNN Model: ${qnnModelInfo.exists ? `✓ Ready (${qnnModelInfo.dir})` : "✗ Not downloaded"}`
      ].join(" | ");

      const qnnEngineSetting = new Setting(containerEl)
        .setName("QNN Engine & Model Status")
        .setDesc(qnnStatusDesc);

      qnnEngineSetting.addButton(btn => {
        btn
          .setButtonText(qnnBinInfo.exists ? "Reinstall QNN Runner" : "Download QNN Runner")
          .onClick(async () => {
            btn.setButtonText("Downloading...").setDisabled(true);
            try {
              let lastNoticeTime = 0;
              await downloadAndInstallQnnRunner(pluginDir, (msg, pct) => {
                if (pct !== undefined && pct > 0) {
                  btn.setButtonText(`Downloading (${pct}%)...`);
                }
                const now = Date.now();
                if (now - lastNoticeTime > 3000 || pct === 100 || !pct) {
                  lastNoticeTime = now;
                  new Notice(msg, 2500);
                }
              });
              new Notice("✓ QNN speech runner installed successfully!");
            } catch (e: any) {
              console.error("QNN runner install error:", e);
              new Notice(`✗ Failed to install QNN runner: ${e.message}`, 8000);
            } finally {
              await this.display();
            }
          });
      });

      qnnEngineSetting.addButton(btn => {
        btn
          .setButtonText(qnnModelInfo.exists ? "Re-download QNN Model" : "Download QNN Model")
          .onClick(async () => {
            btn.setButtonText("Downloading...").setDisabled(true);
            try {
              const mKey = this.plugin.settings.qnnModel || "base.en";
              const size = QNN_MODELS[mKey]?.sizeMb || 199;
              new Notice(`Downloading QNN model ${mKey} (~${size} MB)...`, 5000);
              let lastNoticePct = -1;
              await downloadQnnModel(mKey, pluginDir, (pct) => {
                btn.setButtonText(`Downloading (${pct}%)...`);
                if (pct >= lastNoticePct + 15 || pct === 100) {
                  lastNoticePct = pct;
                  new Notice(`Downloading QNN ${mKey}: ${pct}%`, 2000);
                }
              });
              new Notice(`✓ QNN model ${mKey} downloaded and extracted!`);
            } catch (e: any) {
              console.error("QNN model download error:", e);
              new Notice(`✗ Failed to download QNN model: ${e.message}`, 8000);
            } finally {
              await this.display();
            }
          });
      });

      new Setting(containerEl)
        .setName("Custom QNN HTP Backend Path (Optional)")
        .setDesc("Absolute path to QnnHtp.dll if utilizing a custom Qualcomm AI Engine Direct SDK installation.")
        .addText(text =>
          text
            .setPlaceholder("C:\\path\\to\\QnnHtp.dll")
            .setValue(this.plugin.settings.customQnnBackendPath || "")
            .onChange(async val => {
              this.plugin.settings.customQnnBackendPath = val.trim();
              await this.plugin.saveSettings();
            })
        );
    } else if (this.plugin.settings.transcriptionEngine === "whisper_cpp") {
      // Render Whisper.cpp Configuration
      const binInfo = checkWhisperBinary(pluginDir, this.plugin.settings.customWhisperBinaryPath);
      const modelInfo = checkWhisperModel(
        this.plugin.settings.whisperModel || "base.en",
        pluginDir,
        this.plugin.settings.customWhisperModelPath
      );

      new Setting(containerEl)
        .setName("Whisper Model")
        .setDesc("Select the model size. Base is balanced; Small and Large offer higher accuracy.")
        .addDropdown(drop => {
          for (const [key, info] of Object.entries(WHISPER_MODELS)) {
            drop.addOption(key, info.name);
          }
          drop
            .setValue(this.plugin.settings.whisperModel || "base.en")
            .onChange(async val => {
              this.plugin.settings.whisperModel = val as any;
              await this.plugin.saveSettings();
              this.display();
            });
        });

      const statusDesc = [
        `Engine Binary: ${binInfo.exists ? `✓ Installed (${binInfo.path})` : "✗ Not installed"}`,
        `Selected Model: ${modelInfo.exists ? `✓ Installed (${modelInfo.path})` : "✗ Not downloaded"}`
      ].join(" | ");

      const engineSetting = new Setting(containerEl)
        .setName("Engine & Model Status")
        .setDesc(statusDesc);

      engineSetting.addButton(btn => {
        btn
          .setButtonText(binInfo.exists ? "Reinstall Engine" : "Download Whisper Engine")
          .onClick(async () => {
            btn.setButtonText("Downloading...").setDisabled(true);
            try {
              await downloadAndInstallWhisperEngine(pluginDir, (msg) => {
                new Notice(msg, 3000);
              });
              new Notice("✓ Whisper engine installed successfully!");
            } catch (e: any) {
              new Notice(`✗ Failed to install Whisper engine: ${e.message}`, 8000);
            } finally {
              await this.display();
            }
          });
      });

      engineSetting.addButton(btn => {
        btn
          .setButtonText(modelInfo.exists ? "Re-download Model" : "Download Model")
          .onClick(async () => {
            btn.setButtonText("Downloading...").setDisabled(true);
            try {
              const mKey = this.plugin.settings.whisperModel || "base.en";
              new Notice(`Downloading ${mKey} model (~${WHISPER_MODELS[mKey]?.sizeMb || 140} MB)...`, 5000);
              await downloadWhisperModel(mKey, pluginDir, (pct) => {
                if (pct % 20 === 0 || pct === 100) {
                  new Notice(`Downloading ${mKey}: ${pct}%`, 2000);
                }
              });
              new Notice(`✓ Model ${mKey} downloaded successfully!`);
            } catch (e: any) {
              new Notice(`✗ Failed to download model: ${e.message}`, 8000);
            } finally {
              await this.display();
            }
          });
      });
    }

    new Setting(containerEl)
      .setName("Process Local Audio Inbox")
      .setDesc("Transcribe all audio files currently waiting in your local audio inbox folder.")
      .addButton(btn => {
        btn
          .setButtonText("Process Inbox Now")
          .setCta()
          .onClick(async () => {
            btn.setDisabled(true);
            try {
              await this.plugin.syncEngine.processLocalAudioInbox();
            } finally {
              btn.setDisabled(false);
            }
          });
      });

    // Plaud Desktop Offline Cache Integration
    containerEl.createEl("h4", { text: "Plaud Desktop Offline Cache Integration" });

    const defaultCachePath = this.plugin.syncEngine.getDefaultPlaudCachePath();
    const currentCachePath = this.plugin.settings.plaudDesktopCachePath || defaultCachePath;

    new Setting(containerEl)
      .setName("Plaud Desktop Cache Directory")
      .setDesc("Directory where Plaud Desktop stores offline .ogg recordings. Defaults to %APPDATA%\\ogg-cache (or enter a network share if recorded on another PC).")
      .addText(text => {
        text
          .setPlaceholder(defaultCachePath || "C:\\Users\\<Username>\\AppData\\Roaming\\ogg-cache")
          .setValue(this.plugin.settings.plaudDesktopCachePath || "")
          .onChange(async val => {
            this.plugin.settings.plaudDesktopCachePath = val.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Auto-Import from Cache on Startup / Sync")
      .setDesc("Automatically scan the Plaud Desktop cache directory for new recordings whenever Obsidian starts or Plaud Sync runs.")
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.autoImportPlaudCache || false)
          .onChange(async val => {
            this.plugin.settings.autoImportPlaudCache = val;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Import from Plaud Desktop Cache Now")
      .setDesc(`Scan ${currentCachePath || "cache directory"} and transcribe any new .ogg recordings with the active engine.`)
      .addButton(btn => {
        btn
          .setButtonText("Import Cache Recordings")
          .setCta()
          .onClick(async () => {
            btn.setButtonText("Scanning...").setDisabled(true);
            try {
              const res = await this.plugin.syncEngine.importFromPlaudDesktopCache({
                onProgress: (cur, tot, file) => {
                  btn.setButtonText(`Importing (${cur}/${tot})...`);
                }
              });
              btn.setButtonText(`Done (${res.imported} imported)`);
              setTimeout(() => {
                btn.setButtonText("Import Cache Recordings").setDisabled(false);
              }, 4000);
            } catch (err: any) {
              btn.setButtonText("Import Failed").setDisabled(false);
            }
          });
      });

    // 4. AI Speaker & Entity Resolution
    containerEl.createEl("h3", { text: "AI Speaker & Entity Enrichment" });

    new Setting(containerEl)
      .setName("AI Provider")
      .setDesc("Choose your AI provider for speaker disambiguation, entity extraction, and transcription fallback.")
      .addDropdown(drop => {
        drop
          .addOption("gemini", "Google Gemini")
          .addOption("openai_compatible", "Custom OpenAI-Compatible (Ollama, LM Studio, vLLM, OpenRouter, Groq, OpenAI)")
          .setValue(this.plugin.settings.aiProvider || "gemini")
          .onChange(async val => {
            this.plugin.settings.aiProvider = val as any;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    if (this.plugin.settings.aiProvider === "gemini") {
      new Setting(containerEl)
        .setName("Gemini API Key")
        .setDesc("Google AI Studio key for Gemini speaker disambiguation and entity extraction.")
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
        .setName("Test Gemini Connection")
        .setDesc("Verify that your Gemini API key and model are reachable.")
        .addButton(btn => {
          btn.setButtonText("Test Connection").onClick(async () => {
            if (!this.plugin.settings.geminiApiKey) {
              new Notice("⚠️ Please enter a Gemini API Key first.");
              return;
            }
            btn.setButtonText("Testing...").setDisabled(true);
            try {
              await testGeminiConnection(
                this.plugin.settings.geminiApiKey,
                this.plugin.settings.geminiModel
              );
              new Notice("✓ Successfully connected to Google Gemini!");
            } catch (e: any) {
              new Notice(`✗ Gemini connection failed: ${e.message}`);
            } finally {
              btn.setButtonText("Test Connection").setDisabled(false);
            }
          });
        });
    } else {
      new Setting(containerEl)
        .setName("Endpoint Base URL")
        .setDesc("Base URL of your OpenAI-compatible API (e.g. http://localhost:11434/v1 for Ollama, http://localhost:1234/v1 for LM Studio, https://api.openai.com/v1 for OpenAI, https://openrouter.ai/api/v1 for OpenRouter).")
        .addText(text => {
          text
            .setPlaceholder("http://localhost:11434/v1")
            .setValue(this.plugin.settings.openaiBaseUrl || "http://localhost:11434/v1")
            .onChange(async val => {
              this.plugin.settings.openaiBaseUrl = val.trim();
              await this.plugin.saveSettings();
            });
        });

      new Setting(containerEl)
        .setName("API Key")
        .setDesc("API key for the custom endpoint. Leave blank for local Ollama / LM Studio without authentication.")
        .addText(text => {
          text.inputEl.type = "password";
          text
            .setPlaceholder("sk-... (optional for local)")
            .setValue(this.plugin.settings.openaiApiKey || "")
            .onChange(async val => {
              this.plugin.settings.openaiApiKey = val.trim();
              await this.plugin.saveSettings();
            });
        });

      new Setting(containerEl)
        .setName("Model Name")
        .setDesc("Model identifier (e.g. llama3.1, mistral, gpt-4o-mini, qwen2.5, hermes-3).")
        .addText(text => {
          text
            .setPlaceholder("llama3.1")
            .setValue(this.plugin.settings.openaiModel || "llama3.1")
            .onChange(async val => {
              this.plugin.settings.openaiModel = val.trim();
              await this.plugin.saveSettings();
            });
        });

      new Setting(containerEl)
        .setName("Test Endpoint Connection")
        .setDesc("Verify that your custom endpoint and model are reachable.")
        .addButton(btn => {
          btn.setButtonText("Test Connection").onClick(async () => {
            btn.setButtonText("Testing...").setDisabled(true);
            try {
              const res = await testOpenAIConnection(
                this.plugin.settings.openaiBaseUrl,
                this.plugin.settings.openaiApiKey,
                this.plugin.settings.openaiModel
              );
              new Notice(`✓ Connected to endpoint! Model replied: "${res}"`);
            } catch (e: any) {
              new Notice(`✗ Endpoint connection failed: ${e.message}`);
            } finally {
              btn.setButtonText("Test Connection").setDisabled(false);
            }
          });
        });
    }

    new Setting(containerEl)
      .setName("Confidence Threshold")
      .setDesc("If offline heuristic confidence falls below this value (0.1 to 1.0), the AI provider will be invoked.")
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
      .setName("Force Cloud / Custom AI Enrichment")
      .setDesc("Always invoke the selected AI provider for all meetings with transcript data.")
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
