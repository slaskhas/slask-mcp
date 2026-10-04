// skills-stub-test.ts — standalone tests for local skill support (skills.ts).
//
// No MCP server and no model endpoint needed: runAgentTurn() is driven by a
// fake OpenAI client (same helper shape as agent-stub-test.ts) and discovery
// runs against a throwaway temp directory.
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAgentTurn, SYSTEM_PROMPT } from "./agent.js";
import type { CallToolResult } from "./types.js";
import {
  discoverSkills,
  invokeSkill,
  loadSkill,
  locateScript,
  resolveRef,
  runSkillScript,
  runScriptTool,
  skillSystemBlock,
  skillTool,
} from "./skills.js";
import type { Skill } from "./skills.js";

// runSkillScript always returns a single text part, so extract it here
// instead of indexing the content union (which also allows image parts).
const textOf = (r: CallToolResult): string => {
  const first = r.content[0];
  assert(first.type === "text", JSON.stringify(first));
  return first.text;
};

// runSkillScript/locateScript/invokeSkill are async — assert.throws only sees
// *synchronous* throws, so capture rejections by awaiting them instead.
const thrown = async (f: () => Promise<unknown>): Promise<string> => {
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
// temp workspace with a couple of skills
// ---------------------------------------------------------------------------
const root = join(tmpdir(), `slask-skills-stub-${Date.now()}`);
const skillsDir = join(root, "skills");
await rm(root, { recursive: true, force: true });
await mkdir(skillsDir, { recursive: true });

const writeSkill = async (
  dir: string,
  raw: string,
): Promise<void> => {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), raw, "utf8");
};

// alpha — plain frontmatter; later gets bundled files + skips
await writeSkill(
  join(skillsDir, "alpha"),
  `---
name: alpha
description: Alpha does alpha things.
---
Body of alpha: always say "alpha confirmed".
`,
);

// beta — block-scalar description
await writeSkill(
  join(skillsDir, "beta"),
  `---
name: beta
description: >-
  Beta does beta things
  across several lines.
---
Body of beta.
`,
);

// gamma — disabled: must not be discovered
await writeSkill(
  join(skillsDir, "gamma"),
  `---
name: gamma
description: Should never be discovered.
disabled: true
---
Body of gamma.
`,
);

// alpha-copy — duplicate name; the first directory alphabetically wins
await writeSkill(
  join(skillsDir, "alpha-copy"),
  `---
name: alpha
description: A duplicate of alpha.
---
Duplicate body.
`,
);

// ignored: a dir without SKILL.md and a flat file
await mkdir(join(skillsDir, "no-skill-md"), { recursive: true });
await writeFile(join(skillsDir, "notes.txt"), "flat file, not a skill\n");

// Bundled files for alpha: text file + binary (skipped) + oversize (skipped)
const alphaDir = join(skillsDir, "alpha");
await mkdir(join(alphaDir, "references"), { recursive: true });
await writeFile(
  join(alphaDir, "references", "notes.md"),
  "notes.md content: reference 42.\n",
);
await writeFile(
  join(alphaDir, "bin.dat"),
  Buffer.from([0x68, 0x65, 0x00, 0x6c, 0x6c, 0x6f]),
);
await writeFile(join(alphaDir, "big.txt"), "a".repeat(20000)); // > 16 KiB

// Bundled scripts for alpha: one per allowed extension (python3/node/bash),
// `fail.sh` (exits 3), plus two names that must be rejected on discovery.
const alphaScripts = join(alphaDir, "scripts");
await mkdir(alphaScripts, { recursive: true });
await writeFile(
  join(alphaScripts, "greet.py"),
  'import os, sys\nprint("hello from greet.py: " + " ".join(sys.argv[1:]) + "\\ndir=" + os.environ.get("SLASK_SKILL_DIR", "<unset>"))\n',
);
await writeFile(join(alphaScripts, "echo.sh"), 'echo "$@"\n');
await writeFile(
  join(alphaScripts, "echo.js"),
  "process.stdout.write(process.argv.slice(2).join(\" \") + \"\\n\");\n",
);
await writeFile(join(alphaScripts, "fail.sh"), "echo failing; exit 3\n");
await writeFile(join(alphaScripts, "bad.txt"), "not a script\n");
await writeFile(join(alphaScripts, "noscript"), "not a script\n");
// Decoy outside scripts/: inside the skill dir, so `resolveRef` accepts it but
// `locateScript` must still refuse it.
await writeFile(
  join(alphaDir, "references", "generate.py"),
  "do not run me\n",
);

