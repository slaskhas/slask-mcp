// agent-edges-test.ts — runAgentTurn edge cases, fully network-free.
//
// No MCP server, no model endpoint: a scripted fake OpenAI client (same
// helper shape as agent-stub-test.ts) plus a hand-faked callTool resolver.
import assert from "node:assert/strict";

import { runAgentTurn, SYSTEM_PROMPT, MAX_TOOL_ITERATIONS } from "../agent.js";
import type { AgentTurnConfig, CallToolResult } from "../types.js";

// Scripted fake OpenAI: `create` returns whatever `script(n)` says for round n.
function makeFakeModel(
  script: (n: number) => any,
  record?: (n: number, msgs: any[]) => void,
): unknown {
  let n = 0;
  return {
    chat: {
      completions: {
        async create(req: any) {
          n++;
          if (record) record(n, req.messages);
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

// A resolver that records every call and returns a canned MCP result.
function makeCaller(): {
  calls: { name: string; args: Record<string, unknown> }[];
  fn: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
} {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const fn = (
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<CallToolResult> => {
    calls.push({ name, args });
    return Promise.resolve({ isError: false, content: [{ type: "text", text: "ok" }] } as CallToolResult);
  };
  return { calls, fn };
}

const cfg = (
  openai: any,
  callTool: (...a: any[]) => Promise<CallToolResult>,
): AgentTurnConfig => ({
  openai,
  model: "fake-model",
  systemPrompt: SYSTEM_PROMPT,
  tools: [
    {
      type: "function",
      function: { name: "echo", description: "echoes", parameters: { type: "object" } },
    },
  ],
  callTool,
});

const asyncThrown = async (f: () => Promise<unknown>): Promise<string> => {
  let message = "";
  try {
    await f();
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  return message;
};

// ---------------------------------------------------------------------------
// 1. Safety cap: a tool call every round -> stops after 8 iterations
// ---------------------------------------------------------------------------
{
  const { calls, fn } = makeCaller();
  const fake = makeFakeModel((n: number) =>
    choice({ tool_calls: [toolCall(`c${n}`, "echo", `{"x":${n}}`)] }, "tool_calls")
  );
  const capMsg = `stopped after ${MAX_TOOL_ITERATIONS} tool calls in one turn (safety cap)`;
  const message = await asyncThrown(() => runAgentTurn(cfg(fake, fn), []));
  assert(message.includes(capMsg), `message: ${message}`);
  assert(calls.length === MAX_TOOL_ITERATIONS, `expected ${MAX_TOOL_ITERATIONS} calls, got ${calls.length}`);
  console.log(`PASS test1 — safety cap stops after ${MAX_TOOL_ITERATIONS} tool calls`);
}

// ---------------------------------------------------------------------------
// 2. finish_reason "length" -> cut-off error, no tool call needed
// ---------------------------------------------------------------------------
{
  const { calls, fn } = makeCaller();
  const fake = makeFakeModel((n: number) => {
    if (n === 1) return choice({ content: "trunc..." }, "length");
    throw new Error(`unexpected round ${n}`);
  });
  const message = await asyncThrown(() => runAgentTurn(cfg(fake, fn), []));
  assert(
    /cut off by the token limit — try a shorter prompt/.test(message),
    `message: ${message}`
  );
  assert(calls.length === 0, "no tool calls should be made");
  console.log("PASS test2 — finish_reason length -> cut-off error");
}

// ---------------------------------------------------------------------------
// 3. Malformed tool arguments (non-JSON) -> callTool invoked with {}, no crash
// ---------------------------------------------------------------------------
{
  const { calls, fn } = makeCaller();
  const fake = makeFakeModel((n: number) => {
    if (n === 1)
      return choice({ tool_calls: [toolCall("c1", "echo", "NOT JSON {")] }, "tool_calls");
    if (n === 2) return choice({ content: "Recovered after bad args." }, "stop");
    throw new Error(`unexpected round ${n}`);
  });
  const answer = await runAgentTurn(cfg(fake, fn), []);
  assert(calls.length === 1, `expected 1 call, got ${calls.length}`);
  assert(
    JSON.stringify(calls[0].args) === "{}",
    `bad args: ${JSON.stringify(calls[0].args)}`
  );
  assert(
    calls[0].name === "echo" && JSON.stringify(calls[0].args) === JSON.stringify({}),
    "malformed args collapsed to {}"
  );
  assert(answer.length > 0, "expected a final answer after malformed args");
  console.log("PASS test3 — malformed arguments -> {} (no crash)");
}

// ---------------------------------------------------------------------------
// 4. Non-function tool_calls (type !== "function") -> dropped, callTool never
//    invoked, final answer still returned.
// ---------------------------------------------------------------------------
{
  const { calls, fn } = makeCaller();
  const fake = makeFakeModel((n: number) => {
    if (n === 1)
      return choice({ tool_calls: [{ id: "c1", type: "custom", function: undefined }] }, "tool_calls");
    if (n === 2) return choice({ content: "Finished without running the odd call." }, "stop");
    throw new Error(`unexpected round ${n}`);
  });
  const answer = await runAgentTurn(cfg(fake, fn), []);
  assert(calls.length === 0, `non-function calls should not be run: ${calls.length}`);
  assert(answer.length > 0, "expected a final answer");
  console.log("PASS test4 — non-function tool_calls dropped, final answer returned");
}

// ---------------------------------------------------------------------------
// 5. A failing tool call -> error fed back to the model (already covered by the
//    live agent-stub test 4, but re-asserted here with a fake caller).
// ---------------------------------------------------------------------------
{
  const { calls, fn } = makeCaller();
  const fake = makeFakeModel((n: number) => {
    if (n === 1) return choice({ tool_calls: [toolCall("c1", "ghost", "{}")] }, "tool_calls");
    if (n === 2) return choice({ content: "Sorry, that failed." }, "stop");
    throw new Error(`unexpected round ${n}`);
  });
  const answer = await runAgentTurn(cfg(fake, fn), []);
  assert(calls.length === 1, `expected 1 call, got ${calls.length}`);
  assert(calls[0].name === "ghost", `called: ${calls[0].name}`);
  assert(answer.length > 0, "expected a final answer after a failing tool");
  console.log("PASS test5 — failing tool call survives (error feed-back)");
}

// ---------------------------------------------------------------------------
// 6. The per-turn tool budget is independent of earlier turns: a turn that
//    uses 6 of the budget leaves the NEXT turn with a full fresh budget
//    (MAX_TOOL_ITERATIONS), not a leaked MAX_TOOL_ITERATIONS-6. (Guard against
//    any counter leaking across runAgentTurn calls / carrying over between
//    dialog messages.)
// ---------------------------------------------------------------------------
{
  const { calls: callsA, fn: fnA } = makeCaller();
  const { calls: callsB, fn: fnB } = makeCaller();

  // Turn 1: 6 tool rounds, then an answer. (If the budget leaked across turns,
  // turn 2 below would have MAX_TOOL_ITERATIONS-6, not a full one.)
  const turn1 = await runAgentTurn(
    cfg(
      makeFakeModel((n: number) => {
        if (n <= 6)
          return choice({ tool_calls: [toolCall(`t1-${n}`, "echo", `{"x":${n}}`)] }, "tool_calls");
        return choice({ content: "Done after 6 tool rounds." }, "stop");
      }),
      fnA
    ),
    []
  );
  assert(callsA.length === 6, `turn1 calls: ${callsA.length}`);
  assert(
    turn1 === "Done after 6 tool rounds.",
    `turn1 answer: ${turn1}`
  );

  // Turn 2: a FRESH full budget. It exhausts the whole budget, so it can make
  // MAX_TOOL_ITERATIONS tool rounds — not just (MAX_TOOL_ITERATIONS - 6), which a
  // leaking/accumulating counter would leave it with.
  const turn2Msg = await asyncThrown(
    () =>
      runAgentTurn(
        cfg(
          makeFakeModel((n: number) =>
            choice({ tool_calls: [toolCall(`t2-${n}`, "echo", `{"x":${n}}`)] }, "tool_calls")
          ),
          fnB
        ),
        []
      )
  );
  assert(
    callsB.length === MAX_TOOL_ITERATIONS,
    `turn2 calls (must be a full fresh budget of ${MAX_TOOL_ITERATIONS}, not ${MAX_TOOL_ITERATIONS - 6}): ${callsB.length}`
  );
  assert(
    turn2Msg.includes(
      `stopped after ${MAX_TOOL_ITERATIONS} tool calls in one turn (safety cap)`
    ),
    `turn2 message: ${turn2Msg}`
  );
  console.log("PASS test6 — per-turn tool budget is independent (resets each turn)");
}

// ---------------------------------------------------------------------------
// 7. Inline <reasoning> blocks are not part of the answer or the history
// ---------------------------------------------------------------------------
{
  const { calls, fn } = makeCaller();
  const seen: any[][] = [];
  const fake = makeFakeModel(
    (n: number) => {
      if (n === 1)
        return choice(
          {
            content: "<reasoning>need a tool</reasoning>",
            tool_calls: [toolCall("c1", "t", "{}")],
          },
          "tool_calls"
        );
      return choice(
        { content: "<reasoning>Simple greeting.</reasoning>\nHello!" },
        "stop"
      );
    },
    (_n, msgs) => seen.push(msgs.map((m) => ({ ...m })))
  );
  const answer = await runAgentTurn(cfg(fake, fn), []);
  assert(answer === "Hello!", `answer: ${JSON.stringify(answer)}`);
  const assistant = seen[1].find((m) => m.role === "assistant");
  assert(assistant.content === null, `history content: ${JSON.stringify(assistant.content)}`);
  assert(calls.length === 1, "tool still ran");
  console.log("PASS test7 — <reasoning> stripped from answer and history");
}

console.log("\nALL AGENT EDGES TESTS PASSED");
process.exit(0);