// skills.ts — local skills: discovery, parsing, loading, and script execution.
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
// Only `name` + `description` (plus a list of runnable scripts) are ever in
// context at startup; the model decides whether to use a skill by calling the
// `invoke_skill` tool. That call re-reads the skill and returns the full body
// plus any files bundled in the skill directory, all resolved relative to the
// SKILL.md directory (the Claude Code skill convention — those skills drop into
// `./skills/` unchanged).
//
// Skills may also contain a `scripts/` folder. Those files are the only parts
// of a skill this client can *execute* (via `run_skill_script`):
//   - only files under `<skill>/scripts/` (no escapes),
//   - only `.sh`, `.py`, or `.js` (run via `bash`/`python3`/`node`),
//   - no shell string interpolation — args are separate argv elements,
//   - a 30 s timeout and a capped output,
//   - cwd = launch cwd; env inherits process.env plus SLASK_SKILL_DIR=<skill dir>.
// Execution is the user's responsibility: the client trusts the skills it is
// given (this is a local dev tool operating on user-authored skill dirs).

import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, resolve, sep } from "node:path";

import type { CallToolResult, OpenAiFunctionTool } from "./types.js";

export interface Skill {
  name: string;
  description: string;
  dir: string; // absolute path of the skill directory
  scripts: string[]; // runnable scripts in scripts/ (lowercase, .sh/.py/.js)
}

export interface BundledFile {
  rel: string;
  content: string;
}

export interface LoadedSkill {
  body: string;
  files: BundledFile[];
}

export interface ExecScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Max size (bytes) of a bundled file before it is skipped. */
const BUNDLE_LIMIT = 16384;
/** Max size (chars) of the full skill text returned to the model. */
const OUTPUT_LIMIT = 32768;
/** Extensions of the only scripts this client will execute. */
const SCRIPT_EXTS = [".sh", ".py", ".js"];
/** Hard cap on how long a skill script may run. */
const SCRIPT_TIMEOUT_MS = 30_000;

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

/** Filenames in `skillDir/scripts/` that are executable (allowed extensions). */
async function listScripts(skillDir: string): Promise<string[]> {
  const scriptsDir = join(skillDir, "scripts");
  let entries: string[] = [];
  try {
    entries = await readdir(scriptsDir);
  } catch {
    return [];
  }
  return entries
    .filter((e) => !e.startsWith("."))
    .filter((e) => SCRIPT_EXTS.includes(extname(e).toLowerCase()))
    .sort();
}

/**
 * Discover skills: every `skills/<dir>/SKILL.md` under `root`, best-effort
 * (missing `./skills/` => no skills, mirroring the missing-default mcp.json
 * semantics). Results are sorted by directory name; duplicate names keep the
 * first, `disabled: true` and non-directory entries are skipped. Each skill
 * also records its runnable `scripts/` entries.
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
      scripts: await listScripts(join(skillsDir, entry)),
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
 * in its directory (skipping SKILL.md itself, the `scripts/` folder —
 * executable code, run via `run_skill_script`, not context material —
 * binaries, and files over BUNDLE_LIMIT). Bundled paths are relative to the
 * skill directory.
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
      // SKILL.md is the skill's manifest; the root `scripts/` folder holds
      // executable code (run via run_skill_script, not read into context).
      if (rel === "" && (e === "SKILL.md" || e === "scripts")) continue;
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
    out =
      out.slice(0, OUTPUT_LIMIT) +
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

/**
 * The single synthetic `run_skill_script` function tool (skill is an enum;
 * `script` is validated against the chosen skill's `scripts/` folder at runtime).
 */
export function runScriptTool(skills: Skill[]): OpenAiFunctionTool {
  return {
    type: "function",
    function: {
      name: "run_skill_script",
      description:
        "Execute a script from a local skill's `scripts/` folder using `bash` " +
        "(.sh), `python3` (.py), or `node` (.js). Pass optional `args` as a " +
        "string array. The script runs in the current working directory with " +
        "env `SLASK_SKILL_DIR` set to the skill's directory. Use it only when " +
        "a skill's instructions say to run a bundled script.",
      parameters: {
        type: "object",
        properties: {
          skill: {
            type: "string",
            enum: skills.map((s) => s.name),
            description: "which skill to take the script from",
          },
          script: {
            type: "string",
            description: "script filename in the skill's scripts/ folder (e.g. generate.py)",
          },
          args: {
            type: "array",
            items: { type: "string" },
            description: "command-line arguments to pass to the script (default: none)",
          },
        },
        required: ["skill", "script"],
      },
    },
  };
}

/** The system-prompt block listing available skills ("" when none). */
export function skillSystemBlock(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const lines = skills
    .map((s) => {
      const extra = s.scripts.length
        ? ` (scripts: ${s.scripts.join(", ")})`
        : "";
      return `  ${s.name} — ${s.description}${extra}`;
    })
    .join("\n");
  return (
    "\n\nAvailable skills: call `invoke_skill` with a skill name to load its " +
    "full instructions and any bundled files, or `run_skill_script` to execute " +
    "a script from a skill's `scripts/` folder (.sh, .py, .js).\n" +
    lines
  );
}

