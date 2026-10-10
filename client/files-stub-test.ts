// files-stub-test.ts — standalone tests for the built-in file tools (files.ts).
//
// No MCP server and no model endpoint needed: `baseDir` is an explicit argument
// (not `process.cwd()`), so everything runs against a throwaway temp tree and an
// "outside" temp tree that must stay unreachable. Symlinks crossing from `root`
// to `outside` are the escape vector. Mirrors the skills-stub patterns:
// `assert/strict`, a `thrown` helper for async rejections, `tmpdir()` workspaces.
import assert from "node:assert/strict";
import {
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CallToolResult } from "./types.js";
import {
  callFileTool,
  editFileInBase,
  fileTools,
  resolveExistingInBase,
  resolveInBase,
  readFileInBase,
  writeFileInBase,
} from "./files.js";

// callFileTool always returns a single text part.
const textOf = (r: CallToolResult): string => {
  const first = r.content[0];
  assert(first.type === "text", JSON.stringify(first));
  return first.text;
};

// assert.throws only sees *synchronous* throws; capture rejections **and**
// synchronous throws (used for both sync `resolveInBase` and the async ops)
// by awaiting inside a try/catch.
const thrown = async (f: () => unknown): Promise<string> => {
  let message = "";
  try {
    await f();
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  assert(message !== "", "expected a throw but got none");
  return message;
};

// ---------------------------------------------------------------------------
// workspaces: `root` is the launch dir (baseDir); `outside` must stay
// unreachable. Symlinks crossing from root to outside are the escape vector.
// ---------------------------------------------------------------------------
const root = join(tmpdir(), `slask-files-stub-${Date.now()}`);
const outside = join(
  tmpdir(),
  `slask-files-outside-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);
await mkdir(root, { recursive: true });
await mkdir(outside, { recursive: true });

const insideOutTxt = join(outside, "outside.txt");
await writeFile(join(root, "notes.txt"), "line one\nline two\nline three\n", "utf8");
await writeFile(insideOutTxt, "secret outside content", "utf8");
await writeFile(join(outside, "secret.txt"), "secret outside file", "utf8");

const disk = async (p: string): Promise<string> => readFile(p, "utf8");

// ---------------------------------------------------------------------------
// 1. resolveInBase — string-level containment (empty, absolute, escapes) -----
// ---------------------------------------------------------------------------
{
  assert(resolveInBase(root, "notes.txt").endsWith("notes.txt"));
  assert(resolveInBase(root, "./notes.txt").endsWith("notes.txt"));
  assert(resolveInBase(root, "sub/dir/f.txt").endsWith("sub/dir/f.txt"));

  const mAbs = await thrown(() => resolveInBase(root, "/etc/passwd"));
  assert(/absolute paths are not allowed/.test(mAbs), mAbs);

  const m1 = await thrown(() => resolveInBase(root, ".."));
  assert(/escapes the launch directory/.test(m1), m1);
  const m2 = await thrown(() => resolveInBase(root, "../x.txt"));
  assert(/escapes the launch directory/.test(m2), m2);
  const m3 = await thrown(() => resolveInBase(root, "a/../../etc/passwd"));
  assert(/escapes the launch directory/.test(m3), m3);
  const m4 = await thrown(() => resolveInBase(root, ""));
  assert(/path must not be empty/.test(m4), m4);
  console.log("PASS test1 — resolveInBase escapes are rejected");
}

// ---------------------------------------------------------------------------
// 2. symlink escape: a link inside root pointing outside is refused; a link
// inside root pointing inside root is fine; a symlinked *dir* pointing outside
// is refused when followed into a file ----------------------------------------
// ---------------------------------------------------------------------------
{
  // link inside root -> file outside (string layer passes, symlink layer must reject)
  const linkInsideOut = join(root, "link.txt");
  await symlink(insideOutTxt, linkInsideOut);
  const m = await resolveExistingInBase(root, linkInsideOut).catch((e: Error) => e);
  assert(
    m instanceof Error && /escapes the launch directory \(symlink\)/.test(m.message),
    `expected symlink-escape rejection, got ${m instanceof Error ? m.message : String(m)}`
  );

  // link inside root -> file inside root (allowed)
  await writeFile(join(root, "inner.txt"), "inner content", "utf8");
  const innerLink = join(root, "inlink.txt");
  await symlink(join(root, "inner.txt"), innerLink);
  await resolveExistingInBase(root, innerLink); // must not throw

  // symlinked directory pointing outside, followed into a file
  await symlink(outside, join(root, "escdir"));
  const mDir = await resolveExistingInBase(
    root,
    join(root, "escdir", "secret.txt"),
  ).catch((e: Error) => e);
  assert(
    mDir instanceof Error && /escapes the launch directory \(symlink\)/.test(mDir.message),
    `expected symlinked-dir escape rejection, got ${mDir instanceof Error ? mDir.message : String(mDir)}`
  );
  console.log("PASS test2 — symlink escapes rejected, in-base links allowed");
}

// ---------------------------------------------------------------------------
// 3. readFileInBase: round-trip, missing, directory, binary, empty, truncation
// ---------------------------------------------------------------------------
{
  const r = await readFileInBase(root, "notes.txt");
  assert(r.path.endsWith("notes.txt"), r.path);
  assert(r.content === "line one\nline two\nline three\n", r.content);
  assert(r.totalBytes > 0, String(r.totalBytes));
  assert(r.truncated === false, String(r.truncated));

  const mMiss = await thrown(() => readFileInBase(root, "nope.txt"));
  assert(/no such file/.test(mMiss), mMiss);

  await mkdir(join(root, "subdir"), { recursive: true });
  const mDir = await thrown(() => readFileInBase(root, "subdir"));
  assert(/is a directory/.test(mDir), mDir);

  await writeFile(join(root, "bin.dat"), Buffer.from([0x68, 0x65, 0x00, 0x6c, 0x6c, 0x6f]));
  const mBin = await thrown(() => readFileInBase(root, "bin.dat"));
  assert(/not a plain text file/.test(mBin), mBin);

  await writeFile(join(root, "empty.txt"), "");
  const empty = await readFileInBase(root, "empty.txt");
  assert(empty.content === "" && empty.totalBytes === 0 && empty.truncated === false);

  // oversize -> truncated flag, totalBytes = real size, content capped at 64KiB
  const BIG = 200_000;
  await writeFile(join(root, "big.txt"), "a".repeat(BIG));
  const big = await readFileInBase(root, "big.txt");
  assert(big.truncated === true, String(big.truncated));
  assert(big.totalBytes === BIG, String(big.totalBytes));
  assert(big.content.length === 65536, String(big.content.length));
  console.log("PASS test3 — readFileInBase (round-trip, missing, dir, binary, truncated)");
}

// ---------------------------------------------------------------------------
// 4. editFileInBase: no match, multi (with/without replaceAll), empty search,
// delete, single match, subdir ----------------------------------------------
// ---------------------------------------------------------------------------
{
  await writeFile(join(root, "f.txt"), "a b a b\nx y\n", "utf8");

  // no match -> throw
  const mNoMatch = await thrown(() =>
    editFileInBase(root, "f.txt", "zzz", "q", false),
  );
  assert(/no match for the search string/.test(mNoMatch), mNoMatch);

  // empty search -> throw
  const mEmptySearch = await thrown(() =>
    editFileInBase(root, "f.txt", "", "q", false),
  );
  assert(/search must be a non-empty string/.test(mEmptySearch), mEmptySearch);

  // multiple matches, replaceAll false -> throw with count
  const mMulti = await thrown(() => editFileInBase(root, "f.txt", "a", "X", false));
  assert(/matches 2 times/.test(mMulti), mMulti);

  // multiple matches, replaceAll true -> replaces all (verify on disk)
  await editFileInBase(root, "f.txt", "a", "X", true);
  assert((await disk(join(root, "f.txt"))) === "X b X b\nx y\n");

  // single match (replace "x" — appears once now)
  await editFileInBase(root, "f.txt", "x", "y", false);
  assert((await disk(join(root, "f.txt"))) === "X b X b\ny y\n");

  // delete via empty replace
  await writeFile(join(root, "f2.txt"), "keep REMOVE this keep\n", "utf8");
  const dr = await editFileInBase(root, "f2.txt", "REMOVE", "", false);
  assert(dr.matched === 1, String(dr.matched));
  assert((await disk(join(root, "f2.txt"))) === "keep  this keep\n");

  // subdir edit
  await mkdir(join(root, "deeper"), { recursive: true });
  await writeFile(join(root, "deeper", "g.txt"), "one\ntwo\n");
  await editFileInBase(root, "deeper/g.txt", "two", "TWO", false);
  assert((await disk(join(root, "deeper", "g.txt"))) === "one\nTWO\n");

  console.log("PASS test4 — editFileInBase (no-match, multi, delete, subdir)");
}

// ---------------------------------------------------------------------------
// 5. writeFileInBase: create, nested parents, overwrite, missing content,
// directory target, escape, symlinked-escape-parent --------------------------
// ---------------------------------------------------------------------------
{
  // create
  const w = await writeFileInBase(root, "new.txt", "hello");
  assert(w.created === true, String(w.created));
  assert(w.path === "new.txt", w.path);
  assert((await disk(join(root, "new.txt"))) === "hello");

  // nested path auto-creates parents (all inside base)
  const w2 = await writeFileInBase(root, "a/b/c.txt", "deep");
  assert(w2.created === true, String(w2.created));
  assert((await disk(join(root, "a", "b", "c.txt"))) === "deep");

  // overwrite
  const w3 = await writeFileInBase(root, "new.txt", "hello again");
  assert(w3.created === false, String(w3.created));
  assert((await disk(join(root, "new.txt"))) === "hello again");

  // missing content -> throw
  const mNoContent = await thrown(() => writeFileInBase(root, "nope.txt", undefined));
  assert(/content is required/.test(mNoContent), mNoContent);

  // existing directory as target -> throw
  const mDir = await thrown(() => writeFileInBase(root, "subdir", "x"));
  assert(/is a directory/.test(mDir), mDir);

  // string-layer escape
  const mEsc = await thrown(() => writeFileInBase(root, "../outside.txt", "x"));
  assert(/escapes the launch directory/.test(mEsc), mEsc);

  // symlinked parent pointing outside -> symlink-layer reject
  await symlink(outside, join(root, "escparent"));
  const mEscParent = await thrown(() =>
    writeFileInBase(root, "escparent/new.txt", "x"),
  );
  assert(
    /escapes the launch directory \(symlink\)/.test(mEscParent),
    mEscParent,
  );

  console.log("PASS test5 — writeFileInBase (create, nested, overwrite, reject)");
}

// ---------------------------------------------------------------------------
// 6. fileTools(): 3 tools, names, required arrays, non-empty descriptions ----
// ---------------------------------------------------------------------------
{
  const tools = fileTools();
  assert(tools.length === 3, String(tools.length));
  const byName = new Map(tools.map((t) => [t.function.name, t]));
  for (const n of ["read_file", "edit_file", "write_file"]) {
    assert(byName.has(n), n);
  }
  const req = (t: any) => JSON.stringify(t.function.parameters.required);
  assert(req(byName.get("read_file")!) === JSON.stringify(["path"]));
  assert(req(byName.get("edit_file")!) === JSON.stringify(["path", "search", "replace"]));
  assert(req(byName.get("write_file")!) === JSON.stringify(["path", "content"]));
  for (const t of tools) {
    assert(t.type === "function", t.function.name);
    const d = t.function.description;
    assert(typeof d === "string" && d.length > 0, t.function.name);
    assert(d.includes("launch directory"), t.function.name);
  }
  console.log("PASS test6 — fileTools() shape");
}

// ---------------------------------------------------------------------------
// 7. callFileTool: routes each name; truncated read header; unknown name +
// escaped path throw ---------------------------------------------------------
// ---------------------------------------------------------------------------
{
  await writeFile(join(root, "route.txt"), "orig\n");
  const readRes = await callFileTool(root, "read_file", { path: "route.txt" });
  assert(readRes.isError === false, JSON.stringify(readRes));
  assert(textOf(readRes).includes("orig"), textOf(readRes));

  // truncated read surfaces the byte-range header in the router text
  const readBig = await callFileTool(root, "read_file", { path: "big.txt" });
  assert(/first 65536 bytes of 200000/.test(textOf(readBig)), textOf(readBig));

  const editRes = await callFileTool(root, "edit_file", {
    path: "route.txt",
    search: "orig",
    replace: "edited",
  });
  assert(editRes.isError === false, JSON.stringify(editRes));
  assert((await disk(join(root, "route.txt"))) === "edited\n");
  assert(textOf(editRes).includes("route.txt"), textOf(editRes));

  const writeRes = await callFileTool(root, "write_file", {
    path: "route2.txt",
    content: "fresh\n",
  });
  assert(writeRes.isError === false, JSON.stringify(writeRes));
  assert((await disk(join(root, "route2.txt"))) === "fresh\n");
  assert(textOf(writeRes).includes("route2.txt"), textOf(writeRes));

  // unknown name -> throw (not an isError result)
  const mUnknown = await thrown(() => callFileTool(root, "no_such_tool", {}));
  assert(/unknown file tool/.test(mUnknown), mUnknown);

  // escaped path through the router -> reject
  const mEscRouter = await thrown(() =>
    callFileTool(root, "read_file", { path: "../outside.txt" }),
  );
  assert(/escapes the launch directory/.test(mEscRouter), mEscRouter);

  console.log("PASS test7 — callFileTool routing, truncated header, unknown/escape");
}

await rm(root, { recursive: true, force: true });
await rm(outside, { recursive: true, force: true });
console.log("\nALL FILE STUB TESTS PASSED");
process.exit(0);
