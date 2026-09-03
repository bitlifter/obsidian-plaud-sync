import * as path from "path";
import * as fs from "fs/promises";
import { existsSync } from "fs";
import { spawn } from "child_process";
import * as os from "os";
import { QnnModelKey, QnnPowerMode, TranscriptSegment } from "./types";
import { downloadFileWithProgress } from "./whisper-engine";

export interface SnapdragonHardwareInfo {
  isSnapdragon: boolean;
  isArm64: boolean;
  processorName: string;
  npuTops?: number;
  recommendation: string;
}

/**
 * Detects whether the current host system is a Windows on ARM64 Snapdragon PC
 * equipped with the Qualcomm Hexagon NPU.
 */
export function detectSnapdragonHardware(): SnapdragonHardwareInfo {
  const arch = process.arch;
  const envArch = process.env.PROCESSOR_ARCHITECTURE || "";
  const envArchW64 = process.env.PROCESSOR_ARCHITEW6432 || "";
  const procId = process.env.PROCESSOR_IDENTIFIER || "";

  const isArm64 =
    arch === "arm64" ||
    envArch.toLowerCase().includes("arm64") ||
    envArchW64.toLowerCase().includes("arm64");

  const procLower = procId.toLowerCase();
  const isSnapdragon =
    isArm64 &&
    (procLower.includes("qualcomm") ||
      procLower.includes("snapdragon") ||
      procLower.includes("sc8380") || // Snapdragon X Elite model SC8380XP
      procLower.includes("sc8350") ||
      procLower.includes("sc8280") ||
      procLower.includes("kryo") ||
      procLower.includes("oryon"));

  let processorName = procId || "Unknown Processor";
  let npuTops: number | undefined = undefined;

  if (isSnapdragon) {
    if (procLower.includes("sc8380") || procLower.includes("elite") || procLower.includes("oryon")) {
      processorName = "Qualcomm Snapdragon X Elite";
      npuTops = 45;
    } else if (procLower.includes("plus")) {
      processorName = "Qualcomm Snapdragon X Plus";
      npuTops = 45;
    } else {
      processorName = "Qualcomm Snapdragon";
      npuTops = 45;
    }
  } else if (!isArm64) {
    processorName = procId || "Intel/AMD Processor";
  }

  const recommendation = isSnapdragon
    ? "Qualcomm Snapdragon NPU detected! Hardware-accelerated transcription (QNN HTP v79) is supported."
    : isArm64
    ? "Windows ARM64 detected. Native ARM64 execution supported."
    : "Intel/AMD x64 detected. whisper.cpp CPU execution is recommended on this device.";

  return {
    isSnapdragon,
    isArm64,
    processorName,
    npuTops,
    recommendation,
  };
}

export interface QnnModelInfo {
  id: QnnModelKey;
  name: string;
  folderName: string;
  encoderName: string;
  decoderName: string;
  tokensName: string;
  sizeMb: number;
  url: string;
}

export const QNN_MODELS: Record<QnnModelKey, QnnModelInfo> = {
  "tiny.en": {
    id: "tiny.en",
    name: "Whisper Tiny English (~113 MB ONNX - Ultra Fast)",
    folderName: "sherpa-onnx-whisper-tiny.en",
    encoderName: "tiny.en-encoder.onnx",
    decoderName: "tiny.en-decoder.onnx",
    tokensName: "tiny.en-tokens.txt",
    sizeMb: 113,
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.en.tar.bz2",
  },
  "base.en": {
    id: "base.en",
    name: "Whisper Base English (~199 MB ONNX - Recommended)",
    folderName: "sherpa-onnx-whisper-base.en",
    encoderName: "base.en-encoder.onnx",
    decoderName: "base.en-decoder.onnx",
    tokensName: "base.en-tokens.txt",
    sizeMb: 199,
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-base.en.tar.bz2",
  },
  "small.en": {
    id: "small.en",
    name: "Whisper Small English (~606 MB ONNX - High Accuracy)",
    folderName: "sherpa-onnx-whisper-small.en",
    encoderName: "small.en-encoder.onnx",
    decoderName: "small.en-decoder.onnx",
    tokensName: "small.en-tokens.txt",
    sizeMb: 606,
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-small.en.tar.bz2",
  },
  turbo: {
    id: "turbo",
    name: "Whisper Turbo (~538 MB ONNX - SOTA Precision)",
    folderName: "sherpa-onnx-whisper-turbo",
    encoderName: "turbo-encoder.onnx",
    decoderName: "turbo-decoder.onnx",
    tokensName: "turbo-tokens.txt",
    sizeMb: 538,
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-turbo.tar.bz2",
  },
};

