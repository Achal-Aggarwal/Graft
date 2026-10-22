/**
 * Day-one skills: a procedure the person walked Claude through in two or more
 * past sessions becomes a skill, with the same two-session quote check a
 * learning gets. Claude Code is a stand-in `claude` on PATH, as in the init test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PairRun } from "../src/cloud/pair.js";
import { finishPastRead, findLearnings, saveSkills, type PastSession } from "../src/notes/cold-start.js";
import { saveFoundSkill, type FoundSkill, type SavedSkill } from "../src/skills/found-skill.js";
import { getSkill, listSkills, skillDirs } from "../src/skills/skills.js";
import { writeNote } from "../src/notes/notes.js";
import { tmpRepo } from "./helpers.js";

function session(id: string, at: string, ...texts: string[]): PastSession {
  return { id, at, prompts: texts.map((text) => ({ text })) };
}

const STEPS = ["Run `npm run build`", "Run `npm test`", "Bump the version in package.json", "Run `npm publish --otp` with the code from the user"];

const sessions = [
  session("aaaaaaaa-1", "2026-10-09T00:00:00Z", "ok now cut the release: build, test, bump the version, then publish"),
  session("bbbbbbbb-2", "2026-10-01T00:00:00Z", "cut the release the usual way: build, test, bump the version, publish"),
  session("cccccccc-3", "2026-09-20T00:00:00Z", "something else entirely"),
];

const quotes = (a = "aaaaaaaa", b = "bbbbbbbb") => [
  { session: a, quote: "cut the release: build, test, bump the version" },
  { session: b, quote: "cut the release the usual way: build, test, bump the version" },
];

function rawSkill(over: object = {}) {
  return { name: "cut a release", title: "Cut a release", for: "team", steps: STEPS, evidence: quotes(), ...over };
}

/** A `claude` that answers --version, and answers -p with `skills` and no findings. */
function fakeClaude(skills: object[]): string {
  const bin = mkdtempSync(join(tmpdir(), "fake-claude-skills-"));
  const answer = { is_error: false, total_cost_usd: 0.01, structured_output: { findings: [], skills } };
  writeFileSync(
    join(bin, "claude"),
    `#!/usr/bin/env node\nif (process.argv.includes("--version")) { console.log("9.9.9"); process.exit(0); }\nprocess.stdin.resume(); process.stdin.on("end", () => console.log(${JSON.stringify(JSON.stringify(answer))}));\n`,
  );
  chmodSync(join(bin, "claude"), 0o755);
  return bin;
}

/** Run `fn` with a fresh TRAIL_HOME and the stand-in claude first on PATH. */
async function withClaude<T>(skills: object[], fn: (repo: string) => Promise<T>): Promise<T> {
  const env = { TRAIL_HOME: process.env.TRAIL_HOME, DO_NOT_TRACK: process.env.DO_NOT_TRACK, PATH: process.env.PATH };
  process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "skills-home-"));
  process.env.DO_NOT_TRACK = "1";
  process.env.PATH = `${fakeClaude(skills)}:${process.env.PATH}`;
  try {
    const repo = tmpRepo("found-skill");
    spawnSync("git", ["init", "-q"], { cwd: repo });
    return await fn(repo);
  } finally {
    process.env.TRAIL_HOME = env.TRAIL_HOME;
    process.env.DO_NOT_TRACK = env.DO_NOT_TRACK;
    process.env.PATH = env.PATH;
  }
}

async function readAndFinish(repo: string) {
  const result = await findLearnings(repo, { sessions });
  const done = await finishPastRead(repo, { sessions: sessions.length, started: Date.now(), done: true, result: Promise.resolve(result) });
  return { result, done };
}

// The stand-in for Claude Code is a shebang script, which Windows won't run as `claude`.
const posix = { skip: process.platform === "win32" };

test("a skill quoted in two sessions is saved to the repo as a SKILL.md the skills list reads", posix, async () => {
  await withClaude([rawSkill()], async (repo) => {
    const { result, done } = await readAndFinish(repo);
    assert.equal(result.skills.length, 1);
    assert.deepEqual(result.skills[0]!.sessions, ["aaaaaaaa-1", "bbbbbbbb-2"]);
    const file = join(repo, ".claude", "skills", "cut-a-release", "SKILL.md");
    assert.deepEqual(done.skills.map((s) => s.path), [file]);
    const text = readFileSync(file, "utf8");
    assert.match(text, /^---\nname: cut-a-release\n/);
    assert.match(text, /\n1\. Run `npm run build`\n2\. Run `npm test`\n3\. Bump the version in package.json\n4\. Run /);
    const skill = getSkill(repo, "cut-a-release")!;
    assert.equal(skill.where, "repo");
    assert.equal(skill.description, "Cut a release");
    assert.deepEqual(listSkills(repo).map((s) => s.name), ["cut-a-release"]);
  });
});

