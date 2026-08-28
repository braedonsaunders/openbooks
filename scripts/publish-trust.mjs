#!/usr/bin/env node
/**
 * Publish the trust corpus.
 *
 * Reads the two evidence artifacts produced by CI —
 *   - the standards conformance report (engine/src/conformance/cli.ts report)
 *   - the golden-harness checkpoint (engine/src/harness/cli.ts)
 * — and writes the published surface under docs/trust/:
 *
 *   conformance-matrix.md     the accountant-readable matrix
 *   conformance.json          the machine-readable case results
 *   checkpoint.json           the diffable ledger checkpoint
 *   badge-conformance.json    shields.io endpoint
 *   badge-invariants.json     shields.io endpoint
 *   history.json              one append-only record per published commit
 *
 * Usage:
 *   node scripts/publish-trust.mjs \
 *     --conformance .local/conformance \
 *     --checkpoint engine/harness-checkpoints \
 *     [--out docs/trust] [--sha <git sha>]
 *
 * Missing inputs are tolerated: a run that could only produce one half still
 * publishes that half and records the other as unavailable. What is NOT
 * tolerated is publishing a stale artifact as if it were current — an absent
 * input becomes an explicit "unavailable", never a carried-forward value.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function flag(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const conformanceDir = flag("conformance", ".local/conformance");
const checkpointDir = flag("checkpoint", "engine/harness-checkpoints");
const outDir = flag("out", "docs/trust");
const sha = flag("sha", process.env.GITHUB_SHA ?? null);
const at = new Date().toISOString();

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** The most recently modified checkpoint in the directory. */
function latestCheckpoint(dir) {
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0] ? readJson(join(dir, candidates[0].name)) : null;
}

const conformance = readJson(join(conformanceDir, "conformance.json"));
const matrixMarkdown = existsSync(join(conformanceDir, "conformance-matrix.md"))
  ? readFileSync(join(conformanceDir, "conformance-matrix.md"), "utf8")
  : null;
const checkpoint = latestCheckpoint(checkpointDir);

// Anti-false-green: every ledger invariant passes trivially on an empty company.
// A checkpoint with no posted entries is not evidence of anything and must
// never be published as though it were.
if (checkpoint && !(checkpoint.counts?.postedEntries > 0)) {
  console.error(
    `the checkpoint for "${checkpoint.orgName}" contains no posted journal entries.\n` +
      "Every invariant passes vacuously on an empty ledger. Generate activity first\n" +
      "(npm -w engine run sim -- provision ... && run) and re-run the harness.",
  );
  process.exit(1);
}

// Fail loudly if BOTH inputs are missing — that means the workflow is broken,
// and publishing an all-grey page as if it were a result would be misleading.
// Keep this guard before creating or mutating the output directory so a failed
// publication cannot overwrite the last trustworthy evidence.
if (!conformance && !checkpoint) {
  console.error("no evidence artifacts found — refusing to publish an empty trust page");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

// -- badges -----------------------------------------------------------------
// Gaps are reported in the badge message rather than folded into the colour.
// A published gap is an honest state, not a failure — but it must stay visible.
function conformanceBadge() {
  if (!conformance) {
    return { schemaVersion: 1, label: "conformance", message: "unavailable", color: "lightgrey" };
  }
  const { pass, fail, gap } = conformance.totals;
  return {
    schemaVersion: 1,
    label: "standards conformance",
    message: fail > 0 ? `${fail} failing` : `${pass} passing, ${gap} gaps`,
    color: fail > 0 ? "red" : "brightgreen",
  };
}

function invariantBadge() {
  if (!checkpoint) {
    return { schemaVersion: 1, label: "ledger invariants", message: "unavailable", color: "lightgrey" };
  }
  const failed = (checkpoint.checks ?? []).filter((check) => !check.ok);
  return {
    schemaVersion: 1,
    label: "ledger invariants",
    message: failed.length > 0 ? `${failed.length} failing` : `${(checkpoint.checks ?? []).length} passing`,
    color: failed.length > 0 ? "red" : "brightgreen",
  };
}

writeFileSync(join(outDir, "badge-conformance.json"), `${JSON.stringify(conformanceBadge(), null, 2)}\n`);
writeFileSync(join(outDir, "badge-invariants.json"), `${JSON.stringify(invariantBadge(), null, 2)}\n`);

// -- published artifacts ----------------------------------------------------
if (matrixMarkdown) writeFileSync(join(outDir, "conformance-matrix.md"), matrixMarkdown);
if (conformance) writeFileSync(join(outDir, "conformance.json"), `${JSON.stringify(conformance, null, 2)}\n`);
if (checkpoint) writeFileSync(join(outDir, "checkpoint.json"), `${JSON.stringify(checkpoint, null, 2)}\n`);

// -- append-only history ----------------------------------------------------
// One record per published commit, for charting the trend. Append-only by
// construction: an existing record for the same sha is replaced in place rather
// than duplicated, and nothing else is ever rewritten.
const historyPath = join(outDir, "history.json");
const history = readJson(historyPath) ?? [];

const record = {
  at,
  gitSha: sha,
  conformance: conformance
    ? {
        totals: conformance.totals,
        pass: conformance.pass,
        gaps: conformance.cases.filter((c) => c.status === "gap").map((c) => c.id),
        failures: conformance.cases.filter((c) => c.status === "fail").map((c) => c.id),
      }
    : null,
  invariants: checkpoint
    ? {
        pass: checkpoint.pass,
        orgName: checkpoint.orgName,
        cutoff: checkpoint.cutoff,
        counts: checkpoint.counts,
        trialBalance: checkpoint.trialBalance,
        checks: (checkpoint.checks ?? []).map((check) => ({ name: check.name, ok: check.ok })),
        timings: checkpoint.timings ?? [],
      }
    : null,
};

const existing = history.findIndex((entry) => entry.gitSha && entry.gitSha === sha);
if (existing >= 0) history[existing] = record;
else history.push(record);

writeFileSync(historyPath, `${JSON.stringify(history, null, 2)}\n`);

// -- summary ----------------------------------------------------------------
const lines = [
  `trust corpus published to ${outDir}`,
  conformance
    ? `  conformance: ${conformance.totals.pass} passing, ${conformance.totals.fail} failing, ${conformance.totals.gap} gaps`
    : "  conformance: unavailable",
  checkpoint
    ? `  invariants:  ${(checkpoint.checks ?? []).filter((c) => c.ok).length}/${(checkpoint.checks ?? []).length} passing on ${checkpoint.orgName}`
    : "  invariants:  unavailable",
  `  history:     ${history.length} published commits`,
];
console.log(lines.join("\n"));
