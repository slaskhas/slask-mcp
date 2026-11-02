// state-test.ts — loadState()/saveState(), no server, no model.
//
// Drives the session-state file against a throwaway temp dir.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadState, saveState } from "../state.js";

const dir = await mkdtemp(join(tmpdir(), "slask-state-"));
const file = join(dir, ".slask-state.json");

// 1. missing file → empty state
assert.deepEqual(await loadState(file), {});
console.log("PASS test1 — missing file reads as empty state");

// 2. save + load round trip; patches merge instead of replacing
await saveState({ model: "openai/gpt-x" }, file);
await saveState({ showTools: false }, file);
assert.deepEqual(await loadState(file), { model: "openai/gpt-x", showTools: false });
await saveState({ model: "other/m" }, file);
assert.deepEqual(await loadState(file), { model: "other/m", showTools: false });
console.log("PASS test2 — round trip, patches merge");

// 3. corrupt / wrongly typed content is tolerated and never throws
await writeFile(file, "{not json", "utf8");
assert.deepEqual(await loadState(file), {});
await writeFile(file, JSON.stringify({ model: 5, showTools: "no", extra: 1 }), "utf8");
assert.deepEqual(await loadState(file), {});
await writeFile(file, "[]", "utf8");
assert.deepEqual(await loadState(file), {});
await saveState({ showTools: true }, file); // overwrites the corrupt file
assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { showTools: true });
console.log("PASS test3 — corrupt or mistyped file tolerated");

// 4. no temp files left behind
assert.deepEqual(await readdir(dir), [".slask-state.json"]);
console.log("PASS test4 — atomic write leaves no temp files");

// 5. a failed write only warns (target dir does not exist)
const warn = console.error;
let warned = "";
console.error = (m: string) => { warned += m; };
await saveState({ showTools: false }, join(dir, "missing", "s.json"));
console.error = warn;
assert.match(warned, /could not save session state/);
console.log("PASS test5 — write failure warns, does not throw");

await rm(dir, { recursive: true, force: true });
console.log("\nALL STATE TESTS PASSED");
process.exit(0);
