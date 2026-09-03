import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

/**
 * Encodes a Float32Array of 16,000 Hz audio samples into a standard 16-bit mono WAV Buffer.
 */
function encodeWav16kMono(samples: Float32Array): Buffer {
  const numChannels = 1;
  const sampleRate = 16000;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);

  // fmt chunk
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  buffer.writeUInt16LE(1, 20);  // AudioFormat (1 for PCM)
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  // data chunk
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Write 16-bit PCM samples
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    // Clamp sample between -1.0 and 1.0
    const s = Math.max(-1, Math.min(1, samples[i]));
    const intSample = s < 0 ? s * 0x8000 : s * 0x7fff;
    buffer.writeInt16LE(Math.round(intSample), offset);
    offset += 2;
  }

  return buffer;
}

/**
 * Converts any audio buffer (mp3, m4a, wav, aac, etc.) to a 16kHz mono WAV buffer
 * using Chromium/Electron's built-in Web Audio API.
 * Avoids any external dependency on ffmpeg.
 */
export async function convertAudioTo16kMonoWav(inputBuffer: ArrayBuffer): Promise<Buffer> {
  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioContextClass) {
    throw new Error("Web Audio API (AudioContext) is not available in this environment.");
  }

  const audioCtx = new AudioContextClass();
  let decodedBuffer: AudioBuffer;

  try {
    // decodeAudioData consumes the array buffer, so slice a copy
    decodedBuffer = await audioCtx.decodeAudioData(inputBuffer.slice(0));
  } finally {
    if (audioCtx.state !== "closed") {
      await audioCtx.close();
    }
  }

  const targetSampleRate = 16000;
  const targetLength = Math.ceil(decodedBuffer.duration * targetSampleRate);

  // Use OfflineAudioContext for high-quality C++ Sinc resampling to 16kHz mono
  const OfflineContextClass = window.OfflineAudioContext || (window as any).webkitOfflineAudioContext;
  const offlineCtx = new OfflineContextClass(1, targetLength, targetSampleRate);

  const source = offlineCtx.createBufferSource();
  source.buffer = decodedBuffer;
  source.connect(offlineCtx.destination);
  source.start(0);

  const resampledBuffer = await offlineCtx.startRendering();
  const float32Samples = resampledBuffer.getChannelData(0);

  return encodeWav16kMono(float32Samples);
}

/**
 * Decodes and resamples an audio file buffer to 16kHz mono WAV and writes it
 * to a temporary file on disk. Returns the path and a cleanup callback.
 */
export async function createTemp16kWavFile(
  inputBuffer: ArrayBuffer,
  tempDir?: string
): Promise<{ wavPath: string; cleanup: () => Promise<void> }> {
  const wavBuffer = await convertAudioTo16kMonoWav(inputBuffer);
  const dir = tempDir || os.tmpdir();
  const fileName = `plaud-whisper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`;
  const wavPath = path.join(dir, fileName);

  await fs.writeFile(wavPath, wavBuffer);

  const cleanup = async () => {
    try {
      await fs.unlink(wavPath);
    } catch {
      // Ignore cleanup error if already removed
    }
  };

  return { wavPath, cleanup };
}
