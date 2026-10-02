// env.ts — reads a `.env` file (dotenv style) with no dependency.
//
// Skips blanks and `#` comments, strips an optional `export ` prefix, and
// unquotes matching single or double quotes. Existing `process.env` entries
// always win, so the file only fills in what the shell hasn't set (dotenv
// semantics).

import fs from "node:fs";

export function loadEnvFile(file: string): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    // No file (or unreadable): nothing to do.
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
    if ((q === "\"" || q === "'") && value.length >= 2 && value.endsWith(q)) {
      value = value.slice(1, value.length - 1);
    }
    if (key.length > 0 && !(key in process.env)) process.env[key] = value;
  }
}
