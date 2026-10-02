# slask-mcp-client

A Node.js CLI that makes MCP servers usable by a language model. Point it at
the slask server — or at any number of your own stdio and HTTP MCP servers —
and drive the tools it exposes either interactively (an agent chat using OpenAI
function-calling) or by hand (`list` / `call`).

## Setup

The client is a **TypeScript** Node.js ESM CLI (`"type": "module"`, Node v20+
required) that talks to MCP servers over streamable HTTP or raw stdio. The
source lives in `client/*.ts`; the runnable program is the compiled
`client/dist/` — so the build must be (re)done before running.

### 1. Prerequisites

- Node.js v20+ with `npm`

### 2. Install

```bash
cd client
npm install
```

### 3. Build

```bash
npm run build
```

Compiles every `.ts` file to `client/dist/*.js`. The `slask-client` binary is
`dist/cli.js` (the `bin` entry in `package.json`). Re-run this after every
source change.

```bash
npm run typecheck   # type-checks without emitting anything
npm run clean       # deletes dist/ (then rebuild)
```

### 4. (Optional) Global command — `npm link`

If you want `slask-client` to work from **any** directory, not just
`client/`, make it a global command once (run from `client/`):

```bash
npm link
```

This symlinks this directory into npm's global prefix and drops a
`slask-client` launcher script in the global `bin` directory, so
`slask-client …` runs from any terminal. Because it's a symlink, the
global command always executes the latest `dist/` build — after a source
change, re-run `npm run build`, but you never need to re-link. Undo with
`npm unlink` (from `client/`).

If you only ever run from inside `client/`, skip this step — `npx
slask-client …` covers it.

### 5. Running the client

After a build, three equivalent ways to launch the CLI — all of them run
`client/dist/cli.js`:

| Way | Command | When |
|-----|---------|------|
| `npx` (recommended) | `npx slask-client list` | From inside `client/`; resolves the local package's `bin` entry, nothing to install |
| Direct | `node dist/cli.js list` | Always works once built; no npm resolution step |
| Global | `npm link` in `client/`, then `slask-client list` | Puts `slask-client` on your `PATH` from anywhere |

`slask-client help` (or `--help`) prints the full command reference. For
agent chat, configure the model via `client/.env` (copy
`client/.env.example` first — it lists `SLASK_MCP_URL`, `API_BASE`, `MODEL`,
`OPENAI_API_KEY`), env vars, or flags; every setting is covered in the
**Options & environment** section below.

Typical first run, once the slask server is up (see **Start the server**
below):

```bash
npx slask-client list                        # can the client see the tools?
npx slask-client call echo --message hello
```


## Start the server

Run the slask-mcp server on the same machine (or on any host reachable by URL). Default bind: `127.0.0.1:8000`, default path: `/mcp`. The server is HTTP with optional Bearer-token auth:

```
# no auth (default)
slask-mcp

# with Bearer auth
SLASK_MCP_TOKEN=my-secret slask-mcp
```

## Multiple servers (configuration file)

The slask server is configured with `--url`/`--token` (or `SLASK_MCP_URL`/
`SLASK_MCP_TOKEN`) and is always connected — named **`slask`** — in
addition to any servers you list in a JSON config file. There is **no fixed
limit** on how many you can add; each entry is a complete, self-contained
spec.

The default config path is `client/mcp.json` (next to `cli.js`, not the current
directory). Override it with `--config`/`-c` or the `SLASK_MCP_CONFIG` env var.
A missing *default* file simply means "no extra servers"; a missing *explicitly
given* file is an error. Copy `client/mcp.example.json` to `client/mcp.json`
to get started:

```json
{
  "servers": [
    {
      "name": "weather",
      "type": "stdio",
      "command": "/path/to/weather-mcp",
      "args": ["--verbose"],
      "env": {"WEATHER_API_KEY": ""}
    },
    {
      "name": "calendar",
      "type": "http",
      "url": "http://127.0.0.1:9001/mcp",
      "token": "secret"
    }
  ]
}
```


| Field          | HTTP           | stdio           | Notes                                                             |
|----------------|----------------|-----------------|-------------------------------------------------------------------|
| `name`         | required       | required        | unique; must not contain a space or `__` (reserved for collisions)|
| `type`         | http or stdio  | http or stdio   | connection kind                                                   |
| `url`          | required (http)| ignored         | full endpoint including `/mcp`                                    |
| `token`        | optional (http)| ignored         | bearer token; sent as `Authorization: Bearer ...`                 |
| `command`      | ignored        | required (stdio)| executable path to run as the server process                      |
| `args`         | ignored        | optional (stdio)| command-line arguments passed to the process                      |
| `env`          | ignored        | optional (stdio)| extra environment variables for the process                       |
| `cwd`          | ignored        | optional (stdio)| working directory for the stdio process (default: current dir)    |
| `stderr`       | ignored        | optional (stdio)| child stderr: `"inherit"`, `"pipe"`, `"ignore"`, or `"overlapped"` (default: `"inherit"`; mirrors Node `spawn` `stdio`) |
| `maxBufferSize`| ignored        | optional (stdio)| max bytes of buffered stdio output per read (default: 10 MiB)     |


