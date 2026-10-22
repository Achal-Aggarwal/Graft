/**
 * A skill found in past sessions: a procedure the person walked Claude through
 * in two or more of them, written to a SKILL.md at `trail init` so the next
 * session can follow it without being walked through it again.
 *
 * The team's go in the repo's `.claude/skills/`, where Claude Code loads them
 * for everyone who pulls; the person's own go in this repo's skills under
 * ~/.trail. A skill of that name that already exists is never touched.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureRepoHome } from "../notes/home.js";
import { skillDirs, skillName } from "./skills.js";

export interface FoundSkill {
  name: string;
  title: string;
  /** `team`: written into the repo. `you`: kept on this machine. */
  for: "team" | "you";
  /** What to do, in order: 2 to 8 commands or actions. */
  steps: string[];
  /** Sessions the cited quotes were found in, newest first. */
  sessions: string[];
  quotes: string[];
}

/** A skill's SKILL.md: where it is, and whether this run wrote it (`false`: one of that name was already there). */
export interface SavedSkill {
  skill: FoundSkill;
  path: string;
  created: boolean;
}

/** SKILL.md for a found skill: the frontmatter every skill has, then its steps as a numbered list. */
export function renderFoundSkill(s: FoundSkill): string {
  const name = skillName(s.name);
  const steps = s.steps.map((step, i) => `${i + 1}. ${step}`).join("\n");
  return `---\nname: ${name}\ndescription: ${JSON.stringify(s.title)}\nversion: 1\n---\n\n# ${s.title}\n\n${steps}\n`;
}

/** The SKILL.md a skill of this name already has, in the repo or on this machine; null when there's none. */
function existingSkillFile(repo: string, name: string): string | null {
  const dirs = skillDirs(repo);
  for (const d of [dirs.repo, dirs.home]) {
    const there = join(d, name, "SKILL.md");
    if (existsSync(there)) return there;
  }
  return null;
}

/**
 * The lines init prints for found skills it didn't write because one of that
 * name already exists (in the repo or on this machine), one per skill.
 */
export function skippedSkillLines(repo: string, found: FoundSkill[], written: SavedSkill[]): string[] {
  const out: string[] = [];
  for (const skill of found) {
    const name = skillName(skill.name);
    if (!name || written.some((w) => w.skill === skill) || !existingSkillFile(repo, name)) continue;
    out.push(`· Skipped skill ${name}: one already exists.`);
  }
  return out;
}

/**
 * Write the skill, and return the path of its SKILL.md and whether this call
 * wrote it. A skill of that name the repo or this machine already has is left
 * as it is: its path comes back with `created: false`, and it isn't ours to
 * report or send anywhere.
 */
export function saveFoundSkill(repo: string, s: FoundSkill): { path: string; created: boolean } {
  const name = skillName(s.name);
  if (!name) throw new Error("a skill needs a name");
  const dirs = skillDirs(repo);
  const there = existingSkillFile(repo, name);
  if (there) return { path: there, created: false };
  if (s.for === "you") ensureRepoHome(repo);
  const dir = join(s.for === "you" ? dirs.home : dirs.repo, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, renderFoundSkill(s));
  return { path: file, created: true };
}
