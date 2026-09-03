import { requestUrl } from "obsidian";
import * as os from "os";
import * as path from "path";
import * as fsPromises from "fs/promises";
import { SpeakerResolution, TranscriptSegment } from "./types";

export const COMMON_WORDS_NOT_NAMES = new Set([
  "I", "A", "An", "The", "And", "Or", "But", "If", "So", "Then", "No", "Yes", "Yeah", "Okay",
  "We", "He", "She", "They", "It", "You", "Me", "Us", "Him", "Her", "Them", "My", "Mine", "Our", "Ours", "Your", "Yours", "His", "Hers", "Their", "Theirs", "Its",
  "Right", "Well", "Just", "Like", "Sure", "Thanks", "Thank", "Hello", "Hey",
  "Hi", "Sorry", "Please", "Actually", "Basically", "Obviously", "Honestly",
  "Definitely", "Totally", "Look", "Listen", "See", "Wait", "Hold", "Good",
  "Great", "Fine", "Cool", "Nice", "Man", "Dude", "Folks", "Guys", "Team",
  "Everyone", "Everybody", "Anybody", "Someone", "Nobody", "All", "Both",
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
  "January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December", "India", "US", "USA", "Bay",
  "Area", "Silicon", "Valley", "Meeting", "Call", "Project", "Team", "Group",
  "Plan", "Roadmap", "Report", "Review", "Discussion", "Proposal", "Notes",
  "Action", "Summary", "Item", "Items", "Sample", "Samples", "Model", "Models",
  "Target", "Targets", "Strategy", "Objective", "Objectives", "Issue", "Issues",
  "Conclusion", "Description", "Next", "Arrangements", "Agreement", "Client",
  "Customer", "Partner", "Partners", "Vendor", "Executive", "Director", "VP", "CEO",
  "CTO", "CIO", "Engineering", "Commercial", "Product", "Support", "Finance",
  "Going", "Trying", "Convenient", "Feeling", "Annoying", "Based", "Pointing",
  "Fake", "Serious", "Curious", "Wondering", "Thinking", "Working", "Looking",
  "Starting", "Talking", "Asking", "Telling", "Saying", "Doing", "Having",
  "Getting", "Making", "Taking", "Coming", "Seeing", "Knowing", "Giving",
  "Finding", "Becoming", "Showing", "Leaving", "Putting", "Bringing", "Beginning",
  "Holding", "Writing", "Standing", "Hearing", "Letting", "Meaning", "Setting",
  "Running", "Here", "There", "Where", "When", "What", "Who", "Why", "How",
  "This", "That", "These", "Those", "Some", "Many", "Much", "More", "Most",
  "Very", "Really", "Too", "Also", "Only", "Never", "Always", "Often",
  "Can", "Could", "Will", "Would", "Shall", "Should", "May", "Might", "Must"
]);

export function isValidPersonName(name: string): boolean {
  if (!name || typeof name !== "string") return false;
  const clean = name.replace(/[\[\]]/g, "").trim();
  if (clean.length < 2 || clean.length > 35) return false;
  if (/^Speaker\s*\d+$/i.test(clean) || clean.toLowerCase().includes("speaker")) return false;
  if (!/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}$/.test(clean)) return false;

  const words = clean.split(/\s+/);
  for (const w of words) {
    const titleCased = w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    if (COMMON_WORDS_NOT_NAMES.has(titleCased)) return false;
  }
  return true;
}

export function sanitizePeopleList(people: string[]): string[] {
  if (!Array.isArray(people)) return [];
  const cleanSet = new Set<string>();
  for (const p of people) {
    if (!p) continue;
    const clean = p.replace(/[\[\]]/g, "").trim();
    if (isValidPersonName(clean)) {
      cleanSet.add(clean);
    }
  }
  return Array.from(cleanSet).sort();
}

const ORGS_CACHE_PATH = path.join(os.homedir(), ".plaud", "known_organizations.json");

const BASELINE_ORGS = [
  "Google", "Microsoft", "Apple", "Amazon", "AWS", "Azure",
  "Meta", "OpenAI", "Anthropic", "Slack", "Zoom", "GitHub",
  "NVIDIA", "Intel", "AMD"
];

let cachedOrgs: string[] | null = null;

