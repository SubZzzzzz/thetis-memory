/**
 * Thetis Memory Extension
 *
 * Global memory vault for Pi with:
 * - memory tool: read / list / search
 * - Automatic memory context injection
 * - Dynamic skill discovery
 * - learn_wizard tool: interactive candidate extraction & saving
 * - /learn command: manual trigger for the wizard
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const MEMORY_DIR = path.join(homedir(), ".pi", "agent", "memory");
const MOC_PATH = path.join(MEMORY_DIR, "MOC.md");
const CHECKPOINT_PATH = path.join(MEMORY_DIR, ".checkpoint.json");
const SESSIONS_DIR = path.join(MEMORY_DIR, "Sessions");

const DEFAULT_SECTIONS = ["Conventions", "User", "Skills"];
const SESSION_MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface LearningCandidate {
  type: "memory" | "skill";
  title: string;
  section: string;
  tags: string[];
  content: string;
  reason: string;
}

interface ParsedMemory {
  frontmatter: Record<string, unknown>;
  body: string;
}

interface MemoryEntry {
  absPath: string;
  relPath: string;
  frontmatter: Record<string, unknown>;
  body: string;
  id: string;
  title: string;
  tags: string[];
  section: string;
}

/* ------------------------------------------------------------------ */
/*  Frontmatter                                                        */
/* ------------------------------------------------------------------ */

function parseFrontmatter(content: string): ParsedMemory {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const yaml = match[1];
  const body = match[2];
  const frontmatter: Record<string, unknown> = {};

  for (const line of yaml.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let raw = line.slice(colonIdx + 1).trim();
    if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      raw = raw.slice(1, -1);
    }
    if (raw.startsWith("[") && raw.endsWith("]")) {
      const inner = raw.slice(1, -1);
      if (inner.trim() === "") {
        frontmatter[key] = [];
      } else {
        frontmatter[key] = inner
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""));
      }
    } else {
      frontmatter[key] = raw;
    }
  }
  return { frontmatter, body };
}

function stringifyFrontmatter(frontmatter: Record<string, unknown>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((v) => `"${v}"`).join(", ")}]`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/*  Vault helpers                                                      */
/* ------------------------------------------------------------------ */

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function findMarkdownFiles(dir: string, base = ""): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findMarkdownFiles(abs, rel));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(rel);
    }
  }
  return results;
}

function readMemoryEntry(relPath: string): MemoryEntry | null {
  const absPath = path.join(MEMORY_DIR, relPath);
  if (!fs.existsSync(absPath)) return null;
  const content = fs.readFileSync(absPath, "utf8");
  const { frontmatter, body } = parseFrontmatter(content);

  const id =
    (typeof frontmatter.id === "string" && frontmatter.id)
      ? frontmatter.id
      : (typeof frontmatter.name === "string" && frontmatter.name)
        ? frontmatter.name
        : path.basename(relPath, ".md");

  let title =
    (typeof frontmatter.title === "string" && frontmatter.title)
      ? frontmatter.title
      : id;

  if (
    title === id &&
    relPath.startsWith("skills/") &&
    path.basename(relPath) === "SKILL.md"
  ) {
    const skillName = path.basename(path.dirname(relPath));
    if (skillName && skillName !== ".") title = skillName;
  }

  const rawTags = frontmatter.tags;
  const tags: string[] = Array.isArray(rawTags)
    ? rawTags.filter((t): t is string => typeof t === "string")
    : typeof rawTags === "string"
      ? rawTags.split(/[\s,]+/).filter(Boolean)
      : [];

  let section = "";
  const dirPart = path.dirname(relPath);
  if (dirPart && dirPart !== ".") section = dirPart.split("/")[0];
  if (relPath.startsWith("skills/")) section = "Skills";

  return { absPath, relPath, frontmatter, body, id, title, tags, section };
}

function scanVault(excludeMoc = true): MemoryEntry[] {
  ensureDir(MEMORY_DIR);
  const rels = findMarkdownFiles(MEMORY_DIR);
  const entries: MemoryEntry[] = [];
  for (const rel of rels) {
    if (excludeMoc && rel === "MOC.md") continue;
    const entry = readMemoryEntry(rel);
    if (entry) entries.push(entry);
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/*  MOC helpers                                                        */
/* ------------------------------------------------------------------ */

interface MocSection {
  name: string;
  items: { title: string; link: string }[];
}

function parseMoc(content: string): { frontmatter: Record<string, unknown>; sections: MocSection[] } {
  const { frontmatter, body } = parseFrontmatter(content);
  const sections: MocSection[] = [];
  let current: MocSection | null = null;
  for (const line of body.split("\n")) {
    const sectionMatch = line.match(/^##\s+(.+)$/);
    if (sectionMatch) {
      current = { name: sectionMatch[1].trim(), items: [] };
      sections.push(current);
      continue;
    }
    const itemMatch = line.match(/^-\s+\[\[(.+)\]\]\s*$/);
    if (itemMatch && current) {
      current.items.push({ title: itemMatch[1].trim(), link: itemMatch[1].trim() });
    }
  }
  return { frontmatter, sections };
}

function ensureMoc(): void {
  ensureDir(MEMORY_DIR);
  if (fs.existsSync(MOC_PATH)) return;
  for (const sec of DEFAULT_SECTIONS) {
    if (sec === "Skills") ensureDir(path.join(MEMORY_DIR, "skills"));
    else ensureDir(path.join(MEMORY_DIR, sec));
  }
  const frontmatter = { title: "Pi Memory", tags: ["moc", "memory"] };
  const lines = [stringifyFrontmatter(frontmatter), "", "# Memory", ""];
  for (const sec of DEFAULT_SECTIONS) lines.push(`## ${sec}`, "");
  fs.writeFileSync(MOC_PATH, lines.join("\n") + "\n", "utf8");
}

function buildMemoryContext(): string | null {
  ensureMoc();
  if (!fs.existsSync(MOC_PATH)) return null;
  const content = fs.readFileSync(MOC_PATH, "utf8");
  const { sections } = parseMoc(content);
  if (sections.length === 0) return null;
  const lines = [
    "## Memory map",
    "",
    `The following memories and skills are available in ~/.pi/agent/memory/.`,
    "Use the memory tool to read their full content when relevant.",
    "",
  ];
  for (const sec of sections) {
    if (sec.items.length === 0) continue;
    lines.push(`### ${sec.name}`, "");
    for (const item of sec.items) lines.push(`- ${item.title}`);
    lines.push("");
  }
  return lines.join("\n");
}

