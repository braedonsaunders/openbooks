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
 * All three inputs are required and must name the published commit: a run
 * that could only produce one part must not publish, because conditional
 * writes preserve the missing parts' stale files under a new label. The
 * bundle is built in a staging directory and swapped in atomically, so a
 * previous bundle is either fully replaced or fully kept — never mixed.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

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

// A partial bundle is worse than none: conditional writes preserve the
// missing components' stale files while history claims the new SHA. Every
// component must be present and same-SHA — the publisher fails closed.
const missing = [
  !conformance && "conformance",
  !controls && "controls",
  !checkpoint && "checkpoint",
].filter(Boolean);
if (missing.length > 0) {
  console.error(
    `refusing to publish a partial trust bundle (missing: ${missing.join(", ")}). ` +
      "Every component must be present and same-SHA before the swap.",
  );
  process.exit(1);
}

// Mixed-source or tampered evidence must never reach the bundle, and a
// rejection must not create or touch the output directory either.
validateProvenance({ conformance, controls, checkpoint, sha });

// Build the whole bundle in a staging directory next to the destination
// (same filesystem, so the final rename is atomic). Only a complete,
// validated bundle is ever swapped in — a crash mid-write leaves the
// previous bundle untouched, and stale files cannot survive the swap.
const outAbs = resolve(outDir);
const stagedDir = mkdtempSync(join(dirname(outAbs), ".trust-stage-"));

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

writeFileSync(join(stagedDir, "badge-conformance.json"), `${JSON.stringify(conformanceBadge(), null, 2)}\n`);
writeFileSync(join(stagedDir, "badge-invariants.json"), `${JSON.stringify(invariantBadge(), null, 2)}\n`);

// -- published artifacts ----------------------------------------------------
// The controls set is published with its distinct kind intact: nothing here
// re-labels a control row as a standards citation. All three components are
// guaranteed present by the gate above; only the companion matrices are
// optional files.
if (matrixMarkdown) writeFileSync(join(stagedDir, "conformance-matrix.md"), matrixMarkdown);
writeFileSync(join(stagedDir, "conformance.json"), `${JSON.stringify(conformance, null, 2)}\n`);
if (controlsMarkdown) writeFileSync(join(stagedDir, "controls-matrix.md"), controlsMarkdown);
writeFileSync(join(stagedDir, "controls.json"), `${JSON.stringify(controls, null, 2)}\n`);
writeFileSync(join(stagedDir, "checkpoint.json"), `${JSON.stringify(checkpoint, null, 2)}\n`);

// -- append-only history ----------------------------------------------------
// One record per published commit, for charting the trend. Append-only by
// construction: an existing record for the same sha is replaced in place rather
// than duplicated, and nothing else is ever rewritten. The previous bundle's
// history carries forward; the swap below keeps the trend intact.
const historyPath = join(outAbs, "history.json");
const history = readJson(historyPath) ?? [];

const record = {
  at,
  gitSha: sha,
  provenance: {
    runIds: {
      conformance: conformance.runId ?? null,
      controls: controls.runId ?? null,
      checkpoint: checkpoint.runId ?? null,
    },
    digests: {
      conformance: fileDigest(join(conformanceDir, "conformance.json")),
      controls: fileDigest(join(controlsDir, "controls.json")),
      checkpoint: fileDigest(latestCheckpointFile(checkpointDir)),
    },
  },
  conformance: {
    totals: conformance.totals,
    pass: conformance.pass,
    gaps: conformance.cases.filter((c) => c.status === "gap").map((c) => c.id),
    failures: conformance.cases.filter((c) => c.status === "fail").map((c) => c.id),
  },
  controls: {
    kind: controls.kind ?? "internal-controls",
    totals: controls.totals,
    pass: controls.pass,
    gaps: controls.cases.filter((c) => c.status === "gap").map((c) => c.id),
    failures: controls.cases.filter((c) => c.status === "fail").map((c) => c.id),
  },
  invariants: {
    pass: checkpoint.pass,
    orgName: checkpoint.orgName,
    cutoff: checkpoint.cutoff,
    counts: checkpoint.counts,
    trialBalance: checkpoint.trialBalance,
    checks: (checkpoint.checks ?? []).map((check) => ({ name: check.name, ok: check.ok })),
    timings: checkpoint.timings ?? [],
  },
};

const existing = history.findIndex((entry) => entry.gitSha === sha);
if (existing >= 0) history[existing] = record;
else history.push(record);

writeFileSync(join(stagedDir, "history.json"), `${JSON.stringify(history, null, 2)}\n`);

// -- atomic swap --------------------------------------------------------------
// The previous bundle (if any) moves aside, the staged bundle takes its
// place, and only then is the backup removed. Readers of docs/trust either
// see the complete previous bundle or the complete new one — never a mix —
// and no stale file can survive, because the new directory contains exactly
// this run's bundle.
if (existsSync(outAbs) && !statSync(outAbs).isDirectory()) {
  console.error(`refusing to publish over non-directory ${outAbs}`);
  process.exit(1);
}
const backupDir = `${outAbs}.prev-${process.pid}`;
rmSync(backupDir, { recursive: true, force: true });
if (existsSync(outAbs)) renameSync(outAbs, backupDir);
try {
  renameSync(stagedDir, outAbs);
} catch (error) {
  if (existsSync(backupDir)) renameSync(backupDir, outAbs);
  rmSync(stagedDir, { recursive: true, force: true });
  throw error;
}
rmSync(backupDir, { recursive: true, force: true });

// -- summary ----------------------------------------------------------------
const lines = [
  `trust corpus published to ${outDir}`,
  `  conformance: ${conformance.totals.pass} passing, ${conformance.totals.fail} failing, ${conformance.totals.gap} gaps`,
  `  controls:    ${controls.totals.pass} passing, ${controls.totals.fail} failing, ${controls.totals.gap} gaps`,
  `  invariants:  ${(checkpoint.checks ?? []).filter((c) => c.ok).length}/${(checkpoint.checks ?? []).length} passing on ${checkpoint.orgName}`,
  `  history:     ${history.length} published commits`,
];
console.log(lines.join("\n"));
