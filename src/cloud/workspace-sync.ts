/**
 * Keeps the workspace's copy of a repo's learnings, and its record of how
 * they're used, in step with this machine.
 *
 * What goes up for a repo in the workspace is every learning in its `.trail/`:
 * the working tree's and the ones on teammates' pushed branches, after a
 * `git fetch`. Not just this person's, so one person is enough to cover a
 * repo. Personal learnings in ~/.trail never go up.
 *
 * Uses (a search that showed learnings, a check against them) are appended to
 * `~/.trail/outbox.jsonl` as they happen, and sent with the next sync. That's
 * how a teammate's reuse of a learning shows on the team page. Only while the
 * machine is connected, and only for a repo in the workspace: a search holds
 * what someone typed and the files they're in, and nobody agreed to send that
 * for a repo they didn't pick, or from before they signed in.
 *
 * Commands never wait on any of this: when something changed, a detached
 * `_trail-sync` child does it.
 */
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { graftCliPath } from "../claude/paths.js";
import { readBranchCache, refreshBranches } from "../notes/branches.js";
import { knownRepos, repoName, repoPlace, trailHome } from "../notes/home.js";
import { LEARNINGS_DIR, learningFiles, readLearningFile } from "../notes/repo-trail.js";
import { parseNote } from "../notes/notes.js";
import { OWN_SKILLS, skillDirs } from "../skills/skills.js";
import { matter } from "../util/front-matter.js";
import { cacheDir, readJson, writeJsonAtomic } from "../util/state.js";
import { isError, postActivity, readCloud, uploadLearnings, type ActivityEvent, type ApiError, type Cloud, type UploadedLearning } from "./workspace.js";

/** A failed sync is retried after this long, not on every command. */
const RETRY_MS = 5 * 60 * 1000;
/** The outbox is trimmed to its newest lines past this size. */
const OUTBOX_MAX_BYTES = 1024 * 1024;
const OUTBOX_KEEP_LINES = 2000;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A skill folder name safe to send as a path part. */
const SKILL_FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function inside(root: string, p: string): boolean {
  return p === root || p.startsWith(root + sep);
}

/** A SKILL.md bigger than this is not a skill, and is never sent. */
const SKILL_MAX_BYTES = 256 * 1024;

/**
 * Which of `paths` (relative to `root`) git tracks, by what `git ls-files` says,
 * so a gitignored or untracked file is not among them. Empty when `root` isn't a
 * git checkout or git fails: no skill goes up then.
 */
