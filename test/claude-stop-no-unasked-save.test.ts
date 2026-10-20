/**
 * fix-lab5, item 6: Stop never leads to a learning saved unasked, with skills on too. The 1b lab saw main's old
 * Stop text ("Before you finish, save one ... commit the learning too") make an agent save and commit a learning
 * nobody asked for. Main's ask is back (D182), worded so the agent asks the person and saves only on their own yes
 * in a later message. This pins it, under trail with skills on: the only save-related thing Stop ever writes is
 * that ask, once a session; when a skill offer is due too, the offer is the one answer and the ask waits for a later
 * Stop. Made-up repo, prompts and commands.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRAND_ENV } from '../src/brand.js';
import { NOTE_ASK } from '../src/claude/hooks.js';
import { ensureRepoHome } from '../src/notes/home.js';
import { agentRuns, at, box, done, finish, release, sayOfferLines, session, startHook, stateOf, stopHook, typedLine, type Box, type Session } from './claude-skills-journey-fixtures.js';

const SAVE_ASK = /save (?:a|one|the) learning|trail note|graft note|took real digging|commit the learning/i;

/** A box on trail whose project keeps learnings, so main's ask can fire there. */
function trailBox(tag: string): Box {
  const b = box(tag);
  ensureRepoHome(b.project, { ...process.env, TRAIL_HOME: b.trail });
  return b;
}

async function withTrail<T>(fn: () => Promise<T>): Promise<T> {
  const before = process.env[BRAND_ENV];
  process.env[BRAND_ENV] = 'trail';
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env[BRAND_ENV];
    else process.env[BRAND_ENV] = before;
  }
}

async function dig(s: Session, day: number, from: number): Promise<void> {
  typedLine(s, at(day, from), 'why does the retry loop hang on the second request');
  for (const [k, c] of ['grep -rn retry src', 'sed -n 1,80p src/client.ts', 'npm test -- client', 'git log --oneline -5 src/client.ts', 'npm test'].entries())
    await agentRuns(s, at(day, from + 1 + k), c, () => ({ out: 'ok' }));
}

test('the ask tells the agent to ask the person first, never to save or commit on its own', () => {
  assert.match(NOTE_ASK, /ask the person first whether to save one/);
  assert.match(NOTE_ASK, /Save nothing now\. Only after their own yes in a later message, run `trail note/);
  assert.match(NOTE_ASK, /Never commit the learning file yourself/);
  assert.doesNotMatch(NOTE_ASK, /Before you finish, save one|commit the learning too|finish as trail's output asks/);
});

test("a long turn of digging with skills on: Stop's only save-related answer is the ask, once a session", () =>
  withTrail(async () => {
    const b = trailBox('stop-no-save');
    try {
      const s = session(b);
      await startHook(s, at(10, 0));
      await dig(s, 10, 1);
      const out = await finish(s, 10, 'The retry hangs because the timer is never cleared; fixed in client.ts.');
      assert.deepEqual(out, { decision: 'block', reason: NOTE_ASK });
      assert.equal(await stopHook(s, at(10, 60), 'Want me to save that as a learning? (yes / no)', true), '', 'nothing on a continued Stop');
      await dig(s, 10, 100);
      assert.equal(await finish(s, 10, 'Fixed the second hang too.', 140), null, 'once a session');
    } finally {
      done(b);
    }
  }));

test('when an offer and the ask are both due, the offer is the one answer and the ask comes at a later Stop', () =>
  withTrail(async () => {
    const b = trailBox('stop-offer-first');
    try {
      let offers = 0;
      for (const day of [3, 5, 7]) {
        const s = session(b);
        await startHook(s, at(day, 0));
        await release(s, day, `1.4.${day}`, { failedFirst: true });
        const out = await finish(s, day, 'Published.');
        const text = JSON.stringify(out);
        if (day < 7) {
          assert.deepEqual(out, { decision: 'block', reason: NOTE_ASK }, `day ${day}: no offer yet, so the ask`);
          continue;
        }
        // Day 7: the release is offered, and the ask, due too, is not written beside it.
        assert.ok(!SAVE_ASK.test(text), text);
        assert.match(text, /\(yes \/ (?:show me \/ )?no\)/, 'the person is asked about the skill');
        offers++;
        // The agent says the offer's 2 lines; that continued Stop says nothing.
        assert.equal(await sayOfferLines(s, day, stateOf(s).pendingOffer!.lines!), null);
        // A later turn of digging in the same session: now the ask is the answer.
        await dig(s, day, 100);
        assert.deepEqual(await finish(s, day, 'The retry hangs because the timer is never cleared.', 140), { decision: 'block', reason: NOTE_ASK });
      }
      assert.equal(offers, 1, 'the third day offers the release once');
    } finally {
      done(b);
    }
  }));
