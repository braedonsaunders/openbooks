#!/usr/bin/env node
/**
 * Rewrite every reference to a relocated engine file.
 *
 * The engine's flat namespace (204 files at engine/src root) was folded into
 * bounded module directories; scripts/engine-modules/moves.json records every
 * old path and the path it moved to. This script brings any tree — the primary
 * checkout the day of the move, or a worktree branch rebased onto it later —
 * across mechanically:
 *
 *   1. Text pass. Every tracked text file: `engine/src/<old>` becomes
 *      `engine/src/<new>` (with or without the `@openbooks/` alias prefix, in
 *      imports, mock wiring maps, docs, workflows, timing and mutation JSON).
 *      Old keys carry their extension, so `posting.ts` never matches
 *      `posting.test.ts` or `posting-effects.ts`.
 *   2. Relative pass. Every file under engine/src: each quoted `./x` or `../x`
 *      string is resolved against the directory the file lived in BEFORE the
 *      move (a patch written against the old layout still says `./payroll-run.ts`
 *      from what is now engine/src/payroll/readiness.ts), mapped through
 *      moves.json, and re-expressed relative to where the file lives now.
 *      Strings that resolve nowhere are left alone and listed, never guessed.
 *
 * Idempotent: a tree that is already fully rewritten is left byte-identical.
 *
 *   node scripts/engine-modules/rewrite-imports.mjs           # rewrite in place
 *   node scripts/engine-modules/rewrite-imports.mjs --check   # report, exit 1 if anything would change
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENGINE = "engine/src";
const CHECK = process.argv.includes("--check");

const moves = JSON.parse(readFileSync(join(ROOT, "scripts/engine-modules/moves.json"), "utf8"));
const reverse = new Map(Object.entries(moves).map(([from, to]) => [to, from]));

const TEXT_EXT = /\.(?:[cm]?[jt]sx?|json|md|ya?ml|sql|sh|txt|css|html|svg|toml|env|example)$/i;
// Published migrations (the .sql files) are historical artefacts: every deployed
// database has recorded their digests, so their bytes never change, comments
// included. A path inside one describes where the code stood when it was
// published. A test that merely lives beside them is ordinary code. The
// changelog's released entries are history for the same reason.
const SKIP = /^(?:node_modules\/|.*\/node_modules\/|package-lock\.json$|vendor\/|tmp\/|\.local\/|web\/\.next|.*\.tsbuildinfo$|scripts\/engine-modules\/moves\.json$|schema\/migrations\/.*\.sql$|CHANGELOG\.md$)/;

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, maxBuffer: 1 << 28 });
  return out
    .toString("utf8")
    .split("\0")
    .filter((f) => f && !SKIP.test(f) && (TEXT_EXT.test(f) || /^Dockerfile/.test(posix.basename(f))))
    .filter((f) => existsSync(join(ROOT, f)) && statSync(join(ROOT, f)).isFile());
}

// --- 1. text pass -----------------------------------------------------------
// Longest keys first so `engine/src/a-b.ts` is tried before any shorter key that
// happens to be a prefix; the extension already prevents genuine overlap.
const textKeys = Object.keys(moves)
  .map((from) => [from.slice(ENGINE.length + 1), terminal(from).slice(ENGINE.length + 1)])
  .sort((a, b) => b[0].length - a[0].length);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const textPattern = new RegExp(
  `engine/src/(${textKeys.map(([from]) => escapeRe(from)).join("|")})(?![A-Za-z0-9_-])`,
  "g",
);
const textMap = new Map(textKeys);

// Extensionless spellings (a web test importing an engine module without its
// `.ts`, or a `?query` suffixed specifier) never match an extension-carrying key, so they get
// their own pass: the same keys minus extension, accepted only when the next
// character cannot continue a path (a quote, a query, whitespace, a bracket).
const stemOf = (rel) => rel.replace(/\.(?:[cm]?[jt]sx?)$/, "");
const stemKeys = textKeys
  .filter(([from]) => /\.(?:[cm]?[jt]sx?)$/.test(from))
  .map(([from, to]) => [stemOf(from), stemOf(to)])
  .sort((a, b) => b[0].length - a[0].length);
const stemPattern = new RegExp(`engine/src/(${stemKeys.map(([from]) => escapeRe(from)).join("|")})(?=['"\\x60?#\\s)\\],;]|$)`, "gm");
const stemMap = new Map(stemKeys);

function rewriteText(source) {
  return source
    .replace(textPattern, (_m, key) => `engine/src/${textMap.get(key)}`)
    .replace(stemPattern, (_m, key) => `engine/src/${stemMap.get(key)}`);
}

// --- 2. relative pass -------------------------------------------------------
const RESOLVE_EXTS = ["", ".ts", ".tsx", ".mts", ".mjs", ".js", "/index.ts"];
// A file relocated more than once is recorded under each path it has held;
// follow the chain to where it lives now.
function terminal(path) {
  const seen = new Set();
  while (moves[path] && !seen.has(path)) {
    seen.add(path);
    path = moves[path];
  }
  return path;
}

function probe(candidate) {
  for (const ext of RESOLVE_EXTS) {
    const p = candidate + ext;
    if (moves[p]) return { path: terminal(p), viaMove: true, ext };
  }
  for (const ext of RESOLVE_EXTS) {
    const p = candidate + ext;
    if (existsSync(join(ROOT, p)) && statSync(join(ROOT, p)).isFile()) return { path: p, viaMove: false, ext };
  }
  return null;
}

function relSpec(fromDir, target, hadExt) {
  let spec = posix.relative(fromDir, target);
  if (!spec.startsWith(".")) spec = `./${spec}`;
  if (!hadExt) spec = spec.replace(/(?:\/index)?\.(?:[cm]?[jt]sx?)$/, "");
  return spec;
}

const RELATIVE_STRING = /(['"`])(\.{1,2}\/[^'"`\n\s]+)\1/g;
// Same shape as the source with every comment blanked, so a match's offset
// tells whether it sits in code or in prose. Prose is rewritten when it
// resolves and ignored when it does not; only code is worth a warning.
function commentMask(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/^([ \t]*)\/\/.*$/gm, (line) => " ".repeat(line.length));
}
function rewriteRelative(file, source, unresolved) {
  const currentDir = posix.dirname(file);
  const oldDir = posix.dirname(reverse.get(file) ?? file);
  const mask = commentMask(source);
  return source.replace(RELATIVE_STRING, (whole, quote, spec, offset) => {
    const inComment = mask.slice(offset, offset + whole.length).trim() === "";
    if (spec.includes("${") || spec.includes("{")) return whole; // a template, not a path
    const clean = spec.replace(/[?#].*$/, "");
    const hadExt = /\.(?:[cm]?[jt]sx?)$/.test(clean);
    // Root-relative strings (`./engine/src/x.ts` handed to a child process or a
    // mock map) were already rewritten by the text pass; leave them be.
    if (probe(posix.normalize(clean))) return whole;
    const fromOld = probe(posix.normalize(posix.join(oldDir, clean)));
    let target = null;
    if (fromOld) target = fromOld.path;
    else {
      const fromCurrent = probe(posix.normalize(posix.join(currentDir, clean)));
      if (fromCurrent && !fromCurrent.viaMove) return whole; // already correct where it stands
      if (fromCurrent) target = fromCurrent.path; // written against a layout that has since moved again
      else {
        if (!inComment) unresolved.push(`${file}: ${spec}`);
        return whole;
      }
    }
    const next = relSpec(currentDir, target, hadExt) + spec.slice(clean.length);
    return next === spec ? whole : `${quote}${next}${quote}`;
  });
}

// --- run --------------------------------------------------------------------
const changed = [];
const unresolved = [];
for (const file of trackedFiles()) {
  const abs = join(ROOT, file);
  const before = readFileSync(abs, "utf8");
  let after = rewriteText(before);
  if (file.startsWith(`${ENGINE}/`) && /\.(?:[cm]?[jt]sx?)$/.test(file)) after = rewriteRelative(file, after, unresolved);
  if (after !== before) {
    changed.push(file);
    if (!CHECK) writeFileSync(abs, after);
  }
}

const isEnginePathLike = (line) => /\.(?:[cm]?[jt]sx?)$/.test(line.split(": ").pop() ?? "");
const suspicious = unresolved.filter(isEnginePathLike);
console.log(`${CHECK ? "would rewrite" : "rewrote"} ${changed.length} file(s)`);
if (suspicious.length) {
  // Informational: a string in code that looks like a path but resolves on
  // neither layout. Usually a specifier compared inside a mock resolver or a
  // path assembled at runtime; the typecheck is the arbiter for real breakage.
  console.log(`\n${suspicious.length} relative string(s) in code resolve on neither layout; verify by hand if they are imports:`);
  for (const line of suspicious) console.log(`  ${line}`);
}
if (CHECK && changed.length) {
  for (const file of changed) console.log(`  ${file}`);
  process.exit(1);
}
