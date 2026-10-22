/**
 * The first-run read of PR reviews: which comments count (a reviewer's,
 * inline, on a thread the author acted on), that a finding survives only when
 * the comment it quotes is really there and it names the code it's about, and
 * that `trail init` reads them with `gh` when it can and stays quiet when it
 * can't.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anchoredReviews, codeWords, commentedCode, finishReviewRead, ghReady, reviewDigest, reviewedPRs, reviewWords, verifyReviews, type ReviewedPR, type ReviewFinding, type ReviewResult } from "../src/notes/pr-reviews.js";
import { ensureRepoHome } from "../src/notes/home.js";
import { parseNote } from "../src/notes/notes.js";
import { claudeProjectDir } from "../src/notes/session-cost.js";
import { tmpRepo } from "./helpers.js";

const human = (login: string) => ({ login, __typename: "User" });
const bot = { login: "coderabbitai", __typename: "Bot" };

const HUNK = "@@ -10,6 +10,8 @@ export async function orders(req) {\n   const rows = await db.query(sql);\n+  // TODO\n   return rows;";

/** GitHub's GraphQL answer for four merged PRs, one reviewed only by a bot. */
const GITHUB = {
  data: {
    repository: {
      pullRequests: {
        nodes: [
          {
            number: 38,
            title: "Users endpoint",
            mergedAt: "2026-10-05T09:00:00Z",
            author: { login: "bob" },
            reviews: { nodes: [{ body: "", author: human("alice") }] },
            reviewThreads: {
              nodes: [{ isOutdated: true, comments: { nodes: [{ body: "Same again: handlers in src/api must return a 500 when db.query fails.", path: "src/api/users.ts", author: human("alice") }] } }],
            },
          },
          {
            number: 41,
            title: "Orders endpoint",
            mergedAt: "2026-10-10T09:00:00Z",
            author: { login: "bob" },
            reviews: { nodes: [{ body: "Looks good once the error handling is in. <!-- review-bot:ignore -->", author: human("alice") }] },
            reviewThreads: {
              nodes: [
                {
                  isOutdated: true,
                  comments: {
                    nodes: [
                      { body: "This handler swallows the error from db.query, log it and return a 500.", path: "src/api/orders.ts", diffHunk: HUNK, author: human("alice") },
                      { body: "> This handler swallows the error\n\ndone, thanks", path: "src/api/orders.ts", author: human("bob") },
                    ],
                  },
                },
                { isResolved: true, comments: { nodes: [{ body: "Consider adding tests for this endpoint.", path: "src/api/orders.ts", author: bot }] } },
                // Nobody acted on it: not a rule.
                { isOutdated: false, isResolved: false, comments: { nodes: [{ body: "Nit: maybe rename rows to orders?", path: "src/api/orders.ts", author: human("alice") }] } },
              ],
            },
          },
          {
            number: 35,
            title: "Fixture refresh",
            mergedAt: "2026-09-30T09:00:00Z",
            author: { login: "carol" },
            reviews: { nodes: [{ body: "Thanks!", author: human("dan") }] },
            reviewThreads: {
              nodes: [{ isResolved: true, comments: { nodes: [{ body: "The fixture has token: ghp_abcdefghijklmnopqrstuvwxyz1234 in it, please add a changelog entry too.", path: "CHANGELOG.md", author: human("dan") }] } }],
            },
          },
          {
            number: 30,
            title: "Bump deps",
            mergedAt: "2026-09-20T09:00:00Z",
            author: { login: "dependabot", __typename: "Bot" },
            reviews: { nodes: [{ body: "Auto-approved.", author: { login: "github-actions[bot]" } }] },
            reviewThreads: { nodes: [] },
          },
        ],
      },
    },
  },
};

test("only reviewers' inline words on acted-on threads count: summaries, ignored threads, bots, the PR's author and quoted replies are dropped, and secrets scrubbed", () => {
  const { merged, prs } = reviewedPRs(GITHUB);
  assert.equal(merged, 4);
  assert.deepEqual(prs.map((p) => p.number), [41, 38, 35], "newest merged first, the bot-only PR left out");
  const orders = prs[0]!;
  assert.deepEqual(orders.comments, [
    { path: "src/api/orders.ts", text: "This handler swallows the error from db.query, log it and return a 500.", code: "const rows = await db.query(sql);\n+  // TODO\n   return rows;" },
  ]);
  assert.equal(commentedCode("@@ -1 +1 @@\n"), undefined);
  assert.ok(!prs[2]!.comments[0]!.text.includes("ghp_"));
  assert.equal(reviewWords("> quoted\n\n![shot](https://x/y.png) see this"), "[image] see this");
  assert.equal(reviewWords("<!-- only a marker -->"), null);
  assert.equal(reviewWords("a <!<!-- x -->-- b --> c"), "a c");
  assert.equal(reviewWords("keep this <!-- never closed"), "keep this");
});

