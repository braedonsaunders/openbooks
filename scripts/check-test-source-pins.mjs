#!/usr/bin/env node
/**
 * Repo-wide ratchet: tests must exercise behaviour, not pin source text.
 *
 * A "source pin" is a test that reads a repository source file (.ts, .tsx,
 * .mjs, .js, .sql, .yml, .css) as TEXT and asserts on it with a regex,
 * includes or indexOf. For example, `assert.match(routeSource,
 * /guardSubsidiaryScope\(authz, gate\.subsidiary_id\)/)` proves a line
 * exists, not that the route refuses an out-of-scope caller. The 2026-09-23
 * census sampled 40 such tests, and all 40 were change detectors: they break
 * when the code is reformatted or refactored, and they stay green when the
 * behaviour regresses through any path the regex doesn't mention. About 30%
 * were written alongside a bug fix and only re-check the fixed line.
 *
 * The rule, per test FILE:
 *   - count the tests (test/it calls) whose body asserts on a variable bound
 *     to source text, or reads and asserts on source text inline;
 *   - a file NOT in scripts/test-source-pins.allowlist.json must have 0;
 *   - a file IN it may not exceed its recorded count, and an entry whose
 *     count is now too high is stale and must be lowered. The list only
 *     shrinks; it is the burn-down.
 *
 * A file whose text assertions pin an external or published CONTRACT that
 * IS the behaviour (a CI or release workflow's triggers, a published and
 * immutable migration's bytes) declares it in a header comment:
 *     // source-pin-contract: <the contract, in at least 20 characters>
 * That exempts the file. Reviewers judge the declaration; this checker only
 * requires that it be explicit.
 *
 *   node scripts/check-test-source-pins.mjs
 *   node scripts/check-test-source-pins.mjs --write-baseline   (one-time)
 */
import { globSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWLIST_PATH = join(ROOT, "scripts", "test-source-pins.allowlist.json");
const TEST_GLOBS = ["scripts", "deploy", "engine", "packages", "web", "schema", "e2e"]
  .flatMap((root) => ["ts", "tsx", "js", "mjs"].map((ext) => `${root}/**/*.test.${ext}`));
const SOURCE_EXTENSION = /\.(?:tsx?|mjs|js|sql|ya?ml|css)["'`]/;
const FIXTURE_PATH = /fixture|__fixtures__|testdata|golden|snapshots?\//i;
const CONTRACT = /^\s*\/\/\s*source-pin-contract:\s*(.{20,})$/m;

function escapeIdentifier(name) {
  return name.replace(/\$/g, "\\$");
}

/** Variables bound to repository source text at any level of the file. */
export function sourceTextVariables(source) {
  const names = new Set();
  const binding = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:fs\.)?(?:readFileSync|readFile)\(([^;\n]*)/g;
  for (const match of source.matchAll(binding)) {
    if (SOURCE_EXTENSION.test(match[2]) && !FIXTURE_PATH.test(match[2])) names.add(match[1]);
  }
  return names;
}

/** The tests in one file that assert on source text, by name and line. */
export function sourcePinTests(source) {
  if (CONTRACT.test(source)) return [];
  const variables = [...sourceTextVariables(source)];
  const lines = source.split("\n");
  const starts = [];
  lines.forEach((line, index) => {
    const match = /^\s*(?:test|it)\s*\(\s*(["'`])((?:\\.|(?!\1).)*)\1/.exec(line);
    if (match) starts.push({ index, name: match[2] });
  });
  const pins = [];
  starts.forEach((start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1].index : lines.length;
    const body = lines.slice(start.index, end).join("\n");
    const usesVariable = variables.some((name) => {
      const id = escapeIdentifier(name);
      return new RegExp(`assert\\.(?:match|doesNotMatch)\\(\\s*${id}\\b|\\b${id}\\.(?:includes|indexOf|match|search|slice)\\(`).test(body);
    });
    const inline = /readFileSync\([^)]*\.(?:tsx?|mjs|js|sql|ya?ml|css)["'`]/.test(body)
      && /assert\.(?:match|doesNotMatch)|\.includes\(|\.indexOf\(/.test(body);
    if (usesVariable || inline) pins.push({ name: start.name, line: start.index + 1 });
  });
  return pins;
}

export function scanTree(root = ROOT) {
  const files = [...new Set(TEST_GLOBS.flatMap((pattern) => globSync(pattern, { cwd: root })))]
    .filter((file) => !file.includes("node_modules"))
    .sort();
  const counts = {};
  for (const file of files) {
    const pins = sourcePinTests(readFileSync(join(root, file), "utf8"));
    if (pins.length > 0) counts[file] = pins.length;
  }
  return counts;
}

/** Compare today's counts with the allowlist. The list only shrinks. */
export function reconcile(counts, allowlist) {
  const problems = [];
  for (const [file, count] of Object.entries(counts)) {
    const allowed = allowlist[file];
    if (allowed === undefined) {
      problems.push(`${file}: ${count} new source-pin test(s). Test the behaviour instead (see scripts/check-test-source-pins.mjs)`);
    } else if (count > allowed) {
      problems.push(`${file}: ${count} source-pin tests, allowlist permits ${allowed}. Do not add more`);
    }
  }
  for (const [file, allowed] of Object.entries(allowlist)) {
    const count = counts[file] ?? 0;
    if (count < allowed) {
      problems.push(`${file}: allowlist says ${allowed} but only ${count} remain. Lower the entry${count === 0 ? " (delete it)" : ""} so the ratchet holds`);
    }
  }
  return problems;
}

function loadAllowlist() {
  return JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8")).files;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const counts = scanTree();
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if (process.argv.includes("--write-baseline")) {
    writeFileSync(
      ALLOWLIST_PATH,
      `${JSON.stringify({
        $comment: "Burn-down of tests that assert on repository source text (change detectors). Entries may only be lowered or removed. See scripts/check-test-source-pins.mjs.",
        files: counts,
      }, null, 2)}\n`,
    );
    console.log(`wrote baseline: ${Object.keys(counts).length} files, ${total} source-pin tests`);
    process.exit(0);
  }
  const problems = reconcile(counts, loadAllowlist());
  for (const problem of problems) console.error(problem);
  console.log(`checked test source pins; ${total} remaining in ${Object.keys(counts).length} files; violations=${problems.length}`);
  process.exit(problems.length > 0 ? 1 : 0);
}