function addToMoc(title: string, section: string): void {
  ensureMoc();
  const content = fs.readFileSync(MOC_PATH, "utf8");
  const { frontmatter, sections } = parseMoc(content);

  let target = sections.find((s) => s.name.toLowerCase() === section.toLowerCase());
  if (!target) {
    target = { name: section, items: [] };
    sections.push(target);
  }
  if (!target.items.some((i) => i.title.toLowerCase() === title.toLowerCase())) {
    target.items.push({ title, link: title });
  }

  const lines = [stringifyFrontmatter(frontmatter), "", "# Memory", ""];
  for (const sec of sections) {
    lines.push(`## ${sec.name}`, "");
    for (const item of sec.items) lines.push(`- [[${item.link}]]`);
    lines.push("");
  }
  fs.writeFileSync(MOC_PATH, lines.join("\n"), "utf8");
}

function removeFromMoc(title: string, section?: string): void {
  ensureMoc();
  const content = fs.readFileSync(MOC_PATH, "utf8");
  const { frontmatter, sections } = parseMoc(content);
  for (const sec of sections) {
    if (section && sec.name.toLowerCase() !== section.toLowerCase()) continue;
    sec.items = sec.items.filter((i) => i.title.toLowerCase() !== title.toLowerCase());
  }
  const nonEmpty = sections.filter((s) => s.items.length > 0);
  const lines = [stringifyFrontmatter(frontmatter), "", "# Memory", ""];
  for (const sec of nonEmpty) {
    lines.push(`## ${sec.name}`, "");
    for (const item of sec.items) lines.push(`- [[${item.link}]]`);
    lines.push("");
  }
  fs.writeFileSync(MOC_PATH, lines.join("\n"), "utf8");
}

function renameInMoc(oldTitle: string, newTitle: string, newSection?: string): void {
  ensureMoc();
  const content = fs.readFileSync(MOC_PATH, "utf8");
  const { frontmatter, sections } = parseMoc(content);
  for (const sec of sections) {
    const idx = sec.items.findIndex((i) => i.title.toLowerCase() === oldTitle.toLowerCase());
    if (idx !== -1) {
      sec.items.splice(idx, 1);
      break;
    }
  }
  const targetSection = newSection ?? sections.find((s) => s.items.some((i) => i.title.toLowerCase() === oldTitle.toLowerCase()))?.name ?? "User";
  let target = sections.find((s) => s.name.toLowerCase() === targetSection.toLowerCase());
  if (!target) {
    target = { name: targetSection, items: [] };
    sections.push(target);
  }
  if (!target.items.some((i) => i.title.toLowerCase() === newTitle.toLowerCase())) {
    target.items.push({ title: newTitle, link: newTitle });
  }
  const nonEmpty = sections.filter((s) => s.items.length > 0);
  const lines = [stringifyFrontmatter(frontmatter), "", "# Memory", ""];
  for (const sec of nonEmpty) {
    lines.push(`## ${sec.name}`, "");
    for (const item of sec.items) lines.push(`- [[${item.link}]]`);
    lines.push("");
  }
  fs.writeFileSync(MOC_PATH, lines.join("\n"), "utf8");
}

function renameSectionInMoc(oldName: string, newName: string): void {
  ensureMoc();
  const content = fs.readFileSync(MOC_PATH, "utf8");
  const { frontmatter, sections } = parseMoc(content);
  for (const sec of sections) {
    if (sec.name.toLowerCase() === oldName.toLowerCase()) sec.name = newName;
  }
  const lines = [stringifyFrontmatter(frontmatter), "", "# Memory", ""];
  for (const sec of sections) {
    lines.push(`## ${sec.name}`, "");
    for (const item of sec.items) lines.push(`- [[${item.link}]]`);
    lines.push("");
  }
  fs.writeFileSync(MOC_PATH, lines.join("\n"), "utf8");
}

function mergeSectionsInMoc(source: string, target: string): void {
  ensureMoc();
  const content = fs.readFileSync(MOC_PATH, "utf8");
  const { frontmatter, sections } = parseMoc(content);
  const src = sections.find((s) => s.name.toLowerCase() === source.toLowerCase());
  const tgt = sections.find((s) => s.name.toLowerCase() === target.toLowerCase());
  if (src && tgt) {
    for (const item of src.items) {
      if (!tgt.items.some((i) => i.title.toLowerCase() === item.title.toLowerCase())) {
        tgt.items.push(item);
      }
    }
  }
  const nonEmpty = sections.filter((s) => s.items.length > 0 && s.name.toLowerCase() !== source.toLowerCase());
  const lines = [stringifyFrontmatter(frontmatter), "", "# Memory", ""];
  for (const sec of nonEmpty) {
    lines.push(`## ${sec.name}`, "");
    for (const item of sec.items) lines.push(`- [[${item.link}]]`);
    lines.push("");
  }
  fs.writeFileSync(MOC_PATH, lines.join("\n"), "utf8");
}

/* ------------------------------------------------------------------ */
/*  Checkpoint                                                         */
/* ------------------------------------------------------------------ */

interface Checkpoint {
  lastLearnMessageId: string | null;
}

function readCheckpoint(): Checkpoint {
  if (!fs.existsSync(CHECKPOINT_PATH)) return { lastLearnMessageId: null };
  try {
    return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, "utf8")) as Checkpoint;
  } catch {
    return { lastLearnMessageId: null };
  }
}

function writeCheckpoint(checkpoint: Checkpoint): void {
  ensureDir(MEMORY_DIR);
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint, null, 2) + "\n", "utf8");
}

/* ------------------------------------------------------------------ */
/*  Session topic extraction                                           */
/* ------------------------------------------------------------------ */