test("the digest heads each PR with its number and stops at its size", () => {
  const prs: ReviewedPR[] = [
    { number: 9, title: "New", at: "2026-10-09T00:00:00Z", comments: [{ path: "a.ts", text: "x".repeat(50), code: "return a;" }] },
    { number: 8, title: "Old", at: "2026-09-01T00:00:00Z", comments: [{ path: "b.ts", text: "y".repeat(50) }] },
  ];
  const all = reviewDigest(prs);
  assert.match(all.text, /^=== PR #9 · 2026-10-09 · New ===\n\[code in a\.ts\]\nreturn a;\n\[review on a\.ts\] x+\n\n=== PR #8 · 2026-09-01 · Old ===\n\[review on b\.ts\] y+$/);
  const small = reviewDigest(prs, 110);
  assert.deepEqual(small.read.map((p) => p.number), [9]);
});

test("a review finding is kept when its quotes are really in an acted-on comment, one PR is enough, and trail counts them", () => {
  const { prs } = reviewedPRs(GITHUB);
  const out = verifyReviews(
    [
      {
        title: "Return a 500 when db.query fails in src/api",
        body: "## Decided\n- Handlers in `src/api/` log the db.query error and return a 500.",
        evidence: [
          { pr: 41, quote: "swallows the error from db.query" },
          // Filed under the wrong PR, and as a string: still counts for the one it's on.
          { pr: "#35", quote: "must return a 500 when db.query fails" },
        ],
      },
      { title: "Made up", body: "## Decided\n- x", evidence: [{ pr: 41, quote: "never said anything like this" }, { pr: 38, quote: "nor this one either" }] },
      { title: "Changelog", body: "## Decided\n- y", evidence: [{ pr: 35, quote: "please add a changelog entry too" }, { pr: 41, quote: "please add a changelog entry too" }] },
    ],
    prs,
  );
  assert.deepEqual(out.map((f) => f.title), ["Return a 500 when db.query fails in src/api", "Changelog"], "newest first; the made-up one is gone");
  assert.deepEqual(out[0]!.prs, [41, 38]);
  assert.equal(out[0]!.last, "2026-10-10");
  assert.deepEqual(out[0]!.paths, ["src/api/orders.ts", "src/api/users.ts"], "the files the quoted inline comments are on");
  assert.deepEqual(out[1]!.prs, [35], "one acted-on thread is enough");
});

/* ---- trail init, end to end, with stand-ins for Claude Code and gh on PATH ---- */

function transcript(entries: object[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

/** A repo whose origin is a bare repo under a `github.com/` path: GitHub to trail, no network to git. */
function githubRepo(name: string): string {
  const repo = tmpRepo(name);
  const origin = join(mkdtempSync(join(tmpdir(), "gh-origin-")), "github.com", "acme", "shop.git");
  mkdirSync(origin, { recursive: true });
  spawnSync("git", ["init", "-q", "--bare"], { cwd: origin });
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["remote", "add", "origin", origin], { cwd: repo });
  return repo;
}

/** Two past sessions in `repo` that both say the same thing. */
function pastSessions(repo: string, home: string): void {
  const projects = claudeProjectDir(repo, home);
  mkdirSync(projects, { recursive: true });
  for (const id of ["aaaaaaaa-1111", "bbbbbbbb-2222"])
    writeFileSync(
      join(projects, `${id}.jsonl`),
      transcript([{ type: "user", cwd: repo, timestamp: "2026-10-01T10:00:00Z", message: { role: "user", content: "always run go test with -race before pushing" } }]),
    );
}

/**
 * A `claude` that answers the session read with one finding and the review
 * read with two (one only on one PR), keeping what it was sent; and a `gh`
 * that's signed in or not, answering the GraphQL call with GITHUB.
 */
function fakeTools(signedIn: boolean): { bin: string; log: string } {
  const bin = mkdtempSync(join(tmpdir(), "fake-tools-"));
  const log = join(bin, "log");
  mkdirSync(log);
  const sessions = {
    findings: [
      {
        title: "Run go test with -race before pushing",
        for: "team",
        body: "## Decided\n- Run `go test -race ./...` before every push.",
        evidence: [
          { session: "aaaaaaaa", quote: "always run go test with -race before pushing" },
          { session: "bbbbbbbb", quote: "always run go test with -race before pushing" },
        ],
      },
    ],
  };
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
      { title: "Add a changelog entry", body: "## Decided\n- y", evidence: [{ pr: 35, quote: "please add a changelog entry too" }] },
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
  fs.writeFileSync(${JSON.stringify(log)} + (review ? "/reviews.txt" : "/sessions.txt"), input);
  const out = review ? ${JSON.stringify(reviews)} : ${JSON.stringify(sessions)};
  console.log(JSON.stringify({ is_error: false, total_cost_usd: 0.01, structured_output: out }));
});
`,
  );
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)} + "/gh.txt", args.slice(0, 2).join(" ") + "\\n");
if (args[0] === "auth" && args[1] === "token") process.exit(${signedIn ? 0 : 1});
if (args[0] === "api" && args[1] === "graphql" && args.includes("owner={owner}")) { console.log(${JSON.stringify(JSON.stringify(GITHUB))}); process.exit(0); }
process.exit(1);
`,
  );
  chmodSync(join(bin, "claude"), 0o755);
  chmodSync(join(bin, "gh"), 0o755);
  return { bin, log };
}

