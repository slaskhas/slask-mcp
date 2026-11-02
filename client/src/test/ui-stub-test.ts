// ui-stub-test.ts — drive ui.ts (the one-shot/REPL layer) in-process, fully
// network-free.
//
// No live MCP server and no model endpoint. We hand-fake the `Registry`
// (with a per-view `Client` whose `callTool`/`close` are scripted) and inject a
// scripted fake OpenAI client through the `openai` seam added to
// `buildChatState`/`runOneShot`. A fresh empty working dir (no ./skills/) keeps
// `discoverSkills` empty, so the one-shot run exercises the plain agent loop
// deterministically.
//
// Covers:
//   * runTurn   — success (tool call → answer, history grows) and failure
//     (null, unprocessed user message popped from history).
//   * runOneShot — exit code 0 + answer printed on success; 1 + error on failure.
//   * printBanner — the "Type a request" hint only in interactive mode.
//   * file tools — a scripted model drives write_file → read_file → edit_file
//     and the resulting on-disk content is asserted (test 6).

import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Spinner,
  printBanner,
  runOneShot,
  runTurn,
  summarizeHistory,
  replaceHistoryWithSummary,
  slashCompletions,
  switchModel,
} from "../ui.js";
import type { ChatState } from "../ui.js";
import { mcpToolsToOpenai } from "../agent.js";
import { openAiTools } from "../servers.js";
import { saveModelsFile, type ModelFile } from "../models.js";
import type { OpenAI } from "openai";
import type {
  CallToolResult,
  Client,
  ConversationMessage,
  Registry,
  ServerView,
  Tool,
} from "../types.js";

// The fake model is not structurally an OpenAI instance (it lacks apiKey,
// baseURL, …), so it must be cast. `unknown` casts cleanly to the concrete type.
type FakeOpenAI = InstanceType<typeof OpenAI>;

// ---------------------------------------------------------------------------
// scripted fake OpenAI (same shape as agent-stub-test.ts)
// ---------------------------------------------------------------------------
function makeFakeModel(script: (n: number) => any): unknown {
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
}
const choice = (
  message: { content?: string; tool_calls?: any },
  finish_reason: string
) => ({
  choices: [{ message: { role: "assistant", ...message }, finish_reason }],
});
const toolCall = (id: string, name: string, args: string) => ({
  id,
  type: "function",
  function: { name, arguments: args },
});

// ---------------------------------------------------------------------------
// hand-faked Registry (no real connection)
// ---------------------------------------------------------------------------
function mkTool(name: string): Tool {
  return {
    name,
    title: name,
    description: `dummy ${name}`,
    inputSchema: { type: "object" },
  } as Tool;
}

function makeClient(viewLabel: string): {
  calls: { name: string; args: Record<string, unknown> }[];
  client: Client;
} {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client: Client = {
    callTool: async (req: { name?: string; arguments?: Record<string, unknown> }) => {
      calls.push({ name: req.name ?? "?", args: req.arguments ?? {} });
      return {
        isError: false,
        content: [{ type: "text", text: `${viewLabel}:${req.name ?? "?"}` }],
      } as CallToolResult;
    },
    close: async () => {
      /* nothing */
    },
  } as unknown as Client;
  return { calls, client };
}

function makeRegistry(
  tools: Tool[],
  serverName: string = "fake",
): { registry: Registry; calls: { name: string; args: Record<string, unknown> }[] } {
  const { calls, client } = makeClient(serverName);
  const view: ServerView = {
    name: serverName,
    kind: "http",
    client,
    address: "http://127.0.0.1:9000/mcp",
    tools,
    keyedTools: tools.map((t) => ({ key: t.name, tool: t })),
  };
  const byKey = new Map<string, { view: ServerView; tool: Tool }>();
  for (const { key, tool } of view.keyedTools) byKey.set(key, { view, tool });
  const registry: Registry = {
    views: [view],
    warnings: [],
    keyedViews: [view],
    byKey,
  };
  return { registry, calls };
}

