import { ItemView, WorkspaceLeaf, setIcon, Notice } from "obsidian";
import {
  DaemonClient,
  DaemonEvent,
  TickEvent,
  checkCompanionInstalled,
  getCompanionExeName,
  downloadCompanionDaemon
} from "./daemon-client";
import type PlaudPlugin from "./main";

export const VIEW_TYPE_LIVE_MEETING_DASHBOARD = "live-meeting-dashboard-view";

export class LiveMeetingDashboardView extends ItemView {
  private daemon: DaemonClient;
  private plugin?: PlaudPlugin;
  private unsubscribe: (() => void) | null = null;

  private statusBadgeEl!: HTMLElement;
  private timerEl!: HTMLElement;
  private meetingTitleEl!: HTMLElement;
  private meetingAppEl!: HTMLElement;
  private micMeterEl!: HTMLElement;
  private micDbEl!: HTMLElement;
  private sysMeterEl!: HTMLElement;
  private sysDbEl!: HTMLElement;
  private pauseResumeBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private captureBtn!: HTMLButtonElement;
  private onStopAndProcessCallback?: (filePath: string, durationSec: number, meetingTitle?: string) => void;

  constructor(leaf: WorkspaceLeaf, daemon: DaemonClient, plugin?: PlaudPlugin) {
    super(leaf);
    this.daemon = daemon;
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_LIVE_MEETING_DASHBOARD;
  }

  getDisplayText(): string {
    return "Live Meeting";
  }

  getIcon(): string {
    return "mic";
  }

  public setOnStopAndProcess(cb: (filePath: string, durationSec: number, meetingTitle?: string) => void) {
    this.onStopAndProcessCallback = cb;
  }

  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("plaud-live-dashboard-container");

    // Header
    const header = container.createDiv({ cls: "plaud-dashboard-header" });
    const titleRow = header.createDiv({ cls: "plaud-dashboard-title-row" });
    const iconSpan = titleRow.createSpan({ cls: "plaud-dashboard-icon" });
    setIcon(iconSpan, "audio-lines");
    titleRow.createEl("h3", { text: "Meeting Monitor" });

    this.statusBadgeEl = header.createDiv({ cls: "plaud-status-badge plaud-status-idle", text: "IDLE" });

    // Check if companion binary is installed
    if (this.plugin) {
      const binDir = this.plugin.resolveBinDir();
      const isInstalled = checkCompanionInstalled(binDir);
      const exeName = getCompanionExeName();

      if (!isInstalled) {
        const banner = container.createDiv({ cls: "plaud-companion-banner" });
        banner.createDiv({ cls: "plaud-companion-banner-title", text: "Companion Daemon Missing" });
        banner.createDiv({
          cls: "plaud-companion-banner-desc",
          text: `BRAT only installs plugin scripts. The background recorder (${exeName}) is needed for auto-recording.`
        });
        const dlBtn = banner.createEl("button", {
          cls: "mod-cta plaud-btn",
          text: `Download ${exeName}`,
        });
        dlBtn.onclick = async () => {
          dlBtn.disabled = true;
          dlBtn.textContent = "Downloading...";
          new Notice(`Downloading ${exeName} from GitHub releases...`, 15000);
          try {
            await downloadCompanionDaemon(binDir, (percent) => {
              dlBtn.textContent = `Downloading (${percent}%)...`;
            });
            new Notice(`✓ Installed ${exeName}! Starting daemon...`, 6000);
            const attachmentsDir = this.plugin!.resolveAttachmentsDir();
            this.daemon.launchDaemon(binDir, attachmentsDir);
            await this.onOpen();
          } catch (e: any) {
            console.error("[DashboardView] Failed to download companion:", e);
            new Notice(`Download failed: ${e.message}`, 8000);
            dlBtn.disabled = false;
            dlBtn.textContent = `Download ${exeName}`;
          }
        };
      }
    }

    // Meeting Details Card
    const card = container.createDiv({ cls: "plaud-meeting-card" });
    this.meetingAppEl = card.createDiv({ cls: "plaud-meeting-app", text: "No active meeting detected" });
    this.meetingTitleEl = card.createDiv({ cls: "plaud-meeting-title", text: "Waiting for Teams, Zoom, or Meet..." });

    // Timer
    const timerCard = container.createDiv({ cls: "plaud-timer-card" });
    this.timerEl = timerCard.createDiv({ cls: "plaud-live-timer", text: "00:00" });

    // VU Meters
    const metersContainer = container.createDiv({ cls: "plaud-meters-container" });