export async function getKnownOrganizations(customOrgsString = ""): Promise<string[]> {
  const orgs = new Set(BASELINE_ORGS);

  if (customOrgsString) {
    customOrgsString.split(",").map(o => o.trim()).filter(Boolean).forEach(o => orgs.add(o));
  }

  if (cachedOrgs) {
    cachedOrgs.forEach(o => orgs.add(o));
    return Array.from(orgs);
  }

  try {
    const data = await fsPromises.readFile(ORGS_CACHE_PATH, "utf-8");
    const saved = JSON.parse(data);
    if (Array.isArray(saved)) {
      saved.forEach(o => orgs.add(o));
    }
  } catch {}

  cachedOrgs = Array.from(orgs);
  return cachedOrgs;
}

export async function saveLearnedOrganizations(newOrgs: string[] = []): Promise<void> {
  if (!Array.isArray(newOrgs) || newOrgs.length === 0) return;

  try {
    const current = new Set(await getKnownOrganizations());
    let added = false;
    for (const org of newOrgs) {
      const clean = (org || "").trim();
      if (clean && !current.has(clean) && !COMMON_WORDS_NOT_NAMES.has(clean)) {
        current.add(clean);
        added = true;
      }
    }

    if (added) {
      cachedOrgs = Array.from(current);
      const dir = path.dirname(ORGS_CACHE_PATH);
      await fsPromises.mkdir(dir, { recursive: true });
      await fsPromises.writeFile(ORGS_CACHE_PATH, JSON.stringify(cachedOrgs, null, 2), "utf-8");
    }
  } catch {}
}

