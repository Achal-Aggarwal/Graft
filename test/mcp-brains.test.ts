/**
 * The local `trail mcp` server serves the workspace's brains once this
 * machine is connected: the connector's four brain tools are listed next to
 * the repo tools and each call is passed to `<trail>/api/v1/mcp` with the
 * stored token. Not connected, nothing changes; connected but offline, the
 * repo tools still answer.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { buildGraph } from "../src/graph/build.js";
import { BRAIN_TOOL_DEFS } from "../src/mcp/brains.js";
import { startFakeTrail, TOKEN, type FakeTrail } from "./fake-trail-server.js";

let trail: FakeTrail | null = null;
after(async () => {
  await trail?.close();
});

async function rpc(messages: object[], dir: string, env: NodeJS.ProcessEnv, expected: number, extra: string[] = []): Promise<any[]> {
  const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", "trail.ts"), "mcp", dir, ...extra], { stdio: ["pipe", "pipe", "pipe"], env });
  const responses: any[] = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) responses.push(JSON.parse(line));
    }
  });
  for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
  const deadline = Date.now() + 20000;
  while (responses.length < expected && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  child.kill();
  await once(child, "exit").catch(() => {});
  return responses;
}

const SESSION = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_context", arguments: { query: "how do we write the product name" } } },
  { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "trail_find_code", arguments: { query: "retryDo" } } },
];

async function builtRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "mcp-brains-"));
  writeFileSync(join(dir, "client.ts"), "export function retryDo(n: number): number {\n  return n;\n}\n");
  writeFileSync(join(dir, "a.ts"), 'import { retryDo } from "./client";\nexport const a = retryDo(4);\n');
  await buildGraph(dir);
  return dir;
}

function envWith(cloud: object | null): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "mcp-brains-home-"));
  const trailHome = join(home, ".trail");
  mkdirSync(trailHome, { recursive: true });
  if (cloud) writeFileSync(join(trailHome, "cloud.json"), JSON.stringify(cloud));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, TRAIL_HOME: trailHome, DO_NOT_TRACK: "1", TRAIL_INVOKED_AS: "trail" };
  delete env.TRAIL_MCP_URL;
  return env;
}

function cloudFor(url: string, token = TOKEN) {
  return {
    url,
    token,
    user: { name: "R", email: "r@acme.test" },
    workspace: { id: "w1", name: "Acme", slug: "w1", url, invite_url: url },
    repos: [],
    linkedAt: 1,
    via: "connect",
  };
}

const BRAINS = ["list_brains", "get_context", "search_rules", "get_rules"];

test("connected: the workspace's brain tools are listed beside the repo tools, and calls go to the workspace with the token", async () => {
  trail = await startFakeTrail();
  const dir = await builtRepo();
  const rs = await rpc(SESSION, dir, envWith(cloudFor(trail.url)), 4);
  const init = rs.find((r) => r.id === 1);
  assert.match(init.result.instructions, /Connected to a Trail workspace: list_brains, get_context/);
  const names = rs.find((r) => r.id === 2).result.tools.map((t: any) => t.name);
  assert.ok(names.includes("trail_find_code"), names.join(","));
  for (const b of BRAINS) assert.ok(names.includes(b), `${b} in ${names.join(",")}`);
  assert.ok(!names.includes("list_agents"), "only the brain tools come through");
  // The connector's own descriptions, when it answers.
  assert.equal(rs.find((r) => r.id === 2).result.tools.find((t: any) => t.name === "get_context").description, "Remote: rules that apply to a task.");

  const call = rs.find((r) => r.id === 3).result;
  assert.equal(call.isError, false);
  assert.match(call.content[0].text, /^Brand brain · rule r1: .*\(asked: how do we write the product name\)$/);
  assert.deepEqual(call.structuredContent, { rules: [{ rule_id: "r1", brain: { name: "Brand" } }] });
  const local = rs.find((r) => r.id === 4).result;
  assert.equal(local.isError, false);
  assert.match(local.content[0].text, /retryDo/);

  const mcp = trail.log.filter((l) => l.path === "/api/v1/mcp");
  assert.ok(mcp.length >= 3);
  assert.ok(mcp.every((l) => l.auth === `Bearer ${TOKEN}`));
  assert.equal(mcp[0]!.body.method, "initialize");
  assert.deepEqual(mcp.find((l) => l.body.method === "tools/call")!.body.params, { name: "get_context", arguments: { query: "how do we write the product name" } });
});

test("connected but offline: the brain tools are listed and answer with a soft error; the repo tools still work", async () => {
  const dir = await builtRepo();
  const rs = await rpc(SESSION, dir, envWith(cloudFor("http://127.0.0.1:9")), 4);
  const tools = rs.find((r) => r.id === 2).result.tools;
  for (const b of BRAINS) assert.ok(tools.some((t: any) => t.name === b));
  assert.equal(tools.find((t: any) => t.name === "get_context").description, BRAIN_TOOL_DEFS[1]!.description);
  const call = rs.find((r) => r.id === 3).result;
  assert.equal(call.isError, true);
  assert.match(call.content[0].text, /couldn't reach your Trail workspace · the repo tools still work/);
  assert.equal(rs.find((r) => r.id === 4).result.isError, false);
});

test("a token the workspace won't take says how to reconnect", async () => {
  trail ??= await startFakeTrail();
  const dir = await builtRepo();
  const rs = await rpc(SESSION, dir, envWith(cloudFor(trail.url, "trl_revoked")), 4);
  const call = rs.find((r) => r.id === 3).result;
  assert.equal(call.isError, true);
  assert.match(call.content[0].text, /token was not accepted; run `trail init --connect <code>`/);
});

test("not connected: no brain tools, and the instructions are what they always were", async () => {
  const dir = await builtRepo();
  const rs = await rpc(SESSION.slice(0, 3), dir, envWith(null), 2);
  const names = rs.find((r) => r.id === 2).result.tools.map((t: any) => t.name);
  assert.ok(names.includes("trail_find_code"));
  for (const b of BRAINS) assert.ok(!names.includes(b));
  assert.doesNotMatch(rs.find((r) => r.id === 1).result.instructions, /Trail workspace/);
});

test("trail mcp --brains, Claude Code's entry: the brain tools and nothing of the repo's", async () => {
  trail ??= await startFakeTrail();
  const dir = await builtRepo();
  const rs = await rpc(SESSION, dir, envWith(cloudFor(trail.url)), 4, ["--brains"]);
  const names = rs.find((r) => r.id === 2).result.tools.map((t: any) => t.name);
  assert.deepEqual(names.sort(), [...BRAINS].sort());
  assert.match(rs.find((r) => r.id === 1).result.instructions, /^Connected to a Trail workspace/);
  assert.doesNotMatch(rs.find((r) => r.id === 1).result.instructions, /indexed by/);
  assert.equal(rs.find((r) => r.id === 3).result.isError, false);
  const repoTool = rs.find((r) => r.id === 4).result;
  assert.equal(repoTool.isError, true);
  assert.match(repoTool.content[0].text, /brain tools only/);

  const off = await rpc(SESSION.slice(0, 3), dir, envWith(null), 2, ["--brains"]);
  assert.deepEqual(off.find((r) => r.id === 2).result.tools, []);
  assert.match(off.find((r) => r.id === 1).result.instructions, /Not connected to a Trail workspace: run `trail init --connect <code>`/);
});