// ---------------------------------------------------------------------------
// Script execution
// ---------------------------------------------------------------------------

/** Interpreter chosen by script extension. */
function interpreterFor(ext: string): string {
  if (ext === ".sh") return "bash";
  if (ext === ".py") return "python3";
  if (ext === ".js") return "node";
  return "bash";
}

/**
 * Resolve `scriptName` to an absolute path to an *executable* script inside the
 * skill's `scripts/` folder. Throws (with a message the model can act on) if the
 * name is empty, escapes the skill/scripts dir, has an unsupported extension,
 * or does not exist as a file.
 */
export async function locateScript(
  skill: Skill,
  scriptName: unknown,
): Promise<string> {
  let name = String(scriptName ?? "").trim();
  if (!name) {
    throw new Error(
      `no script name given for skill "${skill.name}" (available: ${
        skill.scripts.join(", ") || "none"
      })`,
    );
  }
  // Tolerate a leading `scripts/` (e.g. the model echoing the full path).
  if (name.startsWith("scripts/")) name = name.slice("scripts/".length).trim();
  const rel = `scripts/${name}`;
  const abs = resolve(skill.dir, rel);
  const scriptsDir = resolve(skill.dir, "scripts");
  // The resolved path must stay inside the skill's `scripts/` folder — which
  // implies containment in the skill dir itself — rejecting `..` climbs of any
  // depth with a single uniform message.
  if (!abs.startsWith(scriptsDir + sep)) {
    throw new Error(
      `script path escapes the skill's scripts/ directory: ${scriptName}`,
    );
  }
  const ext = extname(name).toLowerCase();
  if (!SCRIPT_EXTS.includes(ext)) {
    throw new Error(
      `unsupported script extension "${ext || "(none)"}" in "${scriptName}" ` +
        `(skill ${skill.name}); only .sh, .py, .js are executable`,
    );
  }
  const st = await stat(abs).catch(() => null);
  if (!st || st.isDirectory()) {
    throw new Error(
      `no script named "${name}" in ${skill.name} (available: ${
        skill.scripts.join(", ") || "none"
      })`,
    );
  }
  return abs;
}

/**
 * Spawn and run a script, capturing its output. Never uses `shell: true` or
 * string interpolation — the script path and each arg are separate argv
 * elements, so model-supplied args cannot inject shell metacharacters.
 */
export function executeScript(
  scriptPath: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<ExecScriptResult> {
  const child = spawn(
    interpreterFor(extname(scriptPath)),
    [scriptPath, ...args],
    // stdio as [stdin, stdout, stderr] — no shell, args are individual argv
    // elements. stdout/stderr piped (we read them); stdin ignored.
    { cwd, env, stdio: ["ignore", "pipe", "pipe"], timeout: SCRIPT_TIMEOUT_MS },
  );
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let timedOut = false;
  let settled = false;
  child.stdout.on("data", (b) => out.push(b));
  child.stderr.on("data", (b) => err.push(b));
  return new Promise((resolve) => {
    const done = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      resolve({
        exitCode,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
      });
    };
    child.on("timeout", () => {
      timedOut = true;
      child.kill("SIGKILL");
    });
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT" || e.code === "EACCES") done(127);
      else done(-1);
    });
    child.on("close", (code, signal) => {
      done(code ?? (signal ? 143 : 1));
    });
  });
}

/**
 * The CallToolResult returned to the model by `run_skill_script`: validates the
 * skill/script, executes the script, and formats exit code + stdout/stderr
 * (capped). Throws (fed back as an `ERROR calling run_skill_script` message)
 * when the skill/script is unknown or not runnable.
 */
export async function runSkillScript(
  skills: Skill[],
  input: { skill?: unknown; script?: unknown; args?: unknown },
): Promise<CallToolResult> {
  const skillName = String(input.skill ?? "");
  const found = skills.find((s) => s.name === skillName);
  if (!found) {
    throw new Error(
      `no skill named "${skillName}" (available: ${
        skills.length ? skills.map((s) => s.name).join(", ") : "none"
      })`,
    );
  }
  const scriptPath = await locateScript(found, input.script);
  const rawArgs = Array.isArray(input.args)
    ? input.args.map((a) => String(a))
    : [];
  const { exitCode, stdout, stderr, timedOut } = await executeScript(
    scriptPath,
    rawArgs,
    process.cwd(),
    { ...process.env, SLASK_SKILL_DIR: found.dir },
  );
  let text = `exit code: ${exitCode}`;
  if (timedOut) text += " (timed out)";
  const stdoutTrim = stdout.trimEnd();
  if (stdoutTrim) text += `\n--- stdout ---\n${stdoutTrim}`;
  const stderrTrim = stderr.trimEnd();
  if (stderrTrim) text += `\n--- stderr ---\n${stderrTrim}`;
  if (text.length > OUTPUT_LIMIT) {
    text = text.slice(0, OUTPUT_LIMIT) + "\n… [output truncated]";
  }
  return {
    isError: exitCode !== 0 || timedOut,
    content: [{ type: "text", text }],
  };
}
