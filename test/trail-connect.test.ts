/**
 * `trail init --connect <CODE>`, piece by piece: the code, the claim, the
 * stages and summary as they go to Trail, and what the summary is made of
 * (one lookup's tokens saved, the learnings' titles, teammates' branches
 * from git). Route B: nothing in it is code, a diff or session text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND_ENV } from "../src/brand.js";
import { formatAsk, ask } from "../src/ask/ask.js";
import { buildGraph } from "../src/graph/build.js";
import {
  claimConnectCode,
  conflictLine,
  learningTerms,
  learningsSummary,
  normalizeCode,
  OnboardingReporter,
  parseAskSavings,
  repoRef,
  sessionsIn,
  shortBody,
  teammatesFromGit,
  tokensOnOneLookup,
} from "../src/cloud/onboarding.js";
import { readCloud, writeCloud, type Cloud } from "../src/cloud/workspace.js";
import { inWorkspace, recordActivity } from "../src/cloud/workspace-sync.js";
import { cloudLines } from "../src/cloud/nudge.js";
import { writeNote, listNotes } from "../src/notes/notes.js";
import { existsSync } from "node:fs";

process.env.DO_NOT_TRACK = "1";
process.env[BRAND_ENV] = "trail";
process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "connect-trail-home-"));

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

/* the code ----------------------------------------------------------------- */

test("a code is read however it was pasted, and anything else is refused", () => {
  for (const raw of ["TRL-7F2A-K9QD", "trl-7f2a-k9qd", " TRL7F2AK9QD ", "7F2A-K9QD", "7f2ak9qd", "TRL 7F2A K9QD"]) assert.equal(normalizeCode(raw), "TRL-7F2A-K9QD", raw);
  for (const bad of ["", "TRL-7F2A", "TRL-7F2A-K9QD-XX", "hello world", "TRL-7F2A-K9Q!"]) assert.equal(normalizeCode(bad), null, bad);
});

