/**
 * `trail init --pair CODE` run by a coding agent: the person asked for Trail on
 * its page, so this run reads the repo's merged PR reviews like the person's own
 * terminal does, and what reviewers made authors change reaches the page as
 * found learnings. Without `--pair`, an agent's init still starts no `claude`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { GITHUB } from "./pr-reviews-fixtures.js";

/** Variables an agent sets: the run under test must not inherit the runner's. */
const AGENT_VARS = /^(CLAUDECODE|CLAUDE_CODE_.*|CODEX_.*|OPENCODE.*|GEMINI_CLI|CURSOR_.*|ANTIGRAVITY_AGENT|COPILOT_.*|AI_AGENT|AGENT|TERM_PROGRAM|TRAIL_NO_FETCH|TRAIL_NO_LOOK_BACK|GH_TOKEN|GITHUB_TOKEN)$/;

/** A repo with the files the reviews were on, whose origin is a bare repo under a `github.com/` path. */
function githubRepo(): string {
  const repo = tmpRepo("pair-reviews");
  const origin = join(mkdtempSync(join(tmpdir(), "gh-origin-")), "github.com", "acme", "shop.git");
  mkdirSync(origin, { recursive: true });
  spawnSync("git", ["init", "-q", "--bare"], { cwd: origin });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  spawnSync("git", ["remote", "add", "origin", origin], { cwd: repo });
  mkdirSync(join(repo, "src", "api"), { recursive: true });
  writeFileSync(join(repo, "src", "api", "orders.ts"), "export async function orders(req) {\n  const rows = await db.query(sql);\n  return rows;\n}\n");
  writeFileSync(join(repo, "src", "api", "users.ts"), "export async function users(req) {\n  return db.query(sql);\n}\n");
  spawnSync("git", ["add", "."], { cwd: repo });
  spawnSync("git", ["-c", "user.name=Bob", "-c", "user.email=bob@acme.test", "commit", "-qm", "api"], { cwd: repo });
  return repo;
}

/** A signed-in `gh` that answers the GraphQL call, and a `claude` that names one finding from the reviews; both log. */
function fakeTools(): { bin: string; log: string } {
  const bin = mkdtempSync(join(tmpdir(), "pair-tools-"));
  const log = join(bin, "log");
  mkdirSync(log);
  const reviews = {
    findings: [
      {
        title: "Return a 500 when db.query fails in src/api",
        body: "## Decided\n- Handlers in `src/api/` log the db.query error and return a 500.",
        evidence: [
          { pr: 41, quote: "swallows the error from db.query" },
          { pr: 38, quote: "must return a 500 when db.query fails" },
        ],
      },
    ],
  };
  writeFileSync(
    join(bin, "claude"),
    `#!/usr/bin/env node
const fs = require("fs");
if (process.argv.includes("--version")) { console.log("9.9.9"); process.exit(0); }
let input = "";
process.stdin.on("data", (b) => (input += b));
process.stdin.on("end", () => {
  const review = input.startsWith("Inline review comments");
  fs.writeFileSync(${JSON.stringify(log)} + (review ? "/reviews.txt" : "/other.txt"), input);
  console.log(JSON.stringify({ is_error: false, total_cost_usd: 0.01, structured_output: review ? ${JSON.stringify(reviews)} : { findings: [] } }));
});
`,
  );
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)} + "/gh.txt", args.slice(0, 2).join(" ") + "\\n");
if (args[0] === "auth" && args[1] === "token") process.exit(0);
if (args[0] === "api" && args[1] === "graphql" && args.includes("owner={owner}")) { console.log(${JSON.stringify(JSON.stringify(GITHUB))}); process.exit(0); }
process.exit(1);
`,
  );
  chmodSync(join(bin, "claude"), 0o755);
  chmodSync(join(bin, "gh"), 0o755);
  return { bin, log };
}

/** A stand-in Trail that takes the handoff and its progress, keeping every body. */
async function standInTrail(): Promise<{ url: string; progress: () => Array<Record<string, unknown>>; close: () => void }> {
  const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push({ path: req.url ?? "", body: raw ? JSON.parse(raw) : {} });
      const reply = (status: number, b: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(b));
      };
      if (req.url === "/api/cli/handoffs") return reply(201, { url: "http://127.0.0.1/connect?state=s" });
      if (req.url === "/api/cli/handoffs/progress") return reply(202, {});
      return reply(410, { error: "gone" });
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    progress: () => bodies.filter((b) => b.path === "/api/cli/handoffs/progress").map((b) => b.body),
    close: () => server.close(),
  };
}

/** `trail init` as Claude Code runs it: CLAUDECODE set, no TTY. */
async function agentInit(repo: string, home: string, bin: string, args: string[]): Promise<{ code: number | null; err: string }> {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!AGENT_VARS.test(k)) env[k] = v;
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "init", repo, "--no-build", "--agents", "auto", ...args], {
    env: { ...env, HOME: home, USERPROFILE: home, TRAIL_HOME: join(home, ".trail"), TRAIL_INVOKED_AS: "trail", DO_NOT_TRACK: "1", GRAFT_MCP_NPX: "1", GIT_TERMINAL_PROMPT: "0", CLAUDECODE: "1", PATH: `${bin}${delimiter}${process.env.PATH}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (c) => (err += c));
  const code = await new Promise<number | null>((ok) => child.on("close", ok));
  return { code, err };
}

