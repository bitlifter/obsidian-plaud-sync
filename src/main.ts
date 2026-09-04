import { App, Modal, Plugin, TFile, Notice, Editor, MarkdownView, normalizePath, WorkspaceLeaf } from "obsidian";
import * as path from "path";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import { PlaudPluginSettings, DEFAULT_SETTINGS } from "./types";
import { PlaudSyncEngine } from "./sync-engine";
import { PlaudSettingTab } from "./settings";
import { DaemonClient, DaemonEvent, SlideCapturedEvent, RecordingStoppedEvent } from "./daemon-client";
import { LiveMeetingDashboardView, VIEW_TYPE_LIVE_MEETING_DASHBOARD } from "./dashboard-view";
import { checkWhisperBinary, checkWhisperModel } from "./whisper-engine";
import { checkQnnBinary, checkQnnModel } from "./qnn-engine";
import { sanitizeFilename, formatDuration, formatNoteTitle } from "./extractor";

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
  public daemonClient: DaemonClient | null = null;
  private statusBarItem: HTMLElement | null = null;
  private pendingSlideEditor: Editor | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.syncEngine = new PlaudSyncEngine(
      this.app,
      this.settings,
      () => this.saveSettings()
    );

    // Register Dashboard View
    this.registerView(
      VIEW_TYPE_LIVE_MEETING_DASHBOARD,
      (leaf: WorkspaceLeaf) => {
        const view = new LiveMeetingDashboardView(leaf, this.daemonClient!, this);
        view.setOnStopAndProcess(async (filePath, durationSec, meetingTitle) => {
          await this.handleRecordingStopped(filePath, durationSec, meetingTitle);
        });
        return view;
      }
    );

    // Initialize Companion Daemon if enabled
    if (this.settings.enableCompanionDaemon) {
      this.daemonClient = new DaemonClient(this.settings.daemonPort || 8198);
      this.setupDaemonClient();
    }

    const onProgress = (cur: number, tot: number, title: string) => {
      const shortTitle = title.length > 22 ? title.slice(0, 22) + "..." : title;
      this.updateStatusBar(`[${cur}/${tot}] ${shortTitle}`);
    };

    // 1. Ribbon Icons (Left sidebar)
    this.addRibbonIcon("mic", "Plaud to Obsidian: Sync Recordings", async () => {
      this.updateStatusBar("Syncing...");
      try {
        await this.syncEngine.syncRecordings({ onProgress });
      } finally {
        this.updateStatusBar();
      }
    });

    this.addRibbonIcon("audio-lines", "Live Meeting Monitor", async () => {
      await this.activateDashboardView();
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

    this.addCommand({
      id: "plaud-import-cache",
      name: "Import recordings from Plaud Desktop cache (%APPDATA%\\ogg-cache)",
      callback: async () => {
        await this.syncEngine.importFromPlaudDesktopCache();
      }
    });

    this.addCommand({
      id: "plaud-import-cache-npu",
      name: "Import from Plaud Desktop cache with Snapdragon NPU (QNN)",
      callback: async () => {
        const prev = this.settings.transcriptionEngine;
        this.settings.transcriptionEngine = "qnn_npu";
        try {
          await this.syncEngine.importFromPlaudDesktopCache();
        } finally {
          this.settings.transcriptionEngine = prev;
        }
      }
    });

    // Companion Daemon Commands
    this.addCommand({
      id: "plaud-open-live-dashboard",
      name: "Open Live Meeting Dashboard",
      callback: async () => {
        await this.activateDashboardView();
      }
    });

    this.addCommand({
      id: "plaud-insert-timecode",
      name: "Insert current meeting timecode",
      hotkeys: [{ modifiers: ["Mod", "Alt"], key: "t" }],
      editorCallback: (editor: Editor) => {
        const tc = this.daemonClient?.getTimecode() || "00:00";
        editor.replaceSelection(`**[${tc}]** `);
      }
    });

    this.addCommand({
      id: "plaud-capture-slide",
      name: "Capture meeting slide / screenshot",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "s" }],
      editorCallback: (editor: Editor) => {
        if (!this.daemonClient || !this.daemonClient.connected) {
          new Notice("Meeting recorder companion is not connected.");
          return;
        }
        this.pendingSlideEditor = editor;
        this.daemonClient.captureSlide();
        new Notice("Capturing slide...");
      }
    });

    this.addCommand({
      id: "plaud-daemon-start-record",
      name: "Meeting Recorder: Start manual recording",
      callback: () => {
        this.daemonClient?.startRecording();
        new Notice("Meeting recording requested.");
      }
    });

    this.addCommand({
      id: "plaud-daemon-stop-record",
      name: "Meeting Recorder: Stop recording",
      callback: () => {
        this.daemonClient?.stopRecording();
        new Notice("Stopping meeting recording...");
      }
    });

    this.addCommand({
      id: "plaud-daemon-pause-record",
      name: "Meeting Recorder: Pause/Resume recording",
      callback: () => {
        const isPaused = this.daemonClient?.currentTick?.is_paused;
        if (isPaused) {
          this.daemonClient?.resumeRecording();
          new Notice("Resumed meeting recording.");
        } else {
          this.daemonClient?.pauseRecording();
          new Notice("Paused meeting recording.");
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

    // 5. Auto-sync & auto-import on startup if enabled
    if (this.settings.autoSyncOnStartup || this.settings.autoImportPlaudCache) {
      this.app.workspace.onLayoutReady(() => {
        setTimeout(async () => {
          if (this.settings.autoSyncOnStartup) {
            try {
              await this.syncEngine.syncRecordings();
            } catch (err) {
              console.warn("Auto-sync on startup failed:", err);
            }
          }
          if (this.settings.autoImportPlaudCache) {
            try {
              await this.syncEngine.importFromPlaudDesktopCache();
            } catch (err) {
              console.warn("Auto-import Plaud cache on startup failed:", err);
            }
          }
        }, 5000);
      });
    }
  }

  private setupDaemonClient() {
    if (!this.daemonClient) return;

    this.daemonClient.addListener((event: DaemonEvent) => {
      if (event.type === "meeting_detected") {
        new Notice(`🎙️ Detected ${event.meeting.app}: "${event.meeting.title}"`, 5000);
      } else if (event.type === "recording_started") {
        new Notice(`🔴 Recording started: ${event.meeting?.title || "Meeting"}`, 5000);
      } else if (event.type === "recording_stopped") {
        this.handleRecordingStopped(event.file_path, event.duration_seconds, event.meeting?.title);
      } else if (event.type === "slide_captured") {
        this.handleSlideCaptured(event);
      }
    });

    // Launch daemon process and connect
    this.app.workspace.onLayoutReady(() => {
      setTimeout(() => {
        const binDir = this.resolveBinDir();
        const attachmentsDir = this.resolveAttachmentsDir();
        this.daemonClient?.launchDaemon(binDir, attachmentsDir, this.settings.autoRecordMeetings);
      }, 2000);
    });
  }

  public resolveBinDir(): string {
    const pluginDir = this.syncEngine.getPluginDir();
    const candidatePaths = [
      path.join(pluginDir, "bin"),
      path.join("c:", "Users", "micro", "repos", "personal", "obsidian-plaud-sync", "bin"),
    ];
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) return p;
    }
    return candidatePaths[0];
  }

  public resolveAttachmentsDir(): string {
    const adapter = this.app.vault.adapter as any;
    const basePath = adapter.getBasePath ? adapter.getBasePath() : "";
    if (basePath) {
      return path.join(basePath, this.settings.targetAttachmentsFolder);
    }
    const appData = process.env.APPDATA || ".";
    return path.join(appData, "meeting-recordings");
  }

  public async activateDashboardView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_LIVE_MEETING_DASHBOARD)[0];
    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        await rightLeaf.setViewState({
          type: VIEW_TYPE_LIVE_MEETING_DASHBOARD,
          active: true,
        });
        leaf = rightLeaf;
      }
    }
    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  private async handleRecordingStopped(filePath: string, durationSec: number, meetingTitle?: string) {
    new Notice(`🔴 Meeting recording stopped (${Math.round(durationSec)}s). Processing note...`, 8000);

    try {
      const fileName = path.basename(filePath);
      const vaultRelPath = normalizePath(`${this.settings.targetAttachmentsFolder}/${fileName}`);

      let targetTFile: TFile | null = null;
      const existing = this.app.vault.getAbstractFileByPath(vaultRelPath);

      if (existing instanceof TFile) {
        targetTFile = existing;
      } else if (fs.existsSync(filePath)) {
        const buf = await fsPromises.readFile(filePath);
        const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
        targetTFile = await this.app.vault.createBinary(vaultRelPath, arrayBuf);
      }

      if (targetTFile) {
        const pluginDir = this.syncEngine.getPluginDir();
        const useQnn = this.settings.transcriptionEngine === "qnn_npu";

        let canTranscribe = false;
        if (useQnn) {
          const qBin = checkQnnBinary(pluginDir, this.settings.customQnnBinaryPath);
          const qMod = checkQnnModel(this.settings.qnnModel, pluginDir, this.settings.customQnnModelPath);
          canTranscribe = qBin.exists && qMod.exists;
        } else {
          const wBin = checkWhisperBinary(pluginDir, this.settings.customWhisperBinaryPath);
          const wMod = checkWhisperModel(this.settings.whisperModel, pluginDir, this.settings.customWhisperModelPath);
          canTranscribe = wBin.exists && wMod.exists;
        }

        if (canTranscribe) {
          try {
            const engineLabel = useQnn ? "Snapdragon NPU" : "Whisper";
            new Notice(`Transcribing "${targetTFile.name}" with ${engineLabel}...`, 6000);
            await this.syncEngine.transcribeLocalAudioFile(targetTFile);
            new Notice(`✓ Meeting note generated for "${targetTFile.name}"!`, 8000);
            return;
          } catch (transcribeErr: any) {
            console.warn("[PlaudPlugin] Transcription error, falling back to note creation:", transcribeErr);
          }
        }

        // Whisper or QNN is not installed yet: Create clean note with audio player & instructions
        await this.createRecordingNoteWithAudio(targetTFile, durationSec, meetingTitle);
        new Notice(`✓ Recording saved! Note created with audio playback.`, 8000);
      }
    } catch (err: any) {
      console.error("[PlaudPlugin] Note creation error:", err);
      new Notice(`Failed to save recording note: ${err.message}`, 8000);
    }
  }

  private async createRecordingNoteWithAudio(
    audioFile: TFile,
    durationSec: number,
    meetingTitle?: string
  ) {
    const rawTitle = meetingTitle || audioFile.basename.replace(/^\d{8}_\d{6}_/, "").trim() || "Meeting Recording";
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const durationStr = formatDuration(Math.round(durationSec));

    const safeTitle = sanitizeFilename(rawTitle, 80);
    const noteTitle = formatNoteTitle(dateStr, safeTitle);
    const noteVaultPath = normalizePath(`${this.settings.targetNotesFolder}/${noteTitle}.md`);

    const noteContent = [
      "---",
      `title: "${noteTitle}"`,
      `date: ${dateStr}`,
      `time: "${timeStr}"`,
      `duration: "${durationStr}"`,
      `audio: "[[${audioFile.path}]]"`,
      "tags:",
      "  - meeting",
      "  - audio-recording",
      "---",
      "",
      `# ${noteTitle}`,
      "",
      `![[${audioFile.path}]]`,
      "",
      "> [!INFO] Local Transcription Engine Pending",
      `> Audio was recorded successfully (${durationStr}) and saved to \`${audioFile.path}\`.`,
      "> To generate automated timestamped transcripts and AI summaries:",
      "> 1. Open **Settings** → **Plaud Sync**",
      "> 2. Click **Download Whisper Engine** or **Download Qualcomm QNN Runner**",
      "> 3. Right-click this audio file in Obsidian and choose **Transcribe with Local Whisper / Snapdragon NPU**",
      "",
      "## 📝 Meeting Notes",
      "",
      "- ",
      "",
    ].join("\n");

    await this.syncEngine.ensureFolder(this.settings.targetNotesFolder);
    const existing = this.app.vault.getAbstractFileByPath(noteVaultPath);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, noteContent);
    } else {
      await this.app.vault.create(noteVaultPath, noteContent);
    }

    const noteFile = this.app.vault.getAbstractFileByPath(noteVaultPath);
    if (noteFile instanceof TFile) {
      const leaf = this.app.workspace.getLeaf(false);
      if (leaf) {
        await leaf.openFile(noteFile);
      }
    }
  }

  private async handleSlideCaptured(event: SlideCapturedEvent) {
    const fileName = event.filename;
    const timecode = event.timecode_formatted;
    new Notice(`📸 Slide captured at ${timecode}: ${fileName}`, 4000);

    try {
      const vaultRelPath = normalizePath(`${this.settings.targetAttachmentsFolder}/${fileName}`);
      const existing = this.app.vault.getAbstractFileByPath(vaultRelPath);
      if (!existing && fs.existsSync(event.file_path)) {
        const buf = await fsPromises.readFile(event.file_path);
        const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
        await this.app.vault.createBinary(vaultRelPath, arrayBuf);
      }
    } catch (e) {
      console.warn("Could not copy slide image to vault attachments:", e);
    }

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const editor = this.pendingSlideEditor || activeView?.editor;
    if (editor) {
      editor.replaceSelection(`\n\n![[${fileName}]]\n*Slide captured at ${timecode}*\n\n`);
    }
    this.pendingSlideEditor = null;
  }

  onunload(): void {
    if (this.statusBarItem) {
      this.statusBarItem.remove();
    }
    if (this.daemonClient) {
      this.daemonClient.disconnect();
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
