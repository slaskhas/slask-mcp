// env.ts — load .env files into process.env (no `dotenv` dependency).
//
// A .env file is a flat list of KEY=VALUE lines, with `#` comments, an
// optional leading `export `, and optional single/double quotes around
// values. Only keys not already set by the shell are written — shell env
// wins over the file (same semantics as dotenv's default).

import fs from "node:fs";

/**
 * Load key/value pairs from `file` into `process.env`.
 *
 * Missing file → silently does nothing (callers use this for the optional
 * cwd `.env` default).
 */
export function loadEnvFile(file: string): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;

    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    const q = value.charAt(0);
    if (
      (q === "\"" || q === "'") &&
      value.length >= 2 &&
      value.endsWith(q)
    ) {
      value = value.slice(1, value.length - 1);
    }
    if (key.length > 0 && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}
