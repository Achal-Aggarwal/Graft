/**
 * The repo's committed skills go up to the workspace with its learnings, so
 * the team page can show them. Only the working tree's `.claude/skills/`:
 * never a skill kept on this machine, never one that points outside the repo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND_ENV } from "../src/brand.js";
import { learningsPayload } from "../src/cloud/workspace-sync.js";
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

function checkout(): string {
  return mkdtempSync(join(tmpdir(), "skills-sync-repo-"));
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
  const [s] = skillItems(dir);
  assert.equal(s!.title, "pdf-coords");
  assert.equal(s!.author, "");
  assert.ok(learningsPayload(dir).every((l) => l.kind === undefined || l.kind === "skill"));
});

test("editing a skill changes its hash in the payload", () => {
  const dir = checkout();
  const repo = skillDirs(dir).repo;
  writeSkill(repo, "release-hotfix", HOTFIX);
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

  assert.deepEqual(skillItems(dir).map((i) => i.path), [".claude/skills/shared/SKILL.md"]);
});
