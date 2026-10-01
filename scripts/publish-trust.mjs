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
 *   history.json              one append-only record per publication
 *
 * Usage:
 *   node scripts/publish-trust.mjs \
 *     --conformance .local/conformance \
 *     --controls .local/controls \
 *     --checkpoint engine/harness-checkpoints \
 *     --verification <verification.json> [--out docs/trust] [--sha <full git sha>]
 *
 * All three inputs are required and must name the published commit: a run
 * that could only produce one part must not publish, because conditional
 * writes preserve the missing parts' stale files under a new label. The
 * bundle is built in a staging directory and replaced as a complete set, so a
 * previous bundle is either fully replaced or fully kept — never mixed.
 */

import { validateVerificationReceipt } from "./verification-receipt.mjs";
import { createHash } from "node:crypto";
import {
  existsSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildConformanceBadge, countsAgree, parseMatrixCounts } from "./trust-badge.mjs";

function flag(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

/** Evidence must carry the exact full commit, never an ambiguous prefix. */
function sameSource(candidate, expected) {
  return /^[a-f0-9]{40}$/.test(expected ?? "") && candidate === expected;
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
const checkpointPath = latestCheckpointFile(checkpointDir);
const checkpoint = checkpointPath ? readJson(checkpointPath) : null;

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
const verification = readJson(flag("verification", ".local/verification/verification.json"));
try {
  validateVerificationReceipt(verification, sha);
} catch (error) {
  console.error(`refusing to publish incomplete verification: ${error.message}`);
  process.exit(1);
}
for (const [label, report] of [["conformance", conformance], ["controls", controls]]) {
  const totals = { pass: 0, fail: 0, gap: 0, skipped: 0 };
  const ids = new Set();
  for (const c of report.cases) {
    if (typeof c.id !== "string" || !c.id || ids.has(c.id) || !Object.hasOwn(totals, c.status)) {
      console.error(`${label} evidence has duplicate cases or invalid results; refusing publication`);
      process.exit(1);
    }
    ids.add(c.id);
    totals[c.status]++;
  }
  if (Object.entries(totals).some(([key, count]) => (report.totals?.[key] ?? 0) !== count)) {
    console.error(`${label} totals do not describe the case results; refusing publication`);
    process.exit(1);
  }
  if (label === "controls" && report.kind !== "internal-controls") {
    console.error("controls evidence must identify internal-controls explicitly; refusing publication");
    process.exit(1);
  }
  const ledger = report.cases.filter(c => c.tier === "ledger" && c.support !== "not-implemented");
  if (report.pass !== true || ledger.length === 0 || ledger.some(c => c.status !== "pass") ||
      report.cases.some(c => c.status === "fail" || c.status === "skipped")) {
    console.error(`${label} evidence is failed, empty, or not fully executed; refusing publication`);
    process.exit(1);
  }
}
if (checkpoint.pass !== true || !Array.isArray(checkpoint.checks) || checkpoint.checks.length === 0 ||
    checkpoint.checks.some(check => check.ok !== true)) {
  console.error("checkpoint invariants did not execute successfully; refusing publication");
  process.exit(1);
}

// The badge and the matrix header are two renderings of one derivation
// (scripts/trust-badge.mjs): both must state the corpus totals. A matrix
// refreshed by hand while the badge input comes from an older run — or vice
// versa — is exactly the drift that left the public badge at 42 passing
// while the matrix reported 77 passing with 15 gaps. Refuse it here, before
// the output directory is created or touched, so CI fails instead of
// publishing a badge whose counts differ from the matrix.
if (matrixMarkdown) {
  const header = parseMatrixCounts(matrixMarkdown);
  if (!header || !countsAgree(header, conformance.totals)) {
    console.error(
      `badge/matrix drift: the conformance matrix states ` +
        `${header ? `${header.pass} passing, ${header.fail} failing, ${header.gap} gaps, ${header.skipped} not run` : "unparseable counts"} ` +
        `but conformance.json totals are ${conformance.totals.pass} passing, ${conformance.totals.fail} failing, ` +
        `${conformance.totals.gap} gaps, ${conformance.totals.skipped} not run — refusing to publish a badge ` +
        `whose counts differ from the matrix. Re-run the conformance corpus ` +
        `(engine/src/conformance/cli.ts report) so both inputs come from one run; never hand-edit one artefact.`,
    );
    process.exit(1);
  }
}

// Build the whole bundle in a staging directory next to the destination
// (same filesystem, so the final rename is atomic). Only a complete,
// validated bundle is ever swapped in — a crash mid-write leaves the
// previous bundle untouched, and stale files cannot survive the swap.
const outAbs = resolve(outDir);
const stagedDir = mkdtempSync(join(dirname(outAbs), ".trust-stage-"));
// Narrative documents have independent provenance and are not generated evidence.
if (existsSync(outAbs) && statSync(outAbs).isDirectory()) {
  for (const name of readdirSync(outAbs)) {
    if (name.endsWith(".md") && !["conformance-matrix.md", "controls-matrix.md"].includes(name)) {
      copyFileSync(join(outAbs, name), join(stagedDir, name));
    }
  }
}

// -- badges -----------------------------------------------------------------
// Gaps are reported in the badge message rather than folded into the colour.
// A published gap is an honest state, not a failure — but it must stay visible.
// The badge is the second rendering of the same totals the matrix header
// renders (see scripts/trust-badge.mjs): one derivation, two renderings.
// The gitSha stamp names the corpus run the badge was derived from, so a
// later reader can check the badge against the tree instead of trusting it.
function conformanceBadge() {
  if (!conformance) {
    return { schemaVersion: 1, label: "conformance", message: "unavailable", color: "lightgrey" };
  }
  return buildConformanceBadge(conformance.totals, sha);
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
// One record per publication, including repeat runs of the same source commit.
// Earlier execution evidence is preserved rather than replaced. The previous bundle's
// history carries forward; the swap below keeps the trend intact.
const historyPath = join(outAbs, "history.json");
const history = existsSync(historyPath) ? readJson(historyPath) : [];
if (!Array.isArray(history)) {
  rmSync(stagedDir, { recursive: true, force: true });
  throw new Error("publication history is unreadable; restore the prior history before publishing new evidence");
}

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
      checkpoint: fileDigest(checkpointPath),
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

history.push(record);

writeFileSync(join(stagedDir, "verification.json"), `${JSON.stringify(verification, null, 2)}\n`);
writeFileSync(join(stagedDir, "history.json"), `${JSON.stringify(history, null, 2)}\n`);
const bundle = {
  schemaVersion: 1, gitSha: sha, at,
  components: Object.fromEntries(readdirSync(stagedDir).sort().map(name => [name, fileDigest(join(stagedDir, name))])),
};
writeFileSync(join(stagedDir, "bundle.json"), `${JSON.stringify(bundle, null, 2)}\n`);

// -- atomic swap --------------------------------------------------------------
// The previous bundle (if any) moves aside, the staged bundle takes its
// place, and only then is the backup removed. Readers may observe a brief absence between the directory renames, but
// a visible directory contains one complete bundle —
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
