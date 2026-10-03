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
  resolveRef,
  skillSystemBlock,
  skillTool,
} from "./skills.js";
import type { Skill } from "./skills.js";

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
  assert(rels.join(",") === "references/notes.md", `rel: ${rels.join(",")}`);
  assert(loaded.files[0].content.includes("reference 42"), loaded.files[0].content);
  console.log("PASS test3 — loadSkill (bin.dat and big.txt skipped)");
}

// ---- 4. invokeSkill: body + bundled files; unknown name lists available ------
{
  const text = await invokeSkill(skills, "alpha");
  assert(text.includes("alpha confirmed"), "body missing");
  assert(text.includes("--- references/notes.md ---"), "section header missing");
  assert(text.includes("reference 42"), "reference content missing");
  let msg = "";
  try {
    await invokeSkill(skills, "ghost");
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  assert(msg.includes('no skill named "ghost"') && msg.includes("alpha, beta"), msg);
  console.log("PASS test4 — invokeSkill");
}

// ---- 5. skillTool shape --------------------------------------------------------
{
  const t = skillTool(skills);
  assert(t.type === "function" && t.function.name === "invoke_skill", JSON.stringify(t));
  const params = t.function.parameters as {
    type?: string;
    properties?: { name?: { type?: string; enum?: string[] } };
    required?: unknown;
  };
  assert(params.type === "object", JSON.stringify(params));
  const nameProp = params.properties?.name;
  assert(nameProp?.type === "string", JSON.stringify(nameProp));
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
// + bundled files fed back; an unknown name recovers via error feed-back ------
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

  // 7a — valid skill name: full body + bundled files, plus the startup block
  // really reaching the model
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
  assert(spy[0].resultText.includes("reference 42"), "bundled file missing");
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

await rm(root, { recursive: true, force: true });
console.log("\nALL SKILL STUB TESTS PASSED");
process.exit(0);
