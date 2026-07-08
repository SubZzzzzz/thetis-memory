/**
 * Thetis Memory Extension
 *
 * Provides a global, Obsidian-compatible Markdown memory vault for Pi.
 *
 * Features:
 * - memory tool: read / list / search the vault
 * - Automatic memory context injection into the system prompt
 * - Dynamic discovery of memory skills as Pi skills
 *
 * Vault location: ~/.pi/agent/memory/
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const MEMORY_DIR = path.join(homedir(), ".pi", "agent", "memory");
const MOC_PATH = path.join(MEMORY_DIR, "MOC.md");

const DEFAULT_SECTIONS = ["Conventions", "User", "Skills"];

/* ------------------------------------------------------------------ */
/*  Frontmatter parser (minimal, dependency-free)                      */
/* ------------------------------------------------------------------ */

interface ParsedMemory {
  frontmatter: Record<string, unknown>;
  body: string;
}

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

    // Strip wrapping quotes
    if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      raw = raw.slice(1, -1);
    }

    // Parse [a, b, c] arrays
    if (raw.startsWith("[") && raw.endsWith("]")) {
      const inner = raw.slice(1, -1);
      if (inner.trim() === "") {
        frontmatter[key] = [];
      } else {
        frontmatter[key] = inner.split(",").map((s) =>
          s.trim().replace(/^["']|["']$/g, "")
        );
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
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
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

function readMemoryEntry(relPath: string): MemoryEntry | null {
  const absPath = path.join(MEMORY_DIR, relPath);
  if (!fs.existsSync(absPath)) return null;

  const content = fs.readFileSync(absPath, "utf8");
  const { frontmatter, body } = parseFrontmatter(content);

  // Derive id (prefer frontmatter.id, then frontmatter.name for skills, then filename)
  const id =
    typeof frontmatter.id === "string" && frontmatter.id
      ? frontmatter.id
      : typeof frontmatter.name === "string" && frontmatter.name
        ? frontmatter.name
        : path.basename(relPath, ".md");

  // Derive title
  let title =
    typeof frontmatter.title === "string" && frontmatter.title
      ? frontmatter.title
      : id;

  // For skills, fall back to directory name if title is missing
  if (
    title === id &&
    relPath.startsWith("skills/") &&
    path.basename(relPath) === "SKILL.md"
  ) {
    const skillName = path.basename(path.dirname(relPath));
    if (skillName && skillName !== ".") title = skillName;
  }

  // Derive tags
  const rawTags = frontmatter.tags;
  const tags: string[] = Array.isArray(rawTags)
    ? rawTags.filter((t): t is string => typeof t === "string")
    : typeof rawTags === "string"
      ? rawTags.split(/[\s,]+/).filter(Boolean)
      : [];

  // Derive section from directory
  let section = "";
  const dirPart = path.dirname(relPath);
  if (dirPart && dirPart !== ".") {
    section = dirPart.split("/")[0];
  }
  // Skills always report as Skills section
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

  // Create default folders
  for (const sec of DEFAULT_SECTIONS) {
    if (sec === "Skills") {
      ensureDir(path.join(MEMORY_DIR, "skills"));
    } else {
      ensureDir(path.join(MEMORY_DIR, sec));
    }
  }

  const frontmatter = { title: "Pi Memory", tags: ["moc", "memory"] };
  const lines = [stringifyFrontmatter(frontmatter), "", "# Memory", ""];
  for (const sec of DEFAULT_SECTIONS) {
    lines.push(`## ${sec}`, "");
  }
  fs.writeFileSync(MOC_PATH, lines.join("\n") + "\n", "utf8");
}

/* ------------------------------------------------------------------ */
/*  Memory map context builder                                         */
/* ------------------------------------------------------------------ */

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
    for (const item of sec.items) {
      lines.push(`- ${item.title}`);
    }
    lines.push("");
  }

  return lines.join("\n");
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

  // 1. Exact id match
  let entry = entries.find((e) => e.id.toLowerCase() === normalizedId);
  // 2. Exact title match
  if (!entry) {
    entry = entries.find((e) => e.title.toLowerCase() === normalizedId);
  }
  // 3. Slug match (title with spaces vs id with hyphens)
  if (!entry) {
    entry = entries.find(
      (e) =>
        e.id.toLowerCase().replace(/[\s_]+/g, "-") === slugId ||
        e.title.toLowerCase().replace(/[\s_]+/g, "-") === slugId
    );
  }
  // 4. Partial title match
  if (!entry) {
    entry = entries.find((e) => e.title.toLowerCase().includes(normalizedId));
  }
  // 5. Filename match
  if (!entry) {
    entry = entries.find(
      (e) => path.basename(e.relPath, ".md").toLowerCase() === normalizedId
    );
  }

  if (!entry) {
    return `Memory not found: "${id}". Use memory/list or memory/search to discover available memories.`;
  }

  const header = stringifyFrontmatter(entry.frontmatter);
  return `${header}\n\n${entry.body}`;
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

  const lines = filtered.map((e) => {
    const tagStr = e.tags.length ? ` [${e.tags.join(", ")}]` : "";
    const secStr = e.section ? ` (${e.section})` : "";
    return `- ${e.title}${secStr}${tagStr}`;
  });

  return lines.join("\n");
}

async function handleSearch(query: string): Promise<string> {
  const normalized = query.toLowerCase().trim();
  if (!normalized) return "Empty search query.";

  const entries = scanVault();
  const matched = entries.filter((e) => {
    const text = `${e.title}\n${e.tags.join(" ")}\n${e.body}`.toLowerCase();
    return text.includes(normalized);
  });

  if (matched.length === 0) {
    return `No memories matching "${query}".`;
  }

  const lines = matched.map((e) => {
    const tagStr = e.tags.length ? ` [${e.tags.join(", ")}]` : "";
    const secStr = e.section ? ` (${e.section})` : "";
    return `- ${e.title}${secStr}${tagStr}`;
  });

  return lines.join("\n");
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

export default function piMemoryExtension(pi: ExtensionAPI) {
  // Ensure vault structure exists
  ensureMoc();

  // Register memory tool
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
          if (!params.id) {
            throw new Error("Missing 'id' parameter for memory/read");
          }
          const content = await handleRead(params.id);
          return { content: [{ type: "text", text: content }], details: {} };
        }
        case "list": {
          const content = await handleList(params.section);
          return { content: [{ type: "text", text: content }], details: {} };
        }
        case "search": {
          if (!params.query) {
            throw new Error("Missing 'query' parameter for memory/search");
          }
          const content = await handleSearch(params.query);
          return { content: [{ type: "text", text: content }], details: {} };
        }
        default:
          throw new Error(`Unknown memory action: ${params.action}`);
      }
    },
  });

  // Inject memory map into system prompt on every turn
  pi.on("before_agent_start", async (event) => {
    const memoryContext = buildMemoryContext();
    if (!memoryContext) return;

    return {
      systemPrompt: event.systemPrompt + "\n\n" + memoryContext,
    };
  });

  // Discover memory skills as Pi skills
  pi.on("resources_discover", () => {
    const skillPaths = discoverMemorySkillPaths();
    return skillPaths.length ? { skillPaths } : undefined;
  });
}
