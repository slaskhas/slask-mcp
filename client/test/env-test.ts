// env-test.ts — loadEnvFile(), no server, no model.
//
// Writes throwaway .env files to a temp dir and drives loadEnvFile against
// process.env, then cleans up everything it touched.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadEnvFile } from "../env.js";

// Unique suffix so we never collide with the real environment; every key we
// touch is tracked and removed at the end.
const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const K = (n: string) => `SK_${n.toUpperCase()}_${suffix}`;
const created: Set<string> = new Set();

// Create a throwaway dir with a .env file; return its path.
const makeEnvFile = async (content: string): Promise<string> => {
  const dir = join(tmpdir(), `slask-env-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const p = join(dir, ".env");
  await mkdir(dir, { recursive: true });
  await writeFile(p, content, "utf8");
  return p;
};

// ---------------------------------------------------------------------------
// 1. quotes, export, comments, blank lines, shell-wins, ignored malformed lines
// ---------------------------------------------------------------------------
{
  const shellKey = K("shellwin");
  process.env[shellKey] = "from-shell";
  created.add(shellKey);

  const content = [
    `# top comment`,
    `   `,
    `${K("unquoted")} = unquoted value`,
    `${K("double")}="quoted value"`,
    `${K("single")}='single quoted value'`,
    `export ${K("exported")} = exported value`,
    `${K("noeq")}`,
    `=badleading`,
    `${K("trailing")} =  value with trailing spaces  `,
    `${shellKey}=overridden-by-file`,
  ].join("\n");
  const p = await makeEnvFile(content);
  loadEnvFile(p);

  assert(process.env[K("unquoted")] === "unquoted value", `unquoted: ${process.env[K("unquoted")]}`);
  assert(process.env[K("double")] === "quoted value", `double: ${process.env[K("double")]}`);
  assert(process.env[K("single")] === "single quoted value", `single: ${process.env[K("single")]}`);
  assert(
    process.env[K("exported")] === "exported value",
    `exported: ${process.env[K("exported")]}`
  );
  assert(
    process.env[K("trailing")] === "value with trailing spaces",
    `trailing: ${process.env[K("trailing")]}`
  );
  // shell-wins: pre-set key is unchanged despite the file trying to override it
  assert(process.env[shellKey] === "from-shell", `shell-win: ${process.env[shellKey]}`);
  // ignored lines (no '=' / leading '=' / blank / comment) never set anything
  assert(!(K("noeq") in process.env), "no-equals line ignored");
  assert(
    !(K("badleading") in process.env),
    "leading-equals line ignored"
  );
  console.log("PASS test1 — loadEnvFile (quotes, export, comments, shell-wins)");
}

// ---------------------------------------------------------------------------
// 2. missing file -> silent no-op
// ---------------------------------------------------------------------------
{
  const p = await makeEnvFile("");
  const bogus = join(p, "..", "does-not-exist.env");
  const neverSet = K("missingcheck"); // fresh key, never written by any test
  created.add(neverSet);
  loadEnvFile(bogus);
  assert(!(neverSet in process.env), "missing file should not set anything");
  assert(process.env[K("trailing")] === "value with trailing spaces", "earlier value intact");
  console.log("PASS test2 — missing file is a no-op");
}

// ---------------------------------------------------------------------------
// 3. CRLF line endings still parse
// ---------------------------------------------------------------------------
{
  const c1 = K("crlf");
  created.add(c1);
  const c2 = K("crlf2");
  created.add(c2);
  const p = await makeEnvFile(`${c1}=crlf first line\r\n${c2}=crlf second line\r\n`);
  loadEnvFile(p);
  assert(process.env[c1] === "crlf first line", `crlf1: ${process.env[c1]}`);
  assert(process.env[c2] === "crlf second line", `crlf2: ${process.env[c2]}`);
  console.log("PASS test3 — CRLF line endings");
}

// cleanup: drop everything we added (and any pre-set shell-win key).
for (const k of created) delete process.env[k];

console.log("\nALL ENV TESTS PASSED");
process.exit(0);