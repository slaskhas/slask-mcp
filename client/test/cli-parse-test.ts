// cli-parse-test.ts — drives cli.ts::parse(argv) in-process.
//
// `parse` is exported specifically so it can be exercised without running the
// CLI (the entrypoint is guarded out when cli.js is imported). `CliConfig` is
// not exported; fields are asserted directly. The `--args` rejection paths
// call `process.exit(1)` and so are not exercised in-process (documented
// behavior).
import assert from "node:assert/strict";
import { parse } from "../cli.js";

const DEFAULT_URL = "http://127.0.0.1:8000/mcp";

// `parse` reads SLASK_MCP_URL/SLASK_MCP_TOKEN for its defaults. Delete them
// for deterministic default checks, then restore whatever was set by the shell.
const savedUrl = process.env.SLASK_MCP_URL;
const savedToken = process.env.SLASK_MCP_TOKEN;
delete process.env.SLASK_MCP_URL;
delete process.env.SLASK_MCP_TOKEN;
const restoreEnv = () => {
  if (savedUrl === undefined) delete process.env.SLASK_MCP_URL;
  else process.env.SLASK_MCP_URL = savedUrl;
  if (savedToken === undefined) delete process.env.SLASK_MCP_TOKEN;
  else process.env.SLASK_MCP_TOKEN = savedToken;
};
try {
  // ---- Test 1: defaults (no args) -----------------------------------------
  {
    const c = parse([]);
    assert(c.url === DEFAULT_URL, `url: ${c.url}`);
    assert(c.token === null, `token: ${String(c.token)}`);
    assert(c.config === null, `config: ${c.config}`);
    assert(c.noDefault === false, `noDefault: ${c.noDefault}`);
    assert(c.model === null, `model: ${c.model}`);
    assert(c.base === null, `base: ${c.base}`);
    assert(JSON.stringify(c.positional) === "[]", `positional: ${JSON.stringify(c.positional)}`);
    assert(JSON.stringify(c.args) === "{}", `args: ${JSON.stringify(c.args)}`);
    assert(c.prompt === null, `prompt: ${c.prompt}`);
    assert(c.help === false, `help: ${c.help}`);
    console.log("PASS test1 — defaults");
  }

  // ---- Test 2: each flag/value ------------------------------------------------
  {
    assert(parse(["-p", "hi"]).prompt === "hi", "short -p");
    assert(parse(["--prompt", "hi"]).prompt === "hi", "long --prompt");
    assert(parse(["-m", "gemma"]).model === "gemma", "-m");
    assert(parse(["--model", "gemma"]).model === "gemma", "--model");
    assert(parse(["-b", "http://x:11434"]).base === "http://x:11434", "-b");
    assert(parse(["-u", "http://y:9000/mcp"]).url === "http://y:9000/mcp", "-u");
    assert(parse(["-t", "tok"]).token === "tok", "-t");
    assert(parse(["-c", "my.json"]).config === "my.json", "-c");
    assert(parse(["--no-default"]).noDefault === true, "--no-default");
    console.log("PASS test2 — flag/values");
  }

  // ---- Test 3: --args / --message / --query (the tool args bag) -----------
  {
    const a = parse(["--args", '{"a":1,"b":"x","n":[1,2]}']);
    assert(a.args.a === 1, "args.a");
    assert(a.args.b === "x", "args.b");
    assert(JSON.stringify(a.args.n) === JSON.stringify([1, 2]), "args.n");
    assert(parse(["--message", "hello"]).args.message === "hello", "--message");
    assert(parse(["--query", "echo"]).args.query === "echo", "--query");
    // Multiple --args merge into the bag.
    const m = parse(["--args", '{"a":1}', "--args", '{"b":2}']);
    assert(m.args.a === 1 && m.args.b === 2, `merged args: ${JSON.stringify(m.args)}`);
    console.log("PASS test3 — args bag");
  }

  // ---- Test 4: subcommand extraction (positionals) ------------------------
  {
    assert(parse(["list"]).positional.join(",") === "list", "list");
    assert(parse(["call", "echo"]).positional.join(",") === "call,echo", "call echo");
    assert(parse(["skill", "list"]).positional.join(",") === "skill,list", "skill list");
    assert(parse(["skill", "run", "example", "format.sh"]).positional.join(",") === "skill,run,example,format.sh", "skill run");
    assert(parse(["chat"]).positional.join(",") === "chat", "chat");
    assert(parse(["foobar"]).positional.join(",") === "foobar", "unknown -> positional");
    assert(JSON.stringify(parse([]).positional) === "[]", "no positional");
    console.log("PASS test4 — subcommands -> positionals");
  }

  // ---- Test 5: --help/-h ---------------------------------------------------
  {
    assert(parse(["--help"]).help === true, "--help");
    assert(parse(["-h"]).help === true, "-h");
    assert(parse(["help"]).help === false, "positional 'help' is not the flag");
    assert(parse([]).help === false, "no help flag");
    console.log("PASS test5 — help flag");
  }

  // ---- Test 6: flag values are not leaked into positionals -----------------
  {
    const c = parse(["chat", "-p", "hi", "-m", "gemma"]);
    assert(c.positional.join(",") === "chat", `positional leaked: ${JSON.stringify(c.positional)}`);
    assert(c.prompt === "hi" && c.model === "gemma", "prompt+model set");
    const d = parse(["call", "echo", "--message", "hi", "-t", "tok"]);
    assert(d.positional.join(",") === "call,echo", `call positional: ${JSON.stringify(d.positional)}`);
    assert(d.args.message === "hi" && d.token === "tok", "message+token set");
    // A subcommand plus an unknown flag both land in positionals, value flags
    // consumed.
    const e = parse(["call", "search_tools", "--query", "echo"]);
    assert(e.positional.join(",") === "call,search_tools", `pos: ${JSON.stringify(e.positional)}`);
    assert(e.args.query === "echo", "query set");
    console.log("PASS test6 — flag values not leaked into positionals");
  }

  // ---- Test 7: defaults come from the shell env when the flag is absent ---
  {
    process.env.SLASK_MCP_URL = "http://env:9999/mcp";
    process.env.SLASK_MCP_TOKEN = "env-tok";
    const c = parse([]);
    assert(c.url === "http://env:9999/mcp", `env url: ${c.url}`);
    assert(c.token === "env-tok", `env token: ${c.token}`);
    restoreEnv();
    console.log("PASS test7 — shell env supplies defaults");
  }

  restoreEnv();
  console.log("\nALL CLI-PARSE TESTS PASSED");
} finally {
  restoreEnv();
  process.exit(0);
}