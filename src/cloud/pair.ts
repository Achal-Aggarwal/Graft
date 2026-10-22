/**
 * `trail init --pair CODE`: the setup prompt a person copied from Trail's
 * onboarding page carries a pair code. With it, init tells Trail about itself
 * before doing anything slow, so the page the person is on moves on to sign-up
 * at once; then it streams what it's doing (the map, the PRs, past sessions,
 * the learnings it wrote) to the page that shows it live, and hands over what
 * it found for the person to review there.
 *
 * Nothing goes up as a workspace learning from here. The person keeps or drops
 * each one on the review page, and Trail stores that. A detached
 * `_trail-pair` child then waits for the connection, saves it, waits for the
 * review, and uploads the repo the usual way, which leaves a dropped learning
 * dropped.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { graftCliPath } from "../claude/paths.js";
import { noteAuthor } from "../notes/git-facts.js";
import { repoName, repoPlace } from "../notes/home.js";
import type { SavedSkill } from "../skills/found-skill.js";
import { skillDirs, skillName } from "../skills/skills.js";
import { matter } from "../util/front-matter.js";
import { newState } from "./nudge.js";
import type { TeammateSummary, TokensSummary } from "./onboarding.js";
import { dropActivity, reviewPayload, syncRepo } from "./workspace-sync.js";
import { claimHandoff, fetchMe, isError, postHandoffProgress, readCloud, registerHandoff, trailUrl, writeCloud, type Cloud } from "./workspace.js";

/** A pair code as the onboarding page prints it: letters and digits. */
export function validPairCode(code: string): boolean {
  return /^[A-Za-z0-9-]{6,64}$/.test(code.trim());
}

export type PhaseId = "install" | "files" | "tokens" | "prs" | "decisions" | "team" | "learnings";
type PhaseStatus = "todo" | "running" | "done";
interface Phase {
  id: PhaseId;
  label: string;
  status: PhaseStatus;
  count: string;
}

/**
 * What init found out beyond the learnings, for the onboarding page: one
 * lookup's token saving, the sessions read, and teammates' branches on this
 * person's files. An empty `teammates` list means "checked, none".
 */
export interface PairFindings {
  tokens?: TokensSummary | null;
  sessions?: number;
  teammates?: TeammateSummary[];
}

/**
 * One team skill init just wrote as a found item. Nothing for a skill that was
 * already there, a skill kept for the person alone, or a file that isn't under
 * the repo's own `.claude/skills/`: only what init wrote into the repo goes up.
 */
function foundSkillItem(checkout: string, s: SavedSkill): Record<string, unknown>[] {
  const name = skillName(s.skill.name);
  const expected = join(skillDirs(checkout).repo, name, "SKILL.md");
  if (!s.created || s.skill.for !== "team" || !name || resolve(s.path) !== resolve(expected)) return [];
  let text: string;
  try {
    text = readFileSync(s.path, "utf8");
  } catch {
    return [];
  }
  return [
    {
      kind: "skill",
      path: `.claude/skills/${name}/SKILL.md`,
      title: s.skill.title,
      author: noteAuthor(checkout),
      body: matter(text).content.trim(),
      hash: createHash("sha256").update(text).digest("hex"),
      touches: [],
    },
  ];
}

/** "Found 3 learnings and 1 skill for your team"; the skills part is left out when there are none. */
export function foundLine(learnings: number, skills: number): string {
  const l = `${learnings} learning${learnings === 1 ? "" : "s"}`;
  const sk = `${skills} skill${skills === 1 ? "" : "s"}`;
  return `Found ${learnings === 0 && skills > 0 ? sk : skills > 0 ? `${l} and ${sk}` : l} for your team`;
}

/** The most found learnings one progress call may carry. */
const FOUND_PER_CALL = 200;
/** The most found items Trail keeps from one read. */
const MAX_FOUND = 500;

/**
 * One init run, reported to the onboarding page. Every call is best effort:
 * a slow or unreachable Trail never holds up or fails init.
 */
export class PairRun {
  readonly state: string;
  readonly url: string;
  private readonly base: string;
  private phases: Phase[];
  private chain: Promise<unknown> = Promise.resolve();
  private readonly fetchImpl?: typeof fetch;