const STOP_WORDS = new Set([
  // français
  "avec","ce","ces","cette","dans","de","des","du","en","et","je","la","le","les","mais","ne","ou","par","pas","pour","que","qui","se","sur","tu","un","une","est","sont","être","avoir","faire","plus","très","tout","tous","toute","toutes","alors","aussi","autre","autres","aux","avant","car","chez","comme","comment","depuis","donc","encore","entre","ici","ils","juste","leur","leurs","lui","même","mes","mien","mon","nos","notre","nous","on","ont","peu","peut","plupart","quand","quel","quelle","quelles","quels","sa","ses","si","son","ta","te","tes","ton","tous","tout","trop","vos","votre","vous","y",
  // anglais
  "the","and","for","are","but","not","you","all","any","can","had","her","was","one","our","out","day","get","has","him","his","how","its","may","new","now","old","see","two","way","who","boy","did","she","use","her","now","him","than","them","well","were","what","with","have","from","they","know","want","been","good","much","some","time","very","when","come","here","just","like","long","make","many","over","such","take","than","them","well","were","will","your","this","that","would","there","could","other","after","first","never","these","think","where","being","every","great","might","shall","still","those","under","while","about","should","really","something","going","want","need","please","ok","okay","yes","no","hi","hello","hey","thanks","thank","merci","salut","bonjour","ca","voila","donc","alors",
]);

function generateTopicName(ctx: ExtensionContext): string {
  const entries = ctx.sessionManager.getEntries();
  const userTexts: string[] = [];

  // Collecte les 3 derniers messages utilisateur (du plus récent au plus ancien)
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role === "user") {
      const text = msg.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join(" ");
      if (text.trim()) userTexts.unshift(text.trim());
      if (userTexts.length >= 3) break;
    }
  }

  if (userTexts.length === 0) return "";

  const combined = userTexts.join(" ");
  const words = combined
    .toLowerCase()
    .replace(/[^a-z0-9àâäéèêëïîôöùûüçœ\s]/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));

  if (words.length === 0) return "";

  // Compte la fréquence pour privilégier les mots répétés (sujet fort)
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  const sorted = Array.from(freq.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  // Prend jusqu'à 4 mots, ou moins si le 1er est déjà très représentatif
  const selected: string[] = [];
  for (const [word, count] of sorted) {
    if (selected.length >= 4) break;
    // Évite les répétitions exactes (même racine gardée car c'est un slug simple)
    selected.push(word);
  }

  return selected.join("_");
}

/* ------------------------------------------------------------------ */
/*  Session archive helpers                                            */
/* ------------------------------------------------------------------ */

function getSessionsDir(): string {
  ensureDir(SESSIONS_DIR);
  return SESSIONS_DIR;
}

function formatAge(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function archiveSession(ctx: ExtensionContext): void {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile || !fs.existsSync(sessionFile)) return;
  const sessionId = ctx.sessionManager.getSessionId();
  const sessionName = ctx.sessionManager.getSessionName() || "unnamed";
  const topicName = generateTopicName(ctx);
  const baseName = topicName || sessionName.replace(/[^a-z0-9_\-\s]/gi, "").replace(/\s+/g, "_").slice(0, 40);
  const safeName = baseName.slice(0, 40);
  const fileName = `${safeName}_${sessionId.slice(0, 8)}.jsonl`;
  const destPath = path.join(getSessionsDir(), fileName);

  try {
    const raw = fs.readFileSync(sessionFile, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    const filtered = lines.map((line) => {
      try {
        const entry = JSON.parse(line);
        if (
          entry.type === "message" &&
          entry.message?.role === "assistant" &&
          Array.isArray(entry.message.content)
        ) {
          entry.message.content = entry.message.content.filter(
            (c: any) => c.type !== "thinking"
          );
        }
        return JSON.stringify(entry);
      } catch {
        return line;
      }
    });
    fs.writeFileSync(destPath, filtered.join("\n") + "\n", "utf8");
    const now = new Date();
    fs.utimesSync(destPath, now, now);
  } catch {
    // fallback: raw copy if filtering fails
    try {
      fs.copyFileSync(sessionFile, destPath);
      const now = new Date();
      fs.utimesSync(destPath, now, now);
    } catch {}
  }
}

function cleanupOldSessions(): { deleted: number; names: string[] } {
  const dir = getSessionsDir();
  const now = Date.now();
  const deleted: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtime.getTime() > SESSION_MAX_AGE_MS) {
        fs.unlinkSync(filePath);
        deleted.push(entry.name);
      }
    } catch {
      // ignore cleanup errors
    }
  }
  return { deleted: deleted.length, names: deleted };
}

function listArchivedSessions(): Array<{ name: string; filePath: string; mtime: Date; size: number }> {
  const dir = getSessionsDir();
  const sessions: Array<{ name: string; filePath: string; mtime: Date; size: number }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const stat = fs.statSync(filePath);
      sessions.push({ name: entry.name, filePath, mtime: stat.mtime, size: stat.size });
    } catch {
      // ignore
    }
  }
  return sessions.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

/* ------------------------------------------------------------------ */
/*  LLM extraction                                                     */
/* ------------------------------------------------------------------ */

function buildExtractionPrompt(messages: string, granularity: string): string {
  return `You are a knowledge extraction assistant. Analyze the conversation below and propose memory/skill candidates.

A "memory" is a preference, convention, or fact. A "skill" is a reusable procedure/workflow that works and can be updated to work.
Granularity: ${granularity}. Generic = broad reusable rules; Specific = concrete session notes.

Return ONLY JSON:
{
  "candidates": [
    { "type": "memory|skill", "title": "...", "section": "...", "tags": ["..."], "content": "...", "reason": "..." }
  ]
}

If no candidates, return {"candidates": []}.

Conversation:
${messages}`;
}

