#!/usr/bin/env node
/**
 * Publish the trust corpus.
 *
 * Reads the three evidence artifacts produced by CI —
 *   - the standards conformance report (engine/src/conformance/cli.ts report)
 *   - the internal-controls evidence set (cli.ts controls report)
 *   - the golden-harness checkpoint (engine/src/harness/cli.ts)
 * — and writes the published surface under docs/trust/:
 *
 *   conformance-matrix.md     the accountant-readable standards matrix
 *   conformance.json          the machine-readable standards case results
 *   controls-matrix.md        the accountant-readable controls matrix
 *   controls.json             the machine-readable controls case results
 *                             (kind "internal-controls", never a standard)
 *   checkpoint.json           the diffable ledger checkpoint
 *   badge-conformance.json    shields.io endpoint
 *   badge-invariants.json     shields.io endpoint
 *   history.json              one append-only record per published commit
 *
 * Usage:
 *   node scripts/publish-trust.mjs \
 *     --conformance .local/conformance \
 *     --controls .local/controls \
 *     --checkpoint engine/harness-checkpoints \
 *     [--out docs/trust] [--sha <git sha>]
 *
 * Missing inputs are tolerated: a run that could only produce one part still
 * publishes that part and records the others as unavailable. What is NOT
 * tolerated is publishing a stale artifact as if it were current — an absent
 * input becomes an explicit "unavailable", never a carried-forward value.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function flag(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

/**
 * Same-source comparison for evidence SHAs. Producers may record a full or
 * abbreviated commit hash; either direction of prefix match accepts, anything
 * else rejects. Empty or missing SHAs never match — unpublished provenance
 * fails closed rather than publishing under a borrowed label.
 */
function sameSource(candidate, expected) {
  if (typeof candidate !== "string" || !candidate || typeof expected !== "string" || !expected) {
    return false;
  }
  return candidate === expected || candidate.startsWith(expected) || expected.startsWith(candidate);
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Fail closed on mixed-source or tampered evidence, before the output
 * directory is created or touched. Every present component must name the
 * published commit, and conformance/controls case payloads must match the
 * digest their producer embedded.
 */
function validateProvenance({ conformance, controls, checkpoint, sha }) {
  for (const [label, artifact] of [
    ["conformance.json", conformance],
    ["controls.json", controls],
    ["checkpoint.json", checkpoint],
  ]) {
    if (!artifact) continue;
    if (!sameSource(artifact.gitSha, sha)) {
      console.error(
        `mixed-source evidence: ${label} describes commit ${JSON.stringify(artifact.gitSha)} ` +
          `but this corpus is published for ${JSON.stringify(sha)} — refusing to label one commit's evidence with another's SHA.`,
      );
      process.exit(1);
    }
  }
  for (const [label, artifact] of [
    ["conformance.json", conformance],
    ["controls.json", controls],
  ]) {
    if (!artifact) continue;
    if (!Array.isArray(artifact.cases) || typeof artifact.casesSha256 !== "string") {
      console.error(`${label} carries no case provenance (cases/casesSha256) — refusing to publish unverifiable evidence.`);
      process.exit(1);
    }
    if (sha256Hex(JSON.stringify(artifact.cases)) !== artifact.casesSha256) {
      console.error(`${label} case digest mismatch: the payload no longer matches its embedded digest — refusing to publish tampered evidence.`);
      process.exit(1);
    }
  }
}

const conformanceDir = flag("conformance", ".local/conformance");
const controlsDir = flag("controls", ".local/controls");
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

/** The most recently modified checkpoint file, for the provenance record. */
function latestCheckpointFile(dir) {
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0] ? join(dir, candidates[0].name) : null;
}

function fileDigest(path) {
  try {
    return sha256Hex(readFileSync(path));
  } catch {
    return null;
  }
}

const conformance = readJson(join(conformanceDir, "conformance.json"));
const matrixMarkdown = existsSync(join(conformanceDir, "conformance-matrix.md"))
  ? readFileSync(join(conformanceDir, "conformance-matrix.md"), "utf8")
  : null;
const controls = readJson(join(controlsDir, "controls.json"));
const controlsMarkdown = existsSync(join(controlsDir, "controls-matrix.md"))
  ? readFileSync(join(controlsDir, "controls-matrix.md"), "utf8")
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

// Fail loudly if ALL inputs are missing — that means the workflow is broken,
// and publishing an all-grey page as if it were a result would be misleading.
// Keep this guard before creating or mutating the output directory so a failed
// publication cannot overwrite the last trustworthy evidence.
if (!conformance && !controls && !checkpoint) {
  console.error("no evidence artifacts found — refusing to publish an empty trust page");
  process.exit(1);
}

// Mixed-source or tampered evidence must never reach the bundle, and a
// rejection must not create or touch the output directory either.
validateProvenance({ conformance, controls, checkpoint, sha });

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
// The controls set is published with its distinct kind intact: nothing here
// re-labels a control row as a standards citation.
if (matrixMarkdown) writeFileSync(join(outDir, "conformance-matrix.md"), matrixMarkdown);
if (conformance) writeFileSync(join(outDir, "conformance.json"), `${JSON.stringify(conformance, null, 2)}\n`);
if (controlsMarkdown) writeFileSync(join(outDir, "controls-matrix.md"), controlsMarkdown);
if (controls) writeFileSync(join(outDir, "controls.json"), `${JSON.stringify(controls, null, 2)}\n`);
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
  provenance: {
    runIds: {
      conformance: conformance?.runId ?? null,
      controls: controls?.runId ?? null,
      checkpoint: checkpoint?.runId ?? null,
    },
    digests: {
      conformance: conformance ? fileDigest(join(conformanceDir, "conformance.json")) : null,
      controls: controls ? fileDigest(join(controlsDir, "controls.json")) : null,
      checkpoint: checkpoint ? fileDigest(latestCheckpointFile(checkpointDir)) : null,
    },
  },
  conformance: conformance
    ? {
        totals: conformance.totals,
        pass: conformance.pass,
        gaps: conformance.cases.filter((c) => c.status === "gap").map((c) => c.id),
        failures: conformance.cases.filter((c) => c.status === "fail").map((c) => c.id),
      }
    : null,
  controls: controls
    ? {
        kind: controls.kind ?? "internal-controls",
        totals: controls.totals,
        pass: controls.pass,
        gaps: controls.cases.filter((c) => c.status === "gap").map((c) => c.id),
        failures: controls.cases.filter((c) => c.status === "fail").map((c) => c.id),
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

const existing = history.findIndex((entry) => entry.gitSha === sha);
if (existing >= 0) history[existing] = record;
else history.push(record);

writeFileSync(historyPath, `${JSON.stringify(history, null, 2)}\n`);

// -- summary ----------------------------------------------------------------
const lines = [
  `trust corpus published to ${outDir}`,
  conformance
    ? `  conformance: ${conformance.totals.pass} passing, ${conformance.totals.fail} failing, ${conformance.totals.gap} gaps`
    : "  conformance: unavailable",
  controls
    ? `  controls:    ${controls.totals.pass} passing, ${controls.totals.fail} failing, ${controls.totals.gap} gaps`
    : "  controls:    unavailable",
  checkpoint
    ? `  invariants:  ${(checkpoint.checks ?? []).filter((c) => c.ok).length}/${(checkpoint.checks ?? []).length} passing on ${checkpoint.orgName}`
    : "  invariants:  unavailable",
  `  history:     ${history.length} published commits`,
];
console.log(lines.join("\n"));
