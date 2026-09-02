# Plaud Sync for Obsidian

Seamlessly synchronize your **Plaud.ai** recordings, AI summaries, timestamped transcripts, original audio playback, and attendee speaker identities directly into your Obsidian vault.

Designed from the ground up for seamless compatibility with **Kepano's Obsidian Bases** (`Meetings.base`).

![Obsidian Community Plugin](https://img.shields.io/badge/Obsidian-Community%20Plugin-7C3AED?logo=obsidian&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)

---

## Features

- 🎙️ **1-Click Ribbon & Command Sync**: Sync instantly via the microphone icon in your Obsidian sidebar ribbon or via `Ctrl+P` / `Cmd+P` $\rightarrow$ `Plaud Sync: Sync new recordings`.
- 🎵 **Master Audio Embed**: Automatically downloads original 128 kbps `.mp3` audio files into `Attachments/` and embeds an inline media player at the top of each note (`![[Attachments/<file>.mp3]]`).
- 👥 **Cascade AI Speaker & Entity Resolution**:
  - **Tier 1 (Offline Heuristics)**: Uses conversational turn-taking, vocative addresses (*"Thanks Alice"*, *"Bob here"*), and structural cues to map generic `Speaker 1` labels to real attendee names with zero API cost.
  - **Tier 2 (Cloud LLM Fallback)**: Automatically falls back to **Google Gemini 3.6 Flash** when confidence is low or when forced in settings.
  - **In-Content Replacement**: Replaces raw `Speaker 1` / `@Speaker 2` references throughout note summaries, action item lists, and transcripts.
  - **Dynamic Entity Learning**: Automatically recognizes and persists organizations discussed across your meetings into local storage without hardcoding.
- 🗂️ **Kepano Obsidian Schema**: Generates frontmatter fully compatible with `Meetings.base`, automatically populating `date`, `time`, `duration`, `people`, `org`, `topics`, and `categories: ["[[Meetings]]"]`.
- 💬 **Collapsible Transcripts**: Neatly folds timestamped verbatim transcripts with identified speaker names into native Obsidian callouts (`> [!quote]- Full Transcript (34m 47s)`).
- ⚡ **Incremental & State-Preserving**: Only syncs new recordings and preserves your custom edits inside notes.

---

## Quickstart

### 1. Authenticate with Plaud
If you haven't already authenticated your Plaud account on your computer, run:
```bash
npx -y @plaud-ai/mcp install --yes
```
*(Your browser will open asking you to authorize; tokens are securely stored in `~/.plaud/tokens-mcp.json` and automatically refreshed).*

### 2. Install the Plugin
#### From Community Plugins (Once Approved)
1. In Obsidian, open **Settings** $\rightarrow$ **Community Plugins**.
2. Turn on Community Plugins.
3. Search for **Plaud Sync** and click **Install**, then **Enable**.

#### Manual Installation
1. Download `main.js`, `manifest.json`, and `styles.css` from the latest [GitHub Release](https://github.com/bitlifter/obsidian-plaud-sync/releases).
2. Create a folder named `plaud-sync` inside your vault's `.obsidian/plugins/` directory:
   `<Your-Vault>/.obsidian/plugins/plaud-sync/`
3. Copy `main.js`, `manifest.json`, and `styles.css` into that directory.
4. Reload Obsidian and enable **Plaud Sync** in Community Plugins.

---

## Configuration

In Obsidian, go to **Settings** $\rightarrow$ **Plaud Sync**:

| Setting | Default | Description |
|---|---|---|
| **Plaud Account Status** | Auto | Displays connection state from `~/.plaud/tokens-mcp.json`. |
| **Notes Folder** | `Notes` | Vault folder where meeting markdown notes are created. |
| **Audio Attachments Folder** | `Attachments` | Vault folder where `.mp3` master audio files are stored. |
| **Download Master Audio** | `true` | Save `.mp3` audio files and embed the native Obsidian audio player. |
| **Gemini API Key** | Empty | Optional Google AI Studio key for Gemini 3.6 Flash speaker disambiguation. |
| **Confidence Threshold** | `0.70` | Heuristic threshold below which Gemini will be invoked. |
| **Force Cloud Enrichment**| `false` | When enabled, always uses Gemini 3.6 Flash for speaker mapping. |
| **Custom Organizations** | Empty | Comma-separated list of your company or client names to prioritize. |
| **Auto-sync on Startup** | `false` | Automatically check for and sync new recordings when Obsidian launches. |

---

## Disclaimer

This is an independent open-source community plugin. It is not affiliated with, officially maintained by, or endorsed by Plaud.ai (Nicebuild LLC) or Obsidian (Dynalist Inc.). All product names, logos, and brands are property of their respective owners.

## License

MIT License © 2026 bitlifter