async function callExtractionLLM(
  ctx: ExtensionContext,
  messages: string,
  granularity: string
): Promise<LearningCandidate[]> {
  const model = ctx.model;
  if (!model) throw new Error("No model configured. Set a model with /model before using /learn.");

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(`Auth error: ${auth.error}`);

  const baseUrl =
    (model as any).baseUrl ??
    (model.provider === "anthropic"
      ? "https://api.anthropic.com"
      : model.provider === "openai"
        ? "https://api.openai.com"
        : null);
  if (!baseUrl) throw new Error(`Cannot determine API base URL for provider: ${model.provider}`);

  const api = (model as any).api ?? "openai-completions";
  const prompt = buildExtractionPrompt(messages, granularity);

  let url: string;
  let body: unknown;
  let extractText: (res: any) => string;

  if (api === "anthropic-messages") {
    url = `${baseUrl}/v1/messages`;
    body = {
      model: model.id,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    };
    extractText = (res: any) => res.content?.[0]?.text ?? "";
  } else {
    url = `${baseUrl}/v1/chat/completions`;
    body = {
      model: model.id,
      messages: [{ role: "user", content: prompt }],
    };
    extractText = (res: any) => res.choices?.[0]?.message?.content ?? "";
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(auth.apiKey
      ? api === "anthropic-messages"
        ? { "x-api-key": auth.apiKey, "anthropic-version": "2023-06-01" }
        : { Authorization: `Bearer ${auth.apiKey}` }
      : {}),
    ...(auth.headers ?? {}),
  };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: ctx.signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM API error ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  const text = extractText(data);

  let jsonText = text;
  const blockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (blockMatch) jsonText = blockMatch[1];

  try {
    const parsed = JSON.parse(jsonText) as { candidates?: LearningCandidate[] };
    return parsed.candidates ?? [];
  } catch {
    throw new Error(`Failed to parse extraction response as JSON.\nRaw: ${text.slice(0, 300)}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Session message builder                                            */
/* ------------------------------------------------------------------ */

function buildMessagesForExtraction(ctx: ExtensionContext): { text: string; lastId: string } {
  const checkpoint = readCheckpoint();
  const entries = ctx.sessionManager.getEntries();

  let collect = false;
  const messages: string[] = [];
  let lastId = "";

  for (const entry of entries) {
    if (entry.type !== "message") continue;

    if (!collect && checkpoint.lastLearnMessageId) {
      if (entry.id === checkpoint.lastLearnMessageId) {
        collect = true;
        continue;
      }
    }
    if (!checkpoint.lastLearnMessageId) collect = true;
    if (!collect) continue;

    const msg = entry.message;
    if (msg.role === "user") {
      const text = msg.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      messages.push(`User: ${text}`);
    } else if (msg.role === "assistant") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .map((c) => c.text)
              .join("\n");
      messages.push(`Assistant: ${text}`);
    }
    lastId = entry.id;
  }

  if (messages.length === 0 && checkpoint.lastLearnMessageId) {
    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role === "user" || msg.role === "assistant") {
        const text =
          typeof msg.content === "string"
            ? msg.content
            : msg.content
                .filter((c): c is { type: "text"; text: string } => c.type === "text")
                .map((c) => c.text)
                .join("\n");
        messages.push(`${msg.role}: ${text}`);
      }
      lastId = entry.id;
    }
  }

  const MAX_CHARS = 15000;
  let text = messages.join("\n\n");
  if (text.length > MAX_CHARS) {
    text = "...[truncated]...\n\n" + text.slice(-MAX_CHARS);
  }
  return { text, lastId };
}

/* ------------------------------------------------------------------ */
/*  Wizard (interactive, text-input based)                             */
/* ------------------------------------------------------------------ */

function toSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function isDuplicate(title: string): MemoryEntry | null {
  return scanVault().find((e) => e.title.toLowerCase() === title.toLowerCase()) ?? null;
}

async function saveCandidate(candidate: LearningCandidate): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);

  if (candidate.type === "skill") {
    const skillDir = path.join(MEMORY_DIR, "skills", toSlug(candidate.title));
    ensureDir(skillDir);
    const skillPath = path.join(skillDir, "SKILL.md");
    const fm = {
      name: toSlug(candidate.title),
      description: candidate.reason,
      tags: candidate.tags.length ? candidate.tags : ["skill", "learned"],
    };
    fs.writeFileSync(skillPath, stringifyFrontmatter(fm) + "\n\n" + candidate.content + "\n", "utf8");
    addToMoc(candidate.title, "Skills");
    return `~/.pi/agent/memory/skills/${toSlug(candidate.title)}/SKILL.md`;
  } else {
    const sectionDir = path.join(MEMORY_DIR, candidate.section || "User");
    ensureDir(sectionDir);
    const filePath = path.join(sectionDir, `${toSlug(candidate.title)}.md`);
    const fm: Record<string, unknown> = {
      id: toSlug(candidate.title),
      title: candidate.title,
      tags: candidate.tags.length ? candidate.tags : ["learned"],
      updated: today,
    };
    fs.writeFileSync(filePath, stringifyFrontmatter(fm) + "\n\n" + candidate.content + "\n", "utf8");
    addToMoc(candidate.title, candidate.section || "User");
    return `~/.pi/agent/memory/${candidate.section || "User"}/${toSlug(candidate.title)}.md`;
  }
}

async function askEdit(ctx: ExtensionContext, candidate: LearningCandidate): Promise<void> {
  const field = await ctx.ui.input(
    "What do you want to edit? (title / section / tags / content / type / cancel)",
    "title"
  );
  const f = (field ?? "").trim().toLowerCase();
  if (f === "cancel" || f === "") return;

  if (f === "title") {
    const newVal = await ctx.ui.input("New title:", candidate.title);
    if (newVal) candidate.title = newVal;
  } else if (f === "section") {
    const newVal = await ctx.ui.input("New section:", candidate.section);
    if (newVal) candidate.section = newVal;
  } else if (f === "tags") {
    const newVal = await ctx.ui.input("New tags (comma-separated):", candidate.tags.join(", "));
    if (newVal) candidate.tags = newVal.split(",").map((t) => t.trim()).filter(Boolean);
  } else if (f === "content") {
    const newVal = await ctx.ui.editor("Edit content:", candidate.content);
    if (newVal) candidate.content = newVal;
  } else if (f === "type") {
    const newVal = await ctx.ui.input("New type (memory / skill):", candidate.type);
    const nv = (newVal ?? "").trim().toLowerCase();
    if (nv === "memory" || nv === "skill") candidate.type = nv;
  } else {
    ctx.ui.notify(`Unknown field "${f}". Options: title, section, tags, content, type, cancel.`, "warning");
  }
}

async function handleDuplicate(
  ctx: ExtensionContext,
  candidate: LearningCandidate
): Promise<"save" | "skip" | "rename"> {
  const raw = await ctx.ui.input(
    `A memory titled "${candidate.title}" already exists. What do you want to do? (overwrite / skip / rename)`,
    "overwrite"
  );
  const c = (raw ?? "").trim().toLowerCase();
  if (c.startsWith("o")) return "save";
  if (c.startsWith("s")) return "skip";
  if (c.startsWith("r")) return "rename";
  ctx.ui.notify(`Unrecognized "${raw}". Use: overwrite, skip, or rename.`, "warning");
  return handleDuplicate(ctx, candidate);
}

async function askSave(
  ctx: ExtensionContext,
  candidate: LearningCandidate,
  index: number,
  total: number
): Promise<"yes" | "no" | "edit" | "all" | "none"> {
  const label = candidate.type === "skill" ? "SKILL" : "MEMORY";
  const prompt = `Learning candidate ${index + 1}/${total}:
[${label}] ${candidate.title} (${candidate.section})
Reason: ${candidate.reason}

Save? (yes / no / edit / skip / all / none)`;

  const raw = await ctx.ui.input(prompt, "");
  const cleaned = (raw ?? "").trim().toLowerCase();

  if (cleaned.startsWith("y") || cleaned === "save") return "yes";
  if (cleaned.startsWith("n") || cleaned === "skip") return "no";
  if (cleaned.startsWith("e")) return "edit";
  if (cleaned === "all" || cleaned === "save all") return "all";
  if (cleaned === "none" || cleaned === "discard" || cleaned === "stop") return "none";

  ctx.ui.notify(`Unrecognized "${raw}". Options: yes, no, edit, skip, all, none.`, "warning");
  return askSave(ctx, candidate, index, total);
}

async function runWizard(
  candidates: LearningCandidate[],
  ctx: ExtensionContext,
  lastMessageId: string
): Promise<{ saved: number; skipped: number }> {
  let saved = 0;
  let skipped = 0;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    let action = await askSave(ctx, c, i, candidates.length);

    while (true) {
      if (action === "none" || action === "discard" || action === "stop") {
        skipped += candidates.length - i;
        ctx.ui.notify("Discarded remaining candidates.", "info");
        return { saved, skipped };
      }

      if (action === "all" || action === "save all") {
        for (let j = i; j < candidates.length; j++) {
          const dup = isDuplicate(candidates[j].title);
          if (dup) {
            ctx.ui.notify(`Skipped "${candidates[j].title}" (already exists).`, "warning");
            skipped++;
            continue;
          }
          const savedPath = await saveCandidate(candidates[j]);
          ctx.ui.notify(`Saved "${candidates[j].title}" to ${savedPath}`, "success");
          saved++;
        }
        return { saved, skipped };
      }

      if (action === "no" || action === "n" || action === "skip") {
        skipped++;
        break;
      }

      if (action === "edit" || action === "e") {
        await askEdit(ctx, c);
        action = await askSave(ctx, c, i, candidates.length);
        continue;
      }

      if (action === "yes" || action === "y" || action === "save") {
        const dup = isDuplicate(c.title);
        if (dup) {
          const dupAction = await handleDuplicate(ctx, c);
          if (dupAction === "skip") {
            skipped++;
            break;
          }
          if (dupAction === "rename") {
            const newTitle = await ctx.ui.input("New title:", c.title);
            if (newTitle) c.title = newTitle;
            action = await askSave(ctx, c, i, candidates.length);
            continue;
          }
          // overwrite → fall through
        }
        const savedPath = await saveCandidate(c);
        ctx.ui.notify(`Saved "${c.title}" to ${savedPath}`, "success");
        saved++;
        break;
      }

      // Should not reach here
      action = await askSave(ctx, c, i, candidates.length);
    }
  }

  return { saved, skipped };
}

/* ------------------------------------------------------------------ */
/*  Tool: memory                                                       */
/* ------------------------------------------------------------------ */

const MemoryParams = Type.Object({
  action: StringEnum(["read", "list", "search", "move", "delete", "reorganize"] as const),
  id: Type.Optional(Type.String({ description: "Memory id or title (for read, move, delete)" })),
  section: Type.Optional(Type.String({ description: "Filter by section (for list) or destination section (for move)" })),
  query: Type.Optional(Type.String({ description: "Search query (for search)" })),
  newSection: Type.Optional(Type.String({ description: "Destination section (for move)" })),
  newTitle: Type.Optional(Type.String({ description: "New title when moving (optional)" })),
  operation: Type.Optional(StringEnum(["rename_section", "merge_sections", "reorder_items"] as const, { description: "Reorganization type (for reorganize)" })),
  target: Type.Optional(Type.String({ description: "Target section name (for reorganize)" })),
  value: Type.Optional(Type.String({ description: "New name, source section, or comma-separated order (for reorganize)" })),
});

async function handleRead(id: string): Promise<string> {
  const entries = scanVault();
  const normalizedId = id.toLowerCase().trim();
  const slugId = normalizedId.replace(/[\s_]+/g, "-");

  let entry = entries.find((e) => e.id.toLowerCase() === normalizedId);
  if (!entry) entry = entries.find((e) => e.title.toLowerCase() === normalizedId);
  if (!entry) {
    entry = entries.find(
      (e) =>
        e.id.toLowerCase().replace(/[\s_]+/g, "-") === slugId ||
        e.title.toLowerCase().replace(/[\s_]+/g, "-") === slugId
    );
  }
  if (!entry) entry = entries.find((e) => e.title.toLowerCase().includes(normalizedId));
  if (!entry) {
    entry = entries.find((e) => path.basename(e.relPath, ".md").toLowerCase() === normalizedId);
  }

  if (!entry) {
    return `Memory not found: "${id}". Use memory/list or memory/search to discover available memories.`;
  }
  return stringifyFrontmatter(entry.frontmatter) + "\n\n" + entry.body;
}

async function handleList(section?: string): Promise<string> {
  const entries = scanVault();
  const normalizedSection = section?.toLowerCase().trim();
  const filtered = normalizedSection
    ? entries.filter((e) => e.section.toLowerCase() === normalizedSection)
    : entries;
  if (filtered.length === 0) {
    return normalizedSection
      ? `No memories found in section "${section}".`
      : "No memories found in the vault.";
  }
  return filtered
    .map((e) => {
      const tagStr = e.tags.length ? ` [${e.tags.join(", ")}]` : "";
      const secStr = e.section ? ` (${e.section})` : "";
      return `- ${e.title}${secStr}${tagStr}`;
    })
    .join("\n");
}

async function handleSearch(query: string): Promise<string> {
  const normalized = query.toLowerCase().trim();
  if (!normalized) return "Empty search query.";
  const entries = scanVault();
  const matched = entries.filter((e) => {
    const text = `${e.title}\n${e.tags.join(" ")}\n${e.body}`.toLowerCase();
    return text.includes(normalized);
  });
  if (matched.length === 0) return `No memories matching "${query}".`;
  return matched
    .map((e) => {
      const tagStr = e.tags.length ? ` [${e.tags.join(", ")}]` : "";
      const secStr = e.section ? ` (${e.section})` : "";
      return `- ${e.title}${secStr}${tagStr}`;
    })
    .join("\n");
}

async function handleMove(id: string, newSection: string, newTitle?: string): Promise<string> {
  const entries = scanVault();
  const normalizedId = id.toLowerCase().trim();
  let entry = entries.find((e) => e.id.toLowerCase() === normalizedId || e.title.toLowerCase() === normalizedId);
  if (!entry) entry = entries.find((e) => e.title.toLowerCase().includes(normalizedId));
  if (!entry) return `Memory not found: "${id}".`;

  const finalTitle = newTitle ? newTitle.trim() : entry.title;
  const slug = toSlug(finalTitle);

  let newAbsPath: string;
  let newRelPath: string;
  if (entry.relPath.startsWith("skills/")) {
    const oldSkillDir = path.dirname(entry.absPath);
    const newSkillDir = path.join(MEMORY_DIR, "skills", slug);
    ensureDir(path.dirname(newSkillDir));
    fs.renameSync(oldSkillDir, newSkillDir);
    newAbsPath = path.join(newSkillDir, "SKILL.md");
    newRelPath = `skills/${slug}/SKILL.md`;
  } else {
    const destDir = path.join(MEMORY_DIR, newSection || entry.section || "User");
    ensureDir(destDir);
    newAbsPath = path.join(destDir, `${slug}.md`);
    newRelPath = path.relative(MEMORY_DIR, newAbsPath);
    fs.renameSync(entry.absPath, newAbsPath);
  }

  const content = fs.readFileSync(newAbsPath, "utf8");
  const { frontmatter, body } = parseFrontmatter(content);
  if (newTitle) frontmatter.title = finalTitle;
  if (entry.relPath.startsWith("skills/")) {
    frontmatter.name = slug;
  } else {
    frontmatter.id = slug;
  }
  fs.writeFileSync(newAbsPath, stringifyFrontmatter(frontmatter) + "\n\n" + body, "utf8");

  renameInMoc(entry.title, finalTitle, newSection || entry.section);
  return `Moved "${entry.title}" → ${newRelPath}`;
}

async function handleDelete(id: string): Promise<string> {
  const entries = scanVault();
  const normalizedId = id.toLowerCase().trim();
  let entry = entries.find((e) => e.id.toLowerCase() === normalizedId || e.title.toLowerCase() === normalizedId);
  if (!entry) entry = entries.find((e) => e.title.toLowerCase().includes(normalizedId));
  if (!entry) return `Memory not found: "${id}".`;

  if (entry.relPath.startsWith("skills/")) {
    const skillDir = path.dirname(entry.absPath);
    fs.rmSync(skillDir, { recursive: true, force: true });
  } else {
    fs.unlinkSync(entry.absPath);
  }

  removeFromMoc(entry.title, entry.section);
  return `Deleted "${entry.title}".`;
}

async function handleReorganize(operation: string, target?: string, value?: string): Promise<string> {
  if (operation === "rename_section") {
    if (!target || !value) return "Missing target (old section) or value (new section) for rename_section.";
    const entries = scanVault();
    const toRename = entries.filter((e) => e.section.toLowerCase() === target.toLowerCase() && !e.relPath.startsWith("skills/"));
    for (const e of toRename) {
      const newPath = path.join(MEMORY_DIR, value, path.basename(e.relPath));
      ensureDir(path.dirname(newPath));
      if (fs.existsSync(e.absPath)) fs.renameSync(e.absPath, newPath);
      const content = fs.readFileSync(newPath, "utf8");
      const { frontmatter, body } = parseFrontmatter(content);
      frontmatter.section = value;
      fs.writeFileSync(newPath, stringifyFrontmatter(frontmatter) + "\n\n" + body, "utf8");
    }
    const oldDir = path.join(MEMORY_DIR, target);
    if (fs.existsSync(oldDir)) {
      try { fs.rmdirSync(oldDir); } catch {}
    }
    renameSectionInMoc(target, value);
    return `Renamed section "${target}" → "${value}".`;
  }

  if (operation === "merge_sections") {
    if (!target || !value) return "Missing target (destination section) or value (source section) for merge_sections.";
    const srcDir = path.join(MEMORY_DIR, value);
    const tgtDir = path.join(MEMORY_DIR, target);
    if (fs.existsSync(srcDir)) {
      ensureDir(tgtDir);
      for (const file of fs.readdirSync(srcDir)) {
        const srcPath = path.join(srcDir, file);
        const tgtPath = path.join(tgtDir, file);
        if (fs.existsSync(srcPath) && fs.statSync(srcPath).isFile()) {
          fs.renameSync(srcPath, tgtPath);
        }
      }
      fs.rmSync(srcDir, { recursive: true, force: true });
    }
    mergeSectionsInMoc(value, target);
    return `Merged section "${value}" into "${target}".`;
  }

  if (operation === "reorder_items") {
    if (!target || !value) return "Missing target (section) or value (comma-separated item titles) for reorder_items.";
    ensureMoc();
    const content = fs.readFileSync(MOC_PATH, "utf8");
    const { frontmatter, sections } = parseMoc(content);
    const sec = sections.find((s) => s.name.toLowerCase() === target.toLowerCase());
    if (!sec) return `Section "${target}" not found.`;
    const order = value.split(",").map((s) => s.trim()).filter(Boolean);
    const orderedItems: { title: string; link: string }[] = [];
    for (const t of order) {
      const found = sec.items.find((i) => i.title.toLowerCase() === t.toLowerCase());
      if (found) orderedItems.push(found);
    }
    for (const item of sec.items) {
      if (!orderedItems.some((i) => i.title.toLowerCase() === item.title.toLowerCase())) {
        orderedItems.push(item);
      }
    }
    sec.items = orderedItems;
    const lines = [stringifyFrontmatter(frontmatter), "", "# Memory", ""];
    for (const s of sections) {
      lines.push(`## ${s.name}`, "");
      for (const item of s.items) lines.push(`- [[${item.link}]]`);
      lines.push("");
    }
    fs.writeFileSync(MOC_PATH, lines.join("\n"), "utf8");
    return `Reordered items in section "${target}".`;
  }

  return `Unknown reorganize operation: ${operation}. Supported: rename_section, merge_sections, reorder_items.`;
}

