import { TranscriptSegment } from "./types";
import { sanitizePeopleList } from "./enricher";

export function sanitizeFilename(name: string, maxLength = 100): string {
  if (!name || !name.trim()) return "Untitled Recording";

  let clean = name
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  clean = clean.replace(/[,. ]+$/, "");

  if (clean.length > maxLength) {
    clean = clean.slice(0, maxLength).trim().replace(/[,. ]+$/, "");
  }

  return clean || "Untitled Recording";
}

export function formatNoteTitle(rawName: string, date: string, time = "00:00", maxLength = 100): string {
  let clean = (rawName || "").trim();

  if (clean.match(/^\d{4}[-/]\d{2}[-/]\d{2}\s+\d{2}:\d{2}(?::\d{2})?$/)) {
    return clean.replace(/:/g, "-");
  }
  if (clean.match(/^\d{2}:\d{2}(?::\d{2})?$/)) {
    return `${date} ${clean.replace(/:/g, "-")}`;
  }

  clean = clean.replace(/^\d{2}[-/]\d{2}\s*(?:Meeting:?\s*)?/i, "");
  clean = clean.replace(/^\d{4}[-/]\d{2}[-/]\d{2}\s*(?:Meeting:?\s*)?/i, "");
  clean = clean.replace(/^Meeting:?\s*/i, "");

  clean = sanitizeFilename(clean, maxLength);

  if (!clean) {
    return `${date} ${time.replace(/:/g, "-")} Recording`;
  }

  return `${date} ${clean}`;
}

export function parsePlaudDate(dateStr?: string | number): { date: string; time: string; iso: string } {
  if (!dateStr) {
    const now = new Date();
    return {
      date: now.toISOString().slice(0, 10),
      time: now.toISOString().slice(11, 16),
      iso: now.toISOString()
    };
  }

  let d: Date;
  if (typeof dateStr === "number") {
    d = new Date(dateStr > 1e11 ? dateStr : dateStr * 1000);
  } else if (dateStr.length === 10 && dateStr.includes("-")) {
    d = new Date(`${dateStr}T12:00:00Z`);
  } else {
    d = new Date(dateStr);
  }

  if (isNaN(d.getTime())) {
    d = new Date();
  }

  const pad = (n: number) => String(n).padStart(2, "0");
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const mins = pad(d.getMinutes());

  return {
    date: `${year}-${month}-${day}`,
    time: `${hours}:${mins}`,
    iso: d.toISOString()
  };
}

export function formatDuration(val: number): string {
  if (!val || val <= 0) return "0:00";
  // Plaud API returns duration in milliseconds (e.g. 2434000 ms = 40m 34s)
  const totalSec = val > 10000 ? Math.floor(val / 1000) : Math.floor(val);
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hours > 0) {
    return `${hours}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export function formatTimestamp(ms: number): string {
  const totalSec = Math.floor((ms || 0) / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function formatTranscriptCallout(
  transcriptSegments: TranscriptSegment[] = [],
  speakerMap: Record<string, string> = {}
): string {
  if (!transcriptSegments || transcriptSegments.length === 0) {
    return "";
  }

  const lastTurn = transcriptSegments[transcriptSegments.length - 1];
  const totalDurationMs = lastTurn ? (lastTurn.endTime || lastTurn.startTime || 0) : 0;
  const totalSec = Math.floor(totalDurationMs / 1000);
  const durStr = totalSec > 0 ? ` (${Math.floor(totalSec / 60)}m ${totalSec % 60}s)` : "";

  const lines = [`> [!quote]- Full Transcript${durStr}`];

  for (const turn of transcriptSegments) {
    const rawSpeaker = turn.speaker || "Speaker";
    const mapped = speakerMap[rawSpeaker] || rawSpeaker;
    const start = formatTimestamp(turn.startTime || 0);
    const end = formatTimestamp(turn.endTime || 0);
    const content = (turn.content || "").replace(/\n/g, " ");

    lines.push(`> **${mapped}** \`[${start} - ${end}]\`: ${content}`);
    lines.push(`>`);
  }

  if (lines[lines.length - 1] === `>`) {
    lines.pop();
  }

  return lines.join("\n");
}

