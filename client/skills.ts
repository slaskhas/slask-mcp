// skills.ts — local skills: discovery, parsing, and loading.
//
// A skill is a directory under `<launch cwd>/skills/` with a `SKILL.md` file
// and an optional YAML frontmatter block:
//
//     ---
//     name: my-skill      (optional; defaults to the directory name)
//     description: …      (one-liner the model uses to decide when to use it)
//     disabled: true      (optional; skip discovery)
//     ---
//     full instructions (markdown)
//
// Only `name` + `description` are ever in context at startup; the model
// decides whether to use a skill by calling the `invoke_skill` tool. That
// call re-reads the skill and returns the full body plus any files bundled
// in the skill directory, all resolved relative to the SKILL.md directory
// (the Claude Code skill convention — those skills drop into `./skills/`
// unchanged). Skills are advisory prompt material: this client never
// executes scripts a skill references.

import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

import type { OpenAiFunctionTool } from "./types.js";

export interface Skill {
  name: string;
  description: string;
  dir: string; // absolute path of the skill directory
}

export interface BundledFile {
  rel: string;
  content: string;
}

export interface LoadedSkill {
  body: string;
  files: BundledFile[];
}

/** Max size (bytes) of a bundled file before it is skipped. */
const BUNDLE_LIMIT = 16384;
/** Max size (chars) of the full skill text returned to the model. */
const OUTPUT_LIMIT = 32768;

type Frontmatter = { name?: string; description?: string; disabled?: boolean };

/**
 * Parse the optional frontmatter of a SKILL.md. Missing frontmatter yields
 * the whole file as the body (name/description fall back at the caller).
 */
function parseFrontmatter(raw: string): { fm: Frontmatter; body: string } {
  const text = raw.replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== "---") {
    return { fm: {}, body: text };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { fm: {}, body: text }; // unterminated block: not frontmatter

  const fm: Frontmatter = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = line.indexOf(":");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key === "disabled") {
      fm.disabled = line.slice(eq + 1).trim() === "true";
      continue;
    }
    if (key !== "name" && key !== "description") continue;
    let value = line.slice(eq + 1).trim();
    if (value.startsWith(">-") || value.startsWith("|")) {
      // Block scalar: join indented continuation lines.
      const parts: string[] = [];
      for (let j = i + 1; j < end; j++) {
        const cl = lines[j];
        if (cl === "" || !/^\s/.test(cl)) break;
        parts.push(cl.trim());
        i++; // consume the continuation line
      }
      value = parts.join(value.startsWith(">-") ? " " : "\n");
    } else if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    fm[key] = value;
  }
  return {
    fm,
    body: lines.slice(end + 1).join("\n").replace(/\n+$/, "").trim(),
  };
}

/**
 * Discover skills: every `skills/<dir>/SKILL.md` under `root`, best-effort
 * (missing `./skills/` => no skills, mirroring the missing-default mcp.json
 * semantics). Results are sorted by directory name; duplicate names keep the
 * first, `disabled: true` and non-directory entries are skipped.
 */
export async function discoverSkills(root: string): Promise<Skill[]> {
  const skillsDir = join(root, "skills");
  let entries: string[] = [];
  try {
    const st = await stat(skillsDir);
    if (st.isDirectory()) {
      entries = (await readdir(skillsDir)).filter((e) => !e.startsWith("."));
    }
  } catch {
    return [];
  }

  const results: Skill[] = [];
  const seen = new Set<string>();
  for (const entry of [...entries].sort()) {
    const raw = await readFile(join(skillsDir, entry, "SKILL.md"), "utf8").catch(() =>
      null,
    );
    if (raw === null) continue;
    const { fm } = parseFrontmatter(raw);
    if (fm.disabled) continue;
    const name = (fm.name ?? entry).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    results.push({
      name,
      description: (fm.description ?? "").trim(),
      dir: join(skillsDir, entry),
    });
  }
  return results;
}

