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

const DEFAULT_SECTIONS = ["Conventions", "User", "Skills"];

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
  action: StringEnum(["read", "list", "search"] as const),
  id: Type.Optional(Type.String({ description: "Memory id or title (for read)" })),
  section: Type.Optional(Type.String({ description: "Filter by section (for list)" })),
  query: Type.Optional(Type.String({ description: "Search query (for search)" })),
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
/*  Extension factory                                                  */
/* ------------------------------------------------------------------ */

export default function thetisMemoryExtension(pi: ExtensionAPI) {
  ensureMoc();

  // memory tool
  pi.registerTool({
    name: "memory",
    label: "Memory",
    description:
      "Access the structured knowledge vault (Obsidian-compatible Markdown files).\n\nActions:\n- read: load the full content of a memory by id or title\n- list: list memory titles, optionally filtered by section\n- search: find memories matching the query in titles, tags, or content",
    promptSnippet: "Read, list, or search the global knowledge vault",
    promptGuidelines: [
      "Use memory/read to load the full content of a known memory when its details are needed for the current task.",
      "Use memory/search to find relevant memories when you are unsure which one applies.",
      "Use memory/list to explore available memories by section.",
    ],
    parameters: MemoryParams,

    async execute(_toolCallId, params) {
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
}