/* ------------------------------------------------------------------ */
/*  Tool: learn_wizard                                                 */
/* ------------------------------------------------------------------ */

const LearnWizardParams = Type.Object({
  action: StringEnum(["run", "save"] as const, { description: "run = extract from session + wizard; save = direct save of provided candidate" }),
  granularity: Type.Optional(Type.String({ description: "generic (default) or specific" })),
  candidate: Type.Optional(Type.Object({
    type: StringEnum(["memory", "skill"] as const),
    title: Type.String(),
    section: Type.String(),
    tags: Type.Array(Type.String()),
    content: Type.String(),
  })),
});

async function runLearnWizard(
  ctx: ExtensionContext,
  granularity: string,
): Promise<{ saved: number; skipped: number; lastId: string }> {
  const { text, lastId } = buildMessagesForExtraction(ctx);
  if (text.length === 0) {
    return { saved: 0, skipped: 0, lastId };
  }

  ctx.ui.notify("Analyzing session for learning candidates...", "info");
  const candidates = await callExtractionLLM(ctx, text, granularity);

  if (candidates.length === 0) {
    if (lastId) writeCheckpoint({ lastLearnMessageId: lastId });
    return { saved: 0, skipped: 0, lastId };
  }

  const result = await runWizard(candidates, ctx, lastId);
  if (lastId) writeCheckpoint({ lastLearnMessageId: lastId });
  return { ...result, lastId };
}

