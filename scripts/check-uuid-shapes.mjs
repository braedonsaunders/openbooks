#!/usr/bin/env node
/**
 * Repo-wide refusal: no weak 36-character UUID-shape checks, and no
 * RFC-versioned UUID checks on record identifiers.
 *
 * A "weak UUID shape" is a regex whose whole claim is "36 characters of hex
 * and dashes" — e.g. `/^[0-9a-f-]{36}$/i`. Thirty-six dashes pass it, as does
 * any ungrouped hex run, so anywhere it guards an id it lets a non-UUID reach
 * a uuid column (Postgres answers with `invalid input syntax for type uuid`)
 * or lets a non-UUID ride an actor/idempotency path that must be attributable.
 * The opposite defect is a check that is too strict: zod's `.uuid()` /
 * `z.uuid()` (and `z.guid()`, its looser twin whose JSON Schema format no
 * provider honours) or a hand-written RFC 9562 variant/version pattern
 * (`-[1-8]xxx-[89ab]xxx-`). Sandbox and sample organizations derive their ids
 * deterministically from the source id and a seed, so most of their ids carry
 * arbitrary version and variant nibbles; an RFC check refuses every legitimate
 * request in those organizations.
 *
 * The house rule: the 8-4-4-4-12 hex shape, enforced through exactly one
 * validator — `UUID_RE`, `isUuid` and the zod schema `uuidString()`, defined
 * in `packages/forms-core/src/identifiers.ts` and re-exported as the engine
 * contract `engine/src/platform/uuid.ts` (`@openbooks/engine/platform/identifiers`);
 * web also reaches them through `web/lib/list-params.ts` (`isUuid`) and
 * `web/lib/api/json` (`uuidId`, `uuidString`) — never a local copy.
 *
 * The rule, derived from the shape (no file list, no allowlist):
 *   - scan .ts/.tsx/.js/.mjs sources for an ANCHORED full-string pattern
 *     `^[<hex-and-dashes class>]{36}$` — the claim "this string IS a uuid";
 *   - a match is a violation, wherever it appears: prod code, a mock double
 *     (a double mirroring the weak shape re-admits what prod refuses), or a
 *     stub. Test doubles must mirror the house shape, not the weak one;
 *   - likewise any zod `uuid`/`guid`/`uuidv<N>` format call (`.uuid(`,
 *     `z.uuid(`, `z.guid(`) and any RFC variant/version pattern — the
 *     version nibble pinned (`-[1-8]`, `-4`) next to the variant class
 *     (`-[89ab]`). Use `uuidString()` / `isUuid` instead.
 *
 * String literals ARE scanned, not just regex literals: mock doubles carry
 * the pattern as text, and a double mirroring the weak shape re-admits what
 * prod refuses. Only comments are exempt.
 *
 * Deliberately out of scope, and why:
 *   - comments are stripped before scanning: prose naming the old shape
 *     (history notes, this file's own docs) validates nothing;
 *   - `.sql` is not scanned: baseline and migration SQL is an immutable
 *     published contract and cannot import the TypeScript validators;
 *   - handle-shaped patterns (`prefix:<uuid tail>`, query-param extracts)
 *     claim "contains/extracts", not "is a uuid" — a different defect class;
 *   - this file and its test are skipped by name: the detector and its
 *     fixtures necessarily spell the fragments it hunts.
 *
 *   node scripts/check-uuid-shapes.mjs
 */
import { execFileSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = basename(fileURLToPath(import.meta.url));
const SELF_FILES = new Set([SELF, SELF.replace(/\.mjs$/, ".test.mjs")]);
const GLOBS = ["engine", "web", "packages", "scripts", "schema", "e2e", "deploy"].flatMap((root) =>
  ["ts", "tsx", "js", "mjs"].map((ext) => `${root}/**/*.${ext}`),
);

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
/** zod string-format calls that validate RFC 9562 (or zod's guid) UUIDs. */
const ZOD_UUID_FORMAT = /(?<![\w$])(?:z\s*\.\s*|\.\s*)(uuid|guid|uuidv[1-8])\s*\(/g;
/** A pinned version nibble followed by the RFC variant class: `{4}-[1-8]…{3}-[89ab`. */
const RFC_VARIANT = /\{4\}-(?:\[1-[1-8]\]|[1-8])\[[^\]\r\n]{1,16}\]\{3\}-\[(?:89|8-9)[^\]\r\n]*\]/g;

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

/** Validators that refuse valid non-RFC ids, in one comment-stripped source, by line. */
export function findRfcUuidValidators(source) {
  const hits = [];
  for (const match of source.matchAll(ZOD_UUID_FORMAT)) {
    const line = source.slice(0, match.index).split("\n").length;
    hits.push({ line, text: match[0].replace(/\s+/g, ""), kind: "zod" });
  }
  for (const match of source.matchAll(RFC_VARIANT)) {
    const line = source.slice(0, match.index).split("\n").length;
    hits.push({ line, text: match[0], kind: "rfc" });
  }
  return hits.sort((a, b) => a.line - b.line);
}

/** Git-tracked paths, so local untracked or ignored scratch files never gate CI. */
function trackedFiles(root) {
  try {
    return new Set(
      execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
        .split("\0")
        .filter(Boolean),
    );
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
        !SELF_FILES.has(basename(file)),
    )
    .sort();
  const violations = [];
  for (const file of files) {
    const source = stripComments(readFileSync(join(root, file), "utf8"));
    for (const hit of findWeakUuidShapes(source))
      violations.push(`${file}:${hit.line}: weak 36-char UUID shape ${hit.text}`);
    for (const hit of findRfcUuidValidators(source)) {
      violations.push(
        hit.kind === "zod"
          ? `${file}:${hit.line}: zod ${hit.text}) format check is not the house id validator; use uuidString() from @openbooks/engine/platform/identifiers`
          : `${file}:${hit.line}: RFC variant/version UUID pattern ${hit.text}; use UUID_RE / isUuid from @openbooks/engine/platform/identifiers`,
      );
    }
  }
  return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = scanTree();
  for (const violation of violations) console.error(violation);
  console.log(
    violations.length === 0
      ? "checked uuid shapes; no weak 36-char or RFC-versioned UUID validators"
      : `checked uuid shapes; violations=${violations.length}`,
  );
  process.exit(violations.length > 0 ? 1 : 0);
}