**Tool naming and collisions.** Every tool from every connected server is listed once in the
OpenAI function-calling `tools` array. A tool whose name is unique across all connected
servers is exposed under its raw name. When two or more servers expose a tool with the
same raw name, each occurrence is namespaced as `<serverName>__<toolName>` (e.g.
`weather__forecast`, `calendar__forecast`), and the client routes each call back to the
server it came from. The model sees only the namespaced names, so there is no ambiguity.

**Best-effort connect.** Each server is connected independently. A server that fails to
connect (bad URL, token, command not found, timeout) is reported on stderr with a hint
and then skipped; the other servers keep working. The CLI exits with code 1 only when
**no** servers could be reached.

## Interactive agent chat

Run with no subcommand (or `chat`):

```
# local OpenAI-compatible model (e.g. Ollama), no API key needed
SLASK_MCP_URL=http://127.0.0.1:9000/mcp API_BASE=http://192.168.68.73:11434 MODEL=gemma4:12b-mlx slask-client

# real OpenAI (needs OPENAI_API_KEY; API_BASE defaults to https://api.openai.com/v1)
OPENAI_API_KEY=sk-… SLASK_MCP_URL=http://127.0.0.1:9000/mcp slask-client
```

On startup the client shows a banner listing every connected server (name, kind,
address), the model, and the full set of tools. Then it drops into a line-based REPL:

```
slask-agent > what time is it now?
  ▸ current_time_utc({})
      2026-10-01T00:00:00Z
  The UTC time is 2026-10-01T00:00:00Z.

slask-agent >
```

### REPL commands

| Command| What it does                                  |
|--------|-----------------------------------------------|
| /help  | show REPL help                                |
| /tools | list all tools (across every connected server)|
| /reset | clear the conversation history                |
| /quit  | exit the REPL (or /exit, /q, Ctrl+C)          |


## Direct, non-LLM commands

Run a tool without the agent:

```
# list every tool (across every connected server) with its input schema
slask-client list

# call a tool directly
slask-client call echo --message hello
slask-client call current_time_utc
slask-client call search_tools --query echo
slask-client call echo --args '{"message": "hi"}'
```

Warnings about unreachable servers are printed to stderr; the exit code is 1 on failure.

## Options & environment

| Command           | Flag| Env var        | Description                                                                                                 |
|-------------------|-----|----------------|-------------------------------------------------------------------------------------------------------------|
| -u, --url <url>   | -u  |                | MCP server endpoint (default: http://127.0.0.1:8000/mcp)                                                    |
| -t, --token <tok> | -t  | SLASK_MCP_TOKEN| bearer token for the default server (required when the server is set up with a token; otherwise leave blank)|
| -m, --model <name>| -m  | MODEL          | openai model (chat; default: gpt-4o-mini)                                                                   |
| --base-url <url>  |     | API_BASE       | openai base url (chat; default: https://api.openai.com)                                                     |
| OPENAI_API_KEY    |     | OPENAI_API_KEY | openai api key; only needed for the real openai endpoint (see API_BASE note)                                |
|                   |     | OPENAI_MODEL   | legacy model name (checked after MODEL)                                                                     |


## How the agent loop works

Each user turn runs a bounded OpenAI **function-calling** loop (default: up to 8 tool
round-trips per turn):

1. The model sees the system prompt, the conversation history, and the `tools` array
   (built from `tools/list` on every connected server, with `$schema` keys stripped).
2. If the model requests tool calls, each is **routed to the originating server** (raw
   name or `<serverName>__<toolName>` when names collide), the text result is fed back
   into the conversation, and the loop repeats.
3. When the model produces a final (non-tool-call) answer, it is printed and stored in
   history.

A failed tool call (unknown tool, transport error, or a server 4xx/5xx) is returned to
the model as an `ERROR calling …` message so it can adapt and continue — the session does
not crash.

## Errors

Errors go to stderr; the process exits non-zero. Common ones:

- `no MCP servers could be reached` — every server failed to connect (all best-effort
  warnings were shown first).
- `tool not found` — the named tool is not exposed by any connected server (run `list`).