export const QNN_RUNNER_RELEASES = {
  arm64: {
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.7/sherpa-onnx-v1.13.7-win-arm64-shared-MT-Release.tar.bz2",
    archiveName: "sherpa-onnx-win-arm64.tar.bz2",
  },
  x64: {
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.7/sherpa-onnx-v1.13.7-win-x64-shared-MT-Release.tar.bz2",
    archiveName: "sherpa-onnx-win-x64.tar.bz2",
  },
};

/**
 * Returns the directories for QNN binaries and models inside the plugin folder.
 */
export function getQnnDirs(pluginManifestDir: string): {
  binDir: string;
  modelsDir: string;
} {
  return {
    binDir: path.join(pluginManifestDir, "bin", "qnn"),
    modelsDir: path.join(pluginManifestDir, "models", "qnn"),
  };
}

/**
 * Checks if the QNN / ONNX runner executable exists.
 */
export function checkQnnBinary(
  pluginManifestDir: string,
  customPath?: string
): { path: string; exists: boolean } {
  if (customPath && customPath.trim().length > 0) {
    const p = customPath.trim();
    return { path: p, exists: existsSync(p) };
  }

  const { binDir } = getQnnDirs(pluginManifestDir);
  const candidates = [
    path.join(binDir, "sherpa-onnx-offline.exe"),
    path.join(binDir, "bin", "sherpa-onnx-offline.exe"),
    path.join(binDir, "Release", "sherpa-onnx-offline.exe"),
    path.join(binDir, "sherpa-onnx-offline-speech-recognition.exe"),
    path.join(binDir, "sherpa-onnx-offline"),
    path.join(binDir, "bin", "sherpa-onnx-offline"),
  ];

  for (const c of candidates) {
    if (existsSync(c)) {
      return { path: c, exists: true };
    }
  }

  return { path: path.join(binDir, "sherpa-onnx-offline.exe"), exists: false };
}

/**
 * Checks if a specific QNN Whisper model (encoder, decoder, tokens) exists.
 */
export function checkQnnModel(
  modelKey: QnnModelKey,
  pluginManifestDir: string,
  customModelDir?: string
): {
  dir: string;
  encoderPath: string;
  decoderPath: string;
  tokensPath: string;
  exists: boolean;
} {
  const info = QNN_MODELS[modelKey] || QNN_MODELS["base.en"];
  const { modelsDir } = getQnnDirs(pluginManifestDir);
  const targetDir = customModelDir && customModelDir.trim().length > 0
    ? customModelDir.trim()
    : path.join(modelsDir, info.folderName);

  const encoderPath = path.join(targetDir, info.encoderName);
  const decoderPath = path.join(targetDir, info.decoderName);
  const tokensPath = path.join(targetDir, info.tokensName);

  const exists =
    existsSync(encoderPath) && existsSync(decoderPath) && existsSync(tokensPath);

  return {
    dir: targetDir,
    encoderPath,
    decoderPath,
    tokensPath,
    exists,
  };
}

/**
 * Downloads and installs the native QNN/ONNX speech recognition runner into plugin/bin/qnn/
 */
