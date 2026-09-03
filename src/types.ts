export type AIProvider = "gemini" | "openai_compatible";

export interface PlaudPluginSettings {
  targetNotesFolder: string;
  targetAttachmentsFolder: string;
  downloadAudio: boolean;
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
