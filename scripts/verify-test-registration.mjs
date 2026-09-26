#!/usr/bin/env node
/**
 * Fail when a selected test file registers no tests.
 *
 * A `*.test.*` file that loads zero tests is a failure, not a pass: the
 * runner reports `tests 0` with a zero exit status both when the file path
 * matches nothing (unescaped `[id]`-style segments are globs) and when the
 * file dies during load before registering anything. The shard exit code
 * cannot see either shape, so every shard writes a registration receipt —
 * one line per test file carrying its path and test count, emitted by the
 * reporter in scripts/test-hooks.mjs — and this guard refuses the selected
 * files with no receipt line. Reporter text cannot serve here: neither the
 * spec nor the TAP reporter names the files that passed (spec prints a file
 * path only for a file that fails to load), so a marker scan of shard output
 * reports every healthy file missing.
 *
 *   node scripts/verify-test-registration.mjs <selection.json> <receipt> [...]
 *
 * Each pair is one shard: the test-selection.json the runner wrote plus the
 * registration receipt its reporter wrote for that shard's run.
 */
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

export function filesWithTests(receiptText) {
  const found = new Set();
  for (const line of receiptText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof record?.file !== "string" || record.file.length === 0) continue;
    if (!Number.isInteger(record?.tests) || record.tests < 1) continue;
    const absolute = resolve(ROOT, record.file);
    const againstRoot = relative(ROOT, absolute);
    // An entry that does not resolve under the repository cannot name a
    // selected file; leaving it unmatched fails closed on ambiguity.
    if (againstRoot === "" || againstRoot.startsWith("..")) continue;
    found.add(againstRoot);
  }
  return found;
}

export function filesWithoutTests(selectionFiles, receiptText) {
  const reported = filesWithTests(receiptText);
  return selectionFiles.filter((file) => !reported.has(file));
}

function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv.length % 2 !== 0) {
    console.error(
      "usage: node scripts/verify-test-registration.mjs <selection.json> <receipt> [...]",
    );
    process.exitCode = 2;
    return;
  }
  let failed = false;
  for (let index = 0; index < argv.length; index += 2) {
    const selectionPath = argv[index];
    const receiptPath = argv[index + 1];
    const selection = JSON.parse(readFileSync(selectionPath, "utf8"));
    const missing = filesWithoutTests(
      selection.files,
      readFileSync(receiptPath, "utf8"),
    );
    if (missing.length > 0) {
      failed = true;
      console.error(
        `test registration: ${missing.length} selected file(s) registered no tests in ${receiptPath}:\n` +
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

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main();
}
