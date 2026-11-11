// subagent.ts — the synthetic `run_subagent` tool.
//
// Runs a self-contained task in a fresh agent loop: its own system prompt, an
// empty history (only the task text), a read-only tool set and a small tool
// budget. Only the child's final answer goes back to the parent, so the
// child's tool output never enters the parent's context. Sub-agents cannot
// spawn sub-agents (`run_subagent` is never in the child's tool list), and they
// run one at a time (the agent loop executes tool calls sequentially).

import type { OpenAI } from "openai";

import { runAgentTurn } from "./agent.js";
import type { CallToolResult, OpenAiFunctionTool, ToolCallRecord } from "./types.js";

export const SUBAGENT_TOOL_NAME = "run_subagent";
export const SUBAGENT_MAX_ITERATIONS = 8; // child tool round-trips; its own cap, not /budget
export const SUBAGENT_RESULT_CHARS = 16384; // cap on the report returned to the parent

/** Local tools a sub-agent may use: reading only, plus loading skill instructions. */
export const SUBAGENT_LOCAL_TOOLS: string[] = [
  "read_file",
  "grep_file",
  "list_files",
  "invoke_skill",
];

const SUBAGENT_SYSTEM =
  "You are a research sub-agent working for another agent. Complete the task you " +
  "are given using your tools, then reply with a concise report of what you " +
  "found. You cannot ask questions and nothing you do is visible to the user; " +
  "only your final reply is returned. State facts, not guesses, and say plainly " +
  "when something could not be found.";

export function subagentSystemBlock(): string {
  return (
    "\n\nSub-agents: `run_subagent` runs a task in a fresh context window with " +
    "read-only tools and returns only its final report. Use it to look up facts " +
    "(search files, read large documents, query tools) without filling your own " +
    "context. Give it a complete, self-contained task — it cannot see this " +
    "conversation. It cannot change files."
  );
}

export function subagentTool(): OpenAiFunctionTool {
  return {
    type: "function",
    function: {
      name: SUBAGENT_TOOL_NAME,
      description:
        "Delegate a self-contained research task to a sub-agent with a fresh " +
        "context window and read-only tools (read_file, grep_file, list_files, " +
        "invoke_skill). It cannot see this conversation, so put everything it " +
        "needs in `task`. Returns only its final report.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "the complete, self-contained task, including what to report back",
          },
          use_mcp_tools: {
            type: "boolean",
            description:
              "also give the sub-agent the connected MCP server tools (they may " +
              "have side effects; default false)",
          },
        },
        required: ["task"],
      },
    },
  };
}

export interface SubagentDeps {
  openai: OpenAI;
  model: string;
  maxTokens?: number;
  /** The parent's full tool list; the child gets a filtered subset. */
  tools: OpenAiFunctionTool[];
  /** The parent's tool resolver (keeps role guards and sandboxing in force). */
  callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
  /** Names of the MCP tools within `tools`, added when `use_mcp_tools` is set. */
  mcpToolNames: Set<string>;
  onToolCall?: (record: ToolCallRecord) => void;
}

const textResult = (text: string, isError: boolean): CallToolResult => ({
  isError,
  content: [{ type: "text", text }],
});

/** Run the sub-agent for a `run_subagent` call and wrap its report as a tool result. */
export async function runSubagent(
  deps: SubagentDeps,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const task = typeof args.task === "string" ? args.task.trim() : "";
  if (!task) return textResult("run_subagent requires a non-empty `task`", true);

  const allowed = new Set(SUBAGENT_LOCAL_TOOLS);
  if (args.use_mcp_tools === true) for (const n of deps.mcpToolNames) allowed.add(n);
  const tools = deps.tools.filter(
    (t) => t.function.name !== SUBAGENT_TOOL_NAME && allowed.has(t.function.name),
  );

  try {
    const report = await runAgentTurn(
      {
        openai: deps.openai,
        model: deps.model,
        systemPrompt: SUBAGENT_SYSTEM,
        tools,
        // `tools` is only what the model is offered; enforce it here too.
        callTool: (name, a) =>
          allowed.has(name) && name !== SUBAGENT_TOOL_NAME
            ? deps.callTool(name, a)
            : Promise.reject(new Error(`${name} is not available to a sub-agent`)),
        maxTokens: deps.maxTokens,
        maxIterations: SUBAGENT_MAX_ITERATIONS,
      },
      [{ role: "user", content: task }],
      deps.onToolCall,
    );
    const out =
      report.length > SUBAGENT_RESULT_CHARS
        ? report.slice(0, SUBAGENT_RESULT_CHARS) + "\n… [report truncated]"
        : report;
    return textResult(out || "(the sub-agent returned no report)", false);
  } catch (e) {
    return textResult(`sub-agent failed: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}
