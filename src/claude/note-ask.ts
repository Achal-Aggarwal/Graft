/**
 * Main's end-of-turn learning ask (D182), as the Stop handler (stop.ts) uses
 * it: under trail, a turn that took real digging and left no learning is
 * asked, once a session, to offer one. Its words are main's `trail note`
 * vocabulary, so it lives apart from the skills code and its words rule.
 *
 * The turn is judged from the same incremental read of the transcript that
 * bills it (tally.ts): each line is folded into a small state kept with the
 * read's cursor, so a Stop reads what the transcript gained, never the whole
 * file. {@link turnWantsNote} runs the same fold over a whole transcript.
 */
import { statSync } from 'node:fs';
import { readSession, writeSession } from './state.js';
import { keepsNotes } from '../notes/home.js';
import { NOTE_CALL } from '../notes/session-cost.js';
import { brand } from '../brand.js';
import { readJson } from '../util/state.js';
import type { Memo } from '../trace/cursor.js';
import type { HookOut } from '../skills/types.js';

/** Tool calls in one turn before it counts as digging worth a note. */
export const NOTE_WORTHY_CALLS = 3;

/**
 * Reading that trail's answers stood in for, in one turn, before it counts as
 * digging too. trail answers most questions in one or two calls, so on calls
 * alone an exploratory turn never qualified and its findings were never saved.
 */
export const NOTE_WORTHY_TOKENS = 30_000;

/**
 * What the agent is told when a turn took real digging and left no note: to
 * ask the person, never to save. Main's text said "save one" and "commit the
 * learning too", and a lab saw an agent save and commit a learning nobody
 * asked for; now the save waits for the person's own yes.
 */
export const NOTE_ASK =
  '[trail] This took real digging and the session has saved no learning. Before you finish, ask the person first whether to save one for the next session, ' +
  'naming in one line what it would say. Save nothing now. Only after their own yes in a later message, run ' +
  '`trail note --title "<what it was about>"` with the text on stdin, under ## Decided, ## Tried and ruled out and ## Watch out. ' +
  'A summary, never a transcript, and nothing secret. Never commit the learning file yourself.';

/** The turn so far: its tool calls and the reading trail stood in for, and whether the session ran `trail note`. */
export interface NoteTurn {
  calls: number;
  codeRead: number;
  noted: boolean;
}

/** Where the fold keeps its state in the cursor's memo. */
const KEY = 'noteAsk';

/** The reading a query stood in for, from its `[trail] tokens saved ≈ N` line. A
 * reused learning's own line doesn't count: that digging was done before. */
function codeReadIn(content: unknown): number {
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('\n') : '';
  let total = 0;
  for (const m of text.matchAll(/\[(?:graft|trail)\] tokens saved ≈ ([\d,]+)/g)) total += Number(m[1]!.replace(/,/g, '')) || 0;
  return total;
}

/** One transcript line into the turn: a message the person typed starts a new turn; a tool result does not. */
function foldLine(e: any, t: NoteTurn): void {
  if (t.noted) return;
  const content = e?.message?.content;
  const blocks: any[] = Array.isArray(content) ? content : [];
  if (e?.type === 'user' && (typeof content === 'string' || blocks.some((b) => b?.type === 'text'))) {
    t.calls = 0;
    t.codeRead = 0;
  }
  for (const b of blocks) {
    if (b?.type === 'tool_result') t.codeRead += codeReadIn(b.content);
    if (b?.type !== 'tool_use') continue;
    if (typeof b.input?.command === 'string' && NOTE_CALL.test(b.input.command)) {
      t.noted = true;
      return;
    }
    t.calls++;
  }
}

const wants = (t: NoteTurn) => !t.noted && (t.calls >= NOTE_WORTHY_CALLS || t.codeRead >= NOTE_WORTHY_TOKENS);

function turnIn(memo: Memo | undefined): NoteTurn | null {
  const t = memo?.[KEY] as Partial<NoteTurn> | undefined;
  return t && typeof t === 'object' && typeof t.calls === 'number' && typeof t.codeRead === 'number' ? { calls: t.calls, codeRead: t.codeRead, noted: t.noted === true } : null;
}

/** For `catchUpTranscript`'s `also`: one line folded into the turn kept in the cursor's memo. Never throws. */
export function foldNoteLine(entry: Record<string, unknown>, memo: Memo): void {
  try {
    const t = turnIn(memo) ?? { calls: 0, codeRead: 0, noted: false };
    foldLine(entry, t);
    memo[KEY] = t;
  } catch {
    // One odd line costs that line.
  }
}

/**
 * The turn as the last read of `transcriptPath` left it in the cursor at
 * `cursorPath`, or null when that cursor is not this file's (another file
 * under the same session, or none).
 */
export function noteTurnAt(cursorPath: string, transcriptPath: string): NoteTurn | null {
  try {
    const c = readJson<{ trace?: { memo?: Memo; dev?: unknown; ino?: unknown; offset?: unknown } }>(cursorPath)?.trace;
    const st = statSync(transcriptPath);
    if (!c || c.dev !== st.dev || c.ino !== st.ino || typeof c.offset !== 'number' || c.offset > st.size) return null;
    return turnIn(c.memo);
  } catch {
    return null;
  }
}

/**
 * Whether the turn that just ended deserves a note: since the person's last
 * message it made at least NOTE_WORTHY_CALLS tool calls, or trail's answers in
 * it stood in for at least NOTE_WORTHY_TOKENS of reading; and nothing in the
 * session has run `trail note` yet. Pure, for tests: `text` is the
 * transcript's JSONL.
 */
export function turnWantsNote(text: string): boolean {
  const t: NoteTurn = { calls: 0, codeRead: 0, noted: false };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      foldLine(JSON.parse(line), t);
    } catch {
      continue;
    }
  }
  return wants(t);
}

/**
 * Under trail, a turn that took real digging and left no note is asked once
 * per session to leave one, by blocking the stop with the reason. Never blocks
 * twice in a row: Claude Code sets `stop_hook_active` on the stop that follows
 * a block. The caller writes it only as the Stop's one answer, so the session
 * is marked asked only when it was. Never throws.
 */
export function askForNote(input: { stop_hook_active?: unknown }, dir: string, sessionId: string, turn: NoteTurn | null): HookOut {
  try {
    if (!turn || brand() !== 'trail' || input.stop_hook_active || !keepsNotes(dir)) return {};
    const s = readSession(dir, sessionId);
    if (s.noteAsked || !wants(turn)) return {};
    writeSession(dir, sessionId, { ...s, noteAsked: true });
    return { block: NOTE_ASK };
  } catch {
    // A missed reminder costs one note; a broken Stop hook costs the session.
    return {};
  }
}
