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

import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Spinner, printBanner, runOneShot, runTurn } from "./ui.js";
import type { ChatState } from "./ui.js";
import { mcpToolsToOpenai } from "./agent.js";
import { openAiTools } from "./servers.js";
import type { OpenAI } from "openai";
import type {
  CallToolResult,
  Client,
  ConversationMessage,
  Registry,
  ServerView,
  Tool,
} from "./types.js";

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

  console.log("\nALL UI STUB TESTS PASSED");
} finally {
  process.chdir(originalCwd);
  await rm(workDir, { recursive: true, force: true });
}
process.exit(0);