test("the repo goes up as a name and a clean URL: never a path here, never a token in the remote", () => {
  const dir = mkdtempSync(join(tmpdir(), "connect-ref-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "remote", "add", "origin", "https://x-access-token:ghp_SECRET@github.com/Acme/Retry.git");
  const ref = repoRef(dir);
  assert.deepEqual(ref, { name: "Retry", remote_url: "https://github.com/acme/retry" });
  assert.ok(!JSON.stringify(ref).includes("SECRET"));
  assert.ok(!JSON.stringify(ref).includes(dir));

  const local = mkdtempSync(join(tmpdir(), "connect-local-"));
  git(local, "init", "-q", "-b", "main");
  const l = repoRef(local);
  assert.equal(l.remote_url, undefined);
  assert.ok(l.name);
});

/* the claim ---------------------------------------------------------------- */

test("claiming a code gives a connection with no repos picked, marked as made by --connect", async () => {
  const sent: any[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return json(200, {
      token: "trl_abc",
      user: { id: "u1", name: "Rushabh", email: "r@acme.test" },
      workspace: { id: "w1", name: "Acme", slug: "w1", url: "http://trail.test", invite_url: "http://trail.test/welcome/code/invite" },
      repo: { key: "github.com/acme/retry", name: "retry", remote_url: "https://github.com/acme/retry" },
      repos: ["github.com/acme/retry"],
    });
  }) as typeof fetch;
  const got = await claimConnectCode("http://trail.test", "TRL-7F2A-K9QD", { machine: "Rushabh's MacBook", repo: { name: "retry", remote_url: "https://github.com/acme/retry" } }, { fetchImpl, now: 5 });
  assert.ok("cloud" in got);
  assert.equal(sent[0].url, "http://trail.test/api/public/cli/connect");
  assert.deepEqual(sent[0].body, { code: "TRL-7F2A-K9QD", machine: "Rushabh's MacBook", repo: { name: "retry", remote_url: "https://github.com/acme/retry" } });
  const c = got.cloud;
  assert.equal(c.token, "trl_abc");
  assert.equal(c.workspace.name, "Acme");
  assert.equal(c.via, "connect");
  // The full learnings sync stays off: only the summary goes up from a machine connected this way.
  assert.deepEqual(c.repos, []);
  assert.equal(c.linkedAt, 5);
});

test("a connect answer without a slug or urls still makes a connection readCloud accepts", async () => {
  const fetchImpl = (async () => json(200, { token: "trl_abc", workspace: { id: "w1", name: "Acme" }, user: { name: "R" } })) as unknown as typeof fetch;
  const got = await claimConnectCode("http://trail.test", "TRL-7F2A-K9QD", { machine: "m", repo: { name: "retry" } }, { fetchImpl });
  assert.ok("cloud" in got);
  writeCloud(got.cloud);
  assert.equal(readCloud()?.workspace.slug, "w1");
});

test("a used, expired or wrong code is refused; an unreachable Trail is offline, not refused", async () => {
  const answer = (status: number) => (async () => json(status, { error: "x", error_code: "code_invalid" })) as unknown as typeof fetch;
  for (const status of [400, 404, 410]) {
    const got = await claimConnectCode("http://trail.test", "TRL-7F2A-K9QD", { machine: "m", repo: { name: "r" } }, { fetchImpl: answer(status) });
    assert.ok("reason" in got && got.reason === "invalid", String(status));
  }
  const revoked = await claimConnectCode("http://trail.test", "TRL-7F2A-K9QD", { machine: "m", repo: { name: "r" } }, { fetchImpl: answer(403) });
  assert.ok("reason" in revoked && revoked.reason === "invalid" && /no longer in that workspace/.test(revoked.error));
  const down = await claimConnectCode("http://trail.test", "TRL-7F2A-K9QD", { machine: "m", repo: { name: "r" } }, { fetchImpl: answer(502) });
  assert.ok("reason" in down && down.reason === "offline");
  const offline = await claimConnectCode("http://trail.test", "TRL-7F2A-K9QD", { machine: "m", repo: { name: "r" } }, {
    fetchImpl: (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch,
  });
  assert.ok("reason" in offline && offline.reason === "offline");
});

/* the stages --------------------------------------------------------------- */

const CLOUD: Cloud = {
  url: "http://trail.test",
  token: "trl_abc",
  user: { name: "R", email: "r@acme.test" },
  workspace: { id: "w1", name: "Acme", slug: "w1", url: "http://trail.test", invite_url: "http://trail.test" },
  repos: [],
  linkedAt: 1,
  via: "connect",
};

test("stages and the summary go up in order, with the token, and the repo and machine on each stage", async () => {
  const seen: Array<{ path: string; body: any; auth?: string }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ path: new URL(url).pathname, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).authorization });
    // Answer the first one slowest: order must not depend on who answers first.
    if (seen.length === 1) await new Promise((r) => setTimeout(r, 30));
    return json(200, { ok: true });
  }) as typeof fetch;
  const r = new OnboardingReporter(CLOUD, { name: "retry", remote_url: "https://github.com/acme/retry" }, { fetchImpl, machine: "MacBook" });
  void r.stage("connected");
  void r.stage("mapped", { nodes: 97, edges: 241, files: 6 });
  void r.stage("learned", { learnings: 2, sessions: 3 });
  assert.equal(await r.summary({ tokens: null, learnings: [], teammates: [] }), true);
  await r.stage("done");
  await r.flush();
  assert.deepEqual(
    seen.map((s) => (s.path === "/api/cli/onboarding/events" ? s.body.stage : s.path)),
    ["connected", "mapped", "learned", "/api/cli/repos/summary", "done"],
  );
  assert.ok(seen.every((s) => s.auth === "Bearer trl_abc"));
  assert.deepEqual(seen[1]!.body, { repo: { name: "retry", remote_url: "https://github.com/acme/retry" }, stage: "mapped", machine: "MacBook", data: { nodes: 97, edges: 241, files: 6 } });
});

test("offline, the first stage that can't reach Trail turns the rest off, and nothing throws", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const r = new OnboardingReporter(CLOUD, { name: "retry" }, { fetchImpl });
  assert.equal(await r.stage("connected"), false);
  assert.equal(await r.stage("mapped", {}), false);
  assert.equal(await r.summary({ tokens: null, learnings: [], teammates: [] }), false);
  await r.flush();
  assert.equal(calls, 1);
});