export async function downloadAndInstallQnnRunner(
  pluginManifestDir: string,
  onProgress?: (message: string, percent?: number) => void
): Promise<string> {
  const { binDir } = getQnnDirs(pluginManifestDir);
  await fs.mkdir(binDir, { recursive: true });

  const isArm64 = process.arch === "arm64" || (process.env.PROCESSOR_ARCHITECTURE || "").toLowerCase().includes("arm64");
  const asset = isArm64 ? QNN_RUNNER_RELEASES.arm64 : QNN_RUNNER_RELEASES.x64;

  const tempArchive = path.join(os.tmpdir(), `qnn-runner-${Date.now()}.tar.bz2`);

  if (onProgress) onProgress("Downloading QNN/ONNX runner binary...", 10);
  await downloadFileWithProgress(asset.url, tempArchive, (pct) => {
    if (onProgress) onProgress(`Downloading QNN runner (${pct}%)...`, pct);
  });

  if (onProgress) onProgress("Extracting runner binaries...", 90);

  // Extract using Windows built-in tar (bsdtar handles tar.bz2 natively)
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xf", tempArchive, "-C", binDir], {
      windowsHide: true,
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Extraction failed with exit code ${code}`));
    });
    child.on("error", (err) => reject(err));
  });

  // Clean up archive
  await fs.unlink(tempArchive).catch(() => {});

  // If contents extracted into a single subdirectory, promote them
  try {
    const entries = await fs.readdir(binDir, { withFileTypes: true });
    const subdirs = entries.filter((e) => e.isDirectory());
    for (const sub of subdirs) {
      const subPath = path.join(binDir, sub.name);
      const subEntries = await fs.readdir(subPath);
      for (const item of subEntries) {
        const src = path.join(subPath, item);
        const dest = path.join(binDir, item);
        if (!existsSync(dest)) {
          await fs.cp(src, dest, { recursive: true });
        }
      }
    }
  } catch {}

  const binInfo = checkQnnBinary(pluginManifestDir);
  if (!binInfo.exists) {
    throw new Error(`Runner extracted, but executable was not found in: ${binDir}`);
  }

  if (onProgress) onProgress("QNN runner installed successfully!", 100);
  return binInfo.path;
}

/**
 * Downloads and extracts an ONNX Whisper model package into plugin/models/qnn/
 */
export async function downloadQnnModel(
  modelKey: QnnModelKey,
  pluginManifestDir: string,
  onProgress?: (percent: number, loadedBytes: number, totalBytes: number) => void
): Promise<string> {
  const info = QNN_MODELS[modelKey];
  if (!info) {
    throw new Error(`Unknown QNN model key: ${modelKey}`);
  }

  const { modelsDir } = getQnnDirs(pluginManifestDir);
  await fs.mkdir(modelsDir, { recursive: true });

  const tempArchive = path.join(os.tmpdir(), `qnn-model-${Date.now()}.tar.bz2`);
  await downloadFileWithProgress(info.url, tempArchive, onProgress);

  // Extract model archive
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xf", tempArchive, "-C", modelsDir], {
      windowsHide: true,
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Model extraction failed with exit code ${code}`));
    });
    child.on("error", (err) => reject(err));
  });

  await fs.unlink(tempArchive).catch(() => {});

  const modelInfo = checkQnnModel(modelKey, pluginManifestDir);
  return modelInfo.dir;
}

export interface QnnTranscriptionOptions {
  binaryPath: string;
  modelDir: string;
  audioWavPath: string;
  language?: string;
  powerMode?: QnnPowerMode;
  customBackendPath?: string;
  onProgressNotice?: (msg: string) => void;
}

/**
 * Runs hardware-accelerated transcription using the Qualcomm QNN / ONNX execution provider.
 */
