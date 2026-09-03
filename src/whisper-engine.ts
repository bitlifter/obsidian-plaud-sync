import { spawn } from "child_process";
import * as fs from "fs/promises";
import { existsSync, createWriteStream } from "fs";
import * as path from "path";
import * as os from "os";
import { TranscriptSegment } from "./types";

export interface WhisperModelInfo {
  id: string;
  name: string;
  fileName: string;
  sizeMb: number;
  url: string;
}

export const WHISPER_MODELS: Record<string, WhisperModelInfo> = {
  "tiny.en": {
    id: "tiny.en",
    name: "Tiny English (~75 MB - Ultra Fast)",
    fileName: "ggml-tiny.en.bin",
    sizeMb: 75,
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin",
  },
  "base.en": {
    id: "base.en",
    name: "Base English (~142 MB - Balanced)",
    fileName: "ggml-base.en.bin",
    sizeMb: 142,
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
  },
  "small.en": {
    id: "small.en",
    name: "Small English (~466 MB - High Accuracy)",
    fileName: "ggml-small.en.bin",
    sizeMb: 466,
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin",
  },
  "large-v3-turbo": {
    id: "large-v3-turbo",
    name: "Large v3 Turbo (~1.6 GB - SOTA Precision)",
    fileName: "ggml-large-v3-turbo.bin",
    sizeMb: 1600,
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
  },
};

export const WHISPER_RELEASE_ZIP =
  "https://github.com/ggml-org/whisper.cpp/releases/latest/download/whisper-bin-x64.zip";

/**
 * Downloads a file from URL to destPath with a progress callback.
 */
