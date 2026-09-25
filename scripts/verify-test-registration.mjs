#!/usr/bin/env node
/**
 * Fail when a selected test file registers no tests.
 *
 * A `*.test.*` file that loads zero tests is a failure, not a pass: the
 * runner reports `tests 0` with a zero exit status both when the file path
 * matches nothing (unescaped `[id]`-style segments are globs) and when the
 * file dies during load before registering anything. The shard exit code
 * cannot see either shape, so this guard scans each shard's own output for
 * the per-file marker (`✔`/`✖` followed by the file path) the spec
 * reporter prints for every file that actually ran, and refuses the list
 * of selected files that never appear.
 *
 *   node scripts/verify-test-registration.mjs <selection.json> <shard-log> [...]
 *
 * Each pair is one shard: the test-selection.json the runner wrote plus
 * the shard's captured output (unit.txt / coverage.txt in CI).
 */
import { readFileSync } from "node:fs";

const FILE_MARKER = /^[✔✖] (\S+\.test\.(?:ts|tsx|mjs|js|cjs)) \(/;

export function filesWithMarkers(logText) {
  const found = new Set();
  for (const line of logText.split("\n")) {
    const match = FILE_MARKER.exec(line);
    if (match) found.add(match[1]);
  }
  return found;
}

export function filesWithoutTests(selectionFiles, logText) {
  const marked = filesWithMarkers(logText);
  return selectionFiles.filter((file) => !marked.has(file));
}

function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv.length % 2 !== 0) {
    console.error(
      "usage: node scripts/verify-test-registration.mjs <selection.json> <shard-log> [...]",
    );
    process.exitCode = 2;
    return;
  }
  let failed = false;
  for (let index = 0; index < argv.length; index += 2) {
    const selectionPath = argv[index];
    const logPath = argv[index + 1];
    const selection = JSON.parse(readFileSync(selectionPath, "utf8"));
    const missing = filesWithoutTests(
      selection.files,
      readFileSync(logPath, "utf8"),
    );
    if (missing.length > 0) {
      failed = true;
      console.error(
        `test registration: ${missing.length} selected file(s) registered no tests in ${logPath}:\n` +
          missing.map((file) => `  ${file}`).join("\n"),
      );
    }
  }
  if (failed) {
    console.error(
      "A file reporting zero tests is a failure, not a pass: " +
        "fix the file's load (unmocked server-only import, bad mock specifier) " +
        "or the runner invocation (unescaped glob segments).",
    );
    process.exitCode = 1;
  } else {
    console.log("test registration: every selected file registered at least one test");
  }
}

main();
