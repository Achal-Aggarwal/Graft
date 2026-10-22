/**
 * The repo's committed skills go up to the workspace with its learnings, so
 * the team page can show them. Only the working tree's `.claude/skills/`:
 * never a skill kept on this machine, never one that points outside the repo,
 * and only one git tracks: not an untracked or gitignored one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND_ENV } from "../src/brand.js";
import { learningsPayload } from "../src/cloud/workspace-sync.js";
import { writeNote } from "../src/notes/notes.js";
import { skillDirs } from "../src/skills/skills.js";

process.env.DO_NOT_TRACK = "1";
process.env[BRAND_ENV] = "trail";
process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "skills-sync-home-"));

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

const HOTFIX = `---
name: release-hotfix
description: Cut a hotfix release from a tagged commit
author: Anirudh
---

# Release a hotfix

1. Branch from the tag.
2. Cherry-pick the fix.
`;

const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });

/** A git checkout. Skills go up only once git tracks them: call `track` after writing the ones expected to. */
function checkout(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "skills-sync-repo-")));
  git(dir, "init", "-q", "-b", "main");
  return dir;
}

function track(dir: string): void {
  git(dir, "add", "-A", "-f");
}

function writeSkill(root: string, name: string, text: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), text);
}

const skillItems = (dir: string) => learningsPayload(dir).filter((l) => l.kind === "skill");

test("the repo's skill goes up as a skill learning, and a skill kept on this machine does not", () => {
  const dir = checkout();
  const dirs = skillDirs(dir);
  writeSkill(dirs.repo, "release-hotfix", HOTFIX);
  writeSkill(dirs.home, "my-private-habit", "---\ndescription: Only mine\n---\n\nSecret steps.\n");
  track(dir);

  const items = skillItems(dir);
  assert.equal(items.length, 1);
  const s = items[0]!;
  assert.equal(s.path, ".claude/skills/release-hotfix/SKILL.md");
  assert.equal(s.kind, "skill");
  assert.equal(s.title, "Cut a hotfix release from a tagged commit");
  assert.equal(s.body, "# Release a hotfix\n\n1. Branch from the tag.\n2. Cherry-pick the fix.");
  assert.equal(s.hash, sha(HOTFIX));
  assert.equal(s.author, "Anirudh");
  assert.equal(s.ref, "");
  assert.deepEqual(s.touches, []);
  assert.ok(!learningsPayload(dir).some((l) => l.path.includes("my-private-habit")));
});

test("a skill without a description is titled by its folder, and plain learnings carry no kind", () => {
  const dir = checkout();
  writeSkill(skillDirs(dir).repo, "pdf-coords", "---\nname: pdf-coords\n---\n\nUse points, not pixels.\n");
  writeNote(dir, { title: "Keep payment retries at 4", body: "## Decided\nFour retries.", author: "Sam", date: "2026-10-07", touches: [] });
  track(dir);
  const [s] = skillItems(dir);
  assert.equal(s!.title, "pdf-coords");
  assert.equal(s!.author, "");
  const learning = learningsPayload(dir).filter((l) => l.path.startsWith(".trail/learnings/"));
  assert.equal(learning.length, 1, "the fixture's learning is in the payload");
  assert.equal(learning[0]!.kind, undefined);
});

test("editing a skill changes its hash in the payload", () => {
  const dir = checkout();
  const repo = skillDirs(dir).repo;
  writeSkill(repo, "release-hotfix", HOTFIX);
  track(dir);
  const before = skillItems(dir)[0]!;
  writeSkill(repo, "release-hotfix", HOTFIX + "3. Tag the release.\n");
  const after = skillItems(dir)[0]!;
  assert.notEqual(before.hash, after.hash);
  assert.match(after.body, /Tag the release/);
});

test("a SKILL.md that can't be parsed is skipped, and the others still go up", () => {
  const dir = checkout();
  const repo = skillDirs(dir).repo;
  writeSkill(repo, "broken", "---\ndescription: [unclosed\n  - : :\n---\n\nbody\n");
  writeSkill(repo, "release-hotfix", HOTFIX);
  track(dir);
  const items = skillItems(dir);
  assert.deepEqual(items.map((i) => i.path), [".claude/skills/release-hotfix/SKILL.md"]);
});

test("a skill folder that points outside the repo is skipped, one that points inside is kept", () => {
  const dir = checkout();
  const outside = mkdtempSync(join(tmpdir(), "skills-sync-outside-"));
  writeSkill(outside, "stolen", "---\ndescription: Not in this repo\n---\n\nOutside text.\n");
  const repo = skillDirs(dir).repo;
  mkdirSync(repo, { recursive: true });
  symlinkSync(join(outside, "stolen"), join(repo, "stolen"), "dir");
  mkdirSync(join(repo, "viafile"), { recursive: true });
  symlinkSync(join(outside, "stolen", "SKILL.md"), join(repo, "viafile", "SKILL.md"));
  writeSkill(join(dir, ".agents", "skills"), "shared", "---\ndescription: Shared across agents\n---\n\nSteps.\n");
  symlinkSync(join(dir, ".agents", "skills", "shared"), join(repo, "shared"), "dir");
  track(dir);

  assert.deepEqual(skillItems(dir).map((i) => i.path), [".claude/skills/shared/SKILL.md"]);
});

test("an untracked skill is not uploaded, and a tracked one is", () => {
  const dir = checkout();
  const repo = skillDirs(dir).repo;
  writeSkill(repo, "release-hotfix", HOTFIX);
  track(dir);
  writeSkill(repo, "scratch-idea", "---\ndescription: Not committed\n---\n\nHalf-baked.\n");
  assert.deepEqual(skillItems(dir).map((i) => i.path), [".claude/skills/release-hotfix/SKILL.md"]);
  track(dir);
  assert.deepEqual(skillItems(dir).map((i) => i.path), [".claude/skills/release-hotfix/SKILL.md", ".claude/skills/scratch-idea/SKILL.md"]);
});

test("a gitignored skill is not uploaded, unless it was force-added", () => {
  const dir = checkout();
  const repo = skillDirs(dir).repo;
  writeFileSync(join(dir, ".gitignore"), ".claude/skills/ignored/\n.claude/skills/forced/\n");
  writeSkill(repo, "release-hotfix", HOTFIX);
  writeSkill(repo, "ignored", "---\ndescription: Ignored\n---\n\nKept out of git.\n");
  writeSkill(repo, "forced", "---\ndescription: Forced in\n---\n\nTracked anyway.\n");
  git(dir, "add", ".gitignore", ".claude/skills/release-hotfix");
  git(dir, "add", "-f", ".claude/skills/forced");
  assert.deepEqual(skillItems(dir).map((i) => i.path), [".claude/skills/forced/SKILL.md", ".claude/skills/release-hotfix/SKILL.md"]);
});

test("a checkout that isn't a git repo uploads no skills, and doesn't throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "skills-sync-nogit-"));
  writeSkill(skillDirs(dir).repo, "release-hotfix", HOTFIX);
  assert.deepEqual(skillItems(dir), []);
});

test("a SKILL.md over 256 KB is skipped", () => {
  const dir = checkout();
  const repo = skillDirs(dir).repo;
  writeSkill(repo, "release-hotfix", HOTFIX);
  writeSkill(repo, "huge", `---\ndescription: Too big\n---\n\n${"x".repeat(256 * 1024 + 1)}\n`);
  track(dir);
  assert.deepEqual(skillItems(dir).map((i) => i.path), [".claude/skills/release-hotfix/SKILL.md"]);
});