const skills: Skill[] = await discoverSkills(root);
const alpha = skills.find((s) => s.name === "alpha")!;

// ---- 1. discovery: two real skills (incl. block scalar); dup/disabled/flat
// /no-md all ignored ---------------------------------------------------------
{
  assert(skills.length === 2, `expected 2, got ${skills.length}: ${skills.map((s) => s.name)}`);
  const names = skills.map((s) => s.name).sort();
  assert(names.join(",") === "alpha,beta", `names: ${names.join(",")}`);
  assert(alpha.description === "Alpha does alpha things.", `alpha desc: ${alpha.description}`);
  const beta = skills.find((s) => s.name === "beta")!;
  assert(
    beta.description === "Beta does beta things across several lines.",
    `beta desc: ${beta.description}`
  );
  assert(alpha.dir === alphaDir, `alpha dir: ${alpha.dir}`);
  assert((await discoverSkills(join(tmpdir(), "definitely-missing-xxx"))).length === 0);
  console.log("PASS test1 — discovery:", names.join(", "));
}

// ---- 2. resolveRef keeps references inside the skill dir --------------------
{
  const ok = resolveRef(alphaDir, "references/notes.md");
  assert(ok.endsWith("references/notes.md"), ok);
  assert.throws(() => resolveRef(alphaDir, "../escape.txt"));
  assert.throws(() => resolveRef(alphaDir, "/etc/passwd"));
  assert.throws(() => resolveRef(alphaDir, ".."));
  console.log("PASS test2 — resolveRef escapes are rejected");
}

// ---- 3. loadSkill: body sans frontmatter, bundled text only; binary/oversize
// skipped ----------------------------------------------------------------------
{
  const loaded = await loadSkill(alpha);
  assert(loaded.body.includes("alpha confirmed"), loaded.body);
  assert(!loaded.body.includes("description:"), "frontmatter leaked into body");
  const rels = loaded.files.map((f) => f.rel).sort();
  // references/ text files are bundled into context; scripts/ is not
  // (executed via run_skill_script, not read as prompt material).
  assert(
    rels.join(",") === "references/generate.py,references/notes.md",
    `rel: ${rels.join(",")}`
  );
  // files are sorted by rel; check by name, not by index
  const notes = loaded.files.find((f) => f.rel === "references/notes.md");
  assert(notes && notes.content.includes("reference 42"), notes?.content ?? "missing notes.md");
  console.log("PASS test3 — loadSkill (bin.dat and big.txt skipped)");
}

