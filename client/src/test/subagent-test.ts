// subagent-test.ts — standalone tests for run_subagent (subagent.ts).
//
// No MCP server or model endpoint: the OpenAI client is a scripted fake, and
// the parent's callTool is a recorder.
import assert from "node:assert/strict";

import {
  SUBAGENT_LOCAL_TOOLS,
  SUBAGENT_TOOL_NAME,
  runSubagent,
  subagentTool,
} from "../subagent.js";
import type { CallToolResult, OpenAiFunctionTool } from "../types.js";

const fn = (name: string): OpenAiFunctionTool => ({
  type: "function",
  function: { name, description: name, parameters: { type: "object", properties: {} } },
});
const text = (r: CallToolResult): string => {
  const first = r.content[0];
  assert(first.type === "text");
  return first.text;
};

// Scripted fake model; records the request of each round.
function fakeModel(script: (n: number) => any, seen: any[]): any {
  let n = 0;
  return {
    chat: {
      completions: {
        async create(req: any) {
          seen.push({ ...req, messages: [...req.messages] });
          return script(++n);
        },
      },
    },
  };
}
const toolCall = (id: string, name: string) => ({
  choices: [
    {
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }],
      },
    },
  ],
});
const answer = (content: string) => ({
  choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
});

const allTools = [
  ...SUBAGENT_LOCAL_TOOLS.map(fn),
  fn("write_file"),
  fn("edit_file"),
  fn("mcp_query"),
  fn(SUBAGENT_TOOL_NAME),
];
const mcpToolNames = new Set(["mcp_query"]);
const ok = (t: string): CallToolResult => ({ isError: false, content: [{ type: "text", text: t }] });

// 1. tool definition
assert.equal(subagentTool().function.name, SUBAGENT_TOOL_NAME);

// 2. empty task rejected, model never called
{
  const seen: any[] = [];
  const r = await runSubagent(
    { openai: fakeModel(() => answer("x"), seen), model: "m", tools: allTools, callTool: async () => ok(""), mcpToolNames },
    { task: "  " },
  );
  assert.equal(r.isError, true);
  assert.equal(seen.length, 0);
}

// 3. read-only tool set, fresh history, report returned, tool call routed to parent
{
  const seen: any[] = [];
  const called: string[] = [];
  const r = await runSubagent(
    {
      openai: fakeModel((n) => (n === 1 ? toolCall("c1", "read_file") : answer("the report")), seen),
      model: "m",
      tools: allTools,
      callTool: async (name) => (called.push(name), ok("file body")),
      mcpToolNames,
    },
    { task: "find the thing" },
  );
  assert.equal(r.isError, false);
  assert.equal(text(r), "the report");
  assert.deepEqual(called, ["read_file"]);
  const offered = seen[0].tools.map((t: any) => t.function.name).sort();
  assert.deepEqual(offered, [...SUBAGENT_LOCAL_TOOLS].sort());
  assert.equal(seen[0].messages.length, 2); // system + task only
  assert.deepEqual(seen[0].messages[1], { role: "user", content: "find the thing" });
}

// 4. use_mcp_tools adds MCP tools, still no writes or nesting
{
  const seen: any[] = [];
  await runSubagent(
    { openai: fakeModel(() => answer("done"), seen), model: "m", tools: allTools, callTool: async () => ok(""), mcpToolNames },
    { task: "t", use_mcp_tools: true },
  );
  const offered = seen[0].tools.map((t: any) => t.function.name);
  assert(offered.includes("mcp_query"));
  assert(!offered.includes("write_file") && !offered.includes(SUBAGENT_TOOL_NAME));
}

// 5. a call to a disallowed tool is refused and never reaches the parent
{
  const called: string[] = [];
  const seen: any[] = [];
  await runSubagent(
    {
      openai: fakeModel((n) => (n === 1 ? toolCall("c1", "write_file") : answer("gave up")), seen),
      model: "m",
      tools: allTools,
      callTool: async (name) => (called.push(name), ok("")),
      mcpToolNames,
    },
    { task: "t" },
  );
  assert.deepEqual(called, []);
  const toolMsg = seen[1].messages.find((m: any) => m.role === "tool");
  assert(/not available to a sub-agent/.test(toolMsg.content), toolMsg.content);
}

// 6. model failure becomes an error result, not a throw
{
  const r = await runSubagent(
    {
      openai: { chat: { completions: { create: async () => { throw new Error("boom"); } } } } as any,
      model: "m",
      tools: allTools,
      callTool: async () => ok(""),
      mcpToolNames,
    },
    { task: "t" },
  );
  assert.equal(r.isError, true);
  assert(/boom/.test(text(r)));
}

console.log("subagent-test: ok");