test("an HTTP error is that call's alone: the next one still goes", async () => {
  let calls = 0;
  const fetchImpl = (async () => (++calls === 1 ? json(500, { error: "boom" }) : json(200, { ok: true }))) as unknown as typeof fetch;
  const r = new OnboardingReporter(CLOUD, { name: "retry" }, { fetchImpl });
  assert.equal(await r.stage("connected"), false);
  assert.equal(await r.stage("mapped", {}), true);
});

/* tokens ------------------------------------------------------------------- */

test("the tokens numbers are the ones ask's own savings line prints", () => {
  const line =
    "[trail] tokens saved ≈ 15,392 (88%) — this pack ≈ 2,048 tok vs reading the 3 source file(s) whole ≈ 17,440 tok. Estimate (baseline = those files read in full).";
  assert.deepEqual(parseAskSavings(`${line}\n\nbody`), { saved: 15392, pct: 88, pack: 2048, files: 3, baseline: 17440 });
  assert.equal(parseAskSavings("no line here"), null);
});

test("one real lookup on the fresh map: the most central symbol, and what reading the map saved", async () => {
  const dir = mkdtempSync(join(tmpdir(), "connect-tokens-"));
  // A hub everyone calls, in a big file, so reading it whole costs far more than the pack.
  const filler = Array.from({ length: 400 }, (_, i) => `export function helper${i}(x: number): number {\n  return x * ${i} + ${i};\n}\n`).join("\n");
  writeFileSync(join(dir, "client.ts"), `export function retryDo(attempts: number): number {\n  let n = 0;\n  for (let i = 0; i < attempts; i++) n += i;\n  return n;\n}\n\n${filler}`);
  for (const f of ["a", "b", "c", "d"]) writeFileSync(join(dir, `${f}.ts`), `import { retryDo } from "./client";\nexport function use${f}() {\n  return retryDo(4);\n}\n`);
  await buildGraph(dir);
  const t = tokensOnOneLookup(dir);
  assert.ok(t, "a lookup with a saving");
  assert.equal(t.symbol, "retryDo");
  assert.equal(t.question, "how retryDo works");
  assert.ok(t.saved > 0 && t.baseline > t.pack && t.pct > 0 && t.pct <= 100 && t.files >= 1);
  // The same numbers the agent sees on that query.
  assert.deepEqual(parseAskSavings(formatAsk(ask(dir, "how does retryDo work", { source: true, limit: 5 }))), { saved: t.saved, pct: t.pct, pack: t.pack, files: t.files, baseline: t.baseline });
  assert.equal(tokensOnOneLookup(mkdtempSync(join(tmpdir(), "connect-nograph-"))), null);
});

/* learnings ---------------------------------------------------------------- */

test("a learning goes up as its title, one short line and its session count: no code block, no provenance line", () => {
  const body =
    "## Decided\n- Keep defaultRetryMax at 4: ten retries can hold one Do() call for over an hour.\n\n```go\nconst defaultRetryMax = 4\n```\n\n_Told to Claude in 3 past sessions here, most recently on Oct 9._";
  assert.equal(shortBody(body), "Keep defaultRetryMax at 4: ten retries can hold one Do() call for over an hour.");
  assert.equal(sessionsIn(body), 3);
  assert.equal(shortBody("```\ncode only\n```\nPlain line after."), "Plain line after.");
  assert.equal(shortBody("x".repeat(500)).length, 200);
});

