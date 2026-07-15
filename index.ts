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

function yamlQuote(value: string): string {
  // Keep plain scalars unquoted when safe; quote everything else so the
  // generated YAML survives colons, commas, hashes and special characters.
  if (value === "") return '""';
  if (/^[a-zA-Z0-9_.~/-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function stringifyFrontmatter(frontmatter: Record<string, unknown>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((v) => yamlQuote(String(v))).join(", ")}]`);
    } else {
      lines.push(`${key}: ${yamlQuote(String(value))}`);
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
    "",
    "MANDATORY MEMORY LOADING PROTOCOL:",
    "1. Before beginning your reasoning or thinking process for the user's request, scan the memory map above.",
    "2. If any memory title, tag, or skill is even remotely relevant to the user's request, you MUST call memory/read to load its full content.",
    "3. Do NOT rely on titles, do NOT guess. Read relevant memories first, then reason and answer.",
    "4. If you are unsure which memory applies, use memory/search.",
    "5. After reading, only keep a memory in your reasoning if its content actually helps solve the user's request. If it does not help, ignore it and do not mention it.",
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

function buildOpenAICompatibleUrl(baseUrl: string, suffix: string): string {
  const url = new URL(baseUrl);
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/v1")) {
    url.pathname = pathname + suffix;
  } else {
    url.pathname = pathname + "/v1" + suffix;
  }
  return url.toString();
}

async function callModel(
  ctx: ExtensionContext,
  prompt: string,
  maxTokens = 4096
): Promise<string> {
  const model = ctx.model;
  if (!model) throw new Error("No model configured. Set a model with /model before using this feature.");

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

  let url: string;
  let body: unknown;
  let extractText: (res: any) => string;

  if (api === "anthropic-messages") {
    url = `${baseUrl}/v1/messages`;
    body = {
      model: model.id,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    };
    extractText = (res: any) => res.content?.[0]?.text ?? "";
  } else {
    // openai-completions, openai-responses, or any OpenAI-compatible endpoint.
    // Pi's model.baseUrl may already include /v1 (OpenAI, OpenCode Go, Together)
    // or may not (DeepSeek, some Fireworks configs), so we add /v1 only when absent.
    const suffix = api === "openai-responses" ? "/responses" : "/chat/completions";
    url = buildOpenAICompatibleUrl(baseUrl, suffix);
    body = {
      model: model.id,
      messages: [{ role: "user", content: prompt }],
    };
    extractText = (res: any) =>
      res.choices?.[0]?.message?.content ?? res.output?.[0]?.content?.[0]?.text ?? "";
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
    throw new Error(`LLM API error ${response.status} for ${url}: ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  return extractText(data);
}

async function callExtractionLLM(
  ctx: ExtensionContext,
  messages: string,
  granularity: string
): Promise<LearningCandidate[]> {
  const prompt = buildExtractionPrompt(messages, granularity);
  const text = await callModel(ctx, prompt, 4096);

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

async function updateMocWithLLM(ctx: ExtensionContext): Promise<void> {
  const entries = scanVault();
  const currentMoc = fs.existsSync(MOC_PATH) ? fs.readFileSync(MOC_PATH, "utf8") : "";

  const entryDescriptions = entries
    .map((e) => {
      const preview = e.body.replace(/\s+/g, " ").trim().slice(0, 200);
      return `- [${e.section || "Uncategorized"}] ${e.title} (tags: ${e.tags.join(", ") || "none"})\n  ${preview}`;
    })
    .join("\n");

  const prompt = `You are organizing a personal knowledge vault for Pi.
Update the Map of Content (MOC.md) based on the current memory entries below.

The MOC must use this exact format:

---
title: Pi Memory
tags: [moc, memory]
---

# Memory

## <Section Name>
- [[Memory Title]]

Rules:
1. Keep the frontmatter exactly as shown.
2. Group entries into clear, logical sections. You may create new sections, rename sections, or merge sections as needed.
3. List each memory as a bullet with an Obsidian-style link: - [[Title]]
4. Do NOT add descriptions, tags, or extra text after the links.
5. Ensure each memory appears exactly once.
6. Return ONLY the MOC content, with no markdown code block wrapper and no explanation.

Current MOC:
${currentMoc || "(empty)"}

Memory entries:
${entryDescriptions || "(none)"}

Updated MOC:`;

  const text = await callModel(ctx, prompt, 4096);
  const cleaned = text
    .replace(/^```markdown\s*/i, "")
    .replace(/^```\s*/, "")
    .replace(/```$/, "")
    .trim();

  if (!cleaned.startsWith("---") || !cleaned.includes("# Memory")) {
    throw new Error("LLM response does not look like a valid MOC.");
  }

  fs.writeFileSync(MOC_PATH, cleaned + "\n", "utf8");

  // Safety net: if the LLM dropped an entry, add it back mechanically.
  const { sections } = parseMoc(cleaned);
  const presentTitles = new Set(
    sections.flatMap((s) => s.items.map((i) => i.title.toLowerCase()))
  );
  for (const e of entries) {
    if (!presentTitles.has(e.title.toLowerCase())) {
      addToMoc(e.title, e.section || "Uncategorized");
    }
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
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, MAX_SLUG_LENGTH);
}

function normalizeSkillName(title: string): string {
  // Pi skill names: lowercase a-z, 0-9, hyphens; no leading/trailing/consecutive hyphens; max 64.
  return toSlug(title).slice(0, 64);
}

function buildSkillDescription(candidate: LearningCandidate): string {
  if (candidate.reason && candidate.reason.trim().length > 0) {
    return candidate.reason.trim().slice(0, 1024);
  }
  const preview = candidate.content.replace(/\s+/g, " ").trim();
  if (preview.length > 0) {
    const suffix = preview.length > 200 ? "..." : "";
    return (preview.slice(0, 200) + suffix).slice(0, 1024);
  }
  return "Skill learned from session.";
}

function isDuplicate(title: string): MemoryEntry | null {
  return scanVault().find((e) => e.title.toLowerCase() === title.toLowerCase()) ?? null;
}

async function saveCandidate(candidate: LearningCandidate, ctx?: ExtensionContext): Promise<string> {
  // Refuse oversized content to avoid filling the disk and blocking the TUI.
  if (candidate.content.length > MAX_CONTENT_CHARS) {
    throw new Error(
      `Refusing to save: content is ${candidate.content.length} chars ` +
        `(max ${MAX_CONTENT_CHARS}).`
    );
  }

  if (candidate.type === "skill") {
    const skillName = normalizeSkillName(candidate.title);
    safeSlug(skillName, candidate.title); // validates non-empty / not hidden / length
    const skillDir = path.join(MEMORY_DIR, "skills", skillName);
    ensureDir(skillDir);
    const skillPath = path.join(skillDir, "SKILL.md");
    const fm = {
      name: skillName,
      description: buildSkillDescription(candidate),
      tags: candidate.tags.length ? candidate.tags : ["skill", "learned"],
    };
    // Ensure the skill body starts with an H1 so it matches the Pi skill format.
    let body = candidate.content.trim();
    if (!body.startsWith("# ")) {
      body = `# ${candidate.title}\n\n${body}`;
    }
    fs.writeFileSync(skillPath, stringifyFrontmatter(fm) + "\n\n" + body + "\n", "utf8");
    addToMoc(candidate.title, "Skills");
    return `~/.pi/agent/memory/skills/${skillName}/SKILL.md`;
  } else {
    const slug = safeSlug(toSlug(candidate.title), candidate.title);
    const section = safeSection(candidate.section);
    const sectionDir = path.join(MEMORY_DIR, section);
    ensureDir(sectionDir);
    const filePath = path.join(sectionDir, `${slug}.md`);
    const fm: Record<string, unknown> = {
      id: slug,
      title: candidate.title,
      tags: candidate.tags.length ? candidate.tags : ["learned"],
      updated: new Date().toISOString().slice(0, 10),
    };
    fs.writeFileSync(filePath, stringifyFrontmatter(fm) + "\n\n" + candidate.content + "\n", "utf8");
    addToMoc(candidate.title, section);
    return `~/.pi/agent/memory/${section}/${slug}.md`;
  }
}

async function askEdit(ctx: ExtensionContext, candidate: LearningCandidate): Promise<void> {
  const field = await ctx.ui.select("What do you want to edit?", [
    "title",
    "section",
    "tags",
    "content",
    "type",
    "cancel",
  ]);
  if (!field || field.toLowerCase() === "cancel") return;

  if (field === "title") {
    const newVal = await ctx.ui.input("New title:", candidate.title);
    if (newVal) candidate.title = newVal;
  } else if (field === "section") {
    const newVal = await ctx.ui.input("New section:", candidate.section);
    if (newVal) candidate.section = newVal;
  } else if (field === "tags") {
    const newVal = await ctx.ui.input("New tags (comma-separated):", candidate.tags.join(", "));
    if (newVal) candidate.tags = newVal.split(",").map((t) => t.trim()).filter(Boolean);
  } else if (field === "content") {
    const newVal = await ctx.ui.editor("Edit content:", candidate.content);
    if (newVal) candidate.content = newVal;
  } else if (field === "type") {
    const newVal = await ctx.ui.select("New type:", ["memory", "skill"]);
    if (newVal === "memory" || newVal === "skill") candidate.type = newVal;
  }
}

async function handleDuplicate(
  ctx: ExtensionContext,
  candidate: LearningCandidate
): Promise<"save" | "skip" | "rename"> {
  const choice = await ctx.ui.select(
    `A memory titled "${candidate.title}" already exists. What do you want to do?`,
    ["overwrite", "skip", "rename"]
  );
  if (!choice) return "skip";
  const c = choice.toLowerCase();
  if (c === "overwrite") return "save";
  if (c === "skip") return "skip";
  if (c === "rename") return "rename";
  return "skip";
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
Reason: ${candidate.reason}`;

  const choice = await ctx.ui.select(
    `${prompt}\n\nSave?`,
    ["yes", "no", "edit", "all", "none"]
  );
  if (!choice) return "none";
  const c = choice.toLowerCase();
  if (c === "yes") return "yes";
  if (c === "no") return "no";
  if (c === "edit") return "edit";
  if (c === "all") return "all";
  if (c === "none") return "none";
  return "no";
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
          const savedPath = await saveCandidate(candidates[j], ctx);
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
        const savedPath = await saveCandidate(c, ctx);
        ctx.ui.notify(`Saved "${c.title}" to ${savedPath}`, "success");
        saved++;
        break;
      }

      // Should not reach here
      action = await askSave(ctx, c, i, candidates.length);
    }
  }

  if (saved > 0) {
    try {
      await updateMocWithLLM(ctx);
    } catch (e: any) {
      ctx.ui.notify(`Saved ${saved} item(s), but MOC LLM update failed: ${e.message}`, "warning");
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
  const entry = findEntry(id);
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

async function handleMove(id: string, newSection: string, newTitle?: string, ctx?: ExtensionContext): Promise<string> {
  const entry = findEntry(id);
  if (!entry) return `Memory not found: "${id}".`;

  const finalTitle = newTitle ? newTitle.trim() : entry.title;
  const isSkill = entry.relPath.startsWith("skills/");
  const slug = isSkill
    ? normalizeSkillName(finalTitle)
    : safeSlug(toSlug(finalTitle), finalTitle);
  const targetSection = safeSection(newSection || entry.section);

  let newAbsPath: string;
  let newRelPath: string;
  if (isSkill) {
    const oldSkillDir = path.dirname(entry.absPath);
    const newSkillDir = path.join(MEMORY_DIR, "skills", slug);
    ensureDir(path.dirname(newSkillDir));
    fs.renameSync(oldSkillDir, newSkillDir);
    newAbsPath = path.join(newSkillDir, "SKILL.md");
    newRelPath = `skills/${slug}/SKILL.md`;
  } else {
    const destDir = path.join(MEMORY_DIR, targetSection);
    ensureDir(destDir);
    newAbsPath = path.join(destDir, `${slug}.md`);
    newRelPath = path.relative(MEMORY_DIR, newAbsPath);
    fs.renameSync(entry.absPath, newAbsPath);
  }

  const content = fs.readFileSync(newAbsPath, "utf8");
  const { frontmatter, body } = parseFrontmatter(content);
  if (newTitle) frontmatter.title = finalTitle;
  if (isSkill) {
    frontmatter.name = slug;
  } else {
    frontmatter.id = slug;
  }
  fs.writeFileSync(newAbsPath, stringifyFrontmatter(frontmatter) + "\n\n" + body, "utf8");

  renameInMoc(entry.title, finalTitle, targetSection);

  if (ctx) {
    try {
      await updateMocWithLLM(ctx);
    } catch {
      // Mechanical MOC update is already done; ignore LLM failure.
    }
  }

  return `Moved "${entry.title}" → ${newRelPath}`;
}

async function handleDelete(id: string, ctx?: ExtensionContext): Promise<string> {
  const entry = findEntry(id);
  if (!entry) return `Memory not found: "${id}".`;

  if (entry.relPath.startsWith("skills/")) {
    const skillDir = path.dirname(entry.absPath);
    fs.rmSync(skillDir, { recursive: true, force: true });
  } else {
    fs.unlinkSync(entry.absPath);
  }

  removeFromMoc(entry.title, entry.section);

  if (ctx) {
    try {
      await updateMocWithLLM(ctx);
    } catch {
      // Mechanical MOC update is already done; ignore LLM failure.
    }
  }

  return `Deleted "${entry.title}".`;
}

async function handleReorganize(operation: string, target?: string, value?: string): Promise<string> {
  if (operation === "rename_section") {
    if (!target || !value) return "Missing target (old section) or value (new section) for rename_section.";
    const newSection = safeSection(value);          // validate the NEW section name
    const oldSection = safeSection(target);          // validate the OLD section name
    const entries = scanVault();
    const toRename = entries.filter((e) => e.section.toLowerCase() === oldSection.toLowerCase() && !e.relPath.startsWith("skills/"));
    for (const e of toRename) {
      const newPath = path.join(MEMORY_DIR, newSection, path.basename(e.relPath));
      ensureDir(path.dirname(newPath));
      if (fs.existsSync(e.absPath)) fs.renameSync(e.absPath, newPath);
      const content = fs.readFileSync(newPath, "utf8");
      const { frontmatter, body } = parseFrontmatter(content);
      frontmatter.section = newSection;
      fs.writeFileSync(newPath, stringifyFrontmatter(frontmatter) + "\n\n" + body, "utf8");
    }
    const oldDir = path.join(MEMORY_DIR, oldSection);
    if (fs.existsSync(oldDir)) {
      try { fs.rmdirSync(oldDir); } catch {}
    }
    renameSectionInMoc(oldSection, newSection);
    return `Renamed section "${oldSection}" → "${newSection}".`;
  }

  if (operation === "merge_sections") {
    if (!target || !value) return "Missing target (destination section) or value (source section) for merge_sections.";
    const targetSection = safeSection(target);       // destination (validated)
    const sourceSection = safeSection(value);        // source (validated)
    if (sourceSection.toLowerCase() === targetSection.toLowerCase()) {
      return `Source and destination sections are the same ("${targetSection}").`;
    }
    const srcDir = path.join(MEMORY_DIR, sourceSection);
    const tgtDir = path.join(MEMORY_DIR, targetSection);
    if (fs.existsSync(srcDir)) {
      ensureDir(tgtDir);
      for (const file of fs.readdirSync(srcDir)) {
        const srcPath = path.join(srcDir, file);
        const tgtPath = path.join(tgtDir, file);
        if (fs.existsSync(srcPath) && fs.statSync(srcPath).isFile()) {
          // Avoid silent overwrites: if the target file already exists, skip it.
          if (!fs.existsSync(tgtPath)) fs.renameSync(srcPath, tgtPath);
        }
      }
      fs.rmSync(srcDir, { recursive: true, force: true });
    }
    mergeSectionsInMoc(sourceSection, targetSection);
    return `Merged section "${sourceSection}" into "${targetSection}".`;
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
  const paths: string[] = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const skillMd = path.join(skillsDir, entry.name, "SKILL.md");
      if (fs.existsSync(skillMd)) {
        paths.push(path.join(skillsDir, entry.name));
      }
    }
  }
  return paths;
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
/*  Validation & Confirmation                                          */
/* ------------------------------------------------------------------ */

const MAX_CONTENT_CHARS = 100_000; // 100 KB per file
const MAX_SECTION_LENGTH = 64;
const MAX_SLUG_LENGTH = 64;

/**
 * Validates a user-supplied section name. Rejects path traversal and
 * characters that would let the caller escape MEMORY_DIR. Returns the
 * trimmed name on success, throws on rejection.
 */
function safeSection(s: string | undefined, fallback: string = "User"): string {
  if (!s) return fallback;
  const trimmed = s.trim();
  if (
    trimmed.length === 0 ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0") ||
    trimmed.includes("..") ||
    trimmed.startsWith(".") ||
    /[\x00-\x1f]/.test(trimmed) ||
    trimmed.length > MAX_SECTION_LENGTH
  ) {
    throw new Error(
      `Invalid section name: "${s}". Sections must be a single path segment ` +
        `(no "/", "\\", "..", or control chars), not start with ".", and be at most ${MAX_SECTION_LENGTH} chars.`
    );
  }
  return trimmed;
}

/**
 * Validates a slug used as a filename. Rejects empty, dot-prefixed, and
 * over-long slugs to prevent hidden files and path injection.
 */
function safeSlug(slug: string, originalTitle: string): string {
  if (!slug) {
    throw new Error(`Cannot derive a valid filename from title "${originalTitle}".`);
  }
  if (slug.startsWith(".")) {
    throw new Error(`Title "${originalTitle}" produces a hidden filename "${slug}".`);
  }
  if (slug.length > MAX_SLUG_LENGTH) {
    throw new Error(
      `Title "${originalTitle}" produces a filename longer than ${MAX_SLUG_LENGTH} chars.`
    );
  }
  return slug;
}

/**
 * Resolves a user-supplied id/title to a vault entry, using the same
 * matching strategy as memory/read (exact, slug-normalized, includes, basename).
 */
function findEntry(idOrTitle: string): MemoryEntry | null {
  const entries = scanVault();
  const normalized = idOrTitle.toLowerCase().trim();
  const slugId = normalized.replace(/[\s_]+/g, "-");

  let entry = entries.find(
    (e) => e.id.toLowerCase() === normalized || e.title.toLowerCase() === normalized
  );
  if (!entry) {
    entry = entries.find(
      (e) =>
        e.id.toLowerCase().replace(/[\s_]+/g, "-") === slugId ||
        e.title.toLowerCase().replace(/[\s_]+/g, "-") === slugId
    );
  }
  if (!entry) entry = entries.find((e) => e.title.toLowerCase().includes(normalized));
  if (!entry)
    entry = entries.find((e) => path.basename(e.relPath, ".md").toLowerCase() === normalized);
  return entry ?? null;
}

/**
 * Asks the user to confirm a sensitive action. Routes through the gateway
 * extension (Discord/WhatsApp) if `__gatewayConfirm` is exposed, otherwise
 * falls back to the TUI dialog. Refuses (returns false) when no UI is
 * available or the gateway handler fails.
 */
async function confirmAction(ctx: ExtensionContext, question: string): Promise<boolean> {
  const gatewayConfirm = (globalThis as any).__gatewayConfirm;
  if (typeof gatewayConfirm === "function") {
    try {
      const result = await gatewayConfirm(question);
      if (result === true) return true;
      if (result === false) return false;
      // result === null : pas de thread gateway actif — fallback TUI.
    } catch {
      // Gateway handler failed — fall through to TUI.
    }
  }
  if (ctx.hasUI) {
    return await ctx.ui.confirm("Memory vault — Confirm action", question);
  }
  return false;
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
      "Access and manage the structured knowledge vault (Obsidian-compatible Markdown files).\n\nActions:\n- read: load the full content of a memory by id or title\n- list: list memory titles, optionally filtered by section\n- search: find memories matching the query in titles, tags, or content\n- move: move a memory to a different section (optionally rename) — requires interactive user confirmation\n- delete: permanently remove a memory from the vault — requires interactive user confirmation\n- reorganize: rename sections, merge sections, or reorder items within a section — requires interactive user confirmation",
    promptSnippet: "Read, list, search, move, delete, or reorganize the global knowledge vault",
    promptGuidelines: [
      "Use memory/read to load the full content of a known memory when its details are needed for the current task.",
      "Use memory/search to find relevant memories when you are unsure which one applies.",
      "Use memory/list to explore available memories by section.",
      "Use memory/move to relocate or rename a memory. The exact target is shown to the user before the change is applied.",
      "Use memory/delete to permanently remove a memory. The exact target is shown to the user before the deletion is applied.",
      "Use memory/reorganize to restructure sections or reorder the vault layout. Section names are validated against path traversal before any change is applied.",
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
          // Resolve the entry *before* confirming so the dialog shows the exact
          // memory that will be moved (not the raw, possibly ambiguous, id).
          const entry = findEntry(params.id);
          if (!entry) {
            return { content: [{ type: "text", text: `Memory not found: "${params.id}".` }], details: {}, isError: true };
          }
          // Validate the destination section up front so the confirmation and
          // the actual move use the same sanitized value.
          let targetSection: string;
          try {
            targetSection = safeSection(params.newSection || params.section);
          } catch (e: any) {
            return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
          }
          const renameSuffix = params.newTitle ? ` and rename to "${params.newTitle}"` : "";
          const ok = await confirmAction(
            ctx,
            `Move "${entry.title}" (${entry.relPath}) to section "${targetSection}"${renameSuffix}?`
          );
          if (!ok) return { content: [{ type: "text", text: "Move cancelled by user." }], details: {} };
          return { content: [{ type: "text", text: await handleMove(params.id, targetSection, params.newTitle, ctx) }], details: {} };
        }
        case "delete": {
          if (!params.id) throw new Error("Missing 'id' parameter for memory/delete");
          // Resolve the entry *before* confirming so the dialog shows the exact
          // memory that will be deleted (not the raw, possibly ambiguous, id).
          const entry = findEntry(params.id);
          if (!entry) {
            return { content: [{ type: "text", text: `Memory not found: "${params.id}".` }], details: {}, isError: true };
          }
          const ok = await confirmAction(
            ctx,
            `Permanently delete "${entry.title}" (${entry.relPath}) from the vault?`
          );
          if (!ok) return { content: [{ type: "text", text: "Delete cancelled by user." }], details: {} };
          return { content: [{ type: "text", text: await handleDelete(params.id, ctx) }], details: {} };
        }
        case "reorganize": {
          if (!params.operation) throw new Error("Missing 'operation' parameter for memory/reorganize");
          // For filesystem-touching operations, validate section names up front
          // so a malicious or malformed value never reaches path.join.
          if (params.operation === "rename_section" || params.operation === "merge_sections") {
            try {
              if (params.target) safeSection(params.target);
              if (params.value) safeSection(params.value);
            } catch (e: any) {
              return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
            }
          }
          const ok = await confirmAction(
            ctx,
            `Reorganize: ${params.operation}${params.target ? ` on "${params.target}"` : ""}${params.value ? ` with value "${params.value}"` : ""}?`
          );
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
      "Interactive wizard to extract and save learning candidates from the session into the global memory vault.\n\nActions:\n- run: analyze recent session messages, extract candidates, then present an interactive wizard to review and save them one by one.\n- save: directly save a provided candidate. Requires interactive user confirmation (type, title, section, and a content preview are shown before write).",
    promptSnippet: "Extract and save new knowledge to the memory vault",
    promptGuidelines: [
      "Use learn_wizard/run when the user says something worth remembering (preferences, conventions, procedures, facts). A model must be configured with /model first.",
      "Use learn_wizard/save when you already have a well-formed candidate and want to save it directly. The user will be asked to confirm before anything is written.",
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
        const candidate = params.candidate as LearningCandidate;

        // Validate up front: refuse unsafe section names or oversized content
        // before bothering the user with a confirmation dialog.
        let section: string;
        try {
          section = safeSection(candidate.section);
          if (candidate.content.length > MAX_CONTENT_CHARS) {
            return {
              content: [{ type: "text", text: `Refusing to save: content is ${candidate.content.length} chars (max ${MAX_CONTENT_CHARS}).` }],
              details: {},
              isError: true,
            };
          }
        } catch (e: any) {
          return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
        }

        // Compute the target path so the confirmation message is unambiguous.
        const slug = candidate.type === "skill" ? normalizeSkillName(candidate.title) : toSlug(candidate.title);
        const preview = candidate.type === "skill"
          ? `~/.pi/agent/memory/skills/${slug}/SKILL.md`
          : `~/.pi/agent/memory/${section}/${slug}.md`;
        const contentPreview = candidate.content.length > 240
          ? candidate.content.slice(0, 240) + "…"
          : candidate.content;
        const tagList = candidate.tags.length ? candidate.tags.join(", ") : "(none)";

        const ok = await confirmAction(
          ctx,
          `Save ${candidate.type.toUpperCase()} "${candidate.title}" → ${preview}\n` +
            `Section: ${section}\n` +
            `Tags: ${tagList}\n\n` +
            `---\n${contentPreview}\n---`
        );
        if (!ok) return { content: [{ type: "text", text: "Save cancelled by user." }], details: {} };

        const savedPath = await saveCandidate(candidate, ctx);
        try {
          await updateMocWithLLM(ctx);
        } catch (e: any) {
          ctx.ui.notify(`Saved to ${savedPath}, but MOC LLM update failed: ${e.message}`, "warning");
        }
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

  /* ------------------------------------------------------------------ */
  /*  Tool: tui_question (global TUI wizard)                             */
  /* ------------------------------------------------------------------ */

  const TuiQuestionParams = Type.Object({
    action: StringEnum(["confirm", "select", "input", "editor"] as const, { description: "Type of TUI interaction" }),
    question: Type.String({ description: "Question or prompt text" }),
    options: Type.Optional(Type.Array(Type.String(), { description: "Options for select action" })),
    defaultValue: Type.Optional(Type.String({ description: "Default value for input/editor" })),
    timeoutSeconds: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 300)" })),
  });

  pi.registerTool({
    name: "tui_question",
    label: "TUI Question",
    description:
      "Global TUI wizard for interactive user questions and confirmations.\n\nActions:\n- confirm: ask a yes/no confirmation\n- select: ask the user to pick from a list of options\n- input: ask for a single-line text input\n- editor: ask for multi-line text input in an editor",
    promptSnippet: "Ask the user a question or confirmation via the TUI",
    promptGuidelines: [
      "Use tui_question/confirm when you need an explicit yes/no approval before a sensitive action.",
      "Use tui_question/select when the user must choose one option from a predefined list.",
      "Use tui_question/input for short free-text answers.",
      "Use tui_question/editor for longer free-text answers or code.",
      "Always provide clear, concise question text.",
    ],
    parameters: TuiQuestionParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "tui_question requires an interactive or RPC session (UI not available in print/JSON mode)." }],
          details: {},
          isError: true,
        };
      }

      switch (params.action) {
        case "confirm": {
          const ok = await ctx.ui.confirm(params.question, params.options?.[0] || "");
          return {
            content: [{ type: "text", text: ok ? "yes" : "no" }],
            details: { confirmed: ok },
          };
        }
        case "select": {
          if (!params.options || params.options.length === 0) {
            throw new Error("Missing 'options' parameter for tui_question/select");
          }
          const timeout = params.timeoutSeconds ? params.timeoutSeconds * 1000 : undefined;
          const choice = await ctx.ui.select(params.question, params.options, timeout ? { timeout } : undefined);
          return {
            content: [{ type: "text", text: choice ?? "cancelled" }],
            details: { choice },
          };
        }
        case "input": {
          const value = await ctx.ui.input(params.question, params.defaultValue || "");
          return {
            content: [{ type: "text", text: value ?? "cancelled" }],
            details: { value },
          };
        }
        case "editor": {
          const value = await ctx.ui.editor(params.question, params.defaultValue || "");
          return {
            content: [{ type: "text", text: value ?? "cancelled" }],
            details: { value },
          };
        }
        default:
          throw new Error(`Unknown tui_question action: ${params.action}`);
      }
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
    if (event.toolName === "memory" || event.toolName === "learn_wizard" || event.toolName === "tui_question") {
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
