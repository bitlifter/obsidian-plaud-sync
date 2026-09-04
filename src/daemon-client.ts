import { Notice } from "obsidian";
import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { downloadFileWithProgress } from "./whisper-engine";

export function getCompanionExeName(): string {
  return process.arch === "arm64" ? "recorder-arm64.exe" : "recorder-x64.exe";
}

export function checkCompanionInstalled(binDir: string): boolean {
  const exePath = path.join(binDir, getCompanionExeName());
  return fs.existsSync(exePath);
}

export async function downloadCompanionDaemon(
  binDir: string,
  onProgress?: (percent: number, loadedBytes: number, totalBytes: number) => void
): Promise<string> {
  const exeName = getCompanionExeName();
  const url = `https://github.com/bitlifter/obsidian-plaud-sync/releases/latest/download/${exeName}`;
  const destPath = path.join(binDir, exeName);
  await downloadFileWithProgress(url, destPath, onProgress);
  return destPath;
}

export interface DetectedMeeting {
  app: string;
  title: string;
  hwnd: number;
  pid: number;
}

export interface AudioLevels {
  mic_db: number;
  system_db: number;
}

export interface TickEvent {
  type: "tick";
  is_recording: boolean;
  is_paused: boolean;
  elapsed_seconds: number;
  timecode_formatted: string;
  active_meeting?: DetectedMeeting | null;
  levels: AudioLevels;
}

export interface MeetingDetectedEvent {
  type: "meeting_detected";
  meeting: DetectedMeeting;
}

export interface RecordingStartedEvent {
  type: "recording_started";
  file_path: string;
  meeting?: DetectedMeeting | null;
}

export interface RecordingStoppedEvent {
  type: "recording_stopped";
  file_path: string;
  duration_seconds: number;
  meeting?: DetectedMeeting | null;
}

export interface SlideCapturedEvent {
  type: "slide_captured";
  file_path: string;
  filename: string;
  timecode: number;
  timecode_formatted: string;
}

export interface FeatureToggledEvent {
  type: "feature_toggled";
  enabled: boolean;
}

export type DaemonEvent =
  | TickEvent
  | MeetingDetectedEvent
  | RecordingStartedEvent
  | RecordingStoppedEvent
  | SlideCapturedEvent
  | FeatureToggledEvent;

export class DaemonClient {
  private ws: WebSocket | null = null;
  private port: number = 8198;
  private isConnected: boolean = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private childProcess: ChildProcess | null = null;
  private listeners: ((event: DaemonEvent) => void)[] = [];
  private lastTick: TickEvent | null = null;

  constructor(port = 8198) {
    this.port = port;
  }

  public get connected(): boolean {
    return this.isConnected;
  }

  public get currentTick(): TickEvent | null {
    return this.lastTick;
  }

  public addListener(cb: (event: DaemonEvent) => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  private emit(event: DaemonEvent) {
    if (event.type === "tick") {
      this.lastTick = event;
    }
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch (err) {
        console.error("[DaemonClient] listener error:", err);
      }
    }
  }

  public connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.port}`);

      this.ws.onopen = () => {
        this.isConnected = true;
        console.log(`[DaemonClient] Connected to companion daemon on port ${this.port}`);
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.emit(data);
        } catch (e) {
          console.warn("[DaemonClient] Malformed event:", event.data);
        }
      };

      this.ws.onclose = () => {
        this.isConnected = false;
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.isConnected = false;
        this.ws?.close();
      };
    } catch (e) {
      this.isConnected = false;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }

  public sendCommand(cmd: Record<string, any>) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(cmd));
    } else {
      console.warn("[DaemonClient] Cannot send command, daemon not connected");
    }
  }

  public startRecording(title?: string) {
    this.sendCommand({ command: "start", title });
  }

  public stopRecording() {
    this.sendCommand({ command: "stop" });
  }

  public pauseRecording() {
    this.sendCommand({ command: "pause" });
  }

  public resumeRecording() {
    this.sendCommand({ command: "resume" });
  }

  public captureSlide() {
    this.sendCommand({ command: "capture_slide" });
  }

  public setFeatureEnabled(enabled: boolean) {
    this.sendCommand({ command: "set_feature_enabled", enabled });
  }

  public exitDaemon() {
    this.sendCommand({ command: "exit" });
  }

  public getTimecode(): string {
    return this.lastTick?.timecode_formatted || "00:00";
  }

  public launchDaemon(binDir: string, vaultDir: string, autoRecord: boolean = false) {
    if (this.isConnected) return;

    const exeName = getCompanionExeName();
    const exePath = path.join(binDir, exeName);

    if (!fs.existsSync(exePath)) {
      console.warn(`[DaemonClient] Daemon binary not found at: ${exePath}`);
      return;
    }

    try {
      const args = ["--port", this.port.toString(), "--vault-dir", vaultDir];
      if (autoRecord) {
        args.push("--auto-record");
      }

      this.childProcess = spawn(exePath, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });

      this.childProcess.unref();
      console.log(`[DaemonClient] Spawned companion daemon (${exeName}), auto-record: ${autoRecord}`);
      setTimeout(() => this.connect(), 1000);
    } catch (e) {
      console.error("[DaemonClient] Failed to launch daemon:", e);
    }
  }

  public disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
  }
}