test("the summary's learnings are the team's: what init just learned, else what .trail/learnings has; never a personal one", () => {
  const dir = mkdtempSync(join(tmpdir(), "connect-learn-"));
  git(dir, "init", "-q", "-b", "main");
  const team = writeNote(dir, { title: "Run go test -race before saying done", body: "## Decided\n- Run `go test -race ./...` before saying done.\n\n_Told to Claude in 2 past sessions here, most recently on Oct 9._", author: "R", date: "2026-10-09", touches: [] });
  const mine = writeNote(dir, { title: "My shell aliases", body: "## Decided\n- zsh needs interactivecomments.", author: "R", date: "2026-10-09" }, "personal");
  assert.deepEqual(learningsSummary(dir, [{ note: team, sessions: 3 }, { note: mine, sessions: 2 }]), [
    { title: "Run go test -race before saying done", body: "Run `go test -race ./...` before saying done.", sessions: 3 },
  ]);
  // Nothing learned this run: the repo's own, sessions read from the line under each.
  assert.deepEqual(learningsSummary(dir, []), [{ title: "Run go test -race before saying done", body: "Run `go test -race ./...` before saying done.", sessions: 2 }]);
});

/* teammates ---------------------------------------------------------------- */

const DAY = 24 * 60 * 60 * 1000;

/** A bare "GitHub" remote and clones of it, one per person, like trail-cloud.test.ts. */
function team(): { root: string; bare: string; clone: (who: string, name: string) => string } {
  const root = mkdtempSync(join(tmpdir(), "connect-team-"));
  const bare = join(root, "retry.git");
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  const seed = join(root, "seed");
  git(root, "init", "-q", "-b", "main", seed);
  writeFileSync(join(seed, "client.go"), "package retry\n\nconst defaultRetryMax = 4\n");
  writeFileSync(join(seed, "backoff.go"), "package retry\n");
  writeFileSync(join(seed, "README.md"), "# retry\n");
  git(seed, "add", "-A");
  git(seed, "-c", "user.name=Seed", "-c", "user.email=s@x", "commit", "-qm", "init");
  git(seed, "push", "-q", bare, "main");
  const clone = (who: string, name: string) => {
    const d = join(root, who);
    git(root, "clone", "-q", bare, d);
    git(d, "remote", "set-url", "origin", "https://github.com/acme/retry.git");
    git(d, "config", `url.${bare}.insteadOf`, "https://github.com/acme/retry.git");
    git(d, "config", "user.name", name);
    git(d, "config", "user.email", `${who}@acme.test`);
    git(d, "remote", "set-head", "origin", "main");
    return d;
  };
  return { root, bare, clone };
}

/** Commit `files` on a new branch in `dir` and push it, dated `at`. */
function pushBranch(dir: string, branch: string, files: Record<string, string>, subject: string, at = Date.now()): void {
  git(dir, "checkout", "-q", "-b", branch, "origin/main");
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
  git(dir, "add", "-A");
  const date = new Date(at).toISOString();
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", subject], { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  assert.equal(r.status, 0, r.stderr);
  git(dir, "push", "-q", "origin", branch);
}

test("teammates: others' branches pushed in the last 14 days that change the files you work on, with what they change", () => {
  const { clone } = team();
  const me = clone("rushabh", "Rushabh Nagda");
  const kumar = clone("kumar", "Kumar S");
  const priya = clone("priya", "Priya R");
  const old = clone("olga", "Olga O");

  // What I work on: client.go, committed on my own pushed branch.
  pushBranch(me, "rushabh/retry-docs", { "client.go": "package retry\n\n// Keep it at 4.\nconst defaultRetryMax = 4\n" }, "Document the retry default");
  git(me, "checkout", "-q", "main");

  pushBranch(kumar, "kumar/retry", { "client.go": "package retry\n\nconst defaultRetryMax = 10\n" }, "Raise defaultRetryMax to 10");
  pushBranch(priya, "priya/readme", { "README.md": "# retry\n\nMore docs.\n" }, "Docs: more README");
  pushBranch(old, "olga/client", { "client.go": "package retry\n\nconst defaultRetryMax = 5\n" }, "Try 5", Date.now() - 20 * DAY);

  const rule = writeNote(me, { title: "Keep defaultRetryMax at 4", body: "## Decided\n- Keep it at 4.", author: "Rushabh", date: "2026-10-09", touches: ["client.go"] });
  const got = teammatesFromGit(me, { learnings: [rule] });
  assert.equal(got.length, 1, JSON.stringify(got, null, 2));
  const k = got[0]!;
  assert.equal(k.name, "Kumar S");
  assert.equal(k.email, "kumar@acme.test");
  assert.equal(k.branch, "kumar/retry");
  assert.deepEqual(k.files, ["client.go"]);
  assert.equal(k.change, "Raise defaultRetryMax to 10");
  assert.equal(k.commits, 1);
  assert.equal(k.conflict, 'Changes defaultRetryMax in client.go, which your learning "Keep defaultRetryMax at 4" is about.');
  assert.ok(Math.abs(Date.parse(k.pushed_at) - Date.now()) < DAY);
  // Names, branch and file names and subjects only: no diff.
  assert.ok(!JSON.stringify(got).includes("defaultRetryMax = 10"));
});