export async function extractOrganizations(text = "", title = "", customOrgs = ""): Promise<string[]> {
  const orgs = new Set<string>();
  const combined = `${title}\n${text}`;
  const known = await getKnownOrganizations(customOrgs);

  for (const org of known) {
    const regex = new RegExp(`\\b${org.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (regex.test(combined)) {
      orgs.add(org);
    }
  }

  const suffixMatches = combined.matchAll(
    /\b([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)?)\s+(Inc|LLC|Corp|Corporation|Ltd|Limited|Group|Technologies|Technologies|Systems|Networks|Cloud|Capital|Partners|Labs|Ventures|Solutions|Robotics|Holdings)\b/g
  );
  for (const match of suffixMatches) {
    const fullOrg = `${match[1]} ${match[2]}`.trim();
    if (!COMMON_WORDS_NOT_NAMES.has(match[1])) {
      orgs.add(fullOrg);
    }
  }

  const result = Array.from(orgs);
  if (result.length > 0) {
    await saveLearnedOrganizations(result);
  }

  return result;
}

export async function resolveSpeakersHeuristic(
  transcriptSegments: TranscriptSegment[] = [],
  summaryContent = "",
  title = "",
  customOrgs = ""
): Promise<SpeakerResolution> {
  const organizations = await extractOrganizations(summaryContent, title, customOrgs);
  const orgNamesSet = new Set(organizations.map(o => o.toLowerCase()));
  const orgWordsSet = new Set(organizations.flatMap(o => o.toLowerCase().split(/\s+/)));

  if (!Array.isArray(transcriptSegments) || transcriptSegments.length === 0) {
    return {
      speakerMap: {},
      people: [],
      organizations,
      confidence: 0,
      source: "heuristic"
    };
  }

  const utteranceCounts: Record<string, number> = {};
  for (const t of transcriptSegments) {
    const spk = t.speaker || "Speaker";
    utteranceCounts[spk] = (utteranceCounts[spk] || 0) + 1;
  }
  const totalUtterances = transcriptSegments.length;

  const candidateScores: Record<string, Record<string, number>> = {};
  function scoreName(speaker: string, name: string, weight = 1.0) {
    if (!speaker || !name) return;
    const clean = name.trim();
    if (!isValidPersonName(clean)) return;
    if (orgNamesSet.has(clean.toLowerCase()) || orgWordsSet.has(clean.toLowerCase())) return;

    if (!candidateScores[speaker]) candidateScores[speaker] = {};
    candidateScores[speaker][clean] = (candidateScores[speaker][clean] || 0) + weight;
  }

  // 1. Roll-call / Participants line in summary
  const participantMatch = summaryContent.match(
    /(?:Participants|Attendees|Present|Meeting with):\s*([^\n\r]+)/i
  );
  const detectedAttendees = new Set<string>();
  if (participantMatch) {
    const line = participantMatch[1];
    const bracketMatches = Array.from(line.matchAll(/\[([^\]]+)\]/g));
    if (bracketMatches.length > 0) {
      for (const m of bracketMatches) {
        const item = m[1].trim();
        if (isValidPersonName(item) && !orgNamesSet.has(item.toLowerCase())) {
          detectedAttendees.add(item);
        }
      }
    } else {
      const rawList = line.split(/[,;&]|\band\b/i);
      for (const item of rawList) {
        const clean = item.replace(/[\[\]]/g, "").trim();
        if (isValidPersonName(clean) && !orgNamesSet.has(clean.toLowerCase())) {
          detectedAttendees.add(clean);
        }
      }
    }
  }

  // 2. Analyze turns
  for (let i = 0; i < transcriptSegments.length; i++) {
    const turn = transcriptSegments[i];
    const spk = turn.speaker || "Speaker";
    const text = turn.content || "";

    // Self-identification (case-sensitive on name)
    const selfIdMatch = text.match(
      /\b(?:This is|I am|I'm|Here is|My name is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/
    );
    if (selfIdMatch && isValidPersonName(selfIdMatch[1])) {
      scoreName(spk, selfIdMatch[1], 10.0);
    }

    // Direct address (case-sensitive on name)
    const vocativeMatch = text.match(
      /\b(?:Thanks|Thank you|Hi|Hello|Hey|Good morning|Good afternoon)\s*,?\s+([A-Z][a-z]+)\b/
    );
    if (vocativeMatch && isValidPersonName(vocativeMatch[1])) {
      const addressedName = vocativeMatch[1];
      if (i > 0) {
        const prevSpeaker = transcriptSegments[i - 1].speaker;
        if (prevSpeaker && prevSpeaker !== spk) {
          scoreName(prevSpeaker, addressedName, 4.0);
        }
      }
      if (i < transcriptSegments.length - 1) {
        const nextSpeaker = transcriptSegments[i + 1].speaker;
        if (nextSpeaker && nextSpeaker !== spk) {
          scoreName(nextSpeaker, addressedName, 3.0);
        }
      }
    }
  }

  const speakerMap: Record<string, string> = {};
  const allIdentifiedPeople = new Set<string>();

  for (const [spk, scores] of Object.entries(candidateScores)) {
    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    if (sorted.length > 0 && sorted[0][1] >= 2.0) {
      const bestName = sorted[0][0];
      speakerMap[spk] = bestName;
      allIdentifiedPeople.add(bestName);
    }
  }

  for (const person of detectedAttendees) {
    allIdentifiedPeople.add(person);
  }

  let mappedUtterances = 0;
  for (const [spk, count] of Object.entries(utteranceCounts)) {
    if (speakerMap[spk]) {
      mappedUtterances += count;
    }
  }

  const confidence = totalUtterances > 0 ? mappedUtterances / totalUtterances : 0;

  return {
    speakerMap,
    people: Array.from(allIdentifiedPeople),
    organizations,
    confidence: Math.round(confidence * 100) / 100,
    source: "heuristic"
  };
}

export async function resolveSpeakersGemini(
  transcriptSegments: TranscriptSegment[] = [],
  summaryContent = "",
  title = "",
  apiKey: string,
  model = "gemini-3.6-flash"
): Promise<SpeakerResolution> {
  if (!apiKey) throw new Error("Gemini API key is not configured.");

  const speakers = Array.from(
    new Set(transcriptSegments.map(s => s.speaker).filter(Boolean) as string[])
  );

  const sampleTurns: TranscriptSegment[] = [];
  sampleTurns.push(...transcriptSegments.slice(0, 15));

  for (const spk of speakers) {
    if (!sampleTurns.some(t => t.speaker === spk)) {
      const spkTurns = transcriptSegments
        .filter(t => t.speaker === spk && t.content)
        .sort((a, b) => (b.content?.length || 0) - (a.content?.length || 0))
        .slice(0, 4);
      sampleTurns.push(...spkTurns);
    }
  }

  const sampleDialogue = sampleTurns
    .map((s, idx) => `[${idx}] ${s.speaker}: "${s.content}"`)
    .join("\n");

  const speakerListStr = speakers.length > 0 ? speakers.join(", ") : "Speaker 1, Speaker 2";
  const prompt = `You are an expert executive meeting intelligence assistant.
Your task is to identify the real names of EVERY speaker (${speakerListStr}) in this transcript and summary.

Meeting Title: ${title}

Meeting Summary & Action Items:
${summaryContent.slice(0, 4000)}

Dialogue Excerpt:
${sampleDialogue.slice(0, 6000)}

DISAMBIGUATION & IDENTIFICATION RULES:
1. Pay careful attention to conversational grammar:
   - When Speaker A says "Good morning Bob", the person being addressed (Speaker B) is Bob, NOT Speaker A.
   - When Speaker A says "So that's why we have that questionnaire, Alice", the person being addressed is Alice, NOT Speaker A.
   - When Speaker A says "David Smith here", Speaker A is David Smith.
   - When someone says "Alex and Charlie have joined", and one says "Alex here", the other who joined is Charlie.
2. Cross-reference with Action Items and Summary:
   - Plaud notes often associate tasks with "Speaker 1", "Speaker 3", etc. or "@Person". Match these to resolve who is who.
3. Use process of elimination to map EVERY speaker (${speakerListStr}):
   - Identify all meeting attendees from the introductions, roll-calls, and summary.
   - Match each speaker (${speakerListStr}) to one of these attendees using their role, topics they discuss, and who they interact with.

Respond with ONLY a valid JSON object in this exact schema:
{
  "speakerMap": { "Speaker 1": "Real Name", "Speaker 2": "Real Name", "Speaker 3": "Real Name" },
  "people": ["Name 1", "Name 2"],
  "organizations": ["Org 1", "Org 2"],
  "confidence": 0.95
}`;

  const selectedModel = model || "gemini-3.6-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${apiKey}`;
  const response = await requestUrl({
    url,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.1
      }
    }),
    throw: false
  });

  if (response.status !== 200) {
    throw new Error(`Gemini API error ${response.status}: ${response.text}`);
  }

  const data = response.json;
  const textContent = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textContent) throw new Error("Empty response from Gemini API");

  const parsed = JSON.parse(textContent);
  const orgs = Array.isArray(parsed.organizations) ? parsed.organizations : [];
  if (orgs.length > 0) {
    await saveLearnedOrganizations(orgs);
  }

  return {
    speakerMap: parsed.speakerMap || {},
    people: Array.isArray(parsed.people) ? parsed.people : [],
    organizations: orgs,
    confidence: parsed.confidence || 0.95,
    source: "gemini"
  };
}