export async function downloadFileWithProgress(
  url: string,
  destPath: string,
  onProgress?: (percent: number, loadedBytes: number, totalBytes: number) => void
): Promise<void> {
  await fs.mkdir(path.dirname(destPath), { recursive: true });

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download from ${url}: HTTP ${res.status} ${res.statusText}`);
  }

  const contentLength = res.headers.get("content-length");
  const total = contentLength ? parseInt(contentLength, 10) : 0;
  let loaded = 0;

  if (!res.body) {
    throw new Error("Response body is null");
  }

  const reader = res.body.getReader();
  const fileHandle = await fs.open(destPath, "w");

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        await fileHandle.write(value);
        loaded += value.length;
        if (total > 0 && onProgress) {
          const percent = Math.min(100, Math.round((loaded / total) * 100));
          onProgress(percent, loaded, total);
        }
      }
    }
  } finally {
    await fileHandle.close();
  }
}

/**
 * Resolves the directory where the plugin's native binaries and models reside.
 */
export function getPluginDirs(pluginManifestDir: string): {
  binDir: string;
  modelsDir: string;
} {
  return {
    binDir: path.join(pluginManifestDir, "bin"),
    modelsDir: path.join(pluginManifestDir, "models"),
  };
}

/**
 * Checks if the whisper executable exists.
 */
export function checkWhisperBinary(pluginManifestDir: string, customPath?: string): {
  path: string;
  exists: boolean;
} {
  if (customPath && customPath.trim().length > 0) {
    return { path: customPath.trim(), exists: existsSync(customPath.trim()) };
  }

  const { binDir } = getPluginDirs(pluginManifestDir);
  const candidates = [
    path.join(binDir, "whisper-cli.exe"),
    path.join(binDir, "Release", "whisper-cli.exe"),
    path.join(binDir, "main.exe"),
    path.join(binDir, "Release", "main.exe"),
    path.join(binDir, "whisper-cli"),
    path.join(binDir, "Release", "whisper-cli"),
    path.join(binDir, "main")
  ];

  for (const c of candidates) {
    if (existsSync(c)) {
      return { path: c, exists: true };
    }
  }

  return { path: path.join(binDir, "whisper-cli.exe"), exists: false };
}

/**
 * Checks if a specific model file exists.
 */
export function checkWhisperModel(
  modelKey: string,
  pluginManifestDir: string,
  customPath?: string
): {
  path: string;
  exists: boolean;
} {
  if (customPath && customPath.trim().length > 0) {
    return { path: customPath.trim(), exists: existsSync(customPath.trim()) };
  }

  const info = WHISPER_MODELS[modelKey] || WHISPER_MODELS["base.en"];
  const { modelsDir } = getPluginDirs(pluginManifestDir);
  const targetPath = path.join(modelsDir, info.fileName);

  return { path: targetPath, exists: existsSync(targetPath) };
}

/**
 * Downloads and extracts the official whisper.cpp Windows binaries into plugin/bin/
 */
export async function downloadAndInstallWhisperEngine(
  pluginManifestDir: string,
  onProgress?: (message: string, percent?: number) => void
): Promise<string> {
  const { binDir } = getPluginDirs(pluginManifestDir);
  await fs.mkdir(binDir, { recursive: true });

  const tempZip = path.join(os.tmpdir(), `whisper-bin-${Date.now()}.zip`);

  if (onProgress) onProgress("Downloading whisper.cpp binaries...", 10);
  await downloadFileWithProgress(WHISPER_RELEASE_ZIP, tempZip, (pct) => {
    if (onProgress) onProgress(`Downloading whisper.cpp binaries (${pct}%)...`, pct);
  });

  if (onProgress) onProgress("Extracting binaries...", 95);

  // Extract using Windows built-in tar or PowerShell Expand-Archive
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xf", tempZip, "-C", binDir], { windowsHide: true });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else {
        // Fallback to PowerShell Expand-Archive
        const ps = spawn(
          "powershell.exe",
          ["-NoProfile", "-Command", `Expand-Archive -Path '${tempZip}' -DestinationPath '${binDir}' -Force`],
          { windowsHide: true }
        );
        ps.on("close", (psCode) => {
          if (psCode === 0) resolve();
          else reject(new Error(`Failed to extract whisper zip (code ${psCode})`));
        });
        ps.on("error", (err) => reject(err));
      }
    });
    child.on("error", () => {
      // Fallback if tar command not found
      const ps = spawn(
        "powershell.exe",
        ["-NoProfile", "-Command", `Expand-Archive -Path '${tempZip}' -DestinationPath '${binDir}' -Force`],
        { windowsHide: true }
      );
      ps.on("close", (psCode) => {
        if (psCode === 0) resolve();
        else reject(new Error(`Failed to extract whisper zip (code ${psCode})`));
      });
      ps.on("error", (err) => reject(err));
    });
  });

  // Clean up temp zip
  try {
    await fs.unlink(tempZip);
  } catch {
    // Ignore
  }

  // If extracted into Release subdirectory, promote files to binDir
  const releaseSubdir = path.join(binDir, "Release");
  if (existsSync(releaseSubdir)) {
    try {
      const items = await fs.readdir(releaseSubdir);
      for (const item of items) {
        const src = path.join(releaseSubdir, item);
        const dest = path.join(binDir, item);
        await fs.copyFile(src, dest);
      }
    } catch {}
  }

  const binaryInfo = checkWhisperBinary(pluginManifestDir);
  if (!binaryInfo.exists) {
    throw new Error(`Extraction finished, but whisper executable was not found in ${binDir}`);
  }

  if (onProgress) onProgress("Whisper engine installed successfully!", 100);
  return binaryInfo.path;
}

/**
 * Downloads a whisper GGML model file from Hugging Face into plugin/models/
 */
export async function downloadWhisperModel(
  modelKey: string,
  pluginManifestDir: string,
  onProgress?: (percent: number, loadedBytes: number, totalBytes: number) => void
): Promise<string> {
  const info = WHISPER_MODELS[modelKey];
  if (!info) {
    throw new Error(`Unknown model key: ${modelKey}. Valid options: ${Object.keys(WHISPER_MODELS).join(", ")}`);
  }

  const { modelsDir } = getPluginDirs(pluginManifestDir);
  const targetPath = path.join(modelsDir, info.fileName);

  await downloadFileWithProgress(info.url, targetPath, onProgress);
  return targetPath;
}

/**
 * Runs whisper-cli.exe on a 16kHz mono WAV file and extracts timestamped segments.
 */
export async function runWhisperCli(options: {
  binaryPath: string;
  modelPath: string;
  wavPath: string;
  threads?: number;
  language?: string;
}): Promise<TranscriptSegment[]> {
  const { binaryPath, modelPath, wavPath } = options;
  const threads = options.threads || Math.max(1, Math.min(8, os.cpus().length - 1));
  const language = options.language || "en";

  if (!existsSync(binaryPath)) {
    throw new Error(`Whisper binary not found at: ${binaryPath}`);
  }
  if (!existsSync(modelPath)) {
    throw new Error(`Whisper model not found at: ${modelPath}`);
  }
  if (!existsSync(wavPath)) {
    throw new Error(`Audio WAV file not found at: ${wavPath}`);
  }

  const outputPrefix = path.join(os.tmpdir(), `whisper-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const expectedJsonFile = `${outputPrefix}.json`;

  const args = [
    "-m", modelPath,
    "-f", wavPath,
    "-oj",
    "-of", outputPrefix,
    "-l", language,
    "--threads", String(threads),
    "-np" // No prints to keep output clean
  ];

  return new Promise<TranscriptSegment[]>((resolve, reject) => {
    let stderr = "";
    let stdout = "";

    const proc = spawn(binaryPath, args, {
      windowsHide: true,
      cwd: path.dirname(binaryPath)
    });

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn whisper binary (${binaryPath}): ${err.message}`));
    });

    proc.on("close", async (code) => {
      if (code !== 0) {
        reject(new Error(`Whisper process failed with exit code ${code}: ${stderr || stdout}`));
        return;
      }

      try {
        if (!existsSync(expectedJsonFile)) {
          // If JSON file wasn't created, check stdout for fallback text
          if (stdout.trim().length > 0) {
            resolve([{
              speaker: "Speaker 1",
              startTime: 0,
              endTime: 0,
              content: stdout.trim()
            }]);
            return;
          }
          reject(new Error(`Whisper completed but did not produce expected output file: ${expectedJsonFile}`));
          return;
        }

        const dataRaw = await fs.readFile(expectedJsonFile, "utf-8");
        const parsed = JSON.parse(dataRaw);
        const transcriptItems = parsed.transcription || [];

        const segments: TranscriptSegment[] = transcriptItems
          .map((item: any, idx: number) => {
            let start = 0;
            let end = 0;
            if (item.offsets) {
              start = Math.round((item.offsets.from || 0) / 1000);
              end = Math.round((item.offsets.to || 0) / 1000);
            }
            return {
              speaker: `Speaker 1`,
              startTime: start,
              endTime: end,
              content: (item.text || "").trim(),
            };
          })
          .filter((seg: TranscriptSegment) => seg.content.length > 0);

        // Clean up temporary JSON file
        try {
          await fs.unlink(expectedJsonFile);
        } catch {
          // Ignore
        }

        resolve(segments);
      } catch (parseErr: any) {
        reject(new Error(`Failed to parse whisper JSON output: ${parseErr.message}`));
      }
    });
  });
}
