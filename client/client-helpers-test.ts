// client-helpers-test.ts — pure helpers, no server and no model endpoint.
//
// Covers the text/JSON flattening helpers in client.ts (textFrom,
// mcpResultToText, hintFor) and the OpenAI client construction / tool-shape
// helpers in agent.ts (mcpToolsToOpenai, createOpenAiClient).
import assert from "node:assert/strict";

import { textFrom, mcpResultToText, hintFor } from "./client.js";
import { mcpToolsToOpenai, createOpenAiClient } from "./agent.js";
import type { CallToolResult } from "./types.js";

// ---------------------------------------------------------------------------
// textFrom
// ---------------------------------------------------------------------------
{
  assert(textFrom([]) === "", "empty content should be ''");
  assert(textFrom([{ type: "text", text: "one" }] as CallToolResult["content"]) === "one");
  assert(
    textFrom([{ type: "text", text: "one" }, { type: "text", text: "two" }] as CallToolResult["content"]) ===
      "one\ntwo",
    "multi-block join"
  );
  assert(
    textFrom([{ type: "text", text: "one\n\n" }] as CallToolResult["content"]) === "one",
    "trailing newlines stripped"
  );
  assert(
    textFrom(
      [{ type: "text", text: "one" }, { type: "image" } as any, { type: "text", text: "two" }] as CallToolResult["content"]
    ) === "one\n\ntwo",
    "non-text parts ignored (empty slot)"
  );
  console.log("PASS test1 — textFrom (join, strip, non-text)");
}

// ---------------------------------------------------------------------------
// mcpResultToText
// ---------------------------------------------------------------------------
{
  assert(
    mcpResultToText({ isError: true, content: [{ type: "text", text: "boom" }] } as CallToolResult) ===
      "Error: boom",
    "isError -> Error: <text>"
  );
  assert(
    mcpResultToText({ isError: true, content: [] } as CallToolResult) === "Error: (no message)",
    "isError empty -> Error: (no message)"
  );
  const pretty = JSON.stringify({ a: 1, b: "two" }, null, 2);
  assert(
    mcpResultToText({ structuredContent: { a: 1, b: "two" } } as CallToolResult) === pretty,
    "structuredContent -> pretty JSON"
  );
  assert(
    mcpResultToText({ content: [{ type: "text", text: "plain" }] } as CallToolResult) === "plain",
    "text -> text"
  );
  assert(mcpResultToText({} as any) === "no output", "no content -> no output");
  console.log("PASS test2 — mcpResultToText (error/structured/text/empty)");
}

// ---------------------------------------------------------------------------
// hintFor
// ---------------------------------------------------------------------------
{
  assert(/Bearer token/i.test(hintFor("401 Unauthorized")), "401 -> Bearer hint");
  assert(/Bearer token/i.test(hintFor("unauthorized")), "unauthorized -> Bearer hint");
  assert(/1 MiB/.test(hintFor("413 Payload Too Large")), "413 -> payload hint");
  assert(/1 MiB/.test(hintFor("payload too large")), "payload -> payload hint");
  assert(/10 s/.test(hintFor("504 Gateway Timeout")), "504 -> timeout hint");
  assert(/10 s/.test(hintFor("timed out")), "timed out -> timeout hint");
  assert(hintFor("hello, no clue") === "", "no match -> ''");
  console.log("PASS test3 — hintFor (401/413/504/none)");
}

// ---------------------------------------------------------------------------
// mcpToolsToOpenai
// ---------------------------------------------------------------------------
{
  const out = mcpToolsToOpenai([
    {
      name: "echo",
      description: "echoes its input",
      inputSchema: {
        $schema: "http://example.org/schema",
        type: "object",
        properties: { message: { type: "string" } },
      },
    } as any,
    { name: "no-desc", inputSchema: { type: "object" } } as any,
  ]);
  assert(out.length === 2, `expected 2 tools, got ${out.length}`);
  assert(out[0].type === "function", "type function");
  assert(out[0].function.name === "echo", "name");
  assert(out[0].function.description === "echoes its input", "description carried");
  assert(
    (out[0].function.parameters as Record<string, unknown>)?.$schema === undefined,
    "$schema stripped"
  );
  assert(
    (
      out[0].function.parameters as { properties?: { message?: { type?: string } } }
    )?.properties?.message?.type === "string",
    "parameters preserved"
  );
  assert(out[1].function.description === "", "missing description -> ''");
  console.log("PASS test4 — mcpToolsToOpenai ($schema stripped, default desc)");
}

// ---------------------------------------------------------------------------
// createOpenAiClient
// ---------------------------------------------------------------------------
{
  const savedKey = process.env.OPENAI_API_KEY;
  const savedBase = process.env.API_BASE;
  try {
    // real OpenAI endpoint, no key -> throw
    process.env.OPENAI_API_KEY = "";
    delete process.env.OPENAI_API_KEY;
    assert.throws(() => createOpenAiClient({ base: "https://api.openai.com" }), /OPENAI_API_KEY/);
    assert.throws(() => createOpenAiClient({ base: "https://api.openai.com/v1" }), /OPENAI_API_KEY/);
    assert.throws(() => createOpenAiClient({ base: undefined }), /OPENAI_API_KEY/); // default base

    // real OpenAI endpoint with a key -> ok
    process.env.OPENAI_API_KEY = "real-key";
    const withKey = createOpenAiClient({ base: "https://api.openai.com" });
    assert(withKey, "real base + key returns a client");
    assert(
      withKey.baseURL === "https://api.openai.com/v1",
      `baseURL: ${withKey.baseURL}`
    );

    // local / compatible base, no key -> ok (placeholder key), /v1 normalized
    delete process.env.OPENAI_API_KEY;
    assert(createOpenAiClient({ base: "http://localhost:11434" }), "local base no key ok");
    assert(createOpenAiClient({ base: "http://localhost:11434/" }), "trailing slash ok");
    const local = createOpenAiClient({ base: "http://localhost:11434/v1" });
    assert(
      local.baseURL === "http://localhost:11434/v1",
      `local baseURL: ${local.baseURL}`
    );
    // non-openai.com host is not treated as real (no key required)
    assert(createOpenAiClient({ base: "https://api.openai.com.evil.com" }), "look-alike host ok");
  } finally {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
    if (savedBase === undefined) delete process.env.API_BASE;
    else process.env.API_BASE = savedBase;
  }
  console.log("PASS test5 — createOpenAiClient (key policy + /v1 normalization)");
}

console.log("\nALL CLIENT HELPER TESTS PASSED");
process.exit(0);