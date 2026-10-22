/**
 * Every grammar the package depends on accepts the tree-sitter it ships.
 *
 * One that doesn't makes every `npm install -g` print a wall of "ERESOLVE
 * overriding peer dependency" warnings. The repo's own `overrides` hide it here,
 * because npm applies overrides only to the project it is run in, never to the
 * people installing the package. tree-sitter-swift was that grammar (it asks for
 * ^0.22); it is vendored into dist/ now (scripts/vendor-grammars.mjs).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
type Manifest = { version: string; dependencies: Record<string, string>; peerDependencies?: Record<string, string> };
/** A package's package.json, read from disk: some packages' `exports` don't let `require` reach it. */
const manifest = (dir: string): Manifest => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
const pkg = manifest(root);

/** `version` satisfies `range`, for the plain `^x.y.z` ranges grammars use, joined by `||`. */
function satisfies(version: string, range: string): boolean {
  const [maj, min, pat] = version.split(".").map(Number);
  return range.split("||").some((part) => {
    const m = /^\s*\^(\d+)\.(\d+)\.(\d+)\s*$/.exec(part);
    assert.ok(m, `peer range "${part.trim()}" is not a ^x.y.z range; teach this test to read it`);
    const [a, b, c] = m.slice(1).map(Number);
    if (a !== maj) return false;
    if (a > 0) return min! > b! || (min === b && pat! >= c!);
    return min === b && pat! >= c!;
  });
}

test("every dependency's tree-sitter peer accepts the tree-sitter the package ships", () => {
  const shipped = manifest(join(root, "node_modules", "tree-sitter")).version;
  const clashes: string[] = [];
  for (const name of Object.keys(pkg.dependencies)) {
    const want = manifest(join(root, "node_modules", name)).peerDependencies?.["tree-sitter"];
    if (want && !satisfies(shipped, want)) clashes.push(`${name} wants tree-sitter ${want}`);
  }
  assert.deepEqual(clashes, [], `tree-sitter ${shipped} ships`);
});

test("the range check reads carets the way npm does", () => {
  assert.ok(satisfies("0.21.1", "^0.21.0"));
  assert.ok(!satisfies("0.21.1", "^0.22.1"));
  assert.ok(satisfies("0.21.1", "^0.22.1 || ^0.21.1"));
  assert.ok(satisfies("1.4.0", "^1.3.0"));
  assert.ok(!satisfies("2.0.0", "^1.3.0"));
});
