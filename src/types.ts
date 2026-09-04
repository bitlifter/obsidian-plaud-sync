export type AIProvider = "gemini" | "openai_compatible";
export type TranscriptionEngine = "plaud_cloud" | "whisper_cpp" | "qnn_npu";
export type WhisperModelKey = "tiny.en" | "base.en" | "small.en" | "large-v3-turbo";
export type QnnPowerMode = "burst" | "high_performance" | "balanced" | "low_power";
export type QnnModelKey = "tiny.en" | "base.en" | "small.en" | "turbo";

export interface PlaudPluginSettings {
  targetNotesFolder: string;
  targetAttachmentsFolder: string;
  downloadAudio: boolean;
  transcriptionEngine: TranscriptionEngine;
  whisperModel: WhisperModelKey;
  localAudioFolder: string;
  customWhisperBinaryPath: string;
  customWhisperModelPath: string;
  qnnModel: QnnModelKey;
  qnnPowerMode: QnnPowerMode;
  customQnnBinaryPath: string;
  customQnnModelPath: string;
  customQnnBackendPath: string;
  aiProvider: AIProvider;
  geminiApiKey: string;
  geminiModel: string;
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;
  minConfidence: number;
  forceCloud: boolean;
  customOrgs: string;
  autoSyncOnStartup: boolean;
  plaudDesktopCachePath: string;
  autoImportPlaudCache: boolean;
  enableCompanionDaemon: boolean;
  daemonPort: number;
  autoRecordMeetings: boolean;
  lastSync: string | null;
  syncedFiles: Record<string, {
    title: string;
    note_path: string;
    audio_path?: string;
    synced_at: string;
  }>;
}

export const DEFAULT_SETTINGS: PlaudPluginSettings = {
  targetNotesFolder: "Notes",
  targetAttachmentsFolder: "Attachments",
  downloadAudio: true,
  transcriptionEngine: "plaud_cloud",
  whisperModel: "base.en",
  localAudioFolder: "Attachments/Inbox",
  customWhisperBinaryPath: "",
  customWhisperModelPath: "",
  qnnModel: "base.en",
  qnnPowerMode: "high_performance",
  customQnnBinaryPath: "",
  customQnnModelPath: "",
  customQnnBackendPath: "",
  aiProvider: "gemini",
  geminiApiKey: "",
  geminiModel: "gemini-3.6-flash",
  openaiBaseUrl: "http://localhost:11434/v1",
  openaiApiKey: "",
  openaiModel: "llama3.1",
  minConfidence: 0.70,
  forceCloud: false,
  customOrgs: "",
  autoSyncOnStartup: false,
  plaudDesktopCachePath: "",
  autoImportPlaudCache: false,
  enableCompanionDaemon: true,
  daemonPort: 8198,
  autoRecordMeetings: false,
  lastSync: null,
  syncedFiles: {}
};

export interface PlaudTokenSet {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  token_type?: string;
  scope?: string;
}

export interface PlaudFileItem {
  id: string;
  filename?: string;
  file_name?: string;
  start_time?: number | string;
  end_time?: number | string;
  duration?: number;
  file_type?: string;
  audio_url?: string;
  transcription?: string;
  summary?: string;
  [key: string]: any;
}

export interface TranscriptSegment {
  startTime?: number;
  endTime?: number;
  speaker?: string;
  content: string;
}

export interface SpeakerResolution {
  speakerMap: Record<string, string>;
  people: string[];
  organizations: string[];
  confidence: number;
  source: string;
}