/**
 * Resolve `rel` against a skill directory, throwing if the result would
 * leave that directory (keeps `..` or absolute escapes out of `invoke_skill`
 * output).
 */
export function resolveRef(skillDir: string, rel: string): string {
  const abs = isAbsolute(rel) ? resolve(rel) : resolve(skillDir, rel);
  if (abs !== skillDir && !abs.startsWith(skillDir + sep)) {
    throw new Error(`skill path escapes the skill directory: ${rel}`);
  }
  return abs;
}

function isText(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i += 1) if (buf[i] === 0) return false;
  return true;
}

/**
 * Load a skill: its body (frontmatter stripped) plus every text file bundled
 * in its directory (skipping SKILL.md itself, binaries, and files over
 * BUNDLE_LIMIT). Bundled paths are relative to the skill directory.
 */
export async function loadSkill(skill: Skill): Promise<LoadedSkill> {
  const { body } = parseFrontmatter(await readFile(join(skill.dir, "SKILL.md"), "utf8"));

  const files: BundledFile[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    let entries: string[] = [];
    try {
      entries = (await readdir(dir)).filter((e) => !e.startsWith("."));
    } catch {
      return;
    }
    for (const e of [...entries].sort()) {
      if (rel === "" && e === "SKILL.md") continue;
      const full = join(dir, e);
      const st = await stat(full).catch(() => null);
      if (st === null) continue;
      const relPath = rel ? `${rel}/${e}` : e;
      if (st.isDirectory()) {
        await walk(full, relPath);
      } else if (st.size <= BUNDLE_LIMIT) {
        let buf: Buffer;
        try {
          buf = await readFile(full);
        } catch {
          continue;
        }
        if (buf.length && !isText(buf)) continue;
        files.push({
          rel: relPath,
          content: buf.toString("utf8").replace(/\n+$/, "").trimEnd(),
        });
      }
    }
  }
  await walk(skill.dir, "");
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return { body, files };
}

/**
 * The text returned to the model by `invoke_skill`: the skill body with bundled
 * files appended (path headers), capped to keep context lean. Throws on an
 * unknown skill name.
 */
export async function invokeSkill(skills: Skill[], name: string): Promise<string> {
  const skill = skills.find((s) => s.name === name);
  if (!skill) {
    throw new Error(
      `no skill named "${name}" (available: ${
        skills.length ? skills.map((s) => s.name).join(", ") : "none"
      })`,
    );
  }
  const { body, files } = await loadSkill(skill);
  let out = body;
  if (files.length > 0) {
    out +=
      "\n\n" +
      files.map((f) => `--- ${f.rel} ---\n${f.content}`).join("\n\n");
  }
  if (out.length > OUTPUT_LIMIT) {
    out = out.slice(0, OUTPUT_LIMIT) +
      "\n… [truncated: more than " + OUTPUT_LIMIT + " characters]";
  }
  return out;
}

/** The single synthetic `invoke_skill` function tool (name is an enum). */
export function skillTool(skills: Skill[]): OpenAiFunctionTool {
  return {
    type: "function",
    function: {
      name: "invoke_skill",
      description:
        "Load the full instructions of a local skill (listed in the system " +
        "prompt with its name and description). Call it before doing work a " +
        "skill covers; the result is the skill body plus any files bundled in " +
        "its directory.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            enum: skills.map((s) => s.name),
            description: "the skill to load",
          },
        },
        required: ["name"],
      },
    },
  };
}

/** The system-prompt block listing available skills ("" when none). */
export function skillSystemBlock(skills: Skill[]): string {
  if (skills.length === 0) return "";
  return (
    "\n\nAvailable skills: call `invoke_skill` with a skill name to load its " +
    "full instructions and any bundled files. Use a skill when the user's " +
    "task matches its description.\n" +
    skills.map((s) => `  ${s.name} — ${s.description}`).join("\n")
  );
}