export function extractAutoSumNotes(fileDetail: any): {
  summaryContent: string;
  outlineText: string;
  participantsFromNote: string[];
} {
  const payload = fileDetail?.payload || fileDetail;
  const autoSumNote = payload?.auto_sum_note || {};

  const summary = autoSumNote.summary || payload.summary || "";
  const outline = autoSumNote.outline || payload.outline || "";

  let combinedSummary = "";
  if (typeof summary === "string") {
    combinedSummary = summary;
  } else if (typeof summary === "object") {
    combinedSummary = summary.content || summary.text || JSON.stringify(summary, null, 2);
  }

  let outlineText = "";
  if (typeof outline === "string") {
    outlineText = outline;
  } else if (Array.isArray(outline)) {
    outlineText = outline
      .map((item: any) => {
        if (typeof item === "string") return `- ${item}`;
        const title = item.title || item.topic || "";
        const desc = item.desc || item.description || item.content || "";
        return `- **${title}**${desc ? `: ${desc}` : ""}`;
      })
      .join("\n");
  }

  const participantsFromNote: string[] = [];
  const partMatch = combinedSummary.match(
    /(?:Participants|Attendees|Present|Meeting with):\s*([^\n\r]+)/i
  );
  if (partMatch) {
    const line = partMatch[1];
    const bracketMatches = Array.from(line.matchAll(/\[([^\]]+)\]/g));
    if (bracketMatches.length > 0) {
      for (const m of bracketMatches) {
        participantsFromNote.push(m[1].trim());
      }
    } else {
      const raw = line.split(/[,;&]|\band\b/i);
      for (const p of raw) {
        participantsFromNote.push(p.trim());
      }
    }
  }

  return {
    summaryContent: combinedSummary,
    outlineText,
    participantsFromNote: sanitizePeopleList(participantsFromNote)
  };
}

export function buildKepanoFrontmatter({
  date,
  time,
  duration,
  people = [],
  organizations = [],
  topics = [],
  audioFilename = null
}: {
  date: string;
  time: string;
  duration?: string;
  people?: string[];
  organizations?: string[];
  topics?: string[];
  audioFilename?: string | null;
}): string {
  const lines = [
    "---",
    `date: ${date}`,
    `time: "${time}"`
  ];

  if (duration) {
    lines.push(`duration: "${duration}"`);
  }

  lines.push(`categories:`);
  lines.push(`  - "[[Meetings]]"`);

  const cleanPeople = sanitizePeopleList(people);
  if (cleanPeople.length > 0) {
    lines.push(`people:`);
    for (const p of cleanPeople) {
      lines.push(`  - "[[${p}]]"`);
    }
  }

  if (organizations && organizations.length > 0) {
    lines.push(`org:`);
    for (const o of organizations) {
      lines.push(`  - "[[${o}]]"`);
    }
  }

  if (topics && topics.length > 0) {
    lines.push(`topics:`);
    for (const t of topics) {
      lines.push(`  - "[[${t}]]"`);
    }
  }

  if (audioFilename) {
    lines.push(`audio: "[[Attachments/${audioFilename}]]"`);
  }

  lines.push("type:");
  lines.push('  - "[[Meeting]]"');
  lines.push("---");

  return lines.join("\n");
}

export function replaceSpeakersInContent(content = "", speakerMap: Record<string, string> = {}): string {
  if (!content || !speakerMap || Object.keys(speakerMap).length === 0) return content;

  let result = content;
  for (const [rawSpeaker, realName] of Object.entries(speakerMap)) {
    if (!rawSpeaker || !realName || rawSpeaker === realName) continue;

    // Word boundary match for Speaker X
    const escRaw = rawSpeaker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escRaw}\\b`, "gi");
    result = result.replace(regex, realName);

    // Also match @Speaker X
    const atRegex = new RegExp(`@${escRaw}\\b`, "gi");
    result = result.replace(atRegex, `@${realName}`);

    // Also match [Speaker X]
    const bracketRegex = new RegExp(`\\[${escRaw}\\]`, "gi");
    result = result.replace(bracketRegex, `[${realName}]`);
  }

  return result;
}

export function generateKepanoNote({
  title,
  date,
  time,
  duration,
  people = [],
  organizations = [],
  topics = [],
  summaryContent = "",
  outlineText = "",
  audioFilename = null,
  transcriptSegments = [],
  speakerMap = {}
}: {
  title: string;
  date: string;
  time: string;
  duration?: string;
  people?: string[];
  organizations?: string[];
  topics?: string[];
  summaryContent?: string;
  outlineText?: string;
  audioFilename?: string | null;
  transcriptSegments?: TranscriptSegment[];
  speakerMap?: Record<string, string>;
}): string {
  const frontmatter = buildKepanoFrontmatter({
    date,
    time,
    duration,
    people,
    organizations,
    topics,
    audioFilename
  });

  const bodyParts = [frontmatter, ""];

  if (audioFilename) {
    bodyParts.push(`![[Attachments/${audioFilename}]]`);
    bodyParts.push("");
  }

  if (summaryContent) {
    const enrichedSummary = replaceSpeakersInContent(summaryContent, speakerMap);
    bodyParts.push(enrichedSummary);
    bodyParts.push("");
  }

  if (outlineText) {
    const enrichedOutline = replaceSpeakersInContent(outlineText, speakerMap);
    bodyParts.push(`## Outline`);
    bodyParts.push(enrichedOutline);
    bodyParts.push("");
  }

  if (transcriptSegments && transcriptSegments.length > 0) {
    const transcriptCallout = formatTranscriptCallout(transcriptSegments, speakerMap);
    if (transcriptCallout) {
      bodyParts.push(`## Transcript`);
      bodyParts.push(transcriptCallout);
      bodyParts.push("");
    }
  }

  return bodyParts.join("\n").trim() + "\n";
}