export async function resolveSpeakersOpenAICompatible(
  transcriptSegments: TranscriptSegment[] = [],
  summaryContent = "",
  title = "",
  baseUrl = "http://localhost:11434/v1",
  apiKey = "",
  model = "llama3.1"
): Promise<SpeakerResolution> {
  const speakers = Array.from(
    new Set(transcriptSegments.map(s => s.speaker).filter(Boolean) as string[])
  );

  const sampleTurns: TranscriptSegment[] = [];
  sampleTurns.push(...transcriptSegments.slice(0, 15));

  for (const spk of speakers) {
    if (!sampleTurns.some(t => t.speaker === spk)) {
      const spkTurns = transcriptSegments
        .filter(t => t.speaker === spk && t.content)
        .sort((a, b) => (b.content?.length || 0) - (a.content?.length || 0))
        .slice(0, 4);
      sampleTurns.push(...spkTurns);
    }
  }

  const sampleDialogue = sampleTurns
    .map((s, idx) => `[${idx}] ${s.speaker}: "${s.content}"`)
    .join("\n");

  const speakerListStr = speakers.length > 0 ? speakers.join(", ") : "Speaker 1, Speaker 2";
  const prompt = `You are an expert executive meeting intelligence assistant.
Your task is to identify the real names of EVERY speaker (${speakerListStr}) in this transcript and summary.

Meeting Title: ${title}

Meeting Summary & Action Items:
${summaryContent.slice(0, 4000)}

Dialogue Excerpt:
${sampleDialogue.slice(0, 6000)}

DISAMBIGUATION & IDENTIFICATION RULES:
1. Pay careful attention to conversational grammar:
   - When Speaker A says "Good morning Bob", the person being addressed (Speaker B) is Bob, NOT Speaker A.
   - When Speaker A says "David Smith here", Speaker A is David Smith.
   - When someone says "Alex and Charlie have joined", and one says "Alex here", the other who joined is Charlie.
2. Cross-reference with Action Items and Summary to map each speaker (${speakerListStr}) to their real name.
3. Extract real full or first names of real humans who participated. Do NOT include phrases, verbs, or "Speaker".
4. Extract organizations mentioned.

Respond strictly with ONLY a JSON object (no explanations, no code block markers if possible) in this exact schema:
{
  "speakerMap": { "Speaker 1": "Real Name", "Speaker 2": "Real Name" },
  "people": ["Name 1", "Name 2"],
  "organizations": ["Org 1", "Org 2"],
  "confidence": 0.95
}`;

  const cleanBase = (baseUrl || "http://localhost:11434/v1").replace(/\/+$/, "");
  const url = `${cleanBase}/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  let response = await requestUrl({
    url,
    method: "POST",
    headers,
    body: JSON.stringify({
      model: model || "llama3.1",
      messages: [
        {
          role: "system",
          content: "You are an executive meeting intelligence analyst. You respond only with valid JSON."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.1,
      response_format: { type: "json_object" }
    }),
    throw: false
  });

  if (response.status === 400 && response.text?.includes("response_format")) {
    response = await requestUrl({
      url,
      method: "POST",
      headers,
      body: JSON.stringify({
        model: model || "llama3.1",
        messages: [
          {
            role: "system",
            content: "You are an executive meeting intelligence analyst. You respond strictly with valid JSON without markdown formatting."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.1
      }),
      throw: false
    });
  }

  if (response.status !== 200) {
    throw new Error(`OpenAI-compatible error ${response.status}: ${response.text}`);
  }

  const data = response.json;
  const textContent = data.choices?.[0]?.message?.content;
  if (!textContent) throw new Error("Empty completion response from OpenAI-compatible endpoint");

  let cleanJson = textContent.trim();
  if (cleanJson.startsWith("```json")) {
    cleanJson = cleanJson.replace(/^```json\s*/, "").replace(/```$/, "").trim();
  } else if (cleanJson.startsWith("```")) {
    cleanJson = cleanJson.replace(/^```\s*/, "").replace(/```$/, "").trim();
  }

  const parsed = JSON.parse(cleanJson);
  const orgs = Array.isArray(parsed.organizations) ? parsed.organizations : [];
  if (orgs.length > 0) {
    await saveLearnedOrganizations(orgs);
  }

  const speakerMap = parsed.speakerMap || {};
  const people = sanitizePeopleList(parsed.people || Object.values(speakerMap));

  return {
    speakerMap,
    people,
    organizations: orgs,
    confidence: parsed.confidence || 0.9,
    source: "openai_compatible"
  };
}

