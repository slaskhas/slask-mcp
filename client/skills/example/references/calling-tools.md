Tool reference for the default slask-mcp server:

- `echo({ "message": "<string>" })` — echoes the message back, e.g.
  `echo({ "message": "hi" })` → `hi`.
- `current_time_utc()` — current UTC date and time, ISO 8601, e.g.
  `2026-10-03T12:34:56.789Z`.
- `search_tools({ "query": "<string>" })` — case-insensitive search over tool
  names and descriptions; each match comes with its input schema.

If the client is connected to more than one server, a name shared by two
servers is namespaced as `<serverName>__<toolName>` (e.g. `weather__echo`)
and is routed back to the server it came from.
