/**
 * Found skills: a SKILL.md is never written over one that exists, and
 * `init --pair` hands the page only the team skills this run wrote, as
 * items of kind skill. (Finding them is the look-back's now: src/init/.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PairRun } from "../src/cloud/pair.js";
import { saveFoundSkill, skippedSkillLines, type FoundSkill, type SavedSkill } from "../src/skills/found-skill.js";
import { skillDirs } from "../src/skills/skills.js";
import { writeNote } from "../src/notes/notes.js";
import { tmpRepo } from "./helpers.js";

const STEPS = ["Run `npm run build`", "Run `npm test`", "Bump the version in package.json", "Run `npm publish --otp` with the code from the user"];

/** Each found skill saved, keeping only the ones this call wrote (what init's old look-back did). */
function saveSkills(repo: string, skills: FoundSkill[]): SavedSkill[] {
  return skills.flatMap((skill) => {
    const { path, created } = saveFoundSkill(repo, skill);
    return created ? [{ skill, path, created }] : [];
  });
}

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
  process.env.TRAIL_TEST_SERVER = "http://trail.test";
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
  process.env.TRAIL_TEST_SERVER = "http://trail.test";
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

test("a found team skill that collides with an existing one is named in one line, home or repo", () => {
  const dir = pairRepo("pair-skip-line");
  const theirs = join(dir, ".claude", "skills", "cut-a-release");
  mkdirSync(theirs, { recursive: true });
  writeFileSync(join(theirs, "SKILL.md"), "---\nname: cut-a-release\ndescription: theirs\n---\n\nSteps.\n");
  const mine = join(skillDirs(dir).home, "my-own-habit");
  mkdirSync(mine, { recursive: true });
  writeFileSync(join(mine, "SKILL.md"), "---\nname: my-own-habit\ndescription: mine\n---\n\nSteps.\n");
  const fresh: FoundSkill = { ...COLLIDING, name: "ship it", title: "Ship it" };
  const homeOne: FoundSkill = { ...COLLIDING, name: "my own habit", title: "My own habit", for: "you" };

  const written = saveSkills(dir, [COLLIDING, homeOne, fresh]);
  assert.deepEqual(written.map((w) => w.skill.name), ["ship it"]);
  assert.deepEqual(skippedSkillLines(dir, [COLLIDING, homeOne, fresh], written), [
    "· Skipped skill cut-a-release: one already exists.",
    "· Skipped skill my-own-habit: one already exists.",
  ]);
  assert.deepEqual(skippedSkillLines(dir, [fresh], written), [], "a skill this run wrote isn't reported as skipped");
});