// ---- 4. invokeSkill: body + reference *names* (lazy refs); `file` loads one
// file's content; unknown name lists available --------------------------------
{
  // Without `file`: the model gets the body and the *names* of bundled refs —
  // NOT their content (per spec: references load "when explicitly needed").
  const text = await invokeSkill(skills, "alpha");
  assert(text.includes("alpha confirmed"), "body missing");
  assert(text.includes("references/notes.md"), "ref name missing from list");
  assert(text.includes("references/generate.py"), "ref name missing from list");
  assert(!text.includes("reference 42"), "ref content must not be bundled");
  // With `file`: exactly that file's content is returned.
  const one = await invokeSkill(skills, "alpha", "references/notes.md");
  assert(one.includes("reference 42"), "single-file content missing");
  assert(!one.includes("alpha confirmed"), "body must not appear when file given");
  // A bad file name throws with the available refs listed.
  assert(
    /no reference file named/.test(
      await thrown(() => invokeSkill(skills, "alpha", "references/does-not-exist.md"))
    ),
    "bad file name not thrown"
  );
  let msg = "";
  try {
    await invokeSkill(skills, "ghost");
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  assert(msg.includes('no skill named "ghost"') && msg.includes("alpha, beta"), msg);
  console.log("PASS test4 — invokeSkill (lazy refs)");
}

// ---- 5. skillTool shape --------------------------------------------------------
{
  const t = skillTool(skills);
  assert(t.type === "function" && t.function.name === "invoke_skill", JSON.stringify(t));
  const params = t.function.parameters as {
    type?: string;
    properties?: {
      name?: { type?: string; enum?: string[] };
      file?: { type?: string; description?: string },
    };
    required?: unknown;
  };
  assert(params.type === "object", JSON.stringify(params));
  const nameProp = params.properties?.name;
  assert(nameProp?.type === "string", JSON.stringify(nameProp));
  assert(params.properties?.file?.type === "string", JSON.stringify(params));
  assert(
    JSON.stringify(nameProp?.enum) === JSON.stringify(["alpha", "beta"]),
    `enum: ${JSON.stringify(nameProp?.enum)}`
  );
  assert(
    JSON.stringify(t.function.parameters.required) === JSON.stringify(["name"]),
    JSON.stringify(t.function.parameters.required)
  );
  assert(
    t.function.description && t.function.description.includes("local skill"),
    String(t.function.description)
  );
  console.log("PASS test5 — skillTool shape");
}

// ---- 6. skillSystemBlock ---------------------------------------------------------
{
  const block = skillSystemBlock(skills);
  assert(block.includes("alpha — Alpha does alpha things."), block);
  assert(block.includes("beta — Beta does beta things across several lines."), block);
  assert(skillSystemBlock([]) === "", "empty skills => ''");
  console.log("PASS test6 — skillSystemBlock");
}

// ---- 7. runAgentTurn: the model loads a skill via invoke_skill, gets the body
// + its reference-file list fed back; an unknown name recovers via error feed-back
{
  const record: any[][] = [];
  const cfg = (openai: any) => ({
    openai,
    model: "fake-model",
    systemPrompt: SYSTEM_PROMPT + skillSystemBlock(skills),
    tools: [skillTool(skills)],
    callTool: (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
      if (skills.some((s) => s.name === args.name)) {
        return invokeSkill(skills, String(args.name)).then((text) => {
          const res: CallToolResult = {
            isError: false,
            content: [{ type: "text" as const, text }],
          };
          return res;
        });
      }
      // Non-skill names (or an invented skill name): the MCP-layer error path.
      throw new Error(`no such tool: ${name}`);
    },
  });

  const makeFakeModel = (
    script: (n: number) => any,
    rec?: (n: number, msgs: any[]) => void,
  ): unknown => {
    let n = 0;
    return {
      chat: {
        completions: {
          async create(req: any) {
            n++;
            rec?.(n, req.messages);
            const expected = script(n);
            assert(expected !== undefined, `no scripted response for round ${n}`);
            return expected;
          },
        },
      },
    };
  };
  const choice = (m: any, reason: string) => ({
    choices: [{ message: { role: "assistant", ...m }, finish_reason: reason }],
  });
  const toolCall = (id: string, name: string, args: string) => ({
    id,
    type: "function",
    function: { name, arguments: args },
  });

  // 7a — valid skill name: full body + reference-file list, plus the startup
  // block really reaching the model
  const spy: any[] = [];
  const answer = await runAgentTurn(
    cfg(makeFakeModel((n: number) => {
      if (n === 1)
        return choice(
          { tool_calls: [toolCall("c1", "invoke_skill", '{"name":"alpha"}')] },
          "tool_calls"
        );
      return choice({ content: "Alpha confirmed; reference note read." }, "stop");
    }, (n, msgs) => record.push(msgs))),
    [],
    (tc: any) => spy.push(tc)
  );
  assert(spy.length === 1, spy.map((t) => t.name).join(","));
  assert(spy[0].name === "invoke_skill", spy[0].name);
  assert(spy[0].args.name === "alpha", JSON.stringify(spy[0].args));
  assert(spy[0].resultText.includes("alpha confirmed"), "body missing");
  assert(spy[0].resultText.includes("references/notes.md"), "ref name missing");
  assert(answer && answer.length > 0, "no answer");
  assert(
    record[0] &&
      record[0][0]?.role === "system" &&
      record[0][0].content.includes("alpha — Alpha does alpha things."),
    "system prompt missing the skill block"
  );
  assert(
    (cfg(undefined) as any).tools[0].function.name === "invoke_skill",
    "tools array missing invoke_skill"
  );
  console.log("PASS test7a — model loads skill via invoke_skill");

  // 7b — unknown skill name: error fed back, session survives
  const spy8: any[] = [];
  const answer8 = await runAgentTurn(
    cfg(makeFakeModel((n: number) => {
      if (n === 1)
        return choice(
          { tool_calls: [toolCall("c8", "invoke_skill", '{"name":"ghost"}')] },
          "tool_calls"
        );
      return choice({ content: "No such skill; using a different approach." }, "stop");
    })),
    [],
    (tc: any) => spy8.push(tc)
  );
  assert(spy8.length === 1, "expected 1 call");
  assert(
    /ERROR calling invoke_skill/.test(spy8[0].resultText),
    `resultText: ${spy8[0].resultText}`
  );
  assert(answer8 && answer8.length > 0, "no answer after unknown skill");
  console.log("PASS test7b — unknown skill recovers via error feed-back");
}

// ---- 8. script discovery: allowed extensions only, sorted, decoys skipped ---
{
  assert.deepStrictEqual(
    alpha.scripts,
    ["echo.js", "echo.sh", "fail.sh", "greet.py"],
    `alpha.scripts: ${JSON.stringify(alpha.scripts)}`,
  );
  assert(!alpha.scripts.includes("bad.txt"), "bad.txt discovered");
  assert(!alpha.scripts.includes("noscript"), "noscript discovered");
  console.log("PASS test8 — alpha.scripts (bad.txt / noscript excluded)");
}

// ---- 9. runScriptTool shape ---------------------------------------------------
{
  const t = runScriptTool(skills);
  assert(
    t.type === "function" && t.function.name === "run_skill_script",
    JSON.stringify(t)
  );
  const params = t.function.parameters as {
    type?: string;
    properties?: {
      skill?: { type?: string; enum?: string[] };
      script?: { type?: string };
      args?: { type?: string; items?: { type?: string } };
    };
    required?: unknown;
  };
  assert(params.type === "object", JSON.stringify(params));
  assert(
    params.properties?.skill?.type === "string",
    JSON.stringify(params.properties)
  );
  assert(
    JSON.stringify(params.properties?.skill?.enum) ===
      JSON.stringify(["alpha", "beta"]),
    `skill enum: ${JSON.stringify(params.properties?.skill?.enum)}`
  );
  assert(
    params.properties?.script?.type === "string",
    JSON.stringify(params.properties)
  );
  assert(
    params.properties?.args?.type === "array" &&
      params.properties?.args?.items?.type === "string",
    JSON.stringify(params.properties)
  );
  assert(
    JSON.stringify(t.function.parameters.required) ===
      JSON.stringify(["skill", "script"]),
    JSON.stringify(t.function.parameters.required)
  );
  console.log("PASS test9 — runScriptTool shape");
}

// ---- 10. runSkillScript: python3 / node / bash, exit code, args pass-through --
{
  const py = await runSkillScript(skills, {
    skill: "alpha",
    script: "greet.py",
  });
  const pyText = textOf(py);
  assert(!py.isError, pyText);
  assert(pyText.includes("exit code: 0"), pyText);
  assert(pyText.includes("hello from greet.py"), pyText);
  assert(
    pyText.includes("dir=" + alpha.dir),
    "SLASK_SKILL_DIR not visible to the script"
  );

  const node = await runSkillScript(skills, {
    skill: "alpha",
    script: "echo.js",
    args: ["a", "b"],
  });
  const nodeText = textOf(node);
  assert(!node.isError, nodeText);
  assert(nodeText.includes("a b"), nodeText);

  const sh = await runSkillScript(skills, {
    skill: "alpha",
    script: "echo.sh",
    args: ["x", "y"],
  });
  const shText = textOf(sh);
  assert(!sh.isError, shText);
  assert(shText.includes("x y"), shText);
  console.log("PASS test10 — runSkillScript (python3/node/bash, exit 0, args)");
}

// ---- 11. runSkillScript: a failing script surfaces as isError + exit code ----
{
  const fail = await runSkillScript(skills, {
    skill: "alpha",
    script: "fail.sh",
  });
  const failText = textOf(fail);
  assert(fail.isError, failText);
  assert(failText.includes("exit code: 3"), failText);
  assert(failText.includes("failing"), failText);
  console.log("PASS test11 — non-zero exit code surfaces as isError");
}

// ---- 12. runSkillScript / locateScript throw on misuse --------------------------
{
  // unknown skill
  assert(
    /no skill named "ghost" /.test(
      await thrown(() => runSkillScript(skills, { skill: "ghost", script: "greet.py" }))
    )
  );
  // missing script name
  let msg = "";
  try {
    await runSkillScript(skills, { skill: "alpha" });
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  assert(msg.includes("no script name given"), msg);
  // unknown script (message lists what *is* available)
  try {
    await runSkillScript(skills, { skill: "alpha", script: "missing.sh" });
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  assert(
    msg.includes('no script named "missing.sh"') && msg.includes("echo.js"),
    msg
  );
  // bad extension
  assert(/unsupported script extension/.test(await thrown(() => locateScript(alpha, "bad.txt"))));
  assert(/unsupported script extension/.test(await thrown(() => locateScript(alpha, "noscript"))));
  // escapes: one level up, two up, three up
  assert(
    /escapes the skill's scripts\/ directory/.test(
      await thrown(() => locateScript(alpha, ".."))
    )
  );
  assert(
    /escapes the skill's scripts\/ directory/.test(
      await thrown(() => locateScript(alpha, "../.."))
    )
  );
  assert(
    /escapes the skill's scripts\/ directory/.test(
      await thrown(() => locateScript(alpha, "../../escape.sh"))
    )
  );
  // the decoy lives inside the skill dir but outside scripts/: refused (never run)
  assert(
    /no script named/.test(
      await thrown(() => runSkillScript(skills, { skill: "alpha", script: "references/generate.py" }))
    )
  );
  // a leading `scripts/` is tolerated (e.g. the model echoing the full path)
  assert(
    (await locateScript(alpha, "scripts/greet.py")).endsWith("scripts/greet.py"),
    "leading scripts/ prefix not tolerated"
  );
  console.log("PASS test12 — misuse throws (unknown skill/script, bad ext, escape, empty name)");
}