// Build a ChatState without `buildChatState` (so we skip discoverSkills / the
// real OpenAI constructor) — used for direct `runTurn` tests.
function makeState(
  tools: Tool[],
  registry: Registry,
  openai: unknown,
): ChatState {
  return {
    openai: openai as unknown as ChatState["openai"],
    openaiTools: mcpToolsToOpenai(openAiTools(registry)),
    skills: [],
    registry,
    model: "test-model",
    base: null,
    baseDir: workDir,
  };
}

// ---------------------------------------------------------------------------
// stdout capture (covers console.log *and* the spinner, both of which route
// through process.stdout.write)
// ---------------------------------------------------------------------------
function captureStdout(): { text: () => string; stop: () => void } {
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (chunk: any, ...rest: any[]) => {
    chunks.push(chunk.toString());
    return origWrite(chunk, ...rest);
  };
  return {
    text: () => chunks.join(""),
    stop: () => {
      (process.stdout as any).write = origWrite;
    },
  };
}

// ---------------------------------------------------------------------------
// Work from a fresh, empty cwd so discoverSkills finds nothing.
// ---------------------------------------------------------------------------
const originalCwd = process.cwd();
const workDir = join(
  tmpdir(),
  `slask-ui-stub-${Date.now()}-${Math.random().toString(36).slice(2)}`
);
await mkdir(workDir, { recursive: true });
process.chdir(workDir);
try {
  // ---- Test 1: runTurn success (tool call -> answer, history grows) ---------
  {
    const { registry, calls } = makeRegistry([mkTool("echo")]);
    const state = makeState(
      [mkTool("echo")],
      registry,
      makeFakeModel((n) => {
        if (n === 1)
          return choice(
            { tool_calls: [toolCall("c1", "echo", JSON.stringify({ message: "hi" }))], },
            "tool_calls"
          );
        if (n === 2) return choice({ content: "Hello, hi." }, "stop");
        throw new Error(`unexpected round ${n}`);
      })
    );
    const spinner = new Spinner();
    const history: ConversationMessage[] = [];
    const answer = await runTurn(state, "say hi", history, spinner);
    assert(answer === "Hello, hi.", `answer: ${JSON.stringify(answer)}`);
    assert(history.length === 2, `history length: ${history.length}`);
    assert(
      history[0].role === "user" && history[0].content === "say hi",
      `user msg: ${JSON.stringify(history[0])}`
    );
    assert(
      history[1].role === "assistant" && history[1].content === "Hello, hi.",
      `assistant msg: ${JSON.stringify(history[1])}`
    );
    assert(calls.length === 1, `call count: ${calls.length}`);
    assert(calls[0].name === "echo", `call name: ${calls[0].name}`);
    assert(
      JSON.stringify(calls[0].args) === JSON.stringify({ message: "hi" }),
      `call args: ${JSON.stringify(calls[0].args)}`
    );
    console.log("PASS test1 — runTurn success (tool call, answer, history grows)");
  }

  // ---- Test 2: runTurn failure (null, user message popped) ------------------
  {
    const { registry } = makeRegistry([mkTool("echo")]);
    const state = makeState(
      [mkTool("echo")],
      registry,
      makeFakeModel((n) => {
        if (n === 1) return choice({ content: "cut off mid-sentence..." }, "length");
        throw new Error(`unexpected round ${n}`);
      })
    );
    const spinner = new Spinner();
    const earlier: ConversationMessage = { role: "user", content: "earlier turn" };
    const history: ConversationMessage[] = [earlier];
    const answer = await runTurn(state, "trigger failure", history, spinner);
    assert(answer === null, `answer should be null, got ${JSON.stringify(answer)}`);
    assert(history.length === 1, `history should be unchanged (popped), length ${history.length}`);
    assert(
      history[0].role === "user" && history[0].content === "earlier turn",
      `history[0]: ${JSON.stringify(history[0])}`
    );
    console.log("PASS test2 — runTurn failure -> null + user message popped");
  }

  // ---- Test 3: runOneShot success (exit 0, answer printed) ------------------
  {
    const { registry } = makeRegistry([mkTool("echo")]);
    const out = captureStdout();
    const fake = makeFakeModel((n) => {
      if (n === 1)
        return choice(
          { tool_calls: [toolCall("c1", "echo", JSON.stringify({ message: "hi" }))], },
          "tool_calls"
        );
      if (n === 2) return choice({ content: "Hello, hi." }, "stop");
      throw new Error(`unexpected round ${n}`);
    }) as FakeOpenAI;
    const code = await runOneShot({
      registry,
      model: "test-model",
      base: null,
      prompt: "say hi",
      openai: fake,
    });
    const stdout = out.text();
    out.stop();
    assert(code === 0, `exit code: ${code}`);
    assert(stdout.includes("Hello, hi."), `answer not in stdout: ${JSON.stringify(stdout)}`);
    assert(stdout.includes("prompt:"), `prompt line not in stdout: ${JSON.stringify(stdout)}`);
    console.log("PASS test3 — runOneShot success -> 0 + answer printed");
  }

  // ---- Test 3b: runOneShot --answer-only: stdout is exactly the answer -------
  {
    const { registry } = makeRegistry([mkTool("echo")]);
    const out = captureStdout();
    const fake = makeFakeModel((n) => {
      if (n === 1)
        return choice({ tool_calls: [toolCall("c1", "echo", JSON.stringify({ message: "hi" }))] }, "tool_calls");
      if (n === 2) return choice({ content: "Hello, hi." }, "stop");
      throw new Error(`unexpected round ${n}`);
    }) as FakeOpenAI;
    const code = await runOneShot({ registry, model: "test-model", base: null, prompt: "say hi", openai: fake, answerOnly: true });
    const stdout = out.text();
    out.stop();
    assert(code === 0, `exit code: ${code}`);
    assert(stdout === "Hello, hi.\n", `stdout must be only the answer: ${JSON.stringify(stdout)}`);
    console.log("PASS test3b — runOneShot answerOnly -> stdout is exactly the answer (no prompt, no tool trace)");
  }

  // ---- Test 3c: state.showTools=false hides the tool trace in runTurn ------
  {
    for (const show of [true, false]) {
      const { registry } = makeRegistry([mkTool("echo")]);
      const fake = makeFakeModel((n) => {
        if (n === 1) return choice({ tool_calls: [toolCall("c1", "echo", JSON.stringify({ message: "hi" }))] }, "tool_calls");
        return choice({ content: "done" }, "stop");
      }) as FakeOpenAI;
      const state = makeState([mkTool("echo")], registry, fake);
      state.showTools = show;
      const out = captureStdout();
      const answer = await runTurn(state, "go", [], new Spinner());
      const stdout = out.text();
      out.stop();
      assert(answer === "done", `answer: ${answer}`);
      assert(stdout.includes("▸ echo") === show, `trace ${show ? "missing" : "present"}: ${JSON.stringify(stdout)}`);
    }
    console.log("PASS test3c — showTools=false hides the ▸ tool trace; the answer is still returned");
  }

  // ---- Test 4: runOneShot failure (exit 1, error printed) ------------------
  {
    const { registry } = makeRegistry([mkTool("echo")]);
    const out = captureStdout();
    const fake = makeFakeModel((n) => {
      if (n === 1) return choice({ content: "cut off mid-sentence..." }, "length");
      throw new Error(`unexpected round ${n}`);
    }) as FakeOpenAI;
    const code = await runOneShot({
      registry,
      model: "test-model",
      base: null,
      prompt: "boom",
      openai: fake,
    });
    const stdout = out.text();
    out.stop();
    assert(code === 1, `exit code: ${code}`);
    assert(
      /cut off by the token limit/.test(stdout),
      `cutoff error not in stdout: ${JSON.stringify(stdout)}`
    );
    assert(
      !stdout.includes("Hello, hi."),
      "no stray answer after a failure"
    );
    console.log("PASS test4 — runOneShot failure -> 1 + error printed");
  }

  // ---- Test 5: printBanner (interactive flag) -------------------------------
  {
    const { registry } = makeRegistry([mkTool("echo")]);
    const state: ChatState = {
      openai: {} as unknown as ChatState["openai"],
      openaiTools: mcpToolsToOpenai(openAiTools(registry)),
      skills: [],
      registry,
      model: "test-model",
      base: null,
      baseDir: workDir,
    };

    const a = captureStdout();
    printBanner(state, false);
    const nonInteractive = a.text();
    a.stop();
    assert(
      !nonInteractive.includes("Type a request"),
      `non-interactive should omit 'Type a request': ${JSON.stringify(nonInteractive)}`
    );
    assert(nonInteractive.includes("test-model"), `model not in banner: ${JSON.stringify(nonInteractive)}`);
    assert(nonInteractive.includes("tools"), `tools line not in banner: ${JSON.stringify(nonInteractive)}`);

    const b = captureStdout();
    printBanner(state, true);
    const interactive = b.text();
    b.stop();
    assert(
      interactive.includes("Type a request"),
      `interactive should include 'Type a request': ${JSON.stringify(interactive)}`
    );
    console.log("PASS test5 — printBanner (interactive flag)");
  }

  // ---- Test 6: file tools — write_file → read_file → edit_file, then assert
  // the resulting on-disk content in workDir ----------------------------------
  {
    const { registry, calls } = makeRegistry([mkTool("echo")]);
    const out = captureStdout();
    const state = makeState(
      [mkTool("echo")],
      registry,
      makeFakeModel((n) => {
        if (n === 1)
          return choice(
            {
              tool_calls: [
                toolCall(
                  "f1",
                  "write_file",
                  JSON.stringify({ path: "hello.txt", content: "hi" })
                ),
              ],
            },
            "tool_calls"
          );
        if (n === 2)
          return choice(
            {
              tool_calls: [
                toolCall("f2", "read_file", JSON.stringify({ path: "hello.txt" })),
              ],
            },
            "tool_calls"
          );
        if (n === 3)
          return choice(
            {
              tool_calls: [
                toolCall(
                  "f3",
                  "edit_file",
                  JSON.stringify({
                    path: "hello.txt",
                    search: "hi",
                    replace: "hello, world",
                  })
                ),
              ],
            },
            "tool_calls"
          );
        if (n === 4) return choice({ content: "Done." }, "stop");
        throw new Error(`unexpected round ${n}`);
      })
    );
    const spinner = new Spinner();
    const history: ConversationMessage[] = [];
    const answer = await runTurn(state, "create hello.txt containing hi, read it, then edit it to hello, world", history, spinner);
    const stdout = out.text();
    out.stop();
    assert(answer === "Done.", `answer: ${JSON.stringify(answer)}`);
    assert(history.length === 2, `history length: ${history.length}`);
    // The file on disk must be the *edited* content — proving the full
    // write → read → edit round-trip hit the real filesystem in workDir.
    assert(
      (await readFile(join(workDir, "hello.txt"), "utf8")) === "hello, world",
      "on-disk content wrong: " +
        JSON.stringify((await readFile(join(workDir, "hello.txt"), "utf8")))
    );
    // The tool trace must show all three file tools, in order, and the MCP
    // echo tool must not have been touched (file routing is bypassing MCP).
    const idxW = stdout.indexOf("write_file");
    const idxR = stdout.indexOf("read_file");
    const idxE = stdout.indexOf("edit_file");
    assert(idxW >= 0 && idxR > idxW && idxE > idxR, `tool order: ${JSON.stringify(stdout)}`);
    assert(calls.length === 0, `MCP echo calls expected 0, got ${calls.length}`);
    console.log("PASS test6 — file tools: write→read→edit round-trip on disk");
  }

  // ---- Test 7: /compact — summarizeHistory + history swap --------------------
  //   (a) a non-empty scripted completion -> summary returned; after
  //       replaceHistoryWithSummary, history is a single user-role message.
  //   (b) empty history -> null, unchanged (deterministic no-op).
  //   (c) a throwing model call -> null, history unchanged (failure never
  //       destroys history).
  {
    const { registry } = makeRegistry([mkTool("echo")]);

    // (a) success: the model's answer becomes a single user-role summary.
    const stateA = makeState(
      [],
      registry,
      makeFakeModel((n) =>
        choice(
          {
            content:
              "User wanted a page saved as markdown in tmp/. Open: where to store it.",
          },
          "stop"
        )
      ) as unknown as FakeOpenAI
    );
    const beforeA: ConversationMessage[] = [
      { role: "user", content: "download a web page as a markdown file" },
      { role: "assistant", content: "I can write it to a file in tmp/." },
    ];
    const summaryA = await summarizeHistory(stateA, beforeA);
    assert(
      summaryA === "User wanted a page saved as markdown in tmp/. Open: where to store it.",
      `summary: ${JSON.stringify(summaryA)}`
    );
    const removedA = replaceHistoryWithSummary(beforeA, summaryA);
    assert(removedA === 2, `removed: ${removedA}`);
    assert(beforeA.length === 1, `history length after compact: ${beforeA.length}`);
    assert(beforeA[0].role === "user", `summary role: ${beforeA[0].role}`);
    assert(
      beforeA[0].content ===
        "## Summary of this conversation (generated via /compact)\n\n" + summaryA,
      `summary content: ${JSON.stringify(beforeA[0].content)}`
    );
    console.log(
      "PASS test7a — summarizeHistory success + history swap to single user message"
    );

    // (b) empty history: deterministic no-op (null, unchanged, model not consulted).
    const stateB = makeState(
      [],
      registry,
      makeFakeModel((n) => {
        throw new Error(`no scripted response for round ${n}`);
      }) as unknown as FakeOpenAI
    );
    const emptyB: ConversationMessage[] = [];
    const sB = await summarizeHistory(stateB, emptyB);
    assert(
      sB === null,
      `empty history should be null, got ${JSON.stringify(sB)}`
    );
    assert(emptyB.length === 0, `empty history unchanged, length ${emptyB.length}`);
    console.log("PASS test7b — summarizeHistory empty history -> null, unchanged");

    // (c) a throwing model call -> null, history unchanged.
    const stateC = makeState(
      [],
      registry,
      makeFakeModel((n) => {
        throw new Error(`no scripted response for round ${n}`);
      }) as unknown as FakeOpenAI
    );
    const beforeC: ConversationMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const sC = await summarizeHistory(stateC, beforeC);
    assert(
      sC === null,
      `failing model should be null, got ${JSON.stringify(sC)}`
    );
    assert(
      beforeC.length === 2,
      `failing model leaves history, length ${beforeC.length}`
    );
    assert(
      beforeC[0].content === "hi" && beforeC[1].content === "hello",
      `history content changed: ${JSON.stringify(beforeC)}`
    );
    console.log(
      "PASS test7c — summarizeHistory model throws -> null, history unchanged"
    );
  }

  // ---- Test 8: slashCompletions — the readline tab-completer for the REPL --
  //   Pure function, no TTY needed. Expected values mirror readline's
  //   first-Tab (insert the common-prefix extension) / second-Tab (print
  //   the list) algorithm, where the 2nd array entry is the text the
  //   algorithm replaces/extends.
  {
    const assertPairs = (
      line: string,
      expected: [string[], string],
      label: string,
      modelChoices?: readonly string[],
    ): void => {
      const [cand, completeOn] = slashCompletions(line, modelChoices);
      assert(
        JSON.stringify(cand) === JSON.stringify(expected[0]),
        `${label}: candidates ${JSON.stringify(cand)}`
      );
      assert(completeOn === expected[1], `${label}: completeOn ${JSON.stringify(completeOn)}`);
    };

    const allTop = [
      "help", "tools", "skills", "reset", "clear",
      "compact", "summarize", "model", "budget", "verbose", "schedule", "ralph",
      "quit", "exit",
    ];
    const scheduleSubs = ["add", "list", "rm"];
    const ralphSubs = [
      "add", "check", "init", "list", "plan", "reopen", "report", "spec", "split", "start", "status", "stop",
    ];

    // No hint for plain text or an empty line.
    assertPairs("what time is it?", [[], ""], "plain text");
    assertPairs("", [[], ""], "empty");
    assertPairs("   ", [[], ""], "whitespace");

    // Bare "/" → full top-level list, empty completeOn (second Tab prints it).
    assertPairs("/", [allTop, ""], "bare /");

    // Single-token top-level: unique prefix auto-completes; aliases resolve
    // to full names.
    assertPairs("/sch", [["schedule"], "sch"], "/sch");
    assertPairs("/h", [["help"], "h"], "/h");
    assertPairs("/qu", [["quit"], "qu"], "/qu");
    assertPairs("/t", [["tools"], "t"], "/t");
    // Ambiguous prefix: both "reset" and "ralph" start with "r" -> no auto-insert,
    // second Tab lists both.
    assertPairs("/r", [allTop.filter((c) => c.startsWith("r")), "r"], "/r ambiguous");
    assertPairs("/s", [allTop.filter((c) => c.startsWith("s")), "s"], "/s ambiguous");
    assertPairs("/HEL", [["help"], "HEL"], "/HEL uppercase");
    assertPairs("/unknown", [allTop, "unknown"], "/unknown no-hit fallback");

    // /schedule subcommand completion.
    assertPairs("/schedule a", [["add"], "a"], "/schedule a");
    assertPairs("/schedule l", [["list"], "l"], "/schedule l");
    assertPairs("/schedule rm", [["rm"], "rm"], "/schedule rm");
    // Single token -> top-level path: filter the full top-level list by the typed
    // word, so the fully-typed command yields just itself (already complete).
    assertPairs("/schedule", [["schedule"], "schedule"], "/schedule alone -> self");
    assertPairs("/schedule xyz", [scheduleSubs, "xyz"], "/schedule xyz no-hit fallback");
    assertPairs("/SCHEDULE a", [["add"], "a"], "/SCHEDULE a case-insensitive first token");

    // /model subcommand completion — catalog `provider/id`. Completes only when
    // `modelChoices` is supplied (the REPL loads it once at start); bare `/model`
    // still auto-completes to itself via the top-level path (single-token branch
    // is checked before the subcommand branch).
    const modelChoices = [
      "ollama/qwen2.5:14b",
      "custom-proxy/llama-3.1-8b",
      "real-openai/gpt-4o-mini",
    ];
    // Single token -> top-level path (modelChoices irrelevant): completes to itself.
    assertPairs("/model", [["model"], "model"], "/model alone -> self");
    // With choices: unique prefix auto-completes to a full provider/id.
    assertPairs("/model oll", [["ollama/qwen2.5:14b"], "oll"], "/model oll", modelChoices);
    assertPairs("/model c", [["custom-proxy/llama-3.1-8b"], "c"], "/model c", modelChoices);
    // No hit -> full selection list as fallback (second Tab prints it).
    assertPairs("/model z", [modelChoices, "z"], "/model z no-hit fallback", modelChoices);
    // No modelChoices -> no hint (falls to the no-match default).
    assertPairs("/model foo", [[], ""], "/model foo no choices");

    // /ralph subcommand completion.
    // "st" matches start/status/stop (three) -> no unique extension; second Tab
    // lists all three in array order.
    assertPairs(
      "/ralph st",
      [ralphSubs.filter((c) => c.startsWith("st")), "st"],
      "/ralph st ambiguous",
    );
    assertPairs("/ralph li", [["list"], "li"], "/ralph li");
    assertPairs("/ralph", [["ralph"], "ralph"], "/ralph alone -> self");
    assertPairs("/ralph xyz", [ralphSubs, "xyz"], "/ralph xyz no-hit fallback");

    // Unknown second token → no hint.
    assertPairs("/foo bar", [[], ""], "/foo bar");
    assertPairs("/schedule add", [["add"], "add"], "/schedule add exact");

    console.log("PASS test8 — slashCompletions top-level + /schedule + /ralph + /model");
  }

  // ---- Test 9: switchModel — swap the live REPL agent's model ----------
  //   Seeds a two-provider catalog into the scratch cwd, then applies a bare
  //   id and a full provider/id selection via switchModel. Asserts the resolved
  //   name/base/maxTokens land on state and a new OpenAI client is installed,
  //   while the MCP tool list and skills stay untouched. An unknown selection
  //   throws and leaves the prior (ollama) model exactly as it was.
  {
    const { registry } = makeRegistry([mkTool("echo")]);
    // Two providers: `ollama` (no apiKey, no /v1 in its base) and a keyed
    // `custom-proxy` — covers both the env-key fallback and explicit-key paths.
    await saveModelsFile(
      workDir,
      {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://54.244.44.99:11434",
              models: [
                {
                  id: "qwen2.5:14b",
                  name: "qwen2.5:14b",
                  contextWindow: 65535,
                  maxTokens: 65535,
                },
              ],
            },
            "custom-proxy": {
              baseUrl: "http://localhost:4000",
              apiKey: "LITELLM_KEY",
              models: [
                {
                  id: "llama-3.1-8b",
                  name: "Llama 3.1 8B",
                  contextWindow: 128000,
                  maxTokens: 32000,
                },
              ],
            },
          },
        },
      } satisfies ModelFile
    );
    const state = makeState(
      [mkTool("echo")],
      registry,
      makeFakeModel((n) => choice({ content: "x" }, "stop"))
    );
    const beforeOpenai = state.openai;
    const beforeOpenaiTools = state.openaiTools;
    const beforeSkills = state.skills;

    // Bare id, unique across providers -> resolves under the only provider
    // carrying it (custom-proxy); /v1 appended to the raw base.
    await switchModel(state, "llama-3.1-8b");
    const s1 = { selection: state.selection, model: state.model, base: state.base, maxTokens: state.maxTokens };
    assert(s1.selection === "custom-proxy/llama-3.1-8b");
    assert(s1.model === "Llama 3.1 8B", `model: ${s1.model}`);
    assert(s1.base === "http://localhost:4000/v1", `base: ${s1.base}`);
    assert(s1.maxTokens === 32000);
    assert(state.openai !== beforeOpenai, "new OpenAI client expected");
    assert(state.openaiTools === beforeOpenaiTools, "tools must stay put");
    assert(state.skills === beforeSkills, "skills must stay put");

    // Full provider/id -> ollama (no apiKey -> env/"local" fallback; raw base
    // normalized to /v1).
    await switchModel(state, "ollama/qwen2.5:14b");
    const s2 = { selection: state.selection, model: state.model, base: state.base, maxTokens: state.maxTokens };
    assert(s2.selection === "ollama/qwen2.5:14b");
    assert(s2.model === "qwen2.5:14b", `model: ${s2.model}`);
    assert(s2.base === "http://54.244.44.99:11434/v1", `base: ${s2.base}`);
    assert(s2.maxTokens === 65535);
    assert(state.openai !== beforeOpenai);

    // Unknown selection throws and leaves the prior (ollama) model active.
    const afterFail = {
      model: state.model,
      base: state.base,
      selection: state.selection,
      openai: state.openai,
    };
    await assert.rejects(
      switchModel(state, "nope"),
      (e) => (e instanceof Error ? e.message : String(e)).includes('unknown model "nope"'),
      `switchModel('nope') should reject`
    );
    assert(state.model === afterFail.model);
    assert(state.base === afterFail.base);
    assert(state.selection === afterFail.selection);
    assert(state.openai === afterFail.openai);

    console.log("PASS test9 — switchModel: bare id + provider/id + unknown leaves state intact");
  }

  console.log("\nALL UI STUB TESTS PASSED");
} finally {
  process.chdir(originalCwd);
  await rm(workDir, { recursive: true, force: true });
}
process.exit(0);
