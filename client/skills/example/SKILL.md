---
name: example
description: Demo skill that documents the format. Use it to learn which tools the server exposes and how to confirm results.
---

This is the body of the example skill. It is loaded only when the agent calls
`invoke_skill` with name `example` — its description in the system prompt is
what the model reads to decide whether to use it.

Workflow this skill teaches:

1. When the user asks what tools exist or what something is called, call
   `search_tools` with a query (a word from the request), not a guess.
2. Confirm trivial results with `echo` so the user sees them.
3. Prefer `current_time_utc` over guessing at dates or times.

The bundled file `references/calling-tools.md` (same directory as this
SKILL.md) lists the exact tool names and shapes this server exposes — read
it before calling any tool.