function trackedAmong(root: string, paths: string[]): Set<string> {
  if (paths.length === 0) return new Set();
  try {
    const out = execFileSync("git", ["--literal-pathspecs", "ls-files", "-z", "--", ...paths], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return new Set(out.split("\0").filter(Boolean));
  } catch {
    return new Set();
  }
}

/**
 * The repo's skills, as the workspace takes them: each `.claude/skills/<name>/SKILL.md`
 * in the working tree that git tracks (an untracked or gitignored one isn't the
 * team's, so it stays here; no git, no skills). Same item as the one init sends
 * for a skill it just found (the server keeps one per repo and path): the body is
 * SKILL.md without its frontmatter, the hash is of the whole file. A symlinked
 * skill is read only when it resolves inside the checkout, and goes up when the
 * file it resolves to is tracked. A SKILL.md that can't be read or parsed, or is
 * over 256 KB, is skipped. Skills kept in ~/.trail are never sent.
 */
function skillItems(checkout: string): UploadedLearning[] {
  const dir = skillDirs(checkout).repo;
  let root: string;
  let names: string[];
  try {
    root = realpathSync(join(dir, "..", ".."));
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  // Each candidate that passes the cheap checks, with where its file really is.
  const candidates: Array<{ name: string; file: string; real: string }> = [];
  for (const name of names) {
    if (!SKILL_FOLDER.test(name) || OWN_SKILLS.has(name)) continue;
    try {
      const file = join(dir, name, "SKILL.md");
      if (!statSync(join(dir, name)).isDirectory()) continue;
      const st = statSync(file);
      if (!st.isFile() || st.size > SKILL_MAX_BYTES) continue;
      const real = realpathSync(file);
      if (!inside(root, realpathSync(join(dir, name))) || !inside(root, real)) continue;
      candidates.push({ name, file, real: relative(root, real).split(sep).join("/") });
    } catch {
      /* no SKILL.md here */
    }
  }
  const tracked = trackedAmong(root, [...new Set(candidates.map((c) => c.real))]);
  const out: UploadedLearning[] = [];
  for (const { name, file, real } of candidates) {
    if (!tracked.has(real)) continue;
    try {
      const text = readFileSync(file, "utf8");
      const parsed = matter(text);
      const d = parsed.data as Record<string, unknown>;
      const description = typeof d.description === "string" ? (d.description.trim().split("\n")[0] ?? "").trim() : "";
      out.push({
        path: `.claude/skills/${name}/SKILL.md`,
        kind: "skill",
        ref: "",
        title: description || name,
        author: typeof d.author === "string" ? d.author.trim() : "",
        date: "",
        touches: [],
        body: parsed.content.trim(),
        hash: sha256(text),
      });
    } catch {
      /* a SKILL.md that can't be read or parsed */
    }
  }
  return out;
}

/**
 * Every learning in the repo's `.trail/`, as the workspace takes them: the
 * working tree's, then the ones only a pushed branch has (from the branch
 * cache), then the repo's skills. Paths are repo-relative; nothing about this
 * machine is sent.
 */
export function learningsPayload(checkout: string): UploadedLearning[] {
  const out: UploadedLearning[] = [];
  const seen = new Set<string>();
  const add = (name: string, text: string, ref: string) => {
    if (seen.has(name)) return;
    const n = parseNote(text, name);
    if (!n) return;
    seen.add(name);
    out.push({
      path: `${LEARNINGS_DIR}/${name}`,
      ref,
      branch: n.branch,
      title: n.title,
      author: n.author,
      date: n.date,
      minutes: n.cost?.minutes,
      tokens: n.cost?.tokens,
      touches: n.touches,
      body: n.body,
      hash: sha256(text),
    });
  };
  for (const name of learningFiles(checkout)) {
    const text = readLearningFile(checkout, name);
    if (text) add(name, text, "");
  }
  for (const b of readBranchCache(checkout)?.branches ?? []) for (const l of b.learnings) add(l.name, l.text, b.ref);
  out.push(...skillItems(checkout));
  return out;
}

function fingerprint(learnings: UploadedLearning[]): string {
  return sha256(JSON.stringify(learnings.map((l) => [l.path, l.hash]).sort()));
}

interface SyncState {
  fingerprint: string;
  at: number;
  failedAt?: number;
  learnings?: number;
}

function statePath(repo: string): string {
  return join(cacheDir(repo), "trail-workspace-sync.json");
}

/**
 * Whether the repo at `checkout` is one of the workspace's, so its learnings
 * and uses go up. Never on a machine connected by `trail init --connect`: that
 * one sends a repo summary only (titles and counts, no learning bodies, no
 * searches), whatever repos the workspace lists.
 */
export function inWorkspace(checkout: string, cloud: Cloud | null = readCloud()): boolean {
  return !!cloud && cloud.via !== "connect" && cloud.repos.includes(repoPlace(checkout).key);
}

/**
 * Upload the repo's learnings now, after fetching teammates' branches. Only for
 * a repo in the workspace. Remembers what was sent so an unchanged repo isn't
 * sent again.
 */
export async function syncRepo(
  checkout: string,
  cloud: Cloud,
  opts: { fetch?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<{ repo: string; learnings: number; added: number } | ApiError> {
  const place = repoPlace(checkout);
  if (!cloud.repos.includes(place.key)) return { error: "this repo isn't in your workspace" };
  if (opts.fetch !== false) refreshBranches(place.checkout);
  const learnings = learningsPayload(place.checkout);
  const res = await uploadLearnings(cloud, { repo: { key: place.key, name: repoName(place.key, place.checkout) }, learnings }, opts.fetchImpl);
  const prior = readJson<SyncState>(statePath(place.checkout));
  if (isError(res)) writeJsonAtomic(statePath(place.checkout), { ...(prior ?? { fingerprint: "", at: 0 }), failedAt: Date.now() }, true);
  else writeJsonAtomic(statePath(place.checkout), { fingerprint: fingerprint(learnings), at: Date.now(), learnings: res.learnings }, true);
  return res;
}

/** Sync every repo of the workspace that's on this machine. Returns what went up. */
export async function syncWorkspaceRepos(cloud: Cloud, fetchImpl?: typeof fetch): Promise<{ repos: number; learnings: number }> {
  let repos = 0;
  let learnings = 0;
  for (const r of knownRepos()) {
    if (!cloud.repos.includes(r.key) || !existsSync(r.path)) continue;
    const res = await syncRepo(r.path, cloud, { fetchImpl });
    if (isError(res)) continue;
    repos++;
    learnings += res.learnings;
  }
  await flushActivity(cloud, fetchImpl);
  return { repos, learnings };
}

/* -------------------------------------------------------------------------- */
/* the activity outbox                                                        */
/* -------------------------------------------------------------------------- */

function outboxPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(trailHome(env), "outbox.jsonl");
}

/** Whether a use may go to `cloud`: the repo is the workspace's, and it happened since connecting. */
function sendable(e: ActivityEvent, cloud: Cloud): boolean {
  return cloud.repos.includes(e.repo) && Date.parse(e.at) >= (cloud.linkedAt || 0);
}

/** Whether uses of `repo` are recorded at all: connected by `pair`/login (not `connect`) and the repo is the workspace's. */
export function records(cloud: Cloud | null, repo: string): cloud is Cloud {
  return !!cloud && cloud.via !== "connect" && cloud.repos.includes(repo);
}

/**
 * Remember one use of the learnings, to send with the next sync: only while
 * this machine is connected, and only for a repo in the workspace. Not
 * connected, or another repo, and nothing is written. Never throws.
 */
export function recordActivity(e: ActivityEvent, cloud: Cloud | null = readCloud()): void {
  if (!records(cloud, e.repo)) return;
  try {
    const p = outboxPath();
    appendFileSync(p, `${JSON.stringify(e)}\n`);
    if (statSync(p).size > OUTBOX_MAX_BYTES) {
      const lines = readFileSync(p, "utf8").split("\n").filter(Boolean).slice(-OUTBOX_KEEP_LINES);
      writeFileSync(p, `${lines.join("\n")}\n`);
    }
  } catch {
    /* a lost event undercounts reuse by one */
  }
}

/**
 * Forget every use waiting to go. Run when a machine connects, so nothing
 * recorded before that is ever sent.
 */
export function dropActivity(env: NodeJS.ProcessEnv = process.env): void {
  try {
    rmSync(outboxPath(env), { force: true });
  } catch {
    /* sent-time filtering in flushActivity drops them anyway */
  }
}

function outboxHasEvents(): boolean {
  try {
    return statSync(outboxPath()).size > 0;
  } catch {
    return false;
  }
}

/**
 * Send the outbox. It's moved aside first, so events recorded while the
 * request is out land in a fresh file; on failure they're put back. A use
 * from before this connection, or for a repo the workspace doesn't have
 * (left by an older trail), is dropped, never sent.
 */
export async function flushActivity(cloud: Cloud, fetchImpl?: typeof fetch): Promise<number> {
  const p = outboxPath();
  if (!outboxHasEvents()) return 0;
  const sending = `${p}.${process.pid}.sending`;
  try {
    renameSync(p, sending);
  } catch {
    return 0;
  }
  const events: ActivityEvent[] = [];
  for (const line of readFileSync(sending, "utf8").split("\n")) {
    try {
      if (!line.trim()) continue;
      const e = JSON.parse(line) as ActivityEvent;
      if (sendable(e, cloud)) events.push(e);
    } catch {
      /* a torn line */
    }
  }
  let sent = 0;
  for (let i = 0; i < events.length; i += 500) {
    const res = await postActivity(cloud, events.slice(i, i + 500), fetchImpl);
    if (isError(res)) {
      // Put back what didn't go, ahead of anything recorded since.
      const rest = events.slice(i).map((e) => JSON.stringify(e)).join("\n");
      appendFileSync(p, `${rest}\n`);
      break;
    }
    sent += Math.min(500, events.length - i);
  }
  // Sent, or put back above: either way this copy is done with.
  rmSync(sending, { force: true });
  return sent;
}

/* -------------------------------------------------------------------------- */
/* in the background                                                          */
/* -------------------------------------------------------------------------- */

/** Whether the repo's learnings changed since they last went up, and a retry is due. */
export function syncIsDue(checkout: string, now = Date.now()): boolean {
  const state = readJson<SyncState>(statePath(checkout));
  if (state?.failedAt && now - state.failedAt < RETRY_MS) return false;
  return state?.fingerprint !== fingerprint(learningsPayload(checkout));
}

/**
 * Sync in a detached child when this machine is connected and either the
 * repo (one of the workspace's) has learnings the workspace hasn't seen, or
 * there are uses waiting to go. Never waits, never throws.
 */
export function maybeSyncInBackground(dir: string, now = Date.now()): boolean {
  try {
    const cloud = readCloud();
    if (!cloud) return false;
    const checkout = repoPlace(dir).checkout;
    const due = (inWorkspace(checkout, cloud) && syncIsDue(checkout, now)) || outboxHasEvents();
    if (!due) return false;
    // Marked first, so commands run while the child works don't start another.
    const prior = readJson<SyncState>(statePath(checkout));
    writeJsonAtomic(statePath(checkout), { ...(prior ?? { fingerprint: "", at: 0 }), failedAt: now }, true);
    const child = spawn(process.execPath, [graftCliPath(), "_trail-sync", checkout], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** `_trail-sync`: what the background child does. */
export async function runSyncChild(dir: string): Promise<void> {
  const cloud = readCloud();
  if (!cloud) return;
  const checkout = repoPlace(dir).checkout;
  if (inWorkspace(checkout, cloud)) await syncRepo(checkout, cloud);
  await flushActivity(cloud);
}

/** The name a learning's file goes by, from a path or a `ref:path`. */
export function learningName(path: string): string {
  return basename(path.slice(path.lastIndexOf(":") + 1));
}
