/**
 * One derivation for the standards-conformance badge.
 *
 * The accountant-readable matrix (`conformance-matrix.md`) and the
 * machine-readable corpus (`conformance.json`) are both rendered from one
 * `CorpusReport.totals` by the conformance producer (engine/src/conformance).
 * The shields.io badge (`badge-conformance.json`) is rendered later, by the
 * trust publisher, from the published `conformance.json`. That gap in time
 * and code is where the badge went stale: hand-committed matrix refreshes
 * updated the corpus without re-rendering the badge, and nothing compared
 * them. This module closes that gap:
 *
 * - `buildConformanceBadge` is the single badge derivation. The publisher
 *   and any regeneration use it; the consistency test pins the committed
 *   badge against it.
 * - `parseMatrixCounts` / `parseBadgeCounts` read the two renderings back
 *   so the publisher can refuse a mixed-source bundle and the unit test can
 *   fail when the committed artefacts disagree.
 *
 * Gaps and skips are preserved exactly as the corpus reports them: a
 * published gap is an honest state, never folded into passing, and a
 * nonzero skipped count is named in the message rather than dropped.
 */

export function buildConformanceBadge(totals, sha) {
  const { pass, fail, gap, skipped } = totals;
  const parts = fail > 0 ? [`${fail} failing`] : [`${pass} passing`, `${gap} gaps`];
  if (skipped > 0) parts.push(`${skipped} not run`);
  return {
    schemaVersion: 1,
    label: "standards conformance",
    message: parts.join(", "),
    color: fail > 0 ? "red" : "brightgreen",
    gitSha: sha ?? null,
  };
}

/** Parse a badge message back into counts. Returns null when unparseable. */
export function parseBadgeCounts(message) {
  if (typeof message !== "string") return null;
  const counts = { pass: null, fail: null, gap: null, skipped: null };
  let match = message.match(/^(\d+) failing$/);
  if (match) {
    counts.fail = Number(match[1]);
    return counts;
  }
  match = message.match(/^(\d+) passing, (\d+) gaps?(.*)$/);
  if (!match) return null;
  counts.pass = Number(match[1]);
  counts.gap = Number(match[2]);
  counts.fail = 0;
  counts.skipped = 0;
  const rest = match[3];
  if (rest) {
    const skipped = rest.match(/^, (\d+) not run$/);
    if (!skipped) return null;
    counts.skipped = Number(skipped[1]);
  }
  return counts;
}

/**
 * Parse the `**P passing · F failing · G gaps · S not run**` header line of
 * a conformance matrix. Returns null when the matrix carries no header.
 */
export function parseMatrixCounts(markdown) {
  if (typeof markdown !== "string") return null;
  const match = markdown.match(
    /\*\*(\d+) passing · (\d+) failing · (\d+) gaps? · (\d+) not run\*\*/,
  );
  if (!match) return null;
  return {
    pass: Number(match[1]),
    fail: Number(match[2]),
    gap: Number(match[3]),
    skipped: Number(match[4]),
  };
}

/**
 * True when every count the rendering states matches the corpus totals. A
 * failing badge states only the failure count, so only stated (non-null)
 * fields are compared — an unstated field is not a disagreement.
 */
export function countsAgree(stated, totals) {
  for (const key of ["pass", "fail", "gap", "skipped"]) {
    if (stated[key] !== null && stated[key] !== undefined && stated[key] !== totals[key]) {
      return false;
    }
  }
  return true;
}