export async function runQnnTranscription(
  options: QnnTranscriptionOptions
): Promise<TranscriptSegment[]> {
  const { binaryPath, modelDir, audioWavPath } = options;

  if (!existsSync(binaryPath)) {
    throw new Error(`QNN Runner executable not found at: ${binaryPath}`);
  }
  if (!existsSync(audioWavPath)) {
    throw new Error(`Audio file not found at: ${audioWavPath}`);
  }

  // Find encoder, decoder, tokens in modelDir
  const files = await fs.readdir(modelDir);
  const encoderFile = files.find((f) => f.includes("encoder") && f.endsWith(".onnx"));
  const decoderFile = files.find((f) => f.includes("decoder") && f.endsWith(".onnx"));
  const tokensFile = files.find((f) => f.includes("tokens") && f.endsWith(".txt"));

  if (!encoderFile || !decoderFile || !tokensFile) {
    throw new Error(
      `Incomplete ONNX model in ${modelDir}. Missing encoder, decoder, or tokens file.`
    );
  }

  const encoderPath = path.join(modelDir, encoderFile);
  const decoderPath = path.join(modelDir, decoderFile);
  const tokensPath = path.join(modelDir, tokensFile);

  const hw = detectSnapdragonHardware();
  // Provider: QNN on Snapdragon ARM64, DirectML or CPU on x64
  const provider = hw.isSnapdragon ? "qnn" : "directml";

  const args: string[] = [
    `--whisper-encoder=${encoderPath}`,
    `--whisper-decoder=${decoderPath}`,
    `--tokens=${tokensPath}`,
    `--whisper-language=${options.language || "en"}`,
    `--whisper-task=transcribe`,
    `--provider=${provider}`,
    `--num-threads=4`,
  ];

  if (options.customBackendPath && existsSync(options.customBackendPath)) {
    args.push(`--whisper.qnn-backend-lib=${options.customBackendPath}`);
  }

  args.push(audioWavPath);

  return new Promise<TranscriptSegment[]>((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    const proc = spawn(binaryPath, args, {
      windowsHide: true,
      cwd: path.dirname(binaryPath),
    });

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to start QNN runner (${binaryPath}): ${err.message}`));
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `QNN execution failed (code ${code}): ${stderr.trim() || stdout.trim()}`
          )
        );
        return;
      }

      const text = stdout.trim();
      if (!text) {
        resolve([]);
        return;
      }

      // Try parsing JSON output if sherpa-onnx output formatted JSON
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          resolve(
            parsed.map((p, idx) => ({
              speaker: p.speaker || `Speaker ${idx + 1}`,
              startTime: p.start || p.startTime || 0,
              endTime: p.end || p.endTime || 0,
              content: p.text || p.content || "",
            }))
          );
          return;
        }
      } catch {}

      // Parse line-by-line timestamp format:
      // [00:00:01.000 --> 00:00:04.000] Hello world
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
      const segments: TranscriptSegment[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const tsMatch = line.match(
          /\[?(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*(?:-->|--)\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\]?\s*(.*)/
        );
        if (tsMatch) {
          const startMs =
            parseInt(tsMatch[1], 10) * 3600000 +
            parseInt(tsMatch[2], 10) * 60000 +
            parseInt(tsMatch[3], 10) * 1000 +
            parseInt(tsMatch[4], 10);
          const endMs =
            parseInt(tsMatch[5], 10) * 3600000 +
            parseInt(tsMatch[6], 10) * 60000 +
            parseInt(tsMatch[7], 10) * 1000 +
            parseInt(tsMatch[8], 10);
          const content = tsMatch[9].trim();
          if (content) {
            segments.push({
              speaker: "Speaker 1",
              startTime: startMs,
              endTime: endMs,
              content,
            });
          }
        } else if (
          line.length > 0 &&
          !line.startsWith("{") &&
          !line.startsWith("Loading")
        ) {
          segments.push({
            speaker: "Speaker 1",
            startTime: i * 3000,
            endTime: (i + 1) * 3000,
            content: line,
          });
        }
      }

      if (segments.length === 0 && text.length > 0) {
        segments.push({
          speaker: "Speaker 1",
          startTime: 0,
          endTime: 0,
          content: text,
        });
      }

      resolve(segments);
    });
  });
}
