import { App, Notice, normalizePath, TFile, TFolder } from "obsidian";
import * as path from "path";
import * as fsPromises from "fs/promises";
import { existsSync } from "fs";
import { PlaudApiClient } from "./plaud-api";
import { enrichMeetingData, transcribeAudioGemini, summarizeTranscript } from "./enricher";
import { createTemp16kWavFile } from "./audio-converter";
import { checkWhisperBinary, checkWhisperModel, runWhisperCli } from "./whisper-engine";
import {
  checkQnnBinary,
  checkQnnModel,
  runQnnTranscription,
  detectSnapdragonHardware,
} from "./qnn-engine";
import {
  parsePlaudDate,
  formatDuration,
  formatNoteTitle,
  extractAutoSumNotes,
  generateKepanoNote,
  sanitizeFilename
} from "./extractor";
import { PlaudPluginSettings, TranscriptSegment } from "./types";

export interface SyncProgressCallback {
  (current: number, total: number, currentTitle: string): void;
}

export class PlaudSyncEngine {
  private app: App;
  private settings: PlaudPluginSettings;
  private saveSettings: () => Promise<void>;
  private client: PlaudApiClient;
  private isSyncing = false;

  constructor(app: App, settings: PlaudPluginSettings, saveSettings: () => Promise<void>) {
    this.app = app;
    this.settings = settings;
    this.saveSettings = saveSettings;
    this.client = new PlaudApiClient();
  }

  public getApiClient(): PlaudApiClient {
    return this.client;
  }

  public getIsSyncing(): boolean {
    return this.isSyncing;
  }

  public async log(msg: string): Promise<void> {
    const timestamp = new Date().toLocaleTimeString();
    const line = `[${timestamp}] ${msg}`;
    console.log(`%c[Plaud Sync]%c ${line}`, "color: #9d7cd8; font-weight: bold;", "color: inherit;");
    try {
      const logPath = normalizePath(".obsidian/plaud-sync.log");
      const exists = await this.app.vault.adapter.exists(logPath);
      if (exists) {
        await this.app.vault.adapter.append(logPath, line + "\n");
      } else {
        await this.app.vault.adapter.write(logPath, line + "\n");
      }
    } catch {}
  }

  public async getRecentLogs(): Promise<string> {
    try {
      const logPath = normalizePath(".obsidian/plaud-sync.log");
      const exists = await this.app.vault.adapter.exists(logPath);
      if (exists) {
        return await this.app.vault.adapter.read(logPath);
      }
    } catch {}
    return "No sync logs recorded yet.";
  }

