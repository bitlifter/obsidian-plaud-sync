import * as path from "path";
import * as fs from "fs/promises";
import { existsSync, readdirSync } from "fs";
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
 * Resolves the tar executable on Windows, checking System32 first.
 */
function getTarCommand(): string {
  if (process.platform === "win32") {
    const sysTar = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "tar.exe"
    );
    if (existsSync(sysTar)) return sysTar;
    return "tar.exe";
  }
  return "tar";
}

/**
 * Recursively locates any .exe and .dll files in sourceDir and copies them into destDir.
 */
async function copyBinariesToRoot(sourceDir: string, destDir: string): Promise<void> {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(sourceDir, entry.name);
    if (entry.isDirectory()) {
      await copyBinariesToRoot(fullPath, destDir);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === ".exe" || ext === ".dll" || !path.extname(entry.name)) {
        const target = path.join(destDir, entry.name);
        if (fullPath !== target) {
          await fs.copyFile(fullPath, target).catch(() => {});
        }
      }
    }
  }
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

  // Check if any subdirectories contain sherpa-onnx-offline.exe
  if (existsSync(binDir)) {
    try {
      const entries = readdirSync(binDir);
      for (const entry of entries) {
        const subExe = path.join(binDir, entry, "bin", "sherpa-onnx-offline.exe");
        if (existsSync(subExe)) return { path: subExe, exists: true };
        const directExe = path.join(binDir, entry, "sherpa-onnx-offline.exe");
        if (existsSync(directExe)) return { path: directExe, exists: true };
      }
    } catch {}
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

  let encoderPath = path.join(targetDir, info.encoderName);
  let decoderPath = path.join(targetDir, info.decoderName);
  let tokensPath = path.join(targetDir, info.tokensName);

  let exists =
    existsSync(encoderPath) && existsSync(decoderPath) && existsSync(tokensPath);

  // If not found in targetDir, check modelsDir root
  if (!exists) {
    const rootEncoder = path.join(modelsDir, info.encoderName);
    const rootDecoder = path.join(modelsDir, info.decoderName);
    const rootTokens = path.join(modelsDir, info.tokensName);
    if (existsSync(rootEncoder) && existsSync(rootDecoder) && existsSync(rootTokens)) {
      return {
        dir: modelsDir,
        encoderPath: rootEncoder,
        decoderPath: rootDecoder,
        tokensPath: rootTokens,
        exists: true,
      };
    }
  }

  // If still not found, check if files exist with generic names in targetDir
  if (!exists && existsSync(targetDir)) {
    try {
      const files = readdirSync(targetDir);
      const enc = files.find((f) => f.includes("encoder") && f.endsWith(".onnx"));
      const dec = files.find((f) => f.includes("decoder") && f.endsWith(".onnx"));
      const tok = files.find((f) => f.includes("tokens") && f.endsWith(".txt"));
      if (enc && dec && tok) {
        return {
          dir: targetDir,
          encoderPath: path.join(targetDir, enc),
          decoderPath: path.join(targetDir, dec),
          tokensPath: path.join(targetDir, tok),
          exists: true,
        };
      }
    } catch {}
  }

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

  if (onProgress) onProgress("Connecting to download QNN runner...", 5);
  await downloadFileWithProgress(asset.url, tempArchive, (pct) => {
    if (onProgress) onProgress(`Downloading QNN runner (${pct}%)...`, pct);
  });

  if (onProgress) onProgress("Extracting runner binaries...", 95);

  const tarExe = getTarCommand();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(tarExe, ["-xf", tempArchive, "-C", binDir], {
      windowsHide: true,
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Runner extraction failed with exit code ${code}`));
    });
    child.on("error", (err) => reject(new Error(`Failed to execute tar: ${err.message}`)));
  });

  // Clean up archive
  await fs.unlink(tempArchive).catch(() => {});

  // Copy all binaries and DLLs recursively into binDir root so DLLs resolve automatically
  try {
    await copyBinariesToRoot(binDir, binDir);
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

  const tarExe = getTarCommand();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(tarExe, ["-xf", tempArchive, "-C", modelsDir], {
      windowsHide: true,
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Model extraction failed with exit code ${code}`));
    });
    child.on("error", (err) => reject(new Error(`Failed to execute tar: ${err.message}`)));
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

interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runSherpaProcess(
  binaryPath: string,
  args: string[]
): Promise<ProcessResult> {
  return new Promise((resolve) => {
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
      resolve({ stdout, stderr: err.message, code: -1 });
    });

    proc.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 0 });
    });
  });
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
  const encoderFile =
    files.find((f) => f.includes("encoder") && f.endsWith(".int8.onnx")) ||
    files.find((f) => f.includes("encoder") && f.endsWith(".onnx"));
  const decoderFile =
    files.find((f) => f.includes("decoder") && f.endsWith(".int8.onnx")) ||
    files.find((f) => f.includes("decoder") && f.endsWith(".onnx"));
  const tokensFile = files.find((f) => f.includes("tokens") && f.endsWith(".txt"));

  if (!encoderFile || !decoderFile || !tokensFile) {
    throw new Error(
      `Incomplete ONNX model in ${modelDir}. Missing encoder, decoder, or tokens file.`
    );
  }

  const encoderPath = path.join(modelDir, encoderFile);
  const decoderPath = path.join(modelDir, decoderFile);
  const tokensPath = path.join(modelDir, tokensFile);

  const numThreads = Math.max(1, Math.min(8, os.cpus().length > 4 ? 6 : 4));

  const baseArgs: string[] = [
    `--whisper-encoder=${encoderPath}`,
    `--whisper-decoder=${decoderPath}`,
    `--tokens=${tokensPath}`,
    `--whisper-language=${options.language || "en"}`,
    `--whisper-task=transcribe`,
    `--whisper-enable-segment-timestamps=true`,
    `--num-threads=${numThreads}`,
  ];

  const hasCustomQnn = Boolean(options.customBackendPath && existsSync(options.customBackendPath));
  // Provider strategy:
  // Prebuilt sherpa-onnx releases use ONNX Runtime's CPU execution provider by default,
  // which leverages native 64-bit ARM Neon vector SIMD and KleidiAI kernels on Snapdragon Windows ARM64.
  // The 'qnn' provider option in sherpa-onnx requires custom compilation with the proprietary Qualcomm QNN SDK.
  // If the user provided a custom Qualcomm backend path, we attempt 'qnn' first.
  // Otherwise, or if 'qnn' exits with failure, we run with 'cpu'.
  let provider = hasCustomQnn ? "qnn" : "cpu";

  let runArgs = [...baseArgs, `--provider=${provider}`];
  if (provider === "qnn" && options.customBackendPath) {
    runArgs.push(`--whisper.qnn-backend-lib=${options.customBackendPath}`);
  }
  runArgs.push(audioWavPath);

  let result = await runSherpaProcess(binaryPath, runArgs);

  // If QNN failed (e.g. exit code -1 / 4294967295 due to missing compiled QNN EP),
  // fall back immediately to native ARM64 CPU/Neon provider
  if (result.code !== 0 && provider === "qnn") {
    console.warn(
      `[Plaud Sync] QNN provider execution failed (code ${result.code}), falling back to native CPU/Neon execution provider.`
    );
    provider = "cpu";
    runArgs = [...baseArgs, `--provider=cpu`, audioWavPath];
    result = await runSherpaProcess(binaryPath, runArgs);
  }

  if (result.code !== 0) {
    // Extract meaningful error lines rather than dumping the full config struct
    const errLines = result.stderr
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(
        (l) =>
          l &&
          (l.toLowerCase().includes("error") ||
            l.toLowerCase().includes("failed") ||
            l.toLowerCase().includes("please rebuild") ||
            l.toLowerCase().includes("not exist") ||
            l.toLowerCase().includes("invalid"))
      );
    const detail =
      errLines.length > 0
        ? errLines.join("; ")
        : (result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`);

    throw new Error(`Speech engine failed (code ${result.code}): ${detail}`);
  }

  const text = result.stdout.trim();
  if (!text) {
    return [];
  }

  // 1. Try parsing JSON output from sherpa-onnx (OfflineRecognitionResult::AsJsonString)
  try {
    const jsonMatch = text.match(/\{[\s\S]*"text"[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(text);

    if (parsed && typeof parsed === "object") {
      // Check if Whisper segment timestamps are available
      if (
        Array.isArray(parsed.segment_timestamps) &&
        Array.isArray(parsed.segment_texts) &&
        parsed.segment_timestamps.length > 0
      ) {
        const segments: TranscriptSegment[] = [];
        for (let i = 0; i < parsed.segment_timestamps.length; i++) {
          const startSec = Number(parsed.segment_timestamps[i]) || 0;
          const durSec = Number(parsed.segment_durations?.[i]) || 0;
          const content = String(parsed.segment_texts[i] || "").trim();
          if (content) {
            segments.push({
              speaker: "Speaker 1",
              startTime: Math.round(startSec * 1000),
              endTime: Math.round((startSec + durSec) * 1000),
              content,
            });
          }
        }
        if (segments.length > 0) {
          return segments;
        }
      }

      // Check if array format (custom runner wrapper)
      if (Array.isArray(parsed)) {
        return parsed.map((p, idx) => ({
          speaker: p.speaker || `Speaker ${idx + 1}`,
          startTime: p.start || p.startTime || 0,
          endTime: p.end || p.endTime || 0,
          content: p.text || p.content || "",
        }));
      }

      // If text string is present in JSON object
      if (typeof parsed.text === "string" && parsed.text.trim()) {
        return [
          {
            speaker: "Speaker 1",
            startTime: 0,
            endTime: 0,
            content: parsed.text.trim(),
          },
        ];
      }
    }
  } catch {}

  // 2. Parse line-by-line timestamp format:
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
      !line.startsWith("Loading") &&
      !line.startsWith("Done!") &&
      !line.startsWith("Started")
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

  return segments;
}
