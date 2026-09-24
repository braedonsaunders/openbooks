#!/usr/bin/env node
/**
 * Repo-wide refusal: no weak 36-character UUID-shape checks.
 *
 * A "weak UUID shape" is a regex whose whole claim is "36 characters of hex
 * and dashes" — e.g. `/^[0-9a-f-]{36}$/i`. Thirty-six dashes pass it, as does
 * any ungrouped hex run, so anywhere it guards an id it lets a non-UUID reach
 * a uuid column (Postgres answers with `invalid input syntax for type uuid`)
 * or lets a non-UUID ride an actor/idempotency path that must be attributable.
 * The house rule: the 8-4-4-4-12 hex shape, enforced through exactly one
 * validator per runtime — `engine/src/platform/uuid.ts` (`isUuid`) in the
 * engine, `web/lib/list-params.ts` (`isUuid`) on web — never a local copy.
 *
 * The rule, derived from the shape (no file list, no allowlist):
 *   - scan .ts/.tsx/.js/.mjs sources for an ANCHORED full-string pattern
 *     `^[<hex-and-dashes class>]{36}$` — the claim "this string IS a uuid";
 *   - a match is a violation, wherever it appears: prod code, a mock double
 *     (a double mirroring the weak shape re-admits what prod refuses), or a
 *     stub. Test doubles must mirror the house shape, not the weak one.
 *
 * String literals ARE scanned, not just regex literals: mock doubles carry
 * the pattern as text, and a double mirroring the weak shape re-admits what
 * prod refuses. Only comments are exempt.
 *
 * Deliberately out of scope, and why:
 *   - comments are stripped before scanning: prose naming the old shape
 *     (history notes, this file's own docs) validates nothing;
 *   - schema/migrations/generated/** is skipped: those tests mirror the
 *     immutable published migration bytes, so the mirror must match the
 *     migration, not the house rule;
 *   - `.sql` is not scanned: migration and preflight SQL is an immutable
 *     published contract and cannot import the TypeScript validators;
 *   - handle-shaped patterns (`prefix:<uuid tail>`, query-param extracts)
 *     claim "contains/extracts", not "is a uuid" — a different defect class;
 *   - this file itself is skipped by name: the detector necessarily spells
 *     the fragments it hunts.
 *
 *   node scripts/check-uuid-shapes.mjs
 */
import { execFileSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = basename(fileURLToPath(import.meta.url));
const GLOBS = ["engine", "web", "packages", "scripts", "schema", "e2e", "deploy"]
  .flatMap((root) => ["ts", "tsx", "js", "mjs"].map((ext) => `${root}/**/*.${ext}`));

/** Strip line/block comments while respecting string literals. */
export function stripComments(source) {
  let out = "";
  let i = 0;
  let quote = null;
  let templateDepth = 0;
  const templateStack = [];
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote === "//") {
      // A // comment can only start in normal code or a template ${}
      // expression, so a newline always resumes normal code.
      if (ch === "\n") {
        quote = null;
        out += ch;
      }
      i += 1;
      continue;
    }
    if (quote === "/*") {
      if (ch === "*" && next === "/") {
        quote = null;
        i += 2;
      } else {
        if (ch === "\n") out += ch;
        i += 1;
      }
      continue;
    }
    if (quote === "'" || quote === '"') {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (quote === "`") {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === "`") {
        quote = null;
      } else if (ch === "$" && next === "{") {
        templateStack.push(templateDepth);
        templateDepth = 0;
        quote = null;
        out += next;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    // Normal code (or inside a template ${} expression).
    if (ch === "/" && next === "/") {
      quote = "//";
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      quote = "/*";
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "{") templateDepth += 1;
    if (ch === "}") {
      if (templateDepth > 0) {
        templateDepth -= 1;
      } else if (templateStack.length > 0) {
        templateDepth = templateStack.pop();
        quote = "`";
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * True when a character-class body can only match hex digits and dashes —
 * the weak shape — rather than some wider alphabet (slugs, handles).
 */
export function isWeakUuidClass(body) {
  if (!body || body.length > 48 || body.includes("^")) return false;
  if (!body.includes("-")) return false;
  if (!/0-9|a-f|A-F|\\d/.test(body)) return false;
  const rest = body
    .replace(/0-9/g, "")
    .replace(/a-f/g, "")
    .replace(/A-F/g, "")
    .replace(/\\d/g, "")
    .replace(/\\-/g, "")
    .replace(/-/g, "");
  return rest === "";
}

const ANCHORED_WEAK = /\(?\^\[([^\]\r\n]*)\]\{36\}\$/g;

/** Anchored weak-UUID patterns in one comment-stripped source, by line. */
export function findWeakUuidShapes(source) {
  const hits = [];
  for (const match of source.matchAll(ANCHORED_WEAK)) {
    if (!isWeakUuidClass(match[1])) continue;
    const line = source.slice(0, match.index).split("\n").length;
    hits.push({ line, text: match[0] });
  }
  return hits;
}

/** Git-tracked paths, so local untracked or ignored scratch files never gate CI. */
function trackedFiles(root) {
  try {
    return new Set(execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean));
  } catch {
    return null;
  }
}

export function scanTree(root = ROOT) {
  const tracked = trackedFiles(root);
  const files = [...new Set(GLOBS.flatMap((pattern) => globSync(pattern, { cwd: root })))]
    .filter(
      (file) =>
        (tracked === null || tracked.has(file)) &&
        !file.includes("node_modules") &&
        basename(file) !== SELF &&
        !file.startsWith("schema/migrations/generated/"),
    )
    .sort();
  const violations = [];
  for (const file of files) {
    const hits = findWeakUuidShapes(stripComments(readFileSync(join(root, file), "utf8")));
    for (const hit of hits) violations.push(`${file}:${hit.line}: weak 36-char UUID shape ${hit.text}`);
  }
  return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = scanTree();
  for (const violation of violations) console.error(violation);
  console.log(
    violations.length === 0
      ? "checked uuid shapes; no weak 36-char UUID patterns"
      : `checked uuid shapes; violations=${violations.length}`,
  );
  process.exit(violations.length > 0 ? 1 : 0);
}
