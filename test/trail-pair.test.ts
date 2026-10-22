/**
 * `trail init --pair CODE`: init tells Trail about itself with the pair code
 * from the onboarding page, streams its steps, and hands over the repo's
 * learnings for review. A detached child then waits for the connection and the
 * review before uploading, so a learning dropped on the review page stays
 * dropped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND_ENV } from "../src/brand.js";
import { writeNote } from "../src/notes/notes.js";
import { finishPair, PairRun, validPairCode } from "../src/cloud/pair.js";
import { teammatesFromGit } from "../src/cloud/onboarding.js";
import { readCloud } from "../src/cloud/workspace.js";
import { tmpRepo } from "./helpers.js";

process.env.DO_NOT_TRACK = "1";
process.env[BRAND_ENV] = "trail";
process.env.TRAIL_URL = "http://trail.test";
process.env.TRAIL_NO_FETCH = "1";

function freshHome(): void {
  process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "pair-trail-home-"));
}

function git(d: string, args: string[]) {
  spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: d });
}

/** A GitHub-backed repo with one learning in its .trail/. */
function repo(): string {
  const dir = tmpRepo("pair");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "Priya Raman"]);
  git(dir, ["remote", "add", "origin", "https://github.com/acme/billing.git"]);
  writeNote(dir, { title: "Keep payment retries at 4", body: "## Decided\nFour retries.", author: "Sam", date: "2026-10-07", touches: [] });
  return dir;
}

type Call = { method: string; path: string; body: Record<string, unknown> };

/** A stand-in Trail: `answer` picks each response; every request is recorded. */
function fakeTrail(answer: (c: Call, calls: Call[]) => { status: number; body?: unknown }): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const call = { method: init?.method ?? "GET", path: u.pathname, body: init?.body ? JSON.parse(String(init.body)) : {} };
    calls.push(call);
    const { status, body } = answer(call, calls);
    return new Response(body === undefined ? "" : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetch: f, calls };
}

test("pair codes are letters and digits from the onboarding page", () => {
  assert.equal(validPairCode("X4GM5OQU4NIA65ZR"), true);
  assert.equal(validPairCode("abc"), false);
  assert.equal(validPairCode("rm -rf /"), false);
});

test("init --pair registers with the code, streams its steps, then hands over the learnings", async () => {
  freshHome();
  const dir = repo();
  const t = fakeTrail((c) => (c.path === "/api/cli/handoffs" ? { status: 201, body: { url: "http://trail.test/connect?state=s" } } : { status: 202, body: {} }));
  const run = await PairRun.start(dir, "x4gm5oqu4nia65zr", { agent: "codex", version: "0.23.1", fetchImpl: t.fetch });
  assert.ok(run instanceof PairRun);

  const reg = t.calls[0]!;
  assert.equal(reg.path, "/api/cli/handoffs");
  assert.equal(reg.body.pair, "X4GM5OQU4NIA65ZR");
  assert.deepEqual(reg.body.repo, { key: "github.com/acme/billing", name: "acme/billing" });
  // The repo's own learnings are counted, though init hasn't told Trail about it before.
  assert.equal((reg.body.repos as { key: string; learnings: number }[])[0]!.learnings, 1);

  run.phase("files", "running");
  run.phase("files", "done", "12 files", "Mapped 12 files");
  await run.finish(dir);

  const progress = t.calls.filter((c) => c.path === "/api/cli/handoffs/progress");
  assert.equal(progress[0]!.body.agent, "codex");
  assert.ok(progress.every((c) => c.body.state === run.state));
  const found = progress.flatMap((c) => (c.body.found as { title: string }[] | undefined) ?? []);
  assert.deepEqual(found.map((f) => f.title), ["Keep payment retries at 4"]);
  assert.equal(progress.at(-1)!.body.done, true);
  // Steps arrive in the order they happened.
  const files = progress.map((c) => (c.body.phases as { id: string; status: string }[] | undefined)?.find((p) => p.id === "files")?.status).filter(Boolean);
  assert.deepEqual(files.slice(0, 3), ["todo", "running", "done"]);
});

test("a Trail that turns the code down leaves init to carry on", async () => {
  freshHome();
  const t = fakeTrail(() => ({ status: 500, body: { error: "boom" } }));
  const run = await PairRun.start(repo(), "X4GM5OQU4NIA65ZR", { agent: "claude", version: "0.23.1", fetchImpl: t.fetch });
  assert.ok("error" in run);
});