test("a skill quoted from one session is dropped", posix, async () => {
  await withClaude([rawSkill({ evidence: [quotes()[0]!, { session: "aaaaaaaa", quote: "ok now cut the release: build, test" }] })], async (repo) => {
    const { result, done } = await readAndFinish(repo);
    assert.deepEqual(result.skills, []);
    assert.deepEqual(done.skills, []);
    assert.equal(existsSync(join(repo, ".claude", "skills")), false);
  });
});

test("a skill with made-up quotes, under two steps, or named like trail's own is dropped", posix, async () => {
  const bad = [
    rawSkill({ name: "made up", evidence: [{ session: "aaaaaaaa", quote: "never said anything like this" }, { session: "bbbbbbbb", quote: "nor this one either" }] }),
    rawSkill({ name: "one step", steps: ["Run `npm test`"] }),
    rawSkill({ name: "trail" }),
    rawSkill({ name: "" , title: ""}),
  ];
  await withClaude(bad, async (repo) => {
    const { result } = await readAndFinish(repo);
    assert.deepEqual(result.skills, []);
  });
});

test("a skill for you is written to this machine's skills, not the repo", posix, async () => {
  await withClaude([rawSkill({ for: "you" })], async (repo) => {
    const { done } = await readAndFinish(repo);
    const home = join(skillDirs(repo).home, "cut-a-release", "SKILL.md");
    assert.deepEqual(done.skills.map((s) => s.path), [home]);
    assert.equal(existsSync(home), true);
    assert.equal(existsSync(join(repo, ".claude")), false, "nothing in the repo");
    assert.equal(getSkill(repo, "cut-a-release")!.where, "home");
  });
});

test("at most 2 skills come back, the ones in the most sessions first, with secrets scrubbed from the steps", posix, async () => {
  const many = [
    rawSkill({ name: "one", steps: ["Export `api_key=sk-abcdefghijklmnopqrstuv`", "Run `npm test`"], evidence: quotes() }),
    rawSkill({ name: "two" }),
    rawSkill({ name: "three" }),
  ];
  await withClaude(many, async (repo) => {
    const { result } = await readAndFinish(repo);
    assert.equal(result.skills.length, 2);
    assert.doesNotMatch(result.skills[0]!.steps.join("\n"), /sk-abcdef/);
    assert.match(result.skills[0]!.steps.join("\n"), /\[redacted\]/);
  });
});

test("saving a skill never overwrites one of that name, the team's or this machine's", () => {
  process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "skills-nooverwrite-"));
  const repo = tmpRepo("found-skill-keep");
  spawnSync("git", ["init", "-q"], { cwd: repo });
  const found: FoundSkill = { name: "cut a release", title: "Cut a release", for: "team", steps: STEPS, sessions: ["a", "b"], quotes: [] };
  const theirs = join(repo, ".claude", "skills", "cut-a-release");
  mkdirSync(theirs, { recursive: true });
  writeFileSync(join(theirs, "SKILL.md"), "---\nname: cut-a-release\ndescription: theirs\n---\n\nTheirs.\n");
  assert.deepEqual(saveFoundSkill(repo, found), { path: join(theirs, "SKILL.md"), created: false });
  assert.match(readFileSync(join(theirs, "SKILL.md"), "utf8"), /Theirs\./);
  // The same name for you finds the team's, and leaves it be.
  assert.deepEqual(saveFoundSkill(repo, { ...found, for: "you" }), { path: join(theirs, "SKILL.md"), created: false });
  // Saved once for you, the second save returns the first's path.
  const other: FoundSkill = { ...found, name: "ship it", for: "you" };
  const wrote = saveFoundSkill(repo, other);
  assert.equal(wrote.created, true);
  const first = wrote.path;
  writeFileSync(first, "edited by hand");
  assert.deepEqual(saveFoundSkill(repo, other), { path: first, created: false });
  assert.equal(readFileSync(first, "utf8"), "edited by hand");
});

