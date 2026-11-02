// Session state kept between runs: the last-chosen model and the /verbose
// setting. Stored in `<cwd>/.slask-state.json` (same cwd convention as
// `.env` / `mcp.json` / `.slask-schedule.json`). Persistence is best-effort:
// a missing or corrupt file reads as empty state and a failed write is only
// warned about, so state problems never block a chat.

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface SessionState {
  /** models.json `provider/id` last chosen with `/model`. */
  model?: string;
  /** Last `/verbose` setting (false = tool trace hidden). */
  showTools?: boolean;
}

const STATE_FILE_NAME = ".slask-state.json";

function defaultFile(): string {
  return join(process.cwd(), STATE_FILE_NAME);
}

// Missing / unreadable / malformed file → empty state; unknown or wrongly
// typed fields are dropped.
export async function loadState(file: string = defaultFile()): Promise<SessionState> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const p = parsed as Record<string, unknown>;
  const state: SessionState = {};
  if (typeof p.model === "string" && p.model !== "") state.model = p.model;
  if (typeof p.showTools === "boolean") state.showTools = p.showTools;
  return state;
}

// Merge `patch` into the stored state (atomic temp-file + rename). Never throws.
export async function saveState(
  patch: SessionState,
  file: string = defaultFile(),
): Promise<void> {
  try {
    const next = { ...(await loadState(file)), ...patch };
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
    await rename(tmp, file);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  ⚠ could not save session state: ${msg}`);
  }
}