export async function testOpenAIConnection(baseUrl: string, apiKey: string, model: string): Promise<string> {
  const cleanBase = (baseUrl || "http://localhost:11434/v1").replace(/\/+$/, "");
  const url = `${cleanBase}/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const response = await requestUrl({
    url,
    method: "POST",
    headers,
    body: JSON.stringify({
      model: model || "llama3.1",
      messages: [{ role: "user", content: "Say OK" }],
      max_tokens: 10
    }),
    throw: false
  });

  if (response.status !== 200) {
    throw new Error(`HTTP ${response.status}: ${response.text}`);
  }

  const data = response.json;
  const reply = data.choices?.[0]?.message?.content || "Connected";
  return reply.trim();
}

export async function testGeminiConnection(apiKey: string, model: string): Promise<string> {
  const selectedModel = model || "gemini-3.6-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${apiKey}`;
  const response = await requestUrl({
    url,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: "Say OK" }] }]
    }),
    throw: false
  });

  if (response.status !== 200) {
    throw new Error(`HTTP ${response.status}: ${response.text}`);
  }
  return "Connected successfully";
}

export interface AudioTranscriptionResult {
  summaryContent: string;
  outlineText: string;
  transcriptSegments: TranscriptSegment[];
  people: string[];
  organizations: string[];
}

