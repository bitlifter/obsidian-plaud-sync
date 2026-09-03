# Plaud Sync for Obsidian

Seamlessly synchronize your **Plaud.ai** recordings, or transcribe local audio files **100% offline** using bundled **Whisper.cpp (CPU)** or **Qualcomm QNN on Snapdragon Hexagon NPU (45 TOPS)**. Generates structured meeting notes with AI summaries, timestamped transcripts, attendee speaker resolution, and inline audio playback.

Designed from the ground up for seamless compatibility with **Kepano's Obsidian Bases** (`Meetings.base`).

![Obsidian Community Plugin](https://img.shields.io/badge/Obsidian-Community%20Plugin-7C3AED?logo=obsidian&logoColor=white)
![Snapdragon NPU](https://img.shields.io/badge/Snapdragon-Hexagon%20NPU%20(45%20TOPS)-0066FF?logo=qualcomm&logoColor=white)
![Whisper.cpp](https://img.shields.io/badge/Whisper.cpp-Offline%20STT-brightgreen)
![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)

---

## 🌟 Key Features

### ⚡ 1. Hardware-Accelerated Transcription (Snapdragon Hexagon NPU)
- **Qualcomm QNN Execution Provider**: Leverage the **45 TOPS Hexagon NPU** on Qualcomm Snapdragon X Elite and X Plus Windows 11 Copilot+ laptops.
- **Ultra-Low Power & Silent**: Transcribe lengthy meetings in seconds at `<2W` power consumption with zero fan spin and maximum battery life.
- **NPU Power Profiles**: Switch between `Burst` (fastest batch), `High Performance` (recommended), `Balanced`, and `Power Saver`.
- **Pre-Quantized ONNX Models**: 1-click download of Whisper `tiny.en`, `base.en`, `small.en`, and `turbo` ONNX models optimized for the Qualcomm HTP v79 backend.
- **Cross-Device Vault Safety**: Syncing your vault across devices? The plugin automatically detects whether it is running on ARM64 Snapdragon or Intel/AMD x64 and provides smooth fallback without crashing.

### 🎙️ 2. Bundled Whisper.cpp (100% Offline CPU Engine)
- **Zero Cloud Subscriptions Needed**: Complete privacy for sensitive meetings, patient consultations, legal depositions, and internal retrospectives.
- **Automated Engine & Model Setup**: 1-click download of official `whisper.cpp` Windows binaries and ggml models (`tiny.en`, `base.en`, `small.en`, `large-v3-turbo`) with live download progress.
- **AVX-512 / AVX2 Vector Acceleration**: Blazing fast CPU transcription (transcribes a 30-minute meeting in ~3 minutes on modern processors).
- **In-Memory Web Audio API Resampler**: Automatically decodes and converts `.mp3`, `.m4a`, `.wav`, `.aac`, `.webm`, `.ogg` in-memory to 16kHz mono WAV—**no external FFmpeg installation required**.

### 📥 3. Local Audio Inbox & File Explorer Context Menu
- **Local Audio Inbox Folder**: Drop any audio recordings into `Attachments/Inbox` and run `Process local audio inbox` to transcribe and format all pending files in batch.
- **Right-Click Context Menu**: Right-click any audio file in Obsidian's File Explorer and select **"Transcribe with Snapdragon NPU (QNN)"** or **"Transcribe with Local Whisper"**.

### 🧠 4. Flexible AI Summaries & Speaker Resolution (Local LLMs & Cloud)
- **Local LLM via Ollama / LM Studio**: Full OpenAI-compatible API support (`http://localhost:11434/v1` or `http://localhost:1234/v1`) for 100% offline note summarization, key takeaways, and action items using models like `llama3.2`, `mistral`, or `qwen2.5`.
- **Cloud LLM via Google Gemini**: High-accuracy summarization and attendee resolution using **Gemini 3.6 Flash**.
- **Offline Heuristic Fallback**: Zero-API conversational turn-taking analysis to detect vocative greetings (*"Thanks Alice"*, *"Bob here"*) and replace generic `Speaker 1` labels with real names.
- **Interactive Checkboxes**: Extracted action items are rendered as native Obsidian `- [ ]` task checkboxes.

### ☁️ 5. Seamless Plaud Cloud Sync
- **1-Click Ribbon & Command Palette Sync**: Click the microphone icon in your left sidebar or run `Plaud Sync: Sync new recordings`.
- **Master Audio Download**: Downloads original 128 kbps `.mp3` audio files into `Attachments/` and embeds an inline media player at the top of each note (`![[Attachments/<file>.mp3]]`).
- **Incremental & State-Preserving**: Only syncs new recordings and preserves your custom edits inside notes.

### 🗂️ 6. Kepano Obsidian Schema Compatibility
Generates clean YAML frontmatter and note structure tailored for Kepano's `Meetings.base`:
```markdown
---
date: 2026-09-03
time: 14:30
duration: 34m 12s
people:
  - "[[Alice Smith]]"
  - "[[Bob Johnson]]"
org:
  - "[[Acme Corp]]"
topics:
  - "Q3 Strategy"
  - "Product Roadmap"
categories:
  - "[[Meetings]]"
---
```

---

## 🚀 Quickstart

### Option A: Local Offline Mode (Whisper.cpp / Snapdragon NPU)
*No Plaud cloud account required!*

1. In Obsidian, go to **Settings** $\rightarrow$ **Plaud to Obsidian**.
2. Under **Offline Speech-to-Text**, choose your **Transcription Engine**:
   - **Snapdragon NPU (Qualcomm QNN)**: For Snapdragon X Elite/Plus laptops. Click **Download QNN Runner** and **Download QNN Model**.
   - **Local Whisper.cpp (CPU)**: For standard PCs. Click **Download Whisper Engine** and **Download Model**.
3. Under **AI Speaker & Entity Enrichment**, select your **AI Enrichment Provider**:
   - **Local LLM (Ollama / LM Studio)** for 100% offline summarization.
   - **Google Gemini** for cloud summarization.
   - **Heuristic Only** for rule-based speaker detection with zero LLM calls.
4. Place recordings in your local inbox folder (`Attachments/Inbox`) or right-click any audio file in your vault and click **Transcribe with Local Whisper / Snapdragon NPU**.

### Option B: Cloud Sync (Plaud.ai Account)
1. Authenticate with Plaud on your machine:
   ```bash
   npx -y @plaud-ai/mcp install --yes
   ```
   *(Your browser will open to authorize; tokens are securely stored in `~/.plaud/tokens-mcp.json` and automatically refreshed).*
2. In Obsidian, click the **Plaud Sync** microphone icon in the left ribbon or run:
   `Ctrl+P` / `Cmd+P` $\rightarrow$ `Plaud Sync: Sync new recordings`.

---

## ⚙️ Settings Reference

| Setting | Default | Description |
|---|---|---|
| **Transcription Engine** | `plaud_cloud` | Choose between `Plaud Cloud`, `Local Whisper.cpp (CPU)`, or `Snapdragon NPU (Qualcomm QNN)`. |
| **Local Audio Inbox Folder** | `Attachments/Inbox` | Vault folder where audio files (.mp3, .wav, .m4a) are placed for offline batch processing. |
| **Whisper Model** | `base.en` | Whisper.cpp model size (`tiny.en`, `base.en`, `small.en`, `large-v3-turbo`). |
| **Snapdragon NPU Model** | `base.en` | Pre-quantized ONNX model for Qualcomm Hexagon NPU (`tiny.en`, `base.en`, `small.en`, `turbo`). |
| **NPU Power Mode** | `high_performance` | Hexagon NPU power profile (`Burst`, `High Performance`, `Balanced`, `Power Saver`). |
| **AI Enrichment Provider** | `heuristic_only` | Choose between `Heuristic Only`, `Google Gemini`, or `Local LLM (Ollama / LM Studio)`. |
| **Local LLM Base URL** | `http://localhost:11434/v1` | OpenAI-compatible endpoint for Ollama (`/v1`) or LM Studio. |
| **Local LLM Model** | `llama3.2` | Model name loaded in Ollama or LM Studio. |
| **Gemini API Key** | Empty | Optional Google AI Studio key for Gemini 3.6 Flash summarization. |
| **Notes Folder** | `Notes` | Vault folder where meeting markdown notes are created. |
| **Audio Attachments Folder** | `Attachments` | Vault folder where master audio recordings are stored. |
| **Download Master Audio** | `true` | Save audio files and embed the native Obsidian audio player. |
| **Custom Organizations** | Empty | Comma-separated list of your company or client names to prioritize. |
| **Auto-sync on Startup** | `false` | Automatically check for and sync new recordings when Obsidian launches. |

---

## ⌨️ Command Palette

- `Plaud Sync: Sync new recordings from Plaud`
- `Plaud Sync: Force re-sync all recordings from Plaud`
- `Plaud Sync: Process local audio inbox (Whisper / Snapdragon NPU)`
- `Plaud Sync: Process local audio inbox with Snapdragon NPU (QNN)`
- `Plaud Sync: View sync log`

---

## 🔒 Privacy & Architecture

When running in **Offline Mode** with **Whisper.cpp** or **Snapdragon NPU** and **Local LLM (Ollama)**:
- **0 bytes** of audio or text leave your local machine.
- All neural network inferences execute locally on your CPU or Qualcomm Hexagon NPU.
- Audio conversion is handled directly in-memory via the Web Audio API.

---

## 📄 License & Disclaimer

This is an independent open-source community plugin. It is not affiliated with, officially maintained by, or endorsed by Plaud.ai (Nicebuild LLC), Qualcomm Incorporated, or Obsidian (Dynalist Inc.). All product names, logos, and brands are property of their respective owners.

MIT License © 2026 bitlifter
