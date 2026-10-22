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
import { recordActivity, records } from "./workspace-sync.js";

/** The file part of a hit's `file:Lx-Ly` pointer. */
function pointerFile(pointer: string): string {
  return pointer.replace(/:L\d+(-L?\d+)?$/, "");
}

/**
 * Queue one search event for `r`, when it showed a learning or saved tokens.
 * Uses are counted from the learnings shown only; `saved_tokens` rides along.
 * Query and files are sent only with a shown learning. Never throws.
 */
export function recordLookup(r: AskResult, repo: string, cloud: Cloud | null = readCloud()): void {
  try {
    // Cheapest checks first: most lookups are on a machine that isn't connected,
    // or in a repo outside the workspace, and must cost nothing here.
    const key = repoPlace(repo).key;
    if (!records(cloud, key)) return;
    const shown = r.notes ?? [];
    const saved = askSavedTokens(r);
    if (!shown.length && saved <= 0) return;
    const me = noteAuthor(repo);
    // A lookup that showed no learning leaves with its savings only: the query
    // and the files it touched are session text, and stay on this machine.
    const used = shown.length > 0;
    recordActivity(
      {
        repo: key,
        kind: "search",
        asker: me,
        session: sessionKey(repo) ?? `${me}-${new Date().toISOString().slice(0, 10)}`,
        query: used ? r.query : "",
        files: used ? [...new Set(r.hits.map((h) => pointerFile(h.pointer)))] : [],
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