export async function transcribeAudioGemini(
  audioBuffer: ArrayBuffer,
  apiKey: string,
  title: string,
  model = "gemini-3.6-flash"
): Promise<AudioTranscriptionResult> {
  if (!apiKey) throw new Error("Gemini API key is not configured.");

  const base64Audio = Buffer.from(audioBuffer).toString("base64");

  const prompt = `You are an expert AI meeting transcription and intelligence assistant.
Recording Title: ${title}

Listen carefully to this audio recording and produce:
1. A timestamped verbatim transcript with speaker diarization (label speakers by real names if introduced or obvious from context, or Speaker 1, Speaker 2, etc.).
2. A comprehensive executive meeting summary with key discussion points, context, and decisions made.
3. Outline of discussion topics.
4. Action items with assignees if any were decided.
5. List of meeting participants (people) and organizations mentioned.

Respond strictly with a valid JSON object in this exact schema:
{
  "summary": "Full markdown meeting summary and action items",
  "outline": "Markdown outline of topics discussed with bullet points",
  "people": ["Alice", "Bob"],
  "organizations": ["Org A", "Org B"],
  "transcript": [
    { "speaker": "Speaker 1", "startTime": 0, "endTime": 12000, "content": "Verbatim speech..." }
  ]
}`;

  const selectedModel = model || "gemini-3.6-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${apiKey}`;
  const response = await requestUrl({
    url,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: "audio/mp3", data: base64Audio } },
          { text: prompt }
        ]
      }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.1
      }
    }),
    throw: false
  });

  if (response.status !== 200) {
    throw new Error(`Gemini audio transcription error ${response.status}: ${response.text}`);
  }

  const data = response.json;
  const textContent = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textContent) {
    throw new Error("No transcription content returned by Gemini");
  }

  const parsed = JSON.parse(textContent);
  const orgs = Array.isArray(parsed.organizations) ? parsed.organizations : [];
  if (orgs.length > 0) {
    await saveLearnedOrganizations(orgs);
  }

  return {
    summaryContent: parsed.summary || "",
    outlineText: parsed.outline || "",
    transcriptSegments: Array.isArray(parsed.transcript) ? parsed.transcript : [],
    people: Array.isArray(parsed.people) ? parsed.people : [],
    organizations: orgs
  };
}

export async function enrichMeetingData({
  transcriptSegments = [],
  summaryContent = "",
  title = "",
  aiProvider = "gemini",
  geminiApiKey = "",
  geminiModel = "gemini-3.6-flash",
  openaiBaseUrl = "http://localhost:11434/v1",
  openaiApiKey = "",
  openaiModel = "llama3.1",
  minConfidence = 0.70,
  forceCloud = false,
  customOrgs = ""
}: {
  transcriptSegments?: TranscriptSegment[];
  summaryContent?: string;
  title?: string;
  aiProvider?: "gemini" | "openai_compatible";
  geminiApiKey?: string;
  geminiModel?: string;
  openaiBaseUrl?: string;
  openaiApiKey?: string;
  openaiModel?: string;
  minConfidence?: number;
  forceCloud?: boolean;
  customOrgs?: string;
}): Promise<SpeakerResolution> {
  // 1. If OpenAI-compatible provider is selected
  if (aiProvider === "openai_compatible" && openaiBaseUrl) {
    try {
      const result = await resolveSpeakersOpenAICompatible(
        transcriptSegments,
        summaryContent,
        title,
        openaiBaseUrl,
        openaiApiKey,
        openaiModel
      );
      return {
        ...result,
        people: sanitizePeopleList(result.people || [])
      };
    } catch (err: any) {
      console.warn(`OpenAI-compatible enrichment failed: ${err.message}. Falling back to heuristic.`);
    }
  }

  // 2. If Gemini provider is selected and API key is available
  if (aiProvider === "gemini" && geminiApiKey) {
    try {
      const geminiResult = await resolveSpeakersGemini(
        transcriptSegments,
        summaryContent,
        title,
        geminiApiKey,
        geminiModel
      );
      return {
        ...geminiResult,
        people: sanitizePeopleList(geminiResult.people || [])
      };
    } catch (err: any) {
      console.warn(`Gemini enrichment failed: ${err.message}. Falling back to heuristic.`);
    }
  }

  // 3. Strict offline heuristic fallback
  return await resolveSpeakersHeuristic(transcriptSegments, summaryContent, title, customOrgs);
}