  public async ensureFolder(folderPath: string): Promise<void> {
    const normalized = normalizePath(folderPath);
    if (!normalized || normalized === "/" || normalized === ".") return;

    const parts = normalized.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const file = this.app.vault.getAbstractFileByPath(current);
      if (!file) {
        try {
          await this.app.vault.createFolder(current);
        } catch {}
      }
    }
  }

  public async syncRecordings({
    force = false,
    onProgress
  }: {
    force?: boolean;
    onProgress?: SyncProgressCallback;
  } = {}): Promise<{ total: number; synced: number; skipped: number; errors: number }> {
    if (this.isSyncing) {
      new Notice("Plaud sync is already in progress.");
      return { total: 0, synced: 0, skipped: 0, errors: 0 };
    }

    this.isSyncing = true;
    new Notice("Connecting to Plaud and fetching recordings...");

    try {
      await this.ensureFolder(this.settings.targetNotesFolder);
      if (this.settings.downloadAudio) {
        await this.ensureFolder(this.settings.targetAttachmentsFolder);
      }

      await this.log(`=== Plaud Sync Started (Force: ${force}) ===`);
      const allFiles = await this.client.listFiles(100);
      new Notice(`Found ${allFiles.length} recordings in Plaud.`);
      await this.log(`Found ${allFiles.length} total recordings in Plaud account.`);

      const pendingFiles = force
        ? allFiles
        : allFiles.filter(f => {
            const state = this.settings.syncedFiles[f.id];
            if (!state) return true;
            // Check if note actually exists on disk
            const existingFile = this.app.vault.getAbstractFileByPath(state.note_path);
            return !existingFile;
          });

      if (pendingFiles.length === 0) {
        new Notice("Vault is already up to date! No new recordings to sync.");
        await this.log("Vault is already up to date. No new recordings to sync.");
        this.isSyncing = false;
        return { total: allFiles.length, synced: 0, skipped: allFiles.length, errors: 0 };
      }

      new Notice(`Syncing ${pendingFiles.length} recordings...`);
      await this.log(`Queued ${pendingFiles.length} recordings to sync.`);

      let syncedCount = 0;
      let errorCount = 0;

      for (let i = 0; i < pendingFiles.length; i++) {
        const item = pendingFiles[i];
        let rawTitle = item.name || item.filename || "Recording";

        if (onProgress) {
          onProgress(i + 1, pendingFiles.length, rawTitle);
        }

        try {
          const detail = await this.client.getFileDetail(item.id);
          rawTitle = item.name || detail.name || item.filename || item.file_name || "Recording";

          const dateInfo = parsePlaudDate(item.start_time || item.created_at || detail.start_time || detail.start_at);
          const durationSec = item.duration || detail.duration || 0;
          const durationStr = formatDuration(durationSec);

          await this.log(`[${i + 1}/${pendingFiles.length}] Syncing: "${rawTitle}" (${durationStr})`);

          const autoSum = extractAutoSumNotes(detail);
          const noteTitle = formatNoteTitle(rawTitle, dateInfo.date, dateInfo.time);

          // Audio file handling
          let audioFilename: string | null = null;
          let audioVaultPath: string | null = null;
          let audioBuffer: ArrayBuffer | null = null;

          const downloadLink = item.audio_url || detail.audio_url || detail.presigned_url;
          if (this.settings.downloadAudio && downloadLink) {
            const safeAudioBase = sanitizeFilename(rawTitle, 80);
            audioFilename = `${dateInfo.date} ${safeAudioBase}.mp3`;
            audioVaultPath = normalizePath(`${this.settings.targetAttachmentsFolder}/${audioFilename}`);

            const existingAudio = this.app.vault.getAbstractFileByPath(audioVaultPath);
            if (!existingAudio) {
              try {
                audioBuffer = await this.client.downloadAudioBuffer(item.id, downloadLink);
                await this.app.vault.createBinary(audioVaultPath, audioBuffer);
              } catch (audioErr: any) {
                console.warn(`Could not download audio for ${rawTitle}: ${audioErr.message}`);
                audioFilename = null;
              }
            } else if (this.app.vault.adapter) {
              try {
                audioBuffer = await this.app.vault.adapter.readBinary(audioVaultPath);
              } catch {}
            }
          }

          // 1. Resolve summary from detail.note_list
          let summaryContent = "";
          const noteList = detail.note_list || [];
          const sumNote = noteList.find((n: any) => n.data_type === "auto_sum_note");
          if (sumNote) {
            summaryContent = await this.client.loadBlockContent(sumNote);
          } else if (autoSum.summaryContent) {
            summaryContent = autoSum.summaryContent;
          }

          // 2. Resolve transcript from detail.source_list
          let transcriptSegments: any[] = [];
          const sourceList = detail.source_list || [];
          const txBlock = sourceList.find((s: any) => s.data_type === "transaction" || s.data_type === "transaction_polish");
          if (txBlock) {
            const rawTx = await this.client.loadBlockContent(txBlock);
            if (rawTx) {
              try {
                const parsed = JSON.parse(rawTx);
                if (Array.isArray(parsed)) transcriptSegments = parsed;
              } catch {}
            }
          }
          if (transcriptSegments.length === 0) {
            const payload = detail.payload || detail;
            if (Array.isArray(payload.transcription)) {
              transcriptSegments = payload.transcription;
            } else if (Array.isArray(detail.transcription)) {
              transcriptSegments = detail.transcription;
            } else if (payload.transcription?.segments) {
              transcriptSegments = payload.transcription.segments;
            }
          }

          // 3. Resolve outline from detail.source_list
          let outlineText = "";
          const outlineBlock = sourceList.find((s: any) => s.data_type === "outline");
          if (outlineBlock) {
            const rawOutline = await this.client.loadBlockContent(outlineBlock);
            if (rawOutline) {
              try {
                const parsed = JSON.parse(rawOutline);
                if (Array.isArray(parsed)) {
                  outlineText = parsed.map((it: any) => `- **${it.topic || it.title || ""}**`).join("\n");
                } else if (typeof rawOutline === "string") {
                  outlineText = rawOutline;
                }
              } catch {
                outlineText = rawOutline;
              }
            }
          }
          if (!outlineText && autoSum.outlineText) {
            outlineText = autoSum.outlineText;
          }

          // 4. Fallback: If Plaud never transcribed the audio, use Whisper.cpp or Gemini Multimodal
          let enrichedPeople: string[] = [];
          let enrichedOrganizations: string[] = [];
          let speakerMap: Record<string, string> = {};

          if (transcriptSegments.length === 0 && !summaryContent && audioBuffer) {
            // Option A: Snapdragon NPU (QNN) if configured
            if (this.settings.transcriptionEngine === "qnn_npu") {
              try {
                await this.log(`  └─ ⚡ Untranscribed audio detected. Transcribing with Snapdragon NPU / QNN (${this.settings.qnnModel})...`);
                const pluginDir = this.getPluginDir();
                const binInfo = checkQnnBinary(pluginDir, this.settings.customQnnBinaryPath);
                const modelInfo = checkQnnModel(this.settings.qnnModel, pluginDir, this.settings.customQnnModelPath);
                if (binInfo.exists && modelInfo.exists) {
                  const { wavPath, cleanup } = await createTemp16kWavFile(audioBuffer);
                  try {
                    transcriptSegments = await runQnnTranscription({
                      binaryPath: binInfo.path,
                      modelDir: modelInfo.dir,
                      audioWavPath: wavPath,
                      powerMode: this.settings.qnnPowerMode,
                      customBackendPath: this.settings.customQnnBackendPath
                    });
                  } finally {
                    await cleanup();
                  }
                  await this.log(`  └─ ✓ Snapdragon NPU transcription completed (${transcriptSegments.length} segments)`);
                } else {
                  await this.log(`  └─ ⚠️ QNN runner or model not found. Falling back.`);
                }
              } catch (qnnErr: any) {
                await this.log(`  └─ ⚠️ Snapdragon NPU failed: ${qnnErr.message}`);
              }
            }

            // Option B: Local Whisper (whisper.cpp) if configured or fallback
            if (transcriptSegments.length === 0 && (this.settings.transcriptionEngine === "whisper_cpp" || this.settings.transcriptionEngine === "qnn_npu")) {
              try {
                await this.log(`  └─ 🎙️ Transcribing with local Whisper (${this.settings.whisperModel})...`);
                const pluginDir = this.getPluginDir();
                const binInfo = checkWhisperBinary(pluginDir, this.settings.customWhisperBinaryPath);
                const modelInfo = checkWhisperModel(this.settings.whisperModel, pluginDir, this.settings.customWhisperModelPath);
                if (binInfo.exists && modelInfo.exists) {
                  const { wavPath, cleanup } = await createTemp16kWavFile(audioBuffer);
                  try {
                    transcriptSegments = await runWhisperCli({
                      binaryPath: binInfo.path,
                      modelPath: modelInfo.path,
                      wavPath
                    });
                  } finally {
                    await cleanup();
                  }
                  await this.log(`  └─ ✓ Local Whisper transcription completed (${transcriptSegments.length} segments)`);
                } else {
                  await this.log(`  └─ ⚠️ Whisper binary or model not found. Falling back to Gemini.`);
                }
              } catch (whisperErr: any) {
                await this.log(`  └─ ⚠️ Local Whisper failed: ${whisperErr.message}`);
              }
            }

            // Option B: Gemini Multimodal if transcript still empty
            if (transcriptSegments.length === 0 && this.settings.geminiApiKey) {
              try {
                const model = this.settings.geminiModel || "gemini-3.6-flash";
                await this.log(`  └─ 🎙️ Transcribing with ${model}...`);
                const geminiResult = await transcribeAudioGemini(audioBuffer, this.settings.geminiApiKey, rawTitle, model);
                if (geminiResult.transcriptSegments.length > 0 || geminiResult.summaryContent) {
                  transcriptSegments = geminiResult.transcriptSegments;
                  summaryContent = geminiResult.summaryContent;
                  if (geminiResult.outlineText) outlineText = geminiResult.outlineText;
                  enrichedPeople = geminiResult.people;
                  enrichedOrganizations = geminiResult.organizations;
                  await this.log(`  └─ ✓ Gemini transcription completed (${transcriptSegments.length} segments)`);
                }
              } catch (transErr: any) {
                await this.log(`  └─ ⚠️ Gemini audio transcription failed: ${transErr.message}`);
                console.warn(`Gemini audio transcription fallback failed for ${rawTitle}: ${transErr.message}`);
              }
            }
          }

          // 5. Enrichment (Speaker detection & Org extraction)
          if (enrichedPeople.length === 0 && enrichedOrganizations.length === 0) {
            const enriched = await enrichMeetingData({
              transcriptSegments,
              summaryContent,
              title: rawTitle,
              aiProvider: this.settings.aiProvider,
              geminiApiKey: this.settings.geminiApiKey,
              geminiModel: this.settings.geminiModel,
              openaiBaseUrl: this.settings.openaiBaseUrl,
              openaiApiKey: this.settings.openaiApiKey,
              openaiModel: this.settings.openaiModel,
              minConfidence: this.settings.minConfidence,
              forceCloud: this.settings.forceCloud,
              customOrgs: this.settings.customOrgs
            });
            enrichedPeople = enriched.people;
            enrichedOrganizations = enriched.organizations;
            speakerMap = enriched.speakerMap;
          }

          // 6. Generate Note Content
          const noteContent = generateKepanoNote({
            title: noteTitle,
            date: dateInfo.date,
            time: dateInfo.time,
            duration: durationStr,
            people: enrichedPeople,
            organizations: enrichedOrganizations,
            topics: [],
            summaryContent,
            outlineText,
            audioFilename,
            transcriptSegments,
            speakerMap
          });

          const noteVaultPath = normalizePath(`${this.settings.targetNotesFolder}/${noteTitle}.md`);
          const existingFile = this.app.vault.getAbstractFileByPath(noteVaultPath);

          if (existingFile instanceof TFile) {
            await this.app.vault.modify(existingFile, noteContent);
          } else {
            await this.app.vault.create(noteVaultPath, noteContent);
          }

          this.settings.syncedFiles[item.id] = {
            title: noteTitle,
            note_path: noteVaultPath,
            audio_path: audioVaultPath || undefined,
            synced_at: new Date().toISOString()
          };

          syncedCount++;
          await this.log(`  └─ ✓ Note written: ${noteVaultPath}`);
          if (audioFilename) await this.log(`  └─ ✓ Audio: ${audioFilename}`);
          if (enrichedPeople.length > 0) await this.log(`  └─ Attendees: ${enrichedPeople.join(", ")}`);

          // Periodically save state
          if (syncedCount % 5 === 0) {
            await this.saveSettings();
          }
        } catch (itemErr: any) {
          await this.log(`  └─ ❌ Error processing "${rawTitle}": ${itemErr.message}`);
          console.error(`Error processing recording ${rawTitle}:`, itemErr);
          errorCount++;
        }
      }

      this.settings.lastSync = new Date().toISOString();
      await this.saveSettings();

      await this.log(`=== Plaud Sync Completed: ${syncedCount} synced, ${errorCount} errors ===`);
      const summaryMsg = `Plaud Sync complete! ${syncedCount} synced, ${errorCount} errors.`;
      new Notice(summaryMsg, 5000);

      return {
        total: allFiles.length,
        synced: syncedCount,
        skipped: allFiles.length - pendingFiles.length,
        errors: errorCount
      };
    } catch (err: any) {
      new Notice(`Plaud sync failed: ${err.message}`, 8000);
      throw err;
    } finally {
      this.isSyncing = false;
    }
  }

  public getPluginDir(): string {
    const adapter = this.app.vault.adapter as any;
    if (adapter.getBasePath) {
      const basePath = adapter.getBasePath();
      const configDir = (this.app.vault as any).configDir || ".obsidian";
      return path.join(basePath, configDir, "plugins", "plaud-to-obsidian");
    }
    return "";
  }

  public async transcribeLocalAudioFile(audioFile: TFile): Promise<string> {
    await this.log(`=== Processing Local Audio File: ${audioFile.path} ===`);
    const useQnn = this.settings.transcriptionEngine === "qnn_npu";
    const engineLabel = useQnn ? "Snapdragon NPU (QNN)" : "local Whisper";
    new Notice(`Transcribing "${audioFile.name}" with ${engineLabel}...`, 6000);

    const pluginDir = this.getPluginDir();

    // 1. Read audio buffer from vault
    const rawAudioBuffer = await this.app.vault.readBinary(audioFile);

    // 2. Convert to 16kHz WAV
    await this.log(`  └─ Converting ${audioFile.extension.toUpperCase()} to 16kHz mono WAV via Web Audio API...`);
    const { wavPath, cleanup } = await createTemp16kWavFile(rawAudioBuffer);

    let segments: TranscriptSegment[] = [];
    try {
      if (useQnn) {
        const qnnBin = checkQnnBinary(pluginDir, this.settings.customQnnBinaryPath);
        const qnnModel = checkQnnModel(this.settings.qnnModel, pluginDir, this.settings.customQnnModelPath);

        if (!qnnBin.exists || !qnnModel.exists) {
          // Check if whisper.cpp is available as a fallback
          const wBin = checkWhisperBinary(pluginDir, this.settings.customWhisperBinaryPath);
          const wModel = checkWhisperModel(this.settings.whisperModel, pluginDir, this.settings.customWhisperModelPath);
          if (wBin.exists && wModel.exists) {
            await this.log("  └─ ⚠️ QNN runner/model not found; falling back to Whisper.cpp CPU engine.");
            segments = await runWhisperCli({
              binaryPath: wBin.path,
              modelPath: wModel.path,
              wavPath,
            });
          } else {
            const missing = !qnnBin.exists ? "QNN runner binary" : `QNN model (${this.settings.qnnModel})`;
            const msg = `${missing} not found. Please click 'Download QNN Runner/Model' in Plaud Sync Settings.`;
            new Notice(msg, 7000);
            throw new Error(msg);
          }
        } else {
          await this.log(`  └─ ⚡ Running Snapdragon NPU / QNN transcription (${this.settings.qnnModel})...`);
          segments = await runQnnTranscription({
            binaryPath: qnnBin.path,
            modelDir: qnnModel.dir,
            audioWavPath: wavPath,
            powerMode: this.settings.qnnPowerMode,
            customBackendPath: this.settings.customQnnBackendPath,
          });
          await this.log(`  └─ ✓ Snapdragon NPU transcription complete: ${segments.length} segments.`);
        }
      } else {
        const binInfo = checkWhisperBinary(pluginDir, this.settings.customWhisperBinaryPath);
        if (!binInfo.exists) {
          const msg = "Whisper binary not found. Please click 'Download Whisper Engine' in Plaud Sync Settings.";
          new Notice(msg, 7000);
          throw new Error(msg);
        }

        const modelInfo = checkWhisperModel(
          this.settings.whisperModel,
          pluginDir,
          this.settings.customWhisperModelPath
        );
        if (!modelInfo.exists) {
          const msg = `Whisper model (${this.settings.whisperModel}) not found. Please click 'Download Model' in Plaud Sync Settings.`;
          new Notice(msg, 7000);
          throw new Error(msg);
        }

        await this.log(`  └─ Running whisper.cpp (${this.settings.whisperModel})...`);
        segments = await runWhisperCli({
          binaryPath: binInfo.path,
          modelPath: modelInfo.path,
          wavPath,
        });
        await this.log(`  └─ ✓ Whisper transcription complete: ${segments.length} segments.`);
      }
    } finally {
      await cleanup();
    }

    if (segments.length === 0) {
      throw new Error("Transcription completed but produced no text segments (audio may be silent).");
    }

    // 3. Summarize and enrich transcript
    const rawTitle = audioFile.basename.replace(/^\d{4}-\d{2}-\d{2}[ _]?/, "").trim() || audioFile.basename;
    new Notice("Generating summary and identifying attendees...", 4000);
    await this.log(`  └─ Summarizing meeting & resolving speakers (${this.settings.aiProvider})...`);

    const summaryResult = await summarizeTranscript({
      transcriptSegments: segments,
      title: rawTitle,
      aiProvider: this.settings.aiProvider,
      geminiApiKey: this.settings.geminiApiKey,
      geminiModel: this.settings.geminiModel,
      openaiBaseUrl: this.settings.openaiBaseUrl,
      openaiApiKey: this.settings.openaiApiKey,
      openaiModel: this.settings.openaiModel,
      customOrgs: this.settings.customOrgs
    });

    // 4. Determine date & duration
    let fileDate = new Date(audioFile.stat.mtime || Date.now());
    if (/^\d{10,13}$/.test(audioFile.basename)) {
      const num = parseInt(audioFile.basename, 10);
      const parsedDate = new Date(num > 1e11 ? num : num * 1000);
      if (!isNaN(parsedDate.getTime()) && parsedDate.getFullYear() > 2020) {
        fileDate = parsedDate;
      }
    }
    const dateStr = `${fileDate.getFullYear()}-${String(fileDate.getMonth() + 1).padStart(2, "0")}-${String(fileDate.getDate()).padStart(2, "0")}`;
    const timeStr = `${String(fileDate.getHours()).padStart(2, "0")}:${String(fileDate.getMinutes()).padStart(2, "0")}`;

    let totalSeconds = 0;
    if (segments.length > 0 && segments[segments.length - 1].endTime) {
      totalSeconds = segments[segments.length - 1].endTime!;
    }
    const durationStr = formatDuration(totalSeconds);

    // 5. Ensure audio is in Attachments
    await this.ensureFolder(this.settings.targetAttachmentsFolder);
    await this.ensureFolder(this.settings.targetNotesFolder);

    let displayTitle = rawTitle;
    if (summaryResult.title && /^(rec|\d{6,}|audio|sound|recording|track|plaud)/i.test(rawTitle)) {
      displayTitle = summaryResult.title;
    }

    const safeAudioBase = sanitizeFilename(displayTitle, 80);
    const audioTargetFilename = `${dateStr} ${safeAudioBase}.${audioFile.extension}`;
    const audioTargetVaultPath = normalizePath(`${this.settings.targetAttachmentsFolder}/${audioTargetFilename}`);

    // If audio is in Inbox, copy to Attachments
    if (audioFile.path !== audioTargetVaultPath) {
      const targetExists = await this.app.vault.adapter.exists(audioTargetVaultPath);
      if (!targetExists) {
        await this.app.vault.copy(audioFile, audioTargetVaultPath);
        await this.log(`  └─ Copied audio to ${audioTargetVaultPath}`);
      }
    }

    // 6. Generate Kepano Markdown Note
    const noteTitle = formatNoteTitle(dateStr, displayTitle);
    const noteContent = generateKepanoNote({
      title: noteTitle,
      date: dateStr,
      time: timeStr,
      duration: durationStr,
      people: summaryResult.people,
      organizations: summaryResult.organizations,
      topics: [],
      summaryContent: summaryResult.summaryContent,
      outlineText: summaryResult.outlineText,
      audioFilename: audioTargetFilename,
      transcriptSegments: segments,
      speakerMap: summaryResult.speakerMap
    });

    const noteVaultPath = normalizePath(`${this.settings.targetNotesFolder}/${noteTitle}.md`);
    const existingFile = this.app.vault.getAbstractFileByPath(noteVaultPath);

    if (existingFile instanceof TFile) {
      await this.app.vault.modify(existingFile, noteContent);
    } else {
      await this.app.vault.create(noteVaultPath, noteContent);
    }

    const pseudoId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this.settings.syncedFiles[pseudoId] = {
      title: noteTitle,
      note_path: noteVaultPath,
      audio_path: audioTargetVaultPath,
      synced_at: new Date().toISOString()
    };
    await this.saveSettings();

    await this.log(`  └─ ✓ Created note: ${noteVaultPath}`);
    new Notice(`✓ Note created: "${noteTitle}"`, 5000);
    return noteVaultPath;
  }

  public async processLocalAudioInbox(): Promise<{ total: number; processed: number; errors: number }> {
    const inboxFolder = normalizePath(this.settings.localAudioFolder || "Attachments/Inbox");
    await this.ensureFolder(inboxFolder);

    const folder = this.app.vault.getAbstractFileByPath(inboxFolder);
    if (!(folder instanceof TFolder)) {
      new Notice(`Inbox folder "${inboxFolder}" not found.`, 5000);
      return { total: 0, processed: 0, errors: 0 };
    }

    const audioExtensions = new Set(["mp3", "wav", "m4a", "webm", "aac", "ogg"]);
    const audioFiles = folder.children.filter(
      (f): f is TFile => f instanceof TFile && audioExtensions.has(f.extension.toLowerCase())
    );

    if (audioFiles.length === 0) {
      new Notice(`No audio files found in "${inboxFolder}". Drop .mp3, .wav, or .m4a files there to transcribe!`, 5000);
      return { total: 0, processed: 0, errors: 0 };
    }

    new Notice(`Processing ${audioFiles.length} file(s) from ${inboxFolder}...`, 5000);
    let processed = 0;
    let errors = 0;

    for (const file of audioFiles) {
      try {
        await this.transcribeLocalAudioFile(file);
        processed++;
      } catch (err: any) {
        errors++;
        await this.log(`❌ Error processing inbox file ${file.name}: ${err.message}`);
        new Notice(`Failed to process ${file.name}: ${err.message}`, 6000);
      }
    }

    new Notice(`Inbox processing complete: ${processed} processed, ${errors} errors.`, 6000);
    return { total: audioFiles.length, processed, errors };
  }

  /**
   * Resolves default path for Plaud Desktop offline cache (%APPDATA%\ogg-cache).
   */
  public getDefaultPlaudCachePath(): string {
    if (process.platform === "win32" && process.env.APPDATA) {
      return path.join(process.env.APPDATA, "ogg-cache");
    }
    return "";
  }

  /**
   * Returns configured or default Plaud Desktop cache folder path.
   */
  public getPlaudCachePath(): string {
    const custom = (this.settings.plaudDesktopCachePath || "").trim();
    if (custom.length > 0) {
      return custom;
    }
    return this.getDefaultPlaudCachePath();
  }

  /**
   * Scans Plaud Desktop cache directory (%APPDATA%\ogg-cache or custom), copies new recordings
   * into the vault, runs transcription (Snapdragon NPU / Whisper), and generates Kepano notes.
   */
  public async importFromPlaudDesktopCache(options?: {
    force?: boolean;
    onProgress?: (current: number, total: number, fileName: string) => void;
  }): Promise<{ total: number; imported: number; skipped: number; errors: number }> {
    const cacheDir = this.getPlaudCachePath();

    if (!cacheDir || !existsSync(cacheDir)) {
      const msg = `Plaud Desktop cache directory not found:\n${cacheDir || "(path not configured)"}\n\nIf Plaud Desktop is on another computer, enter its shared network path in Settings.`;
      new Notice(msg, 7000);
      await this.log(`⚠️ Plaud Desktop cache directory not found: ${cacheDir}`);
      return { total: 0, imported: 0, skipped: 0, errors: 0 };
    }

    await this.log(`🔍 Scanning Plaud Desktop cache at: ${cacheDir}`);

    let fileNames: string[] = [];
    try {
      const dirEntries = await fsPromises.readdir(cacheDir, { withFileTypes: true });
      const validAudioExts = new Set([".ogg", ".wav", ".mp3", ".m4a", ".aac", ".webm"]);
      fileNames = dirEntries
        .filter((d) => d.isFile() && validAudioExts.has(path.extname(d.name).toLowerCase()))
        .map((d) => d.name);
    } catch (readErr: any) {
      new Notice(`Failed to read Plaud cache folder: ${readErr.message}`, 6000);
      await this.log(`❌ Failed to read Plaud cache folder: ${readErr.message}`);
      return { total: 0, imported: 0, skipped: 0, errors: 1 };
    }

    if (fileNames.length === 0) {
      new Notice(`No audio recordings found in Plaud Desktop cache (${cacheDir}).`, 5000);
      await this.log(`  └─ No audio recordings found in cache folder.`);
      return { total: 0, imported: 0, skipped: 0, errors: 0 };
    }

    const inboxFolder = normalizePath(this.settings.localAudioFolder || "Attachments/Inbox");
    await this.ensureFolder(inboxFolder);

    let imported = 0;
    let skipped = 0;
    let errors = 0;

    for (let i = 0; i < fileNames.length; i++) {
      const fileName = fileNames[i];
      const cacheKey = `plaud_cache_${fileName}`;

      // Check if already synced unless forced
      if (!options?.force && this.settings.syncedFiles[cacheKey]) {
        skipped++;
        continue;
      }

      if (options?.onProgress) {
        options.onProgress(i + 1, fileNames.length, fileName);
      }

      const fullSourcePath = path.join(cacheDir, fileName);
      await this.log(`📥 Ingesting Plaud cache recording (${i + 1}/${fileNames.length}): ${fileName}...`);
      new Notice(`Ingesting Plaud recording (${i + 1}/${fileNames.length}): ${fileName}...`, 4000);

      try {
        const fileBuffer = await fsPromises.readFile(fullSourcePath);
        const targetVaultPath = normalizePath(`${inboxFolder}/${fileName}`);

        // Write into vault
        const existingVaultFile = this.app.vault.getAbstractFileByPath(targetVaultPath);
        let vaultFile: TFile;
        if (existingVaultFile instanceof TFile) {
          await this.app.vault.modifyBinary(existingVaultFile, fileBuffer.buffer);
          vaultFile = existingVaultFile;
        } else {
          vaultFile = await this.app.vault.createBinary(targetVaultPath, fileBuffer.buffer);
        }

        // Transcribe and generate note
        const notePath = await this.transcribeLocalAudioFile(vaultFile);

        // Mark in synced registry
        this.settings.syncedFiles[cacheKey] = {
          title: vaultFile.basename,
          note_path: notePath,
          audio_path: targetVaultPath,
          synced_at: new Date().toISOString(),
        };
        await this.saveSettings();
        imported++;
      } catch (fileErr: any) {
        errors++;
        await this.log(`❌ Failed to import ${fileName}: ${fileErr.message}`);
        new Notice(`Failed to import ${fileName}: ${fileErr.message}`, 6000);
      }
    }

    const resultMsg = `Plaud Cache Import: ${imported} imported, ${skipped} already synced${errors > 0 ? `, ${errors} errors` : ""}.`;
    new Notice(resultMsg, 6000);
    await this.log(`✓ ${resultMsg}`);

    return { total: fileNames.length, imported, skipped, errors };
  }
}