/* ------------------------------------------------------------------ */
/*  Skills discovery                                                   */
/* ------------------------------------------------------------------ */

function discoverMemorySkillPaths(): string[] {
  const skillsDir = path.join(MEMORY_DIR, "skills");
  if (!fs.existsSync(skillsDir)) return [];
  return [skillsDir];
}

/* ------------------------------------------------------------------ */
/*  TUI notification queue (widget above editor)                     */
/* ------------------------------------------------------------------ */

interface MemoryNotif {
  id: number;
  text: string;
  expiresAt: number;
}

let notifId = 0;
let activeNotifs: MemoryNotif[] = [];
let widgetTimer: NodeJS.Timeout | null = null;
let latestCtx: ExtensionContext | null = null;

function refreshWidget() {
  if (!latestCtx) return;
  if (activeNotifs.length === 0) {
    latestCtx.ui.setWidget("thetis-memory", undefined);
    return;
  }
  const lines = activeNotifs.map((n) => `🔧 ${n.text}`);
  latestCtx.ui.setWidget("thetis-memory", lines, { placement: "aboveEditor" });
}

function scheduleRefresh() {
  if (widgetTimer) clearTimeout(widgetTimer);
  if (activeNotifs.length === 0) {
    refreshWidget();
    return;
  }
  const now = Date.now();
  const nextExpire = Math.min(...activeNotifs.map((n) => n.expiresAt));
  const delay = Math.max(100, nextExpire - now);
  widgetTimer = setTimeout(() => {
    activeNotifs = activeNotifs.filter((n) => n.expiresAt > Date.now());
    refreshWidget();
    scheduleRefresh();
  }, delay);
}