    // Mic Meter
    const micRow = metersContainer.createDiv({ cls: "plaud-meter-row" });
    micRow.createSpan({ cls: "plaud-meter-label", text: "Microphone (You)" });
    const micTrack = micRow.createDiv({ cls: "plaud-meter-track" });
    this.micMeterEl = micTrack.createDiv({ cls: "plaud-meter-fill" });
    this.micDbEl = micRow.createSpan({ cls: "plaud-meter-db", text: "-60 dB" });

    // System Meter
    const sysRow = metersContainer.createDiv({ cls: "plaud-meter-row" });
    sysRow.createSpan({ cls: "plaud-meter-label", text: "System Audio (Them)" });
    const sysTrack = sysRow.createDiv({ cls: "plaud-meter-track" });
    this.sysMeterEl = sysTrack.createDiv({ cls: "plaud-meter-fill" });
    this.sysDbEl = sysRow.createSpan({ cls: "plaud-meter-db", text: "-60 dB" });

    // Actions Card
    const actionsCard = container.createDiv({ cls: "plaud-actions-card" });

    this.pauseResumeBtn = actionsCard.createEl("button", {
      cls: "mod-cta plaud-btn",
      text: "Pause",
    });
    this.pauseResumeBtn.onclick = () => {
      const isPaused = this.daemon.currentTick?.is_paused;
      if (isPaused) {
        this.daemon.resumeRecording();
      } else {
        this.daemon.pauseRecording();
      }
    };

    this.stopBtn = actionsCard.createEl("button", {
      cls: "mod-warning plaud-btn",
      text: "Stop & Process",
    });
    this.stopBtn.onclick = () => {
      this.daemon.stopRecording();
    };

    this.captureBtn = actionsCard.createEl("button", {
      cls: "plaud-btn",
      text: "📸 Capture Slide",
    });
    this.captureBtn.onclick = () => {
      this.daemon.captureSlide();
    };

    // Listen to daemon events
    this.unsubscribe = this.daemon.addListener((event) => this.handleDaemonEvent(event));

    // Initial tick if present
    if (this.daemon.currentTick) {
      this.updateFromTick(this.daemon.currentTick);
    }
  }

  private handleDaemonEvent(event: DaemonEvent) {
    if (event.type === "tick") {
      this.updateFromTick(event);
    } else if (event.type === "recording_stopped") {
      if (this.onStopAndProcessCallback) {
        this.onStopAndProcessCallback(
          event.file_path,
          event.duration_seconds,
          event.meeting?.title
        );
      }
    }
  }

  private updateFromTick(tick: TickEvent) {
    // Timer
    this.timerEl.textContent = tick.timecode_formatted;

    // Status Badge
    if (tick.is_recording) {
      if (tick.is_paused) {
        this.statusBadgeEl.textContent = "PAUSED";
        this.statusBadgeEl.className = "plaud-status-badge plaud-status-paused";
        this.pauseResumeBtn.textContent = "Resume";
      } else {
        this.statusBadgeEl.textContent = "RECORDING";
        this.statusBadgeEl.className = "plaud-status-badge plaud-status-recording";
        this.pauseResumeBtn.textContent = "Pause";
      }
      this.pauseResumeBtn.disabled = false;
      this.stopBtn.disabled = false;
      this.captureBtn.disabled = false;
    } else {
      this.statusBadgeEl.textContent = "IDLE";
      this.statusBadgeEl.className = "plaud-status-badge plaud-status-idle";
      this.pauseResumeBtn.disabled = true;
      this.stopBtn.disabled = true;
      this.captureBtn.disabled = true;
    }

    // Meeting Info
    if (tick.active_meeting) {
      this.meetingAppEl.textContent = tick.active_meeting.app;
      this.meetingTitleEl.textContent = tick.active_meeting.title;
    } else if (!tick.is_recording) {
      this.meetingAppEl.textContent = "No meeting active";
      this.meetingTitleEl.textContent = "Waiting for Teams, Zoom, or Meet...";
    }

    // VU Meters (map -60dB to 0dB -> 0% to 100%)
    const micPercent = Math.min(100, Math.max(0, ((tick.levels.mic_db + 60) / 60) * 100));
    const sysPercent = Math.min(100, Math.max(0, ((tick.levels.system_db + 60) / 60) * 100));

    this.micMeterEl.style.width = `${micPercent}%`;
    this.micDbEl.textContent = `${tick.levels.mic_db.toFixed(0)} dB`;

    this.sysMeterEl.style.width = `${sysPercent}%`;
    this.sysDbEl.textContent = `${tick.levels.system_db.toFixed(0)} dB`;
  }

  async onClose() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}