  private constructor(base: string, state: string, url: string, version: string, fetchImpl?: typeof fetch) {
    this.base = base;
    this.fetchImpl = fetchImpl;
    this.state = state;
    this.url = url;
    this.phases = [
      { id: "install", label: "Install Trail-code", status: "done", count: version },
      { id: "files", label: "Map the code", status: "todo", count: "" },
      { id: "tokens", label: "Measure one lookup", status: "todo", count: "" },
      { id: "prs", label: "Read pull request reviews", status: "todo", count: "" },
      { id: "decisions", label: "Read past Claude sessions", status: "todo", count: "" },
      { id: "team", label: "Check your team's branches", status: "todo", count: "" },
      { id: "learnings", label: "Write learnings", status: "todo", count: "" },
    ];
  }

  /**
   * Tell Trail about this run, with the pair code, and return it; null when
   * Trail can't be reached or turns the code down (init carries on without it).
   */
  static async start(repo: string, code: string, opts: { agent: string; version: string; fetchImpl?: typeof fetch }): Promise<PairRun | { error: string }> {
    const base = trailUrl();
    const state = newState();
    const place = repoPlace(repo);
    const current = place.git ? { key: place.key, name: repoName(place.key, place.checkout) } : null;
    // This repo only, with the learnings it already has: nobody has signed in
    // yet, so nothing tells Trail what else is on this machine.
    const here = place.git ? reviewPayload(place.checkout).filter((l) => l.ref === "" && l.kind !== "skill").length : 0;
    const known = current ? [{ ...current, learnings: here }] : [];
    const reg = await registerHandoff(
      base,
      { state, repo: current, repos: known, author: noteAuthor(repo), pair: code.trim().toUpperCase() },
      opts.fetchImpl,
    );
    if (isError(reg)) return { error: reg.error };
    const run = new PairRun(base, state, reg.url, opts.version, opts.fetchImpl);
    run.send({ agent: opts.agent, phases: run.phases, log: [`Installed Trail-code ${opts.version}`] });
    return run;
  }

  /** Move a step on: running, or done with what it counted. */
  phase(id: PhaseId, status: PhaseStatus, count = "", log?: string): void {
    this.phases = this.phases.map((p) => (p.id === id ? { ...p, status, count: count || p.count } : p));
    this.send({ phases: this.phases, ...(log ? { log: [log] } : {}) });
  }

  /** The token step's end: the saving is an estimate (the pack against reading the files whole), and the page says so. */
  tokensDone(tokens: TokensSummary | null): void {
    this.phase(
      "tokens",
      "done",
      tokens ? `~${tokens.pct}% fewer tokens` : "skipped",
      tokens ? `One lookup used ~${tokens.pct}% fewer tokens than reading ${tokens.files} file${tokens.files === 1 ? "" : "s"} (estimate)` : undefined,
    );
  }

  /** The team step's end: `undefined` teammates means nothing was checked (no origin remote), not "none". */
  teamDone(teammates: TeammateSummary[] | undefined): void {
    if (teammates) this.phase("team", "done", `${teammates.length} ${teammates.length === 1 ? "person" : "people"}`);
    else this.phase("team", "done", "skipped", "No origin remote, so no teammates' branches to check");
  }

  /** Send what init found beyond the learnings; keys left undefined (or a null `tokens`) are left out. */
  findings(f: PairFindings): void {
    const out: Record<string, unknown> = {};
    if (f.tokens) out.tokens = f.tokens;
    if (f.sessions !== undefined) out.sessions = f.sessions;
    if (f.teammates !== undefined) out.teammates = f.teammates;
    this.send({ findings: out });
  }