test("init --pair hands over found items with a kind: learnings are decisions, skills are skills", async () => {
  process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "skills-pair-"));
  process.env.DO_NOT_TRACK = "1";
  process.env.TRAIL_URL = "http://trail.test";
  const dir = tmpRepo("pair-skill");
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  spawnSync("git", ["remote", "add", "origin", "https://github.com/acme/billing.git"], { cwd: dir });
  writeNote(dir, { title: "Keep payment retries at 4", body: "## Decided\nFour retries.", author: "Sam", date: "2026-10-07", touches: [] });
  const team: FoundSkill = { name: "cut a release", title: "Cut a release", for: "team", steps: STEPS, sessions: ["a", "b"], quotes: [] };
  const mine: FoundSkill = { name: "my own habit", title: "My own habit", for: "you", steps: STEPS, sessions: ["a", "b"], quotes: [] };
  const saved = [team, mine].map((skill) => ({ skill, ...saveFoundSkill(dir, skill) }));

  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push({ path: u.pathname, body: init?.body ? JSON.parse(String(init.body)) : {} });
    return u.pathname === "/api/cli/handoffs" ? new Response(JSON.stringify({ url: "http://trail.test/c" }), { status: 201 }) : new Response("{}", { status: 202 });
  }) as typeof fetch;
  const run = await PairRun.start(dir, "X4GM5OQU4NIA65ZR", { agent: "claude", version: "0.23.1", fetchImpl });
  assert.ok(run instanceof PairRun);
  await run.finish(dir, saved);

  const found = calls.filter((c) => c.path === "/api/cli/handoffs/progress").flatMap((c) => (c.body.found as Record<string, unknown>[] | undefined) ?? []);
  assert.deepEqual(found.map((f) => [f.kind, f.title]), [["decision", "Keep payment retries at 4"], ["skill", "Cut a release"]]);
  const skill = found[1]!;
  assert.equal(skill.path, ".claude/skills/cut-a-release/SKILL.md");
  assert.match(String(skill.body), /1\. Run `npm run build`/);
  assert.equal(typeof skill.hash, "string");
});

/** What init --pair sends as found items for `saved`, given a repo with one learning. */
async function pairFound(dir: string, saved: SavedSkill[]): Promise<Record<string, unknown>[]> {
  process.env.DO_NOT_TRACK = "1";
  process.env.TRAIL_URL = "http://trail.test";
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push({ path: u.pathname, body: init?.body ? JSON.parse(String(init.body)) : {} });
    return u.pathname === "/api/cli/handoffs" ? new Response(JSON.stringify({ url: "http://trail.test/c" }), { status: 201 }) : new Response("{}", { status: 202 });
  }) as typeof fetch;
  const run = await PairRun.start(dir, "X4GM5OQU4NIA65ZR", { agent: "claude", version: "0.23.1", fetchImpl });
  assert.ok(run instanceof PairRun);
  await run.finish(dir, saved);
  return calls.filter((c) => c.path === "/api/cli/handoffs/progress").flatMap((c) => (c.body.found as Record<string, unknown>[] | undefined) ?? []);
}

function pairRepo(tag: string): string {
  process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "skills-collide-"));
  const dir = tmpRepo(tag);
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  spawnSync("git", ["remote", "add", "origin", "https://github.com/acme/billing.git"], { cwd: dir });
  writeNote(dir, { title: "Keep payment retries at 4", body: "## Decided\nFour retries.", author: "Sam", date: "2026-10-07", touches: [] });
  return dir;
}

const COLLIDING: FoundSkill = { name: "cut a release", title: "Cut a release", for: "team", steps: STEPS, sessions: ["a", "b"], quotes: [] };

test("a team skill named like one of this machine's skills sends nothing and leaves that skill alone", async () => {
  const dir = pairRepo("pair-collide-home");
  const mine = join(skillDirs(dir).home, "cut-a-release");
  mkdirSync(mine, { recursive: true });
  const personal = "---\nname: cut-a-release\ndescription: personal\n---\n\nMy private steps, with a secret.\n";
  writeFileSync(join(mine, "SKILL.md"), personal);

  const saved = saveSkills(dir, [COLLIDING]);
  assert.deepEqual(saved, [], "not written, so not reported");
  assert.equal(existsSync(join(dir, ".claude")), false, "nothing written into the repo");
  assert.equal(readFileSync(join(mine, "SKILL.md"), "utf8"), personal);

  // Even handed the existing path by a caller, the personal file never goes up.
  const found = await pairFound(dir, [{ skill: COLLIDING, path: join(mine, "SKILL.md"), created: true }, ...saved]);
  assert.deepEqual(found.map((f) => f.kind), ["decision"]);
  assert.doesNotMatch(JSON.stringify(found), /private steps/);
});

test("a team skill named like one the repo already has is not reported as found, and the file is untouched", async () => {
  const dir = pairRepo("pair-collide-repo");
  const theirs = join(dir, ".claude", "skills", "cut-a-release");
  mkdirSync(theirs, { recursive: true });
  const text = "---\nname: cut-a-release\ndescription: theirs\n---\n\nA teammate's steps.\n";
  writeFileSync(join(theirs, "SKILL.md"), text);

  const saved = saveSkills(dir, [COLLIDING]);
  assert.deepEqual(saved, []);
  assert.equal(readFileSync(join(theirs, "SKILL.md"), "utf8"), text);
  const found = await pairFound(dir, [{ skill: COLLIDING, path: join(theirs, "SKILL.md"), created: false }]);
  assert.deepEqual(found.map((f) => f.kind), ["decision"]);
});