export async function summarizeTranscript({
  transcriptSegments = [],
  title = "Local Meeting",
  aiProvider = "gemini",
  geminiApiKey = "",
  geminiModel = "gemini-3.6-flash",
  openaiBaseUrl = "http://localhost:11434/v1",
  openaiApiKey = "",
  openaiModel = "llama3.1",
  customOrgs = ""
}: {
  transcriptSegments?: TranscriptSegment[];
  title?: string;
  aiProvider?: "gemini" | "openai_compatible";
  geminiApiKey?: string;
  geminiModel?: string;
  openaiBaseUrl?: string;
  openaiApiKey?: string;
  openaiModel?: string;
  customOrgs?: string;
}): Promise<{
  summaryContent: string;
  outlineText: string;
  people: string[];
  organizations: string[];
  speakerMap: Record<string, string>;
}> {
  const fullDialogue = transcriptSegments
    .map(s => `${s.speaker || "Speaker"}: ${s.content}`)
    .join("\n");

  const prompt = `You are an expert executive meeting assistant.
Analyze this meeting transcript and produce a comprehensive, structured meeting summary in Obsidian Markdown format.

Meeting Title: ${title}

Transcript:
${fullDialogue.slice(0, 80000)}

Respond strictly with ONLY a JSON object adhering to this schema:
{
  "summary": "2-3 paragraph executive summary of key discussion points, context, and outcomes.",
  "outline": "### Key Discussion Topics\\n- Topic 1\\n- Topic 2\\n\\n### Decisions Made\\n- Decision 1\\n\\n### Action Items\\n- [ ] Task 1 (Assignee)\\n- [ ] Task 2 (Assignee)",
  "people": ["Alice Smith", "Bob Jones"],
  "organizations": ["Company A"],
  "speakerMap": { "Speaker 1": "Alice Smith" }
}`;

  // 1. Try OpenAI-compatible endpoint
  if (aiProvider === "openai_compatible" && openaiBaseUrl) {
    try {
      const cleanBase = openaiBaseUrl.replace(/\/+$/, "");
      const res = await requestUrl({
        url: `${cleanBase}/chat/completions`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(openaiApiKey ? { "Authorization": `Bearer ${openaiApiKey}` } : {})
        },
        body: JSON.stringify({
          model: openaiModel || "llama3.1",
          messages: [
            { role: "system", content: "You are a meeting summarization engine. You output strictly valid JSON." },
            { role: "user", content: prompt }
          ],
          temperature: 0.2
        }),
        throw: false
      });

      if (res.status === 200) {
        let content = res.json?.choices?.[0]?.message?.content || "";
        content = content.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
        const parsed = JSON.parse(content);
        const orgs = Array.isArray(parsed.organizations) ? parsed.organizations : [];
        if (orgs.length > 0) await saveLearnedOrganizations(orgs);
        return {
          summaryContent: parsed.summary || "",
          outlineText: parsed.outline || "",
          people: sanitizePeopleList(parsed.people || []),
          organizations: orgs,
          speakerMap: parsed.speakerMap || {}
        };
      }
    } catch (e: any) {
      console.warn("OpenAI-compatible summarization failed, falling back:", e.message);
    }
  }

  // 2. Try Gemini
  if (geminiApiKey) {
    try {
      const selectedModel = geminiModel || "gemini-3.6-flash";
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${geminiApiKey}`;
      const res = await requestUrl({
        url,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.2
          }
        }),
        throw: false
      });

      if (res.status === 200) {
        const textContent = res.json?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (textContent) {
          const parsed = JSON.parse(textContent);
          const orgs = Array.isArray(parsed.organizations) ? parsed.organizations : [];
          if (orgs.length > 0) await saveLearnedOrganizations(orgs);
          return {
            summaryContent: parsed.summary || "",
            outlineText: parsed.outline || "",
            people: sanitizePeopleList(parsed.people || []),
            organizations: orgs,
            speakerMap: parsed.speakerMap || {}
          };
        }
      }
    } catch (e: any) {
      console.warn("Gemini summarization failed, falling back to heuristic:", e.message);
    }
  }

  // 3. Fallback: heuristic attendee extraction & basic outline
  const heuristic = await resolveSpeakersHeuristic(transcriptSegments, "", title, customOrgs);
  return {
    summaryContent: "Meeting transcribed locally via whisper.cpp.",
    outlineText: "### Summary\n- Meeting transcribed from local audio.",
    people: heuristic.people,
    organizations: heuristic.organizations,
    speakerMap: heuristic.speakerMap
  };
}

