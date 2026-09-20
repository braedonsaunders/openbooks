#!/usr/bin/env node
/**
 * Engine module boundaries.
 *
 * engine/src is a set of bounded modules, one directory each, declared in
 * engine/src/modules.json. This check is what makes the declaration true:
 *
 *   1. No source file may sit at engine/src root; every file lives inside a
 *      declared module directory, and every directory is a declared module.
 *   2. A non-test file may import another module only when its own module
 *      declares that module in `dependsOn`. Tests are composition and may
 *      import any module; they are still forbidden nothing else here.
 *   3. Non-test engine code never imports the web app (`@/…`). The engine is
 *      the layer beneath web; tests are the only place that direction is
 *      tolerated (see engine/tsconfig.json).
 *   4. Every declared edge is used. A declaration nothing relies on is either
 *      stale or a permission granted in advance; both are removed.
 *   5. The module graph's strongly connected sets (cycles) must be exactly the
 *      ones pinned under `cycles`. A new cycle is refused; a cycle that has
 *      been broken must be struck from the list in the same commit, so the
 *      pin can only ever shrink. The pinned cycles are the engine's known
 *      layering debt: the posting kernel orchestrating subledgers that call
 *      back into it. Breaking them is refactoring work, not manifest work.
 *
 * Fails loudly with file:line, the two modules involved, and the remedy.
 *
 *   node scripts/check-engine-boundaries.mjs           # gate
 *   node scripts/check-engine-boundaries.mjs --usage   # print the measured module graph as JSON
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE = "engine/src";
const MANIFEST = `${ENGINE}/modules.json`;
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
// Tests and test-support files (fixtures, the child processes tests spawn) are
// composition: they may reach into any module. Everything else is bounded.
const TEST = /\.(?:integration\.)?test\.[cm]?[jt]sx?$|\.probe\.test\.|\/(?:tests?|__tests__|fixtures?)\/|(?:^|[-/])test-fixtures?\.[cm]?[jt]sx?$|\.child\.[cm]?[jt]sx?$|^engine\/src\/testing\//;
const ROOT_ALLOWED = new Set(["modules.json", "README.md"]);

export function loadManifest(root = ROOT) {
  const manifest = JSON.parse(readFileSync(join(root, MANIFEST), "utf8"));
  if (!manifest.modules || typeof manifest.modules !== "object") throw new Error(`${MANIFEST}: expected a "modules" object`);
  for (const [name, mod] of Object.entries(manifest.modules)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`${MANIFEST}: module name "${name}" must be lowercase kebab-case`);
    if (typeof mod.description !== "string" || !mod.description.trim()) throw new Error(`${MANIFEST}: module "${name}" needs a description`);
    if (!Array.isArray(mod.dependsOn)) throw new Error(`${MANIFEST}: module "${name}" needs a dependsOn array`);
    for (const dep of mod.dependsOn) {
      if (dep === name) throw new Error(`${MANIFEST}: module "${name}" lists itself in dependsOn`);
      if (!manifest.modules[dep]) throw new Error(`${MANIFEST}: module "${name}" depends on undeclared module "${dep}"`);
    }
    const sorted = [...mod.dependsOn].sort();
    if (JSON.stringify(sorted) !== JSON.stringify(mod.dependsOn)) throw new Error(`${MANIFEST}: module "${name}" dependsOn must be sorted (${sorted.join(", ")})`);
  }
  manifest.cycles ??= [];
  return manifest;
}

// Tracked and untracked-but-not-ignored files, so a scratch probe git ignores
// is not the repository's problem while a new file someone forgot to add is.
// Outside a git checkout (the check's own tests) the tree is walked directly.
export function engineFiles(root = ROOT) {
  let listed;
  try {
    listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ENGINE], { cwd: root, maxBuffer: 1 << 27, stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
  } catch {
    listed = [];
    const walk = (dir) => {
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel);
        else listed.push(rel);
      }
    };
    walk(ENGINE);
  }
  return listed.filter((f) => existsSync(join(root, f)) && statSync(join(root, f)).isFile()).sort();
}

export function moduleOf(file) {
  const rel = file.slice(ENGINE.length + 1);
  const slash = rel.indexOf("/");
  return slash === -1 ? null : rel.slice(0, slash);
}

const RESOLVE_EXTS = ["", ".ts", ".tsx", ".mts", ".mjs", ".js", "/index.ts"];
function resolveTarget(fromFile, spec, root) {
  let candidate;
  if (spec.startsWith("@openbooks/engine/src/")) candidate = `${ENGINE}/${spec.slice("@openbooks/engine/src/".length)}`;
  else if (spec.startsWith(".")) candidate = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  else return null;
  candidate = candidate.replace(/[?#].*$/, "");
  for (const ext of RESOLVE_EXTS) {
    const p = candidate + ext;
    if (existsSync(join(root, p)) && statSync(join(root, p)).isFile()) return p;
  }
  return null;
}

// Static imports/re-exports and dynamic `import("…")` with a literal specifier.
// `import type` counts: a type dependency is still a dependency the module
// cannot compile without.
const IMPORT_RE = /(?:^|[^.\w$])(?:import|export)\s*(?:type\s+)?(?:[\w$*{}\s,]*?\s*from\s*)?\(?\s*(['"])([^'"\n]+)\1|(?:^|[^.\w$])import\s*\(\s*(['"])([^'"\n]+)\3\s*\)/gm;

// Comments are not dependencies. Block comments are blanked (newlines kept so
// line numbers survive) and whole-line `//` comments are blanked; a `//` inside
// a string (a URL) is left alone because only lines that START with it go.
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

export function importsOf(file, source) {
  const out = [];
  const code = stripComments(source);
  const lineAt = (index) => code.slice(0, index).split("\n").length;
  for (const m of code.matchAll(IMPORT_RE)) {
    const spec = m[2] ?? m[4];
    if (!spec) continue;
    out.push({ spec, line: lineAt(m.index + m[0].indexOf(spec)) });
  }
  return out;
}

export function analyze(root = ROOT) {
  const manifest = loadManifest(root);
  const declared = new Set(Object.keys(manifest.modules));
  const problems = [];
  const usedEdges = new Map(); // "a->b" -> first file:line
  const files = engineFiles(root);

  for (const file of files) {
    const rel = file.slice(ENGINE.length + 1);
    const mod = moduleOf(file);
    if (mod === null) {
      if (!ROOT_ALLOWED.has(rel)) problems.push(`${file}: files do not live at ${ENGINE} root. Move it into the module it belongs to (engine/src/<module>/) and declare any new cross-module import in ${MANIFEST}.`);
      continue;
    }
    if (!declared.has(mod)) {
      problems.push(`${file}: directory "${mod}" is not a declared module. Add it to ${MANIFEST} with a description and its dependsOn list, or move the file into an existing module.`);
      continue;
    }
    if (!SOURCE.test(file)) continue;
    const isTest = TEST.test(file);
    const source = readFileSync(join(root, file), "utf8");
    for (const { spec, line } of importsOf(file, source)) {
      if (spec.startsWith("@/")) {
        if (!isTest) problems.push(`${file}:${line}: engine code must not import the web app ("${spec}"). Move the shared piece into the engine or a package; only engine TESTS may reach into web.`);
        continue;
      }
      const target = resolveTarget(file, spec, root);
      if (!target || !target.startsWith(`${ENGINE}/`)) continue;
      const targetMod = moduleOf(target);
      if (targetMod === null || targetMod === mod) continue;
      if (isTest) continue;
      const key = `${mod}->${targetMod}`;
      if (!usedEdges.has(key)) usedEdges.set(key, `${file}:${line}`);
      if (!manifest.modules[mod].dependsOn.includes(targetMod)) {
        problems.push(`${file}:${line}: module "${mod}" imports "${spec}" from module "${targetMod}", which it does not declare. Either add "${targetMod}" to modules.${mod}.dependsOn in ${MANIFEST} (and keep the module graph's cycles unchanged), or move the shared piece into a module both already depend on.`);
      }
    }
  }

  for (const [name, mod] of Object.entries(manifest.modules)) {
    for (const dep of mod.dependsOn) {
      if (!usedEdges.has(`${name}->${dep}`)) problems.push(`${MANIFEST}: module "${name}" declares dependsOn "${dep}" but no non-test file in engine/src/${name}/ imports it. Remove the declaration; permissions are not granted in advance.`);
    }
  }
  const empty = [...declared].filter((name) => !files.some((f) => moduleOf(f) === name));
  for (const name of empty) problems.push(`${MANIFEST}: module "${name}" is declared but engine/src/${name}/ holds no files. Remove the declaration or add the module.`);

  // Strongly connected sets over the DECLARED graph (Tarjan).
  const sccs = stronglyConnected(manifest.modules);
  const actualCycles = sccs.filter((c) => c.length > 1).map((c) => [...c].sort());
  const pinned = manifest.cycles.map((c) => [...c].sort());
  const keyOf = (c) => c.join(",");
  const actualKeys = new Set(actualCycles.map(keyOf));
  const pinnedKeys = new Set(pinned.map(keyOf));
  for (const cycle of actualCycles) {
    if (!pinnedKeys.has(keyOf(cycle))) {
      const near = pinned.find((p) => p.some((m) => cycle.includes(m)));
      problems.push(
        `${MANIFEST}: the declared graph contains a cycle through {${cycle.join(", ")}} that is not pinned under "cycles".` +
          (near ? ` The nearest pinned cycle is {${near.join(", ")}}; this change grew it.` : "") +
          ` Cycles only shrink: remove the new edge or break an existing one; do not add to the pin.`,
      );
    }
  }
  for (const cycle of pinned) {
    if (!actualKeys.has(keyOf(cycle))) problems.push(`${MANIFEST}: pinned cycle {${cycle.join(", ")}} no longer exists in the declared graph. Strike it from "cycles" in this commit so the pin keeps shrinking.`);
  }

  const usage = {};
  for (const key of usedEdges.keys()) {
    const [a, b] = key.split("->");
    (usage[a] ??= []).push(b);
  }
  for (const a of Object.keys(usage)) usage[a].sort();
  return { problems, usage, cycles: actualCycles, files: files.length };
}

export function stronglyConnected(modules) {
  const names = Object.keys(modules);
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const out = [];
  const visit = (v) => {
    idx.set(v, index);
    low.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of modules[v].dependsOn) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const component = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      out.push(component);
    }
  };
  for (const v of names) if (!idx.has(v)) visit(v);
  return out;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.argv.includes("--usage")) {
    const { usage, cycles } = analyzeUsageOnly();
    console.log(JSON.stringify({ usage, cycles }, null, 2));
    process.exit(0);
  }
  const { problems, files, cycles } = analyze();
  if (problems.length) {
    console.error(`engine boundaries: ${problems.length} problem(s) across ${files} files\n`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`engine boundaries: ${files} files inside declared modules; ${cycles.length} pinned cycle(s); every declared edge used.`);
}

// --usage tolerates an incomplete manifest so the graph can be measured before
// it is declared: modules are inferred from directories.
function analyzeUsageOnly() {
  const files = engineFiles();
  const dirs = [...new Set(files.map(moduleOf).filter(Boolean))];
  const usedEdges = new Set();
  for (const file of files) {
    const mod = moduleOf(file);
    if (!mod || !SOURCE.test(file) || TEST.test(file)) continue;
    const source = readFileSync(join(ROOT, file), "utf8");
    for (const { spec } of importsOf(file, source)) {
      const target = resolveTarget(file, spec, ROOT);
      if (!target || !target.startsWith(`${ENGINE}/`)) continue;
      const t = moduleOf(target);
      if (t && t !== mod) usedEdges.add(`${mod}->${t}`);
    }
  }
  const modules = Object.fromEntries(dirs.map((d) => [d, { dependsOn: [] }]));
  for (const key of usedEdges) {
    const [a, b] = key.split("->");
    modules[a].dependsOn.push(b);
  }
  for (const d of dirs) modules[d].dependsOn.sort();
  const cycles = stronglyConnected(modules).filter((c) => c.length > 1).map((c) => [...c].sort());
  return { usage: Object.fromEntries(dirs.sort().map((d) => [d, modules[d].dependsOn])), cycles };
}