test("with no history of your own here, teammates are matched on the repo's busiest files", () => {
  const { clone } = team();
  const kumar = clone("kumar", "Kumar S");
  pushBranch(kumar, "kumar/retry", { "client.go": "package retry\n\nconst defaultRetryMax = 10\n" }, "Raise defaultRetryMax to 10");
  const fresh = clone("newbie", "New Person");
  const got = teammatesFromGit(fresh);
  assert.deepEqual(got.map((t) => t.branch), ["kumar/retry"]);
  assert.deepEqual(got[0]!.files, ["client.go"]);
});

test("a conflict needs the branch to change a name the learning is about, not just its file", () => {
  const { clone } = team();
  const me = clone("rushabh", "Rushabh Nagda");
  const kumar = clone("kumar", "Kumar S");
  const priya = clone("priya", "Priya R");
  pushBranch(kumar, "kumar/retry", { "client.go": "package retry\n\nconst defaultRetryMax = 10\n" }, "Raise defaultRetryMax to 10");
  pushBranch(priya, "priya/jitter", { "client.go": "package retry\n\nconst defaultRetryMax = 4\n\nfunc Jitter() {}\n" }, "Add jitter");
  git(me, "fetch", "-q", "origin");
  const rule = { title: "Keep defaultRetryMax at 4", body: "## Decided\n- Ten retries can hold one Do() call for over an hour.", author: "", date: "", touches: ["client.go"], path: "", scope: "repo" as const };
  assert.deepEqual(learningTerms(rule).sort(), ["Do", "defaultRetryMax"]);
  assert.equal(conflictLine(me, "origin/main", "origin/kumar/retry", ["client.go"], [rule]), 'Changes defaultRetryMax in client.go, which your learning "Keep defaultRetryMax at 4" is about.');
  assert.equal(conflictLine(me, "origin/main", "origin/priya/jitter", ["client.go"], [rule]), undefined, "same file, different code");
  assert.equal(conflictLine(me, "origin/main", "origin/kumar/retry", ["client.go"], [{ ...rule, title: "Keep the retry count low", body: "## Decided\n- Keep it low." }]), undefined, "a learning naming nothing code-like");
  assert.deepEqual(learningTerms({ ...rule, title: "x", body: "", touches: ["client.go#Client.Do"] }), ["Do"]);
});

/* a connection made by --connect ------------------------------------------- */

test("a machine connected by --connect never syncs learnings or records searches, and is never asked to add a repo", () => {
  const { clone } = team();
  const me = clone("rushabh", "Rushabh Nagda");
  writeNote(me, { title: "A team learning", body: "## Decided\n- x", author: "R", date: "2026-10-09" });
  const key = "github.com/acme/retry";
  const cloud: Cloud = { ...CLOUD, repos: [key] };
  writeCloud(cloud);
  assert.equal(inWorkspace(me, cloud), false);
  recordActivity({ repo: key, kind: "search", asker: "R", session: "s", query: "secret question", files: [], shown_paths: [], shown_authors: [], at: new Date().toISOString() }, cloud);
  assert.equal(existsSync(join(process.env.TRAIL_HOME!, "outbox.jsonl")), false);
  assert.deepEqual(cloudLines(me, { command: "ask", agent: true }), []);
  assert.equal(listNotes(me).length, 1);
  // The same connection made by `trail login` keeps today's behaviour.
  const { via: _via, ...byLogin } = cloud;
  assert.equal(inWorkspace(me, byLogin), true);
});