function pushNotification(text: string, ctx: ExtensionContext) {
  latestCtx = ctx;
  const now = Date.now();
  // Reduce previous notifications' remaining time by 1 second (min 500ms)
  for (const n of activeNotifs) {
    n.expiresAt = Math.max(now + 500, n.expiresAt - 1000);
  }
  activeNotifs.push({ id: ++notifId, text, expiresAt: now + 5000 });
  refreshWidget();
  scheduleRefresh();
}

/* ------------------------------------------------------------------ */
/*  Extension factory                                                  */
/* ------------------------------------------------------------------ */

export default function thetisMemoryExtension(pi: ExtensionAPI) {
  ensureMoc();

  // memory tool
  pi.registerTool({
    name: "memory",
    label: "Memory",
    description:
      "Access and manage the structured knowledge vault (Obsidian-compatible Markdown files).\n\nActions:\n- read: load the full content of a memory by id or title\n- list: list memory titles, optionally filtered by section\n- search: find memories matching the query in titles, tags, or content\n- move: move a memory to a different section (optionally rename) — requires interactive user confirmation\n- delete: permanently remove a memory from the vault — requires interactive user confirmation\n- reorganize: rename sections, merge sections, or reorder items within a section — requires interactive user confirmation",},{
    promptSnippet: "Read, list, search, move, delete, or reorganize the global knowledge vault",
    promptGuidelines: [
      "Use memory/read to load the full content of a known memory when its details are needed for the current task.",
      "Use memory/search to find relevant memories when you are unsure which one applies.",
      "Use memory/list to explore available memories by section.",
      "Use memory/move to relocate or rename a memory. The user will be asked to confirm before the change is applied.",
      "Use memory/delete to permanently remove a memory. The user will be asked to confirm before the deletion is applied.",
      "Use memory/reorganize to restructure sections or reorder the vault layout. The user will be asked to confirm before the change is applied.",
    ],
    parameters: MemoryParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      switch (params.action) {
        case "read": {
          if (!params.id) throw new Error("Missing 'id' parameter for memory/read");
          return { content: [{ type: "text", text: await handleRead(params.id) }], details: {} };
        }
        case "list": {
          return { content: [{ type: "text", text: await handleList(params.section) }], details: {} };
        }
        case "search": {
          if (!params.query) throw new Error("Missing 'query' parameter for memory/search");
          return { content: [{ type: "text", text: await handleSearch(params.query) }], details: {} };
        }
        case "move": {
          if (!params.id) throw new Error("Missing 'id' parameter for memory/move");
          if (!params.newSection && !params.section) throw new Error("Missing 'newSection' or 'section' parameter for memory/move");
          if (!ctx.hasUI) {
            return { content: [{ type: "text", text: "Move cancelled: interactive confirmation required but UI is not available." }], details: {}, isError: true };
          }
          const targetSection = params.newSection ?? params.section ?? "User";
          const ok = await ctx.ui.confirm("Memory vault — Confirm move", `Move "${params.id}" to section "${targetSection}"${params.newTitle ? ` and rename to "${params.newTitle}"` : ""}?`);
          if (!ok) return { content: [{ type: "text", text: "Move cancelled by user." }], details: {} };
          return { content: [{ type: "text", text: await handleMove(params.id, targetSection, params.newTitle) }], details: {} };
        }
        case "delete": {
          if (!params.id) throw new Error("Missing 'id' parameter for memory/delete");
          if (!ctx.hasUI) {
            return { content: [{ type: "text", text: "Delete cancelled: interactive confirmation required but UI is not available." }], details: {}, isError: true };
          }
          const ok = await ctx.ui.confirm("Memory vault — Confirm delete", `Permanently delete "${params.id}" from the vault?`);
          if (!ok) return { content: [{ type: "text", text: "Delete cancelled by user." }], details: {} };
          return { content: [{ type: "text", text: await handleDelete(params.id) }], details: {} };
        }
        case "reorganize": {
          if (!params.operation) throw new Error("Missing 'operation' parameter for memory/reorganize");
          if (!ctx.hasUI) {
            return { content: [{ type: "text", text: "Reorganize cancelled: interactive confirmation required but UI is not available." }], details: {}, isError: true };
          }
          const ok = await ctx.ui.confirm("Memory vault — Confirm reorganize", `Reorganize: ${params.operation}${params.target ? ` on "${params.target}"` : ""}${params.value ? ` with value "${params.value}"` : ""}?`);
          if (!ok) return { content: [{ type: "text", text: "Reorganize cancelled by user." }], details: {} };
          return { content: [{ type: "text", text: await handleReorganize(params.operation, params.target, params.value) }], details: {} };
        }
        default:
          throw new Error(`Unknown memory action: ${params.action}`);
      }
    },
  });

  // learn_wizard tool
  pi.registerTool({
    name: "learn_wizard",
    label: "Learn Wizard",
    description:
      "Interactive wizard to extract and save learning candidates from the session into the global memory vault.\n\nActions:\n- run: analyze recent session messages, extract candidates, then present an interactive wizard to review and save them one by one.\n- save: directly save a provided candidate without wizard interaction.",
    promptSnippet: "Extract and save new knowledge to the memory vault",
    promptGuidelines: [
      "Use learn_wizard/run when the user says something worth remembering (preferences, conventions, procedures, facts).",
      "Use learn_wizard/save when you already have a well-formed candidate and want to save it directly.",
    ],
    parameters: LearnWizardParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "learn_wizard requires an interactive or RPC session (UI not available in print/JSON mode)." }],
          details: {},
          isError: true,
        };
      }

      if (params.action === "save") {
        if (!params.candidate) throw new Error("Missing 'candidate' parameter for learn_wizard/save");
        const savedPath = await saveCandidate(params.candidate as LearningCandidate);
        return { content: [{ type: "text", text: `Saved to ${savedPath}` }], details: {} };
      }

      // action === "run"
      const granularity = params.granularity === "specific" ? "specific" : "generic";
      const result = await runLearnWizard(ctx, granularity);

      if (result.saved === 0 && result.skipped === 0) {
        return {
          content: [{ type: "text", text: "No new learning candidates found since the last checkpoint." }],
          details: { checkpointUpdated: true, lastId: result.lastId },
        };
      }

      return {
        content: [{ type: "text", text: `${result.saved} candidate(s) saved, ${result.skipped} skipped. Checkpoint advanced.` }],
        details: { saved: result.saved, skipped: result.skipped, checkpointUpdated: true, lastId: result.lastId },
      };
    },
  });

  // Inject memory map into system prompt
  pi.on("before_agent_start", async (event) => {
    const memoryContext = buildMemoryContext();
    if (!memoryContext) return;
    return { systemPrompt: event.systemPrompt + "\n\n" + memoryContext };
  });

  // Discover memory skills as Pi skills
  pi.on("resources_discover", () => {
    const skillPaths = discoverMemorySkillPaths();
    return skillPaths.length ? { skillPaths } : undefined;
  });

  // Auto-archive session on every turn and on shutdown
  pi.on("turn_end", async (_event, ctx) => {
    archiveSession(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    archiveSession(ctx);
  });

  // Auto-cleanup old sessions on startup
  pi.on("session_start", async (_event, ctx) => {
    const { deleted } = cleanupOldSessions();
    if (deleted > 0 && ctx.hasUI) {
      ctx.ui.notify(`Auto-cleaned ${deleted} archived session(s) older than 48h`, "info");
    }
  });

  // /learn command
  pi.registerCommand("learn", {
    description: "Extract and save learning candidates from the session (wizard)",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/learn requires an interactive or RPC session.", "error");
        return;
      }

      const granularity =
        args.match(/--granularity\s*=\s*(generic|specific)/)?.[1] ??
        (args.includes("--granularity specific") ? "specific" : "generic");

      const result = await runLearnWizard(ctx, granularity);

      if (result.saved === 0 && result.skipped === 0) {
        ctx.ui.notify("No new learning candidates found since the last checkpoint.", "info");
      } else {
        ctx.ui.notify(
          `Done: ${result.saved} saved, ${result.skipped} skipped. Checkpoint advanced.`,
          "info"
        );
      }
    },
  });

  // Notify TUI widget when memory tools are executed
  pi.on("tool_execution_start", async (event, ctx) => {
    if (event.toolName === "memory" || event.toolName === "learn_wizard") {
      const action = (event.args as any)?.action ?? "";
      pushNotification(`${event.toolName}${action ? "/" + action : ""}`, ctx);
    }
  });

  // Clear notifications on session events
  pi.on("session_start", async () => {
    activeNotifs = [];
    if (widgetTimer) { clearTimeout(widgetTimer); widgetTimer = null; }
    notifId = 0;
    latestCtx = null;
  });

  pi.on("session_shutdown", async () => {
    activeNotifs = [];
    if (widgetTimer) { clearTimeout(widgetTimer); widgetTimer = null; }
    notifId = 0;
    latestCtx = null;
  });

  // /session-history command
  pi.registerCommand("session-history", {
    description: "List archived sessions and restore a previous one",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/session-history requires an interactive or RPC session.", "error");
        return;
      }

      const sessions = listArchivedSessions();
      if (sessions.length === 0) {
        ctx.ui.notify("No archived sessions found.", "info");
        return;
      }

      const choices = sessions.map(
        (s) => `${s.name}  —  ${formatAge(s.mtime)}, ${(s.size / 1024).toFixed(1)} KB`
      );

      const choice = await ctx.ui.select("Select a session to restore:", choices);
      if (!choice) return;

      const index = choices.indexOf(choice);
      if (index === -1 || index >= sessions.length) return;

      const target = sessions[index];

      await ctx.switchSession(target.filePath, {
        withSession: async (newCtx) => {
          newCtx.ui.notify(`Restored session: ${target.name}`, "success");
        },
      });
    },
  });
}