test("the child waits for the connect, then the review, and only then uploads", async () => {
  freshHome();
  const dir = repo();
  let reviewed = false;
  const t = fakeTrail((c, calls) => {
    if (c.path === "/api/cli/handoffs/claim") {
      // Waiting the first time, connected the second.
      return calls.filter((x) => x.path === c.path).length < 2
        ? { status: 202, body: { pending: true } }
        : { status: 200, body: { token: "trl_test", user: { name: "Priya", email: "p@acme.test" }, workspace: { slug: "acme", name: "Acme", url: "http://trail.test/w/acme" }, repos: [] } };
    }
    if (c.path === "/api/cli/handoffs/progress") {
      const was = reviewed;
      reviewed = true;
      return was ? { status: 409, body: { error: "the learnings were already reviewed" } } : { status: 202, body: {} };
    }
    if (c.path === "/api/cli/me")
      return { status: 200, body: { user: { name: "Priya", email: "p@acme.test" }, workspace: { slug: "acme", name: "Acme", url: "http://trail.test/w/acme" }, repos: [{ key: "github.com/acme/billing", name: "acme/billing", learnings: 1, added_by: "Priya" }] } };
    if (c.path === "/api/cli/learnings") return { status: 200, body: { learnings: 1, added: 0 } };
    return { status: 404, body: { error: "not found" } };
  });
  const outcome = await finishPair("s".repeat(32), dir, { fetchImpl: t.fetch, sleep: async () => {} });
  assert.equal(outcome, "uploaded");

  const order = t.calls.map((c) => c.path);
  const firstUpload = order.indexOf("/api/cli/learnings");
  assert.ok(firstUpload > order.lastIndexOf("/api/cli/handoffs/progress"), "no upload before the review is in");
  const put = t.calls[firstUpload]!;
  assert.deepEqual(put.body.repo, { key: "github.com/acme/billing", name: "acme/billing" });
  assert.equal(readCloud()?.workspace.slug, "acme");
  assert.deepEqual(readCloud()?.repos, ["github.com/acme/billing"]);
});

test("an expired link stops the child without uploading", async () => {
  freshHome();
  const t = fakeTrail(() => ({ status: 410, body: { error: "gone" } }));
  const outcome = await finishPair("s".repeat(32), repo(), { fetchImpl: t.fetch, sleep: async () => {} });
  assert.equal(outcome, "expired");
  assert.equal(t.calls.some((c) => c.path === "/api/cli/learnings"), false);
});

const progressCalls = (t: { calls: Call[] }) => t.calls.filter((c) => c.path === "/api/cli/handoffs/progress");
const okTrail = () => fakeTrail((c) => (c.path === "/api/cli/handoffs" ? { status: 201, body: { url: "http://trail.test/connect?state=s" } } : { status: 202, body: {} }));

test("phases include tokens and team in order", async () => {
  freshHome();
  const t = okTrail();
  const run = await PairRun.start(repo(), "X4GM5OQU4NIA65ZR", { agent: "claude", version: "0.23.1", fetchImpl: t.fetch });
  assert.ok(run instanceof PairRun);
  await run.flush();
  const phases = progressCalls(t)[0]!.body.phases as { id: string; label: string }[];
  assert.deepEqual(phases.map((p) => p.id), ["install", "files", "tokens", "prs", "decisions", "team", "learnings"]);
  assert.equal(phases.find((p) => p.id === "tokens")!.label, "Measure one lookup");
  assert.equal(phases.find((p) => p.id === "team")!.label, "Check your team's branches");
});

test("findings ride on progress", async () => {
  freshHome();
  const dir = repo();
  const t = okTrail();
  const run = await PairRun.start(dir, "X4GM5OQU4NIA65ZR", { agent: "claude", version: "0.23.1", fetchImpl: t.fetch });
  assert.ok(run instanceof PairRun);
  run.findings({
    tokens: { question: "how Do works", symbol: "Do", saved: 15392, pack: 2048, baseline: 17440, pct: 88, files: 3 },
    sessions: 3,
    teammates: [{ name: "Sam", email: "sam@acme.test", branch: "sam/retry", files: ["client.go"], change: "Raise retries to 10", pushed_at: "2026-10-21T14:20:00Z" }],
  });
  await run.finish(dir);
  const withFindings = progressCalls(t).filter((c) => c.body.findings);
  assert.equal(withFindings.length, 1);
  const f = withFindings[0]!.body.findings as { tokens: { pct: number }; teammates: { branch: string }[]; sessions: number };
  assert.equal(f.tokens.pct, 88);
  assert.equal(f.teammates[0]!.branch, "sam/retry");
  assert.equal(f.sessions, 3);
});

test("findings leave out what is undefined or null", async () => {
  freshHome();
  const t = okTrail();
  const run = await PairRun.start(repo(), "X4GM5OQU4NIA65ZR", { agent: "claude", version: "0.23.1", fetchImpl: t.fetch });
  assert.ok(run instanceof PairRun);
  run.findings({ tokens: null, sessions: undefined, teammates: [] });
  await run.flush();
  const f = progressCalls(t).find((c) => c.body.findings)!.body.findings as Record<string, unknown>;
  assert.deepEqual(Object.keys(f), ["teammates"]);
  assert.deepEqual(f.teammates, []);
});

test("teammates absent on a repo without origin", async () => {
  freshHome();
  const dir = tmpRepo("pair-no-origin");
  git(dir, ["init", "-q", "-b", "main"]);
  assert.deepEqual(teammatesFromGit(dir), []);
  const t = okTrail();
  const run = await PairRun.start(repo(), "X4GM5OQU4NIA65ZR", { agent: "claude", version: "0.23.1", fetchImpl: t.fetch });
  assert.ok(run instanceof PairRun);
  run.findings({ teammates: [] });
  await run.flush();
  const f = progressCalls(t).find((c) => c.body.findings)!.body.findings as { teammates: unknown[] };
  assert.deepEqual(f.teammates, []);
});
