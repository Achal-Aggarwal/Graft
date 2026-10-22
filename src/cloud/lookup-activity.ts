/**
 * What a code lookup tells the workspace: the learnings it showed (a use) and
 * the tokens the map saved against reading the files whole. Shared by the CLI's
 * `ask` and the MCP `graft_find_code`, so both report the same event.
 */
import { askSavedTokens, type AskResult } from "../ask/ask.js";
import { repoPlace } from "../notes/home.js";
import { noteAuthor } from "../notes/git-facts.js";
import { noteName } from "../notes/notes.js";
import { sessionKey } from "./nudge.js";
import { readCloud, type Cloud } from "./workspace.js";
import { recordActivity } from "./workspace-sync.js";

/** The file part of a hit's `file:Lx-Ly` pointer. */
function pointerFile(pointer: string): string {
  return pointer.replace(/:L\d+(-L?\d+)?$/, "");
}

/**
 * Queue one search event for `r`, when it showed a learning or saved tokens.
 * Uses are counted from the learnings shown only; `saved_tokens` rides along.
 * Never throws.
 */
export function recordLookup(r: AskResult, repo: string, cloud: Cloud | null = readCloud()): void {
  try {
    const shown = r.notes ?? [];
    const saved = askSavedTokens(r);
    if (!shown.length && saved <= 0) return;
    const me = noteAuthor(repo);
    recordActivity(
      {
        repo: repoPlace(repo).key,
        kind: "search",
        asker: me,
        session: sessionKey(repo) ?? `${me}-${new Date().toISOString().slice(0, 10)}`,
        query: r.query,
        files: [...new Set(r.hits.map((h) => pointerFile(h.pointer)))],
        shown_paths: shown.map((h) => noteName(h.note)),
        shown_authors: shown.map((h) => h.note.author),
        ...(saved > 0 ? { saved_tokens: saved } : {}),
        at: new Date().toISOString(),
      },
      cloud,
    );
  } catch {
    /* a lost event undercounts by one */
  }
}
