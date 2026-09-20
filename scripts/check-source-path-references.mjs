#!/usr/bin/env node
/**
 * Source files referenced by path for a purpose other than importing them.
 *
 * A test that reads a source file to inspect its text, a harness that names
 * its subject, a script that opens a module to audit it: each holds a path
 * that no typecheck, lint or import rewriter ever resolves. When the file
 * moves, the reference goes stale and the failure is a runtime ENOENT in a
 * partition, or a regex that quietly stops matching. Three independent grep
 * censuses missed the segment-assembled form during the engine module move;
 * this check resolves every such reference against disk on every run.
 *
 * Shapes covered:
 *   1. Segment-assembled paths: join(..., "engine", "src", "crm.ts"), also
 *      across line breaks. The tail after "engine", "src" is resolved under
 *      engine/src/. A tail that names a directory is fine.
 *   2. new URL("../x.ts", import.meta.url) with a relative literal, resolved
 *      against the referencing file's directory.
 *   3. Escaped alias paths inside regex literals: engine\/src\/x\.ts,
 *      resolved after unescaping.
 *
 * Not covered, by construction: a path computed from a variable at runtime,
 * and relative specifiers compared inside a module-resolution hook (those
 * are relative to the PARENT module, not the test; check-test-mock-surface
 * owns them).
 *
 * A reference to a path that intentionally does not exist (a synthetic
 * fixture) is opted out with a `// source-path: synthetic` comment on the
 * same line as the first segment.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCOPE = /^(?:engine\/src|web|packages|schema|scripts|e2e)\//;
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const OPT_OUT = /source-path:\s*synthetic/;

export function trackedSources(root = ROOT) {
  // Tracked plus untracked-but-not-ignored, so a file that is new in the
  // working tree is checked before it is committed, not after.
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, maxBuffer: 1 << 27 })
    .toString("utf8")
    .split("\0")
    .filter((f) => f && SCOPE.test(f) && SOURCE.test(f) && !f.includes("/node_modules/") && existsSync(join(root, f)));
}

const lineAt = (source, index) => source.slice(0, index).split("\n").length;

// Comments are blanked with their line structure kept, so an example path in
// prose is never resolved and line numbers survive.
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/^[ \t]*\/\/.*$/gm, (line) => " ".repeat(line.length));
}

// Only files this repository owns as source or fixtures. Environment files,
// workflow YAML and other operator artefacts are not this check's business.
const CHECKED_TARGET = /\.(?:[cm]?[jt]sx?|json|sql|md)$/;
const lineText = (source, line) => source.split("\n")[line - 1] ?? "";

// 1. join(..., "engine", "src", <segments>) — quoted segments separated by
// commas and any whitespace, so a call broken across lines still matches.

export function segmentReferences(source) {
  // Hand-rolled scanner: find each `"engine"` token, then read following
  // quoted segments separated by commas.
  const out = [];
  const re = /(['"])engine\1/g;
  for (const m of source.matchAll(re)) {
    let pos = m.index + m[0].length;
    const segments = [];
    for (;;) {
      const rest = source.slice(pos);
      const seg = rest.match(/^\s*,\s*(['"])([^'"\n]+)\1/);
      if (!seg) break;
      segments.push(seg[2]);
      pos += seg[0].length;
    }
    if (segments[0] !== "src" || segments.length < 2) continue;
    out.push({ index: m.index, path: posix.join("engine", ...segments) });
  }
  return out;
}

// 2. new URL("../x.ts", import.meta.url)
const NEW_URL_RE = /new URL\(\s*(['"])(\.{1,2}\/[^'"\n]+?)\1\s*,\s*import\.meta\.url/g;

// 3. engine\/src\/…\.ts inside a regex literal
const ESCAPED_RE = /engine\\\/src\\\/((?:[A-Za-z0-9_.-]+\\\/)*[A-Za-z0-9_-]+)\\\.([cm]?[jt]sx?)\b/g;

export function analyze(root = ROOT) {
  const problems = [];
  let checked = 0;
  for (const file of trackedSources(root)) {
    const original = readFileSync(join(root, file), "utf8");
    const source = stripComments(original);
    const report = (index, target, shape) => {
      const line = lineAt(source, index);
      if (OPT_OUT.test(lineText(original, line))) return;
      if (!CHECKED_TARGET.test(target)) return;
      // A reference whose purpose is to prove ABSENCE is not stale.
      if (/existsSync\(\s*$/.test(source.slice(Math.max(0, index - 40), index))) return;
      checked += 1;
      const abs = join(root, target);
      if (existsSync(abs)) return;
      problems.push(`${file}:${line}: ${shape} "${target}" does not exist. The file it names has moved or been deleted; point the reference at its current path (see scripts/engine-modules/moves.json for the engine module move), or mark a deliberately synthetic path with \`// source-path: synthetic\`.`);
    };
    for (const ref of segmentReferences(source)) report(ref.index, ref.path, "segment-assembled path");
    for (const m of source.matchAll(NEW_URL_RE)) {
      const spec = m[2].replace(/[?#].*$/, "");
      if (spec.includes("${")) continue;
      report(m.index, posix.normalize(posix.join(posix.dirname(file), spec)), "new URL() path");
    }
    for (const m of source.matchAll(ESCAPED_RE)) report(m.index, `engine/src/${m[1].replace(/\\\//g, "/")}.${m[2]}`, "escaped regex path");
  }
  return { problems, checked };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { problems, checked } = analyze();
  if (problems.length) {
    console.error(`source path references: ${problems.length} stale of ${checked} checked\n`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`source path references: ${checked} resolved against disk; none stale.`);
}