function initRun(repo: string, home: string, bin: string) {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", "trail.ts"), "init", repo, "--agents", "claude", "--no-build", "--no-global"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      TRAIL_HOME: join(home, ".trail"),
      PATH: `${bin}:${process.env.PATH}`,
      DO_NOT_TRACK: "1",
      GIT_TERMINAL_PROMPT: "0",
      TRAIL_NO_FETCH: undefined,
      CLAUDECODE: undefined,
      TRAIL_INVOKED_AS: undefined,
      GH_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
    },
  });
  return { status: r.status, err: r.stderr };
}

const reviewLearnings = (repo: string) =>
  readdirSync(join(repo, ".trail", "learnings"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => parseNote(readFileSync(join(repo, ".trail", "learnings", f), "utf8"), f)!)
    .filter((n) => /From review on/.test(n.body));

// The stand-ins are shebang scripts, which Windows won't run as `claude` or `gh`.
test("trail init learns what reviewers made authors change, beside the session learnings, once per repo", { skip: process.platform === "win32" }, () => {
  const home = mkdtempSync(join(tmpdir(), "reviews-init-home-"));
  const repo = githubRepo("reviews-init");
  // The code the reviews were about: a finding tied to no code that exists isn't the team's.
  mkdirSync(join(repo, "src", "api"), { recursive: true });
  writeFileSync(join(repo, "src", "api", "orders.ts"), "export const orders = 1;\n");
  pastSessions(repo, home);
  const { bin, log } = fakeTools(true);

  const first = initRun(repo, home, bin);
  assert.equal(first.status, 0, first.err);
  assert.match(first.err, /· reading review comments on this repo's merged PRs for what reviewers keep flagging/);
  assert.match(first.err, /✓ learned 1 thing reviewers made authors change, from the last 4 merged PRs here\n {4}for your team · from review on #41, #38: Return a 500 when db\.query fails in src\/api\n/);
  assert.match(first.err, /✓ learned 1 thing you told Claude more than once, from your last 2 sessions here, just for you\n {4}just for you  · told Claude in 2 sessions: Run go test with -race before pushing\n· Claude follows them from your next session\n🌱 Commit what you learned/);
  assert.match(first.err, /→ 1 team learning in \.trail\/learnings\/ isn't committed yet\. Ask the user: "Commit it so your teammates' Claude starts from it\? \(yes \/ no\)"/, "run without a terminal, init ends by telling the agent to ask");
  assert.equal(first.err.match(/Claude follows them/g)?.length, 1, "one closing line for both");

  const [learning] = reviewLearnings(repo);
  assert.ok(learning);
  assert.equal(learning.standing, true);
  assert.deepEqual(learning.touches, ["src/api/orders.ts"], "the file the quoted comment was on");
  assert.match(learning.body, /_From review on #41, #38 here, merged Oct 10\._/);

  // What Claude was sent: reviewers' comments, scrubbed, with no names, bots or author replies.
  const sent = readFileSync(join(log, "reviews.txt"), "utf8");
  assert.match(sent, /=== PR #41 · 2026-10-10 · Orders endpoint ===\n\[code in src\/api\/orders\.ts\]\nconst rows = await db\.query\(sql\);[\s\S]*?\n\[review on src\/api\/orders\.ts\] This handler swallows/);
  for (const absent of ["ghp_", "alice", "bob", "done, thanks", "Consider adding tests", "Looks good once", "Nit: maybe rename", "PR #30"]) assert.ok(!sent.includes(absent), `sent ${absent}`);

  const again = initRun(repo, home, bin);
  assert.equal(again.status, 0, again.err);
  assert.doesNotMatch(again.err, /reading review comments/, "read once per repo on this machine");

  // A teammate's machine, with the review learning already in the repo: nothing new to learn from the same reviews.
  const teammate = mkdtempSync(join(tmpdir(), "reviews-teammate-home-"));
  const theirs = initRun(repo, teammate, bin);
  assert.equal(theirs.status, 0, theirs.err);
  assert.doesNotMatch(theirs.err, /reading review comments/);
  assert.equal(reviewLearnings(repo).length, 1);
});

test("without a signed-in gh, trail init skips PR reviews quietly and still learns from sessions", { skip: process.platform === "win32" }, () => {
  const home = mkdtempSync(join(tmpdir(), "reviews-nogh-home-"));
  const repo = githubRepo("reviews-nogh");
  pastSessions(repo, home);
  const { bin, log } = fakeTools(false);

  const r = initRun(repo, home, bin);
  assert.equal(r.status, 0, r.err);
  assert.doesNotMatch(r.err, /review/i);
  assert.match(r.err, /✓ learned 1 thing you told Claude more than once/);
  assert.equal(readFileSync(join(log, "gh.txt"), "utf8"), "auth token\n", "asked gh only whether it's signed in");
  assert.ok(!existsSync(join(log, "reviews.txt")));
});

test("gh isn't asked at all without a GitHub remote, and a missing gh means no reviews", () => {
  const plain = tmpRepo("reviews-no-remote");
  spawnSync("git", ["init", "-q"], { cwd: plain });
  const { bin, log } = fakeTools(true);
  assert.equal(ghReady(plain, join(bin, "gh")), false);
  assert.ok(!existsSync(join(log, "gh.txt")));
  assert.equal(ghReady(githubRepo("reviews-missing-gh"), "trail-test-no-such-gh"), false);
});

/* ---- ticking which review learnings to keep ---- */

function flagged(title: string, paths: string[] = ["src/api/users.ts"]): ReviewFinding {
  return { title, body: `## Decided\n- ${title}${paths[0] ? `, in ${paths[0]}` : ""}.`, prs: [41, 38], last: "2026-10-10", quotes: [], paths };
}

/** A repo with the files the review findings are about. */
function reviewedRepo(name: string): string {
  const repo = tmpRepo(name);
  spawnSync("git", ["init", "-q"], { cwd: repo });
  mkdirSync(join(repo, "src", "api"), { recursive: true });
  writeFileSync(join(repo, "src", "api", "users.ts"), "export const users = 1;\n");
  return repo;
}

function reviewReadWith(findings: ReviewFinding[]) {
  const result: ReviewResult = { prs: 50, reviewed: 12, read: 12, findings, model: "claude-sonnet-5-5", durationMs: 10 };
  return { started: Date.now(), done: true, result: Promise.resolve(result) };
}

async function withTrailHome(name: string, run: () => Promise<void>): Promise<void> {
  const env = { TRAIL_HOME: process.env.TRAIL_HOME, DO_NOT_TRACK: process.env.DO_NOT_TRACK };
  process.env.TRAIL_HOME = join(mkdtempSync(join(tmpdir(), name)), ".trail");
  process.env.DO_NOT_TRACK = "1";
  try {
    await run();
  } finally {
    process.env.TRAIL_HOME = env.TRAIL_HOME;
    process.env.DO_NOT_TRACK = env.DO_NOT_TRACK;
  }
}

test("init saves only the review learnings the person kept, and remembers the reviews were read", () =>
  withTrailHome("review-keep-home-", async () => {
    const repo = reviewedRepo("review-keep-some");
    const all = [flagged("Return a 500 when db.query fails"), flagged("Add a changelog entry"), flagged("Name migrations by date")];
    const { saved, kept, cancelled } = await finishReviewRead(repo, reviewReadWith(all), async (f) => [f[0]!, f[2]!]);
    assert.equal(cancelled, false);
    assert.deepEqual(kept.map((f) => f.title), ["Return a 500 when db.query fails", "Name migrations by date"]);
    assert.deepEqual(saved.map((n) => [n.title, n.scope]), [["Return a 500 when db.query fails", "repo"], ["Name migrations by date", "repo"]]);
    assert.deepEqual(saved[0]!.touches, ["src/api/users.ts"], "touches the file the review was on, so Claude gets it when it opens that file");
    assert.ok(existsSync(join(ensureRepoHome(repo).place.dir, "pr-reviews.json")), "read once per repo");
  }));

test("cancelling the pick saves no review learning, and the next init asks again", () =>
  withTrailHome("review-keep-none-home-", async () => {
    const repo = reviewedRepo("review-keep-cancel");
    const { saved, cancelled } = await finishReviewRead(repo, reviewReadWith([flagged("Add a changelog entry")]), async () => null);
    assert.equal(cancelled, true);
    assert.equal(saved.length, 0);
    assert.equal(existsSync(join(repo, ".trail", "learnings")) && readdirSync(join(repo, ".trail", "learnings")).some((f) => f.endsWith(".md")), false);
    assert.equal(existsSync(join(ensureRepoHome(repo).place.dir, "pr-reviews.json")), false, "not marked read");
  }));

test("a review finding that names no code that exists, or that CLAUDE.md already says, isn't offered", () =>
  withTrailHome("review-anchor-home-", async () => {
    const repo = reviewedRepo("review-anchor");
    writeFileSync(join(repo, "CLAUDE.md"), "# Rules\n\n- Every handler in src/api returns a 500 when the database query fails, and logs the error.\n");
    const out = anchoredReviews(repo, [
      flagged("Comments must match the code", []),
      flagged("Return a 500 when the database query fails in every handler", ["src/api/users.ts"]),
      flagged("Validate the page size in listUsers", ["src/api/gone.ts", "src/api/users.ts"]),
    ]);
    assert.deepEqual(out.map((f) => f.title), ["Validate the page size in listUsers"]);
    assert.deepEqual(out[0]!.touches, ["src/api/users.ts"], "only files that still exist");
    const { result, saved } = await finishReviewRead(repo, reviewReadWith([flagged("Comments must match the code", [])]));
    assert.equal(saved.length, 0);
    assert.equal(result.findings.length, 1);
    assert.ok(existsSync(join(ensureRepoHome(repo).place.dir, "pr-reviews.json")), "still read once: the same reviews would give the same answer");
  }));

test("a finding that never names the code it's on is generic advice, and the files the team edits now come first", () =>
  withTrailHome("review-generic-home-", async () => {
    const repo = reviewedRepo("review-generic");
    writeFileSync(join(repo, "src", "api", "orders.ts"), "export const orders = 1;\n");
    spawnSync("git", ["add", "-A"], { cwd: repo });
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a"], { cwd: repo });
    writeFileSync(join(repo, "src", "api", "orders.ts"), "export const orders = 2;\n");
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "b"], { cwd: repo });
    const generic: ReviewFinding = { title: "Keep comments true to what the code does", body: "## Decided\n- Check a comment's claims against the code.", prs: [41], last: "2026-10-10", quotes: [], paths: ["src/api/users.ts"] };
    const out = anchoredReviews(repo, [flagged("Page size is capped at 100 in listUsers"), generic, flagged("Return 409 only on a stale version in orders", ["src/api/orders.ts"])]);
    assert.deepEqual(out.map((f) => f.title), ["Return 409 only on a stale version in orders", "Page size is capped at 100 in listUsers"], "the generic one is gone; orders.ts was edited twice lately, users.ts once");
    assert.deepEqual(codeWords(["backend/internal/services/agent_hook_targets.go#Service.ValidateAgentHookTargets", "src/index.ts"]), ["agent_hook_targets", "services", "service", "validateagenthooktargets"]);
  }));