  /**
   * Hand over the repo's learnings and skills, then say the read is done. A
   * learning is a `decision`; a skill is a `skill`. A skill kept for the
   * person alone isn't the team's, so it stays off the page.
   */
  finish(repo: string, skills: SavedSkill[] = []): Promise<void> {
    const place = repoPlace(repo);
    // Everything the person's agents now start from in this repo, so the page
    // counts what the home will: their learnings and teammates' pushed ones,
    // then the skills this run wrote and the ones the repo already has.
    const found: Record<string, unknown>[] = [];
    if (place.git) {
      const payload = reviewPayload(place.checkout);
      const item = (l: (typeof payload)[number]) => ({
        kind: l.kind === "skill" ? "skill" : "decision", path: l.path, title: l.title, author: l.author, body: l.body, hash: l.hash, touches: l.touches,
      });
      const written = skills.flatMap((s) => foundSkillItem(place.checkout, s));
      const paths = new Set(written.map((w) => w.path));
      found.push(
        ...payload.filter((l) => l.kind !== "skill").map(item),
        ...written,
        ...payload.filter((l) => l.kind === "skill" && !paths.has(l.path)).map(item),
      );
      found.splice(MAX_FOUND); // Trail takes this many from one read
    }
    const n = found.length;
    const m = found.filter((f) => f.kind === "skill").length;
    const learned = n - m;
    this.phases = this.phases.map((p) => (p.status === "done" ? p : { ...p, status: "done" as const }));
    this.phases = this.phases.map((p) => (p.id === "learnings" ? { ...p, count: String(n) } : p));
    for (let i = 0; i < Math.max(n, 1); i += FOUND_PER_CALL) {
      const part = found.slice(i, i + FOUND_PER_CALL);
      this.send({ phases: this.phases, found: part, ...(i === 0 ? { log: [foundLine(learned, m)] } : {}) });
    }
    this.send({ done: true });
    return this.flush();
  }

  /** Wait for every report so far to be sent (or to fail). */
  flush(): Promise<void> {
    return this.chain.then(() => undefined);
  }

  /** Start the detached wait for the connection and the review, at the Trail this run reported to. */
  handOff(repo: string): void {
    const child = spawn(process.execPath, [graftCliPath(), "_trail-pair", this.state, repo, this.base], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  }

  private send(body: Record<string, unknown>): void {
    // One after another, so the page sees the steps in order.
    this.chain = this.chain.then(() => postHandoffProgress(this.base, { state: this.state, ...body }, this.fetchImpl)).catch(() => undefined);
  }
}

export interface FinishOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long to wait for the person, all told. */
  waitMs?: number;
}

/** Wait an hour at most for someone to sign up, connect and review. */
const FINISH_WAIT_MS = 60 * 60 * 1000;

/**
 * What `_trail-pair` runs: wait for the person to connect in the browser, save
 * the connection, wait for their review, then upload this repo's learnings.
 * Returns what happened, for tests.
 */
export async function finishPair(state: string, repo: string, opts: FinishOptions = {}): Promise<"uploaded" | "expired" | "timed_out" | "failed"> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = now();
  const late = () => now() - started >= (opts.waitMs ?? FINISH_WAIT_MS);
  const base = trailUrl();

  let cloud: Cloud | null = null;
  for (;;) {
    const got = await claimHandoff(base, state, opts.fetchImpl);
    if ("cloud" in got) {
      cloud = { ...got.cloud, url: base, linkedAt: now() };
      // Like any first connect: nothing recorded before it goes up.
      dropActivity();
      writeCloud(cloud);
      break;
    }
    if ("error" in got) return "expired";
    if (late()) return "timed_out";
    await sleep(1500);
  }

  // Trail turns progress away once the review is in: that's the signal.
  for (;;) {
    const r = await postHandoffProgress(base, { state }, opts.fetchImpl);
    if (r === "reviewed") break;
    if (r === "gone") return "expired";
    if (late()) return "timed_out";
    await sleep(2000);
  }

  // The review added this repo to the workspace; pick that up, then upload.
  const me = await fetchMe(cloud, opts.fetchImpl);
  if (!isError(me)) {
    cloud = { ...cloud, user: me.user, workspace: me.workspace, repos: me.repos.map((r) => r.key) };
    writeCloud(cloud);
  }
  const place = repoPlace(repo);
  if (!place.git) return "uploaded";
  const res = await syncRepo(place.checkout, readCloud() ?? cloud, { fetch: false, fetchImpl: opts.fetchImpl });
  return isError(res) ? "failed" : "uploaded";
}