// ---- 13. runAgentTurn: the model runs a bundled script via run_skill_script ---
{
  const choice13 = (m: any, reason: string) => ({
    choices: [{ message: { role: "assistant", ...m }, finish_reason: reason }],
  });
  const toolCall13 = (id: string, name: string, args: string) => ({
    id,
    type: "function",
    function: { name, arguments: args },
  });

  const cfg13 = (openai: any) => ({
    openai,
    model: "fake-model",
    systemPrompt: SYSTEM_PROMPT + skillSystemBlock(skills),
    tools: [skillTool(skills), runScriptTool(skills)],
    callTool: (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
      if (name === "invoke_skill") {
        return invokeSkill(skills, String(args.name)).then((text) => ({
          isError: false,
          content: [{ type: "text" as const, text }],
        }));
      }
      if (name === "run_skill_script") {
        return runSkillScript(skills, args as {
          skill?: unknown;
          script?: unknown;
          args?: unknown;
        });
      }
      throw new Error(`no such tool: ${name}`);
    },
  });

  const makeFakeModel = (script: (n: number) => unknown): unknown => {
    let n = 0;
    return {
      chat: {
        completions: {
          async create(req: any) {
            n++;
            const expected = script(n);
            assert(expected !== undefined, `no scripted response for round ${n}`);
            return expected;
          },
        },
      },
    };
  };

  const spy13: any[] = [];
  const answer13 = await runAgentTurn(
    cfg13(makeFakeModel((n: number) => {
      if (n === 1)
        return choice13(
          {
            tool_calls: [
              toolCall13(
                "c13",
                "run_skill_script",
                '{"skill":"alpha","script":"greet.py","args":["agent"]}'
              ),
            ],
          },
          "tool_calls"
        );
      return choice13({ content: "The subject is within 50 characters." }, "stop");
    })),
    [],
    (tc: any) => spy13.push(tc)
  );
  assert(spy13.length === 1, `expected 1 call, got ${spy13.length}`);
  assert(spy13[0].name === "run_skill_script", spy13[0].name);
  assert(spy13[0].args.skill === "alpha", JSON.stringify(spy13[0].args));
  assert(spy13[0].args.script === "greet.py", JSON.stringify(spy13[0].args));
  assert(spy13[0].resultText.includes("hello from greet.py"), "script output missing");
  assert(spy13[0].resultText.includes("agent"), "args missing");
  assert(answer13 && answer13.length > 0, "no answer after running a skill script");
  console.log("PASS test13 — model runs a skill script via run_skill_script");
}

await rm(root, { recursive: true, force: true });
console.log("\nALL SKILL STUB TESTS PASSED");
process.exit(0);
