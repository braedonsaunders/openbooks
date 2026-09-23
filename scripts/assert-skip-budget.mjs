#!/usr/bin/env node
/**
 * A skipped control is an unrun control.
 *
 * Every DB-backed test in this repository is written `{ skip: !DB }` so it can
 * be authored without a database. That is convenient and it is also how a test
 * reaches main having never once executed: it self-skips, the partition
 * reports green, and nothing distinguishes "passed" from "was not run".
 *
 * The database partition HAS a database, so a DB-gated skip there means the
 * wiring broke. The existing Integration canary proves one known file runs;
 * this proves nothing skipped in the shard that actually matters.
 *
 * The budget is per partition and may only SHRINK. A partition that must skip
 * something records the number and the reason in test-skip-budgets.json, so a
 * skip is a declared, reviewable fact rather than silence.
 *
 * Usage: node scripts/assert-skip-budget.mjs <partition> <spec-log-file>
 */
import { readFileSync } from "node:fs";

const [partition, logPath] = process.argv.slice(2);
if (!partition || !logPath) {
  console.error("usage: assert-skip-budget.mjs <partition> <spec-log-file>");
  process.exit(2);
}

const budgets = JSON.parse(
  readFileSync(new URL("./test-skip-budgets.json", import.meta.url), "utf8"),
);
const entry = budgets[partition];
if (!entry) {
  console.error(
    `FATAL: no skip budget declared for partition "${partition}". ` +
      "Add one to scripts/test-skip-budgets.json with the reason it is not zero.",
  );
  process.exit(1);
}

let log;
try {
  log = readFileSync(logPath, "utf8");
} catch {
  // A missing log is not a pass. The step that should have produced it either
  // never ran or died before writing, and either way this check has no
  // evidence to clear the partition on.
  console.error(`FATAL: ${logPath} is missing — the partition produced no run log to audit.`);
  process.exit(1);
}

// node's spec reporter prints one summary block per run: "ℹ skipped 3".
const counts = [...log.matchAll(/^\s*(?:ℹ|i)?\s*skipped\s+(\d+)\s*$/gim)].map((m) =>
  Number(m[1]),
);
if (counts.length === 0) {
  console.error(
    `FATAL: no skip summary found in ${logPath}. The reporter shape changed, ` +
      "so this gate cannot see skips and must not report success.",
  );
  process.exit(1);
}
const skipped = counts.reduce((a, b) => a + b, 0);

if (skipped > entry.budget) {
  const named = [...log.matchAll(/^.*# SKIP.*$/gim)].map((m) => m[0].trim());
  console.error(
    `FATAL: ${partition} skipped ${skipped} test(s); the declared budget is ${entry.budget}.`,
  );
  console.error(`  budget reason: ${entry.reason}`);
  if (named.length > 0) {
    console.error("  skipped:");
    for (const line of named.slice(0, 40)) console.error(`    ${line}`);
  }
  console.error(
    "  A skip here means the control did not execute. Fix the wiring, or raise " +
      "the budget in scripts/test-skip-budgets.json WITH a reason in the same commit.",
  );
  process.exit(1);
}

console.log(
  `skip budget ok: ${partition} skipped ${skipped} of a permitted ${entry.budget}.`,
);
