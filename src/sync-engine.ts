import { App, Notice, normalizePath, TFile } from "obsidian";
import { PlaudApiClient } from "./plaud-api";
import { enrichMeetingData, transcribeAudioGemini } from "./enricher";
import {
  parsePlaudDate,
  formatDuration,
  formatNoteTitle,
  extractAutoSumNotes,
  generateKepanoNote,
  sanitizeFilename
} from "./extractor";
import { PlaudPluginSettings } from "./types";

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

  private async ensureFolder(folderPath: string): Promise<void> {
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

          // 4. Fallback: If Plaud never transcribed the audio, use Gemini Multimodal Audio Transcription
          let enrichedPeople: string[] = [];
          let enrichedOrganizations: string[] = [];
          let speakerMap: Record<string, string> = {};

          if (transcriptSegments.length === 0 && !summaryContent && audioBuffer && this.settings.geminiApiKey) {
            try {
              const model = this.settings.geminiModel || "gemini-3.6-flash";
              await this.log(`  └─ 🎙️ Untranscribed audio detected. Transcribing with ${model}...`);
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
}