/** A PATH with node (the stand-ins' shebang) and git, and nothing else from this machine: no `trail`, whatever it has installed. */
function gitOnly(): string {
  const dir = mkdtempSync(join(tmpdir(), "git-only-"));
  const git = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  symlinkSync(git, join(dir, "git"));
  symlinkSync(process.execPath, join(dir, "node"));
  return dir;
}

type Found = { kind: string; title: string; path: string };
type PhaseRow = { id: string; status: string; count: string };

// The stand-ins are shebang scripts, which Windows won't run as `claude` or `gh`.
test("an agent's init --pair reads the merged PRs' reviews and hands what reviewers flagged to Trail's page", { skip: process.platform === "win32" }, async () => {
  const trail = await standInTrail();
  try {
    const home = tmpRepo("pair-reviews-home");
    mkdirSync(join(home, ".claude"));
    const repo = githubRepo();
    const { bin, log } = fakeTools();
    const r = await agentInit(repo, home, bin, ["--pair", "X4GM5OQU4NIA65ZR", "--server", trail.url]);
    assert.equal(r.code, 0, r.err);
    assert.ok(existsSync(join(log, "reviews.txt")), `claude was asked about the reviews\n${r.err}`);

    const progress = trail.progress();
    const found = progress.flatMap((p) => (p.found as Found[] | undefined) ?? []);
    assert.deepEqual(found.filter((f) => f.kind === "decision").map((f) => f.title), ["Return a 500 when db.query fails in src/api"], JSON.stringify(progress));
    const prs = progress.map((p) => (p.phases as PhaseRow[] | undefined)?.find((ph) => ph.id === "prs")).filter(Boolean).at(-1);
    assert.equal(prs?.status, "done");
    assert.equal(prs?.count, "4 PRs", "the merged PRs it read");
    assert.equal(readdirSync(join(repo, ".trail", "learnings")).filter((f) => f.endsWith(".md")).length, 1, "saved in the repo, for the person to keep or drop on the page");
  } finally {
    trail.close();
  }
});

test("without --pair an agent's init still asks neither gh nor claude", { skip: process.platform === "win32" }, async () => {
  const home = tmpRepo("pair-reviews-nopair-home");
  mkdirSync(join(home, ".claude"));
  const repo = githubRepo();
  const { bin, log } = fakeTools();
  const r = await agentInit(repo, home, bin, []);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(readdirSync(log), [], "neither gh nor claude ran");
});

// Trail's setup prompt is a request for Trail, whatever name ran it: an agent whose `npm install` of
// @trailhq/trail-code failed swaps in the `graft` it already has, and an old shim loads dist/cli.js with no name.
for (const [how, entry] of [["graft", join("src", "bin", "graft.ts")], ["no name (an old shim)", join("src", "cli.ts")]] as const) {
  test(`init --pair started as ${how} still sets up Trail: .trail/ in the repo, and the page told it read the PRs`, { skip: process.platform === "win32" }, async () => {
    const trail = await standInTrail();
    try {
      const home = tmpRepo("pair-graft-home");
      mkdirSync(join(home, ".claude"));
      const repo = githubRepo();
      const { bin } = fakeTools();
      const env: NodeJS.ProcessEnv = {};
      for (const [k, v] of Object.entries(process.env)) if (!AGENT_VARS.test(k) && k !== "TRAIL_INVOKED_AS") env[k] = v;
      const child = spawn(process.execPath, ["--import", "tsx", entry, "init", repo, "--no-build", "--agents", "claude", "--pair", "X4GM5OQU4NIA65ZR", "--server", trail.url], {
        env: { ...env, HOME: home, USERPROFILE: home, TRAIL_HOME: join(home, ".trail"), DO_NOT_TRACK: "1", GRAFT_MCP_NPX: "1", GIT_TERMINAL_PROMPT: "0", CLAUDECODE: "1", PATH: `${bin}${delimiter}${gitOnly()}` },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let err = "";
      child.stderr.on("data", (c) => (err += c));
      const code = await new Promise<number | null>((ok) => child.on("close", ok));
      assert.equal(code, 0, err);
      assert.ok(existsSync(join(repo, ".trail", "hook.cjs")), `wired as Trail\n${err}`);
      const found = trail.progress().flatMap((p) => (p.found as Found[] | undefined) ?? []);
      assert.deepEqual(found.filter((f) => f.kind === "decision").map((f) => f.title), ["Return a 500 when db.query fails in src/api"], err);
      // This machine has no `trail` command (PATH holds only the stand-ins and git): say how to get it.
      assert.match(err, /the trail command isn't installed here · npm install -g @trailhq\/trail-code/);
    } finally {
      trail.close();
    }
  });
}
