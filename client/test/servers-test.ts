// servers-test.ts — drives the servers.ts config + keying helpers in-process
// against temp files and a hand-faked Registry (no live MCP servers).
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildSpecs,
  callToolBy,
  loadConfigServers,
  openAiTools,
  resolveTool,
} from "../servers.js";
import type {
  CallToolResult,
  Client,
  HttpSpec,
  Registry,
  ServerView,
  ServerSpec,
  StdioSpec,
  Tool,
} from "../types.js";

// Capture a thrown value from a sync or async callable (assert.throws only
// sees synchronous throws, so this also catches Promise rejections).
const thrown = async (f: () => unknown): Promise<string> => {
  let message = "";
  try {
    await f();
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  assert(message !== "", "expected a throw but got none");
  return message;
};

// ---------------------------------------------------------------------------
// Config-file loading (loadConfigServers)
// ---------------------------------------------------------------------------
const root = join(tmpdir(), `slask-servers-stub-${Date.now()}`);
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

const writeFileIn = async (name: string, content: string): Promise<string> => {
  const p = join(root, name);
  await writeFile(p, content, "utf8");
  return p;
};

// ---- 1. valid http + stdio entries; all fields carried through -------------
{
  const file = await writeFileIn(
    "valid.json",
    JSON.stringify({
      servers: [
        { name: "weather", type: "http", url: "http://127.0.0.1:9001/mcp", token: "s" },
        {
          name: "cal",
          type: "stdio",
          command: "/bin/false",
          args: ["-a"],
          env: { K: "v" },
          cwd: "/",
          stderr: "pipe",
          maxBufferSize: 10,
        },
      ],
    }),
  );
  const specs = await loadConfigServers({ flag: file });
  assert(specs.length === 2, `specs: ${specs.length}`);
  const http = specs[0] as HttpSpec;
  assert(
    http.name === "weather" &&
      http.kind === "http" &&
      http.url === "http://127.0.0.1:9001/mcp" &&
      http.token === "s",
    JSON.stringify(http)
  );
  const stdio = specs[1] as StdioSpec;
  assert(
    stdio.name === "cal" &&
      stdio.kind === "stdio" &&
      stdio.command === "/bin/false" &&
      JSON.stringify(stdio.args) === JSON.stringify(["-a"]) &&
      stdio.env?.K === "v" &&
      stdio.cwd === "/" &&
      stdio.stderr === "pipe" &&
      stdio.maxBufferSize === 10,
    JSON.stringify(stdio)
  );
  console.log("PASS test1 — valid http + stdio entries");
}

// ---- 2. empty/absent http token => null --------------------------------------
{
  const file = await writeFileIn(
    "tok.json",
    JSON.stringify({
      servers: [
        { name: "x", type: "http", url: "http://127.0.0.1:9002/mcp", token: "" },
        { name: "y", type: "http", url: "http://127.0.0.1:9003/mcp" },
      ],
    }),
  );
  const specs = await loadConfigServers({ flag: file });
  assert((specs[0] as HttpSpec).token === null, "empty token not null");
  assert((specs[1] as HttpSpec).token === null, "absent token not null");
  console.log("PASS test2 — empty/absent token -> null");
}

// ---- 3. missing default path => []; missing explicit path => throw ------------
{
  const emptyDir = join(tmpdir(), `slask-empty-${Date.now()}`);
  await rm(emptyDir, { recursive: true, force: true });
  await mkdir(emptyDir, { recursive: true });
  const defaultPath = join(emptyDir, "mcp.json"); // absent
  const empty = await loadConfigServers({ defaultPath });
  assert(empty.length === 0, `default missing: ${JSON.stringify(empty)}`);
  const m = await thrown(() => loadConfigServers({ flag: join(emptyDir, "nope.json") }));
  assert(/config file not found/.test(m), `explicit missing: ${m}`);
  console.log("PASS test3 — missing default => []; missing explicit => throw");
}

// ---- 4. bad JSON / no servers array / non-object => throw -------------------
{
  const bad = await writeFileIn("bad.json", "{ not json");
  const m1 = await thrown(() => loadConfigServers({ flag: bad }));
  assert(/not valid JSON/.test(m1), `bad json: ${m1}`);

  const noServers = await writeFileIn("noservers.json", JSON.stringify({ foo: "bar" }));
  const m2 = await thrown(() => loadConfigServers({ flag: noServers }));
  assert(/top-level `servers` array/.test(m2), `no servers: ${m2}`);

  const notObj = await writeFileIn("notobj.json", "42");
  const m3 = await thrown(() => loadConfigServers({ flag: notObj }));
  assert(/top-level `servers` array/.test(m3), `non-object: ${m3}`);
  console.log("PASS test4 — bad JSON / no servers array / non-object");
}

// ---- 5. per-entry validation ---------------------------------------------------
{
  const bads = {
    missingName: { type: "http", url: "http://127.0.0.1:9999/mcp" },
    dunder: { name: "a__b", type: "http", url: "http://127.0.0.1:9999/mcp" },
    httpNoUrl: { name: "x", type: "http" },
    httpBadUrl: { name: "x", type: "http", url: "not a url" },
    stdioNoCmd: { name: "x", type: "stdio" },
    badType: { name: "x", type: "grpc", url: "http://x" },
    notObject: null,
  };
  const check = async (label: string, entry: unknown, needle: RegExp): Promise<void> => {
    const file = await writeFileIn(`${label}.json`, JSON.stringify({ servers: [entry] }));
    const m = await thrown(() => loadConfigServers({ flag: file }));
    assert(needle.test(m), `${label}: ${m}`);
  };
  await check("missingName", bads.missingName, /name must be a non-empty string/);
  await check("dunder", bads.dunder, /must not contain "__"/);
  await check("httpNoUrl", bads.httpNoUrl, /url is required for type "http"/);
  await check("httpBadUrl", bads.httpBadUrl, /not a valid URL/);
  await check("stdioNoCmd", bads.stdioNoCmd, /command is required for type "stdio"/);
  await check("badType", bads.badType, /must be "http" or "stdio"/);
  await check("notObject", bads.notObject, /must be an object/);
  console.log(
    "PASS test5 — entry validation (name, __, url, command, type, object)",
  );
}

// ---- 6. buildSpecs: merge default + config; duplicate names => throw ----------
{
  const defaultSpec: ServerSpec = {
    name: "slask",
    kind: "http",
    url: "http://127.0.0.1:8000/mcp",
    token: null,
  } as HttpSpec;
  const configSpecs: ServerSpec[] = [
    { name: "weather", kind: "stdio", command: "/bin/false" } as StdioSpec,
  ];
  const specs = buildSpecs({ defaultSpec, configServers: configSpecs });
  assert(specs.length === 2, `merge: ${specs.length}`);
  assert(specs[0].name === "slask" && specs[1].name === "weather", "order");

  const noDefault = buildSpecs({ configServers: configSpecs });
  assert(noDefault.length === 1 && noDefault[0].name === "weather", "no default");

  // duplicate against the default
  const m1 = await thrown(() =>
    buildSpecs({
      defaultSpec,
      configServers: [{ name: "slask", kind: "stdio", command: "/bin/false" } as StdioSpec],
    })
  );
  assert(/duplicate server name "slask"/.test(m1), m1);
  // duplicate between two config entries
  const m2 = await thrown(() =>
    buildSpecs({
      defaultSpec: null,
      configServers: [
        { name: "dup", kind: "stdio", command: "/bin/false" } as StdioSpec,
        { name: "dup", kind: "stdio", command: "/bin/false2" } as StdioSpec,
      ],
    })
  );
  assert(/duplicate server name "dup"/.test(m2), m2);
  console.log("PASS test6 — buildSpecs merge + duplicate rejection");
}

// ---------------------------------------------------------------------------
// Keying (openAiTools / resolveTool / callToolBy) on a hand-faked Registry
// ---------------------------------------------------------------------------
function mkTool(name: string, desc: string, schema?: Record<string, unknown>): Tool {
  return { name, title: name, description: desc, inputSchema: schema ?? {} } as Tool;
}

// A per-view fake MCP client whose callTool returns text carrying the view
// name, so routing is observable.
function fakeClient(label: string): Client {
  return {
    callTool: async (req: { name?: string }) => ({
      isError: false,
      content: [{ type: "text", text: `${label}:${req.name ?? "?"}` }],
    }),
    close: async () => {
      /* nothing */
    },
  } as unknown as Client;
}

function makeRegistry(
  specs: { name: string; address: string; tools: Tool[]; label: string }[],
): Registry {
  // Mirror connectAllServers' collision logic so the keys are realistic.
  const nameCount = new Map<string, number>();
  for (const v of specs)
    for (const t of v.tools) nameCount.set(t.name, (nameCount.get(t.name) ?? 0) + 1);
  const views: ServerView[] = specs.map((vs) => ({
    name: vs.name,
    kind: "http",
    client: fakeClient(vs.label),
    address: vs.address,
    tools: vs.tools,
    keyedTools: vs.tools.map((tool) => {
      const key = (nameCount.get(tool.name) ?? 0) > 1 ? `${vs.name}__${tool.name}` : tool.name;
      return { key, tool };
    }),
  }));
  const keyedViews = views;
  const byKey = new Map<string, { view: ServerView; tool: Tool }>();
  for (const view of keyedViews)
    for (const { key, tool } of view.keyedTools) byKey.set(key, { view, tool });
  return { views, warnings: [], keyedViews, byKey };
}

const weather = {
  name: "weather",
  address: "http://127.0.0.1:9001/mcp",
  label: "weather",
  tools: [
    mkTool("current_time_utc", "weather's clock", {}),
    mkTool("echo", "echoes", { type: "object" }),
  ],
};
const calendar = {
  name: "calendar",
  address: "http://127.0.0.1:9002/mcp",
  label: "calendar",
  tools: [mkTool("current_time_utc", "calendar's clock", {})],
};
const registry = makeRegistry([weather, calendar]);

// ---- 7. openAiTools: shared names namespaced, unique raw -------------------
{
  const names = openAiTools(registry).map((t) => t.name);
  assert(names.includes("weather__current_time_utc"), names.join(", "));
  assert(names.includes("calendar__current_time_utc"), names.join(", "));
  assert(names.includes("echo"), names.join(", "));
  assert(!names.includes("current_time_utc"), "shared name leaked un-namespaced");
  // $schema-stripped, description carried, schema present.
  const et = openAiTools(registry).find((t) => t.name === "echo");
  assert(et?.description === "echoes", "echo description");
  assert(et?.inputSchema?.type === "object", "echo schema");
  console.log("PASS test7 — openAiTools namespaces shared tools");
}

// ---- 8. resolveTool: namespaced -> right view + raw tool; unknown -> null ----
{
  const w = resolveTool("weather__current_time_utc", registry);
  assert(w, "weather__current_time_utc resolved");
  assert(w!.view.name === "weather" && w!.tool.name === "current_time_utc", "route");
  const e = resolveTool("echo", registry);
  assert(e && e.view.name === "weather" && e.tool.name === "echo", "echo raw");
  assert(resolveTool("ghost", registry) === null, "ghost -> null");
  console.log("PASS test8 — resolveTool routing");
}

// ---- 9. callToolBy: routes to the right client; unknown => throw --------------
{
  const r = await callToolBy("weather__current_time_utc", registry, { extra: 1 });
  assert(r.isError === false, "not error");
  const text = r.content.find((c) => c.type === "text")?.text ?? "";
  assert(text === "weather:current_time_utc", `canned: ${text}`);
  const ce = await callToolBy("calendar__current_time_utc", registry, {});
  const ceText = ce.content.find((c) => c.type === "text")?.text ?? "";
  assert(ceText === "calendar:current_time_utc", `canned: ${ceText}`);
  const m = await thrown(() => callToolBy("ghost", registry, {}));
  assert(/tool "ghost" not found/.test(m), m);
  console.log("PASS test9 — callToolBy routes + unknown throws");
}

await rm(root, { recursive: true, force: true });
console.log("\nALL SERVERS TESTS PASSED");
process.exit(0);