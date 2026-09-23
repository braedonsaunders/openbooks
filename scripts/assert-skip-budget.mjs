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
 * A skip can also be DECLARED by its exact reason string (the text a test
 * passes to `skip:` or `t.skip()`), with why this partition may skip it. A
 * declared skip does not count against the budget, and an undeclared one does,
 * so a new skip cannot hide behind a count that an old, known one justified.
 * Every skip must be named: if the log's summary counts more skips than the
 * reporter's lines name, the gate cannot say what went unrun and fails.
 *
 * Usage: node scripts/assert-skip-budget.mjs <partition> <spec-log-file>
 */
import { readFileSync } from "node:fs";

/**
 * Audit one partition's run log against its budget entry. Pure: returns
 * { ok, lines } so the rules can be tested without a CI log or process exit.
 */
export function auditSkips(log, entry, partition, logPath = "the log") {
  const out = [];
  const fail = (...lines) => ({ ok: false, lines: [...out, ...lines] });

  // node's spec reporter prints one summary block per run: "ℹ skipped 3".
  const counts = [...log.matchAll(/^\s*(?:ℹ|i)?\s*skipped\s+(\d+)\s*$/gim)].map((m) =>
    Number(m[1]),
  );
  if (counts.length === 0) {
    return fail(
      `FATAL: no skip summary found in ${logPath}. The reporter shape changed, ` +
        "so this gate cannot see skips and must not report success.",
    );
  }
  const skipped = counts.reduce((a, b) => a + b, 0);
  // The reporter prints todo tests with the same "﹣" mark as skips. A todo is
  // also an unrun control, so it is named and budgeted the same way.
  const todos = [...log.matchAll(/^\s*(?:ℹ|i)?\s*todo\s+(\d+)\s*$/gim)].reduce(
    (a, m) => a + Number(m[1]),
    0,
  );

  // The spec reporter names each skipped test: "﹣ <name> (1.2ms) # <reason>".
  // TAP prints "ok 3 - <name> # SKIP <reason>". Either way the reason is the key.
  const named = [
    ...[...log.matchAll(/^\s*﹣ (.+?) \([\d.]+m?s\)(?: # (.*))?$/gm)].map((m) => ({
      name: m[1],
      reason: (m[2] ?? "").trim(),
    })),
    ...[...log.matchAll(/^\s*ok \d+ - (.+?) # SKIP\s*(.*)$/gim)].map((m) => ({
      name: m[1],
      reason: m[2].trim(),
    })),
  ];
  if (named.length !== skipped + todos) {
    return fail(
      `FATAL: ${logPath} counts ${skipped} skip(s) and ${todos} todo(s) but names ${named.length}. ` +
        "This gate cannot say what went unrun, so it must not report success.",
      ...named.map((s) => `    ${s.name} # ${s.reason}`),
    );
  }

  const declared = entry.declared ?? {};
  const undeclared = named.filter((s) => !Object.hasOwn(declared, s.reason));
  if (undeclared.length > entry.budget) {
    return fail(
      `FATAL: ${partition} skipped ${undeclared.length} undeclared test(s); the declared budget is ${entry.budget}.`,
      `  budget reason: ${entry.reason}`,
      "  undeclared skips:",
      ...undeclared.slice(0, 40).map((s) => `    ${s.name} # ${s.reason || "(no reason given)"}`),
      "  A skip here means the control did not execute. Fix the wiring, declare the " +
        "exact reason in scripts/test-skip-budgets.json with why this partition may " +
        "skip it, or raise the budget WITH a reason, in the same commit.",
    );
  }

  for (const s of named) {
    const why = Object.hasOwn(declared, s.reason) ? "declared" : "within budget";
    out.push(`  skipped (${why}): ${s.name} # ${s.reason}`);
  }
  out.push(
    `skip budget ok: ${partition} skipped ${named.length} ` +
      `(${named.length - undeclared.length} declared, ${undeclared.length} undeclared of a permitted ${entry.budget}).`,
  );
  return { ok: true, lines: out };
}

const invoked = process.argv[1] ? process.argv[1].endsWith("assert-skip-budget.mjs") : false;
if (invoked) {
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

  const result = auditSkips(log, entry, partition, logPath);
  for (const line of result.lines) (result.ok ? console.log : console.error)(line);
  process.exit(result.ok ? 0 : 1);
}
