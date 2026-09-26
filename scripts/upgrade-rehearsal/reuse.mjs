#!/usr/bin/env node
/**
 * Decide whether an upgrade rehearsal that passed on an earlier commit still
 * covers a release candidate.
 *
 * The rehearsal runs the candidate's installer, engine harness, catalog
 * snapshot and its own scripts against upgraded databases. When every file
 * changed since the rehearsed commit lies outside those inputs, the candidate
 * upgrades exactly as the rehearsed commit did, and rehearsing it again proves
 * nothing new.
 *
 * A changed file leaves the earlier rehearsal valid only when both hold:
 *   - it is documentation, a test file, repository automation under .github
 *     other than the rehearsal's own workflow, or web code; and
 *   - it is not in the import graph of anything the rehearsal runs from the
 *     candidate. The graph is computed here, never listed by hand: the
 *     installer seeds roles from web/lib/permissions.ts, so "web code" alone
 *     would be wrong.
 * Anything else (engine, schema and migrations, package manifests, the
 * rehearsal's own scripts and configuration) needs a fresh rehearsal. So does
 * a whole category when code in that graph names one of its paths as a
 * string, because a file read by path never shows up as an import.
 *
 *   node scripts/upgrade-rehearsal/reuse.mjs <rehearsed-commit> <candidate-commit>
 *
 * Run from a checkout of the candidate. Exits 0 when the earlier rehearsal
 * still covers the candidate, and 1, naming the first file that needs a fresh
 * rehearsal, when it does not or when the decision cannot be made.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const REHEARSAL = "scripts/upgrade-rehearsal";

// The rehearsal workflow and any local action it uses are rehearsal inputs;
// the rest of .github (other workflows, the repository card, templates) is not.
const REHEARSAL_WORKFLOW = ".github/workflows/upgrade-rehearsal.yml";
const rehearsalActions = [...readFileSync(REHEARSAL_WORKFLOW, "utf8").matchAll(/uses:\s*\.\/(\S+)/g)].map((match) => match[1]);

// `namedBy` recognizes a string in code that names a path of the category.
// Test files have none: only the test runner ever loads one.
const CATEGORIES = [
  {
    name: "documentation",
    holds: (file) => file.startsWith("docs/") || file.endsWith(".md"),
    // A bare "name.md" counts only when it is a repository file: the rehearsal
    // also names the markdown reports it writes.
    namedBy: (literal) => /^(\.{1,2}\/)*docs(\/|$)/.test(literal)
      || (/\.md$/.test(literal) && existsSync(literal.replace(/^(\.{1,2}\/)+/, ""))),
  },
  {
    name: "test",
    holds: (file) => /\.test\.[cm]?[jt]sx?$/.test(file),
    namedBy: () => false,
  },
  {
    name: "repository automation",
    holds: (file) => file.startsWith(".github/") && file !== REHEARSAL_WORKFLOW && !rehearsalActions.some((action) => file.startsWith(action)),
    namedBy: (literal) => /^(\.{1,2}\/)*\.github(\/|$)/.test(literal),
  },
  {
    name: "web",
    holds: (file) => file.startsWith("web/"),
    namedBy: (literal) => /^(\.{1,2}\/)*web(\/|$)/.test(literal),
  },
];

function refuse(message) {
  console.log(`fresh rehearsal required: ${message}`);
  process.exit(1);
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/** What the rehearsal runs from the candidate checkout. */
function entryPoints() {
  const runner = readFileSync(join(REHEARSAL, "rehearse.mjs"), "utf8");
  const scripts = [...runner.matchAll(/["'](scripts\/[\w./-]+\.(?:ts|mts|mjs|js))["']/g)].map((match) => match[1]);
  const harness = JSON.parse(readFileSync("engine/package.json", "utf8")).scripts?.harness?.match(/\b(src\/\S+\.ts)\b/)?.[1];
  if (scripts.length === 0 || !harness) {
    refuse("cannot tell what the rehearsal runs from rehearse.mjs and the engine harness script");
  }
  // Seeders are copied into the source release and run against its engine, so
  // they are rehearsal inputs by location, not candidate code to follow. This
  // script belongs to the publish gate, not to the rehearsal.
  const self = relative(process.cwd(), fileURLToPath(import.meta.url));
  const own = readdirSync(REHEARSAL, { recursive: true })
    .map((file) => String(file))
    .filter((file) => /\.[cm]?[jt]s$/.test(file) && !/\.test\./.test(file) && !file.startsWith("seeders"))
    .map((file) => join(REHEARSAL, file))
    .filter((file) => file !== self);
  const entries = [...new Set([...scripts, join("engine", harness), ...own])];
  const missing = entries.filter((file) => !existsSync(file));
  if (missing.length > 0) refuse(`the rehearsal names files that do not exist: ${missing.join(", ")}`);
  return entries;
}

/** Workspace package names: imports of these are followed, every other package is external. */
function workspacePackages() {
  const names = new Set();
  const dirs = ["engine", "schema", "web", ...readdirSync("packages").map((name) => join("packages", name))];
  for (const dir of dirs) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) names.add(JSON.parse(readFileSync(manifest, "utf8")).name);
  }
  return names;
}

async function importGraph(entries) {
  const workspace = workspacePackages();
  let result;
  try {
    result = await build({
      entryPoints: entries,
      bundle: true,
      write: false,
      metafile: true,
      platform: "node",
      format: "esm",
      outdir: "rehearsal-reuse-graph",
      logLevel: "silent",
      plugins: [{
        name: "repository-only",
        setup(builder) {
          builder.onResolve({ filter: /^[^./]/ }, (args) => {
            // web's "@/" alias resolves through web/tsconfig.json.
            if (args.path.startsWith("@/")) return undefined;
            const name = args.path.split("/").slice(0, args.path.startsWith("@") ? 2 : 1).join("/");
            return workspace.has(name) ? undefined : { external: true };
          });
        },
      }],
    });
  } catch (error) {
    refuse(`cannot compute the rehearsal's import graph: ${error.errors?.[0]?.text ?? error.message}`);
  }
  const inputs = result.metafile.inputs;
  const files = new Set(Object.keys(inputs).filter((file) => existsSync(file)));
  const specifiers = new Set(Object.values(inputs).flatMap((input) => input.imports.map((edge) => edge.original).filter(Boolean)));
  return { files, specifiers };
}

/** Categories whose paths code in the graph names as strings (a read by path, invisible to imports). */
function categoriesNamedByPath({ files, specifiers }) {
  const named = new Map();
  for (const file of files) {
    const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
    for (const [, literal] of code.matchAll(/["'`]([^"'`\n]*)["'`]/g)) {
      // A path has no whitespace; a message that mentions one is not a read.
      if (specifiers.has(literal) || /\s/.test(literal)) continue;
      for (const category of CATEGORIES) {
        if (category.namedBy(literal) && !named.has(category.name)) named.set(category.name, `${file} names "${literal}"`);
      }
    }
  }
  return named;
}

const [rehearsed, candidate] = process.argv.slice(2);
if (!rehearsed || !candidate) {
  console.error("usage: node scripts/upgrade-rehearsal/reuse.mjs <rehearsed-commit> <candidate-commit>");
  process.exit(2);
}
if (git("rev-parse", "HEAD") !== git("rev-parse", `${candidate}^{commit}`)) {
  refuse(`the checkout is not the candidate ${candidate}`);
}
try {
  git("merge-base", "--is-ancestor", rehearsed, candidate);
} catch {
  refuse(`${rehearsed} is not an ancestor of ${candidate}`);
}

const changed = git("diff", "--name-only", "--no-renames", rehearsed, candidate).split("\n").filter(Boolean);
const graph = await importGraph(entryPoints());
const namedByPath = categoriesNamedByPath(graph);
for (const file of changed) {
  const category = CATEGORIES.find((candidateCategory) => candidateCategory.holds(file));
  if (!category) refuse(`${file} may change what the rehearsal runs`);
  if (graph.files.has(file)) refuse(`${file} is imported by what the rehearsal runs`);
  if (namedByPath.has(category.name)) refuse(`${file} is ${category.name}, and ${namedByPath.get(category.name)}`);
}
console.log(`the rehearsal of ${rehearsed} covers ${candidate}: ${changed.length} changed file(s), none of them rehearsal inputs (graph of ${graph.files.size} files)`);
