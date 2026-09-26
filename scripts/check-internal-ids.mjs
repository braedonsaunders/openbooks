#!/usr/bin/env node
/**
 * Ratchet on internal work-tracking language in product surfaces.
 *
 * Comments, test titles, strings, SQL comments and docs must read as a
 * professional product: finding/ticket ids (I1-refix-23, AC-webui-3, CI4-...,
 * ARCH-MODULE-CYCLE, ...) and fleet work-organization wording (fleet shard
 * numbers, wave-N pack labels, build-fleet freezes, coordinator/integrator
 * pickup and landing language) belong in commit messages and the issue
 * tracker, never in the tree. This check scans the tracked source, test,
 * SQL and docs roots and fails when the violation count exceeds the ceiling
 * recorded in scripts/internal-ids-baseline.json. The ceiling only goes
 * down: it sits at zero, and any new violation fails the build.
 *
 *   node scripts/check-internal-ids.mjs           check
 *   node scripts/check-internal-ids.mjs --lower[=N]  lower the ceiling to
 *     the current total plus N lines of headroom (default 0), never raising
 *     it.
 *
 * Deliberate non-matches (documented, not gaps):
 * - Bare "coordinator" is the product's own posting/payroll coordination
 *   vocabulary and HR job titles (Building Coordinator); only the
 *   work-organization shapes (decides/picks it up, coordinator's-and-shards)
 *   are refused.
 * - Bare "fleet" is construction equipment-fleet domain language (owned
 *   fleet, Fleet & Equipment, including the possessive); only the
 *   work-organization compounds are refused. "by the coordinator" is
 *   likewise indistinguishable from the posting-coordinator component, so
 *   only decides/picks-it-up and coordinator's-and-shards shapes are
 *   refused.
 * - Bare "shard" is the test runner's own partition vocabulary
 *   (--test-shard, shardFiles, matrix.shard); only the workstream shapes
 *   (shard A2, cross-shard, -owned, -labeled migrations) are refused.
 * - "wave" is refused except as the ordinary verb (wave a requirement
 *   through), which the negative lookahead preserves.
 * - HR-NN (HR-12, ...) and AUDIT-CONTROLS ids are durable product
 *   requirements traceability, not work tracking, and are not refused.
 * - SEC-NN collides with secondary-book/section fixture shorthand
 *   (SEC-1), and RLS/DSAR prose is row-level-security / subject-access
 *   product vocabulary; only numbered RLS-/DSAR- findings are refused.
 * - web/ is owned by a sibling sweep and schema/migrations/generated is
 *   digest-pinned with its own transition mechanism, so neither root is
 *   scanned here.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const BASELINE = 'scripts/internal-ids-baseline.json'
const SELF = 'scripts/check-internal-ids.mjs'
const ROOTS = ['engine/', 'schema/src', 'scripts/', 'packages/', 'docs/', 'CHANGELOG.md']

// Finding/ticket id families. Case-sensitive where product vocabulary would
// otherwise collide (CI run, THR_EARN, SEC-1 fixtures).
const ID_PATTERNS = [
  /\bI[1-6]-[a-z]+-[0-9]+\b/,
  /\bAC-[a-z]+-[0-9]+\b/,
  /\bARCH-[A-Z]+\b/,
  /\bCI[0-9]+-[a-z]+\b/,
  /\bRLS-[0-9]+\b/,
  /\bDSAR-[0-9]+\b/,
  /\(C1[34]\)/,
  /\bthr_[a-z0-9]{6,}\b/,
]

// Fleet work-organization wording. Case-insensitive; each shape was removed
// from the tree, so any reappearance is a regression.
const FLEET_PATTERNS = [
  /fleet\s+shard/i,
  /build\s+fleet/i,
  /pack-fleet/i,
  /fleet-propose/i,
  /tax-vendor-sweep/i,
  /fleet-wide/i,
  /fleet\s+test\b/i,
  /fleet\s+worker/i,
  /fleet\s+worktree/i,
  /sibling\s+fleet/i,
  /fleet\s+[a-z]*\d+/i,
  /cross-shard/i,
  /shard\s+[A-Z]+\d*/,
  /migration\s+shard/i,
  /prior-year\s+shard/i,
  /registration\s+shard/i,
  /live\s+shard/i,
  /shard-owned/i,
  /shard's\s+(stated|declared)/i,
  /per-wave/i,
  /own\s+wave/i,
  /its\s+wave/i,
  /\bwave\b(?!(?:\s+\S+){0,6}\s+through)/i,
  /\b(first|second|third|fourth|fifth)[-\s]wave\b/i,
  /\bwave\s*-?\s*\d/i,
  /wave-[a-z0-9]/i,
  /\bthis\s+wave\b/i,
  /\([A-Z]\s+wave\)/i,
  /the\s+coordinator\s+(decides?|picks?)\b/i,
  /coordinator's\s+and\s+shards/i,
  /run\s+by\s+the\s+integrator/i,
  /integrator's\s+(landing|migration)/i,
]

const PATTERNS = [...ID_PATTERNS, ...FLEET_PATTERNS]

export function internalIdViolations(files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0')) {
  const violations = []
  for (const file of files) {
    if (file === SELF || file === BASELINE) continue
    if (!ROOTS.some((root) => file === root || file.startsWith(root))) continue
    if (!existsSync(file)) continue
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, index) => {
      const hit = PATTERNS.find((pattern) => pattern.test(line))
      if (hit) violations.push(`${file}:${index + 1}: ${hit} :: ${line.trim().slice(0, 160)}`)
    })
  }
  return violations
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
const violations = internalIdViolations()
const lower = process.argv.find((arg) => arg === '--lower' || arg.startsWith('--lower='))
if (lower) {
  const target = violations.length + Number(lower.split('=')[1] ?? 0)
  if (target < baseline.ceiling) {
    baseline.ceiling = target
    writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + '\n')
    console.log(`lowered internal-ids ceiling to ${target} (total ${violations.length})`)
  }
} else {
  console.log(`checked internal work-tracking language; total=${violations.length} ceiling=${baseline.ceiling}`)
  if (violations.length > baseline.ceiling) {
    console.error(
      `internal work-tracking language is ${violations.length - baseline.ceiling} violation(s) over its ceiling (${BASELINE}). ` +
        'Rewrite each hit in plain product language (or delete it if the comment only carried the id); the ceiling never rises.',
    )
    for (const violation of violations.slice(0, 50)) console.error(`- ${violation}`)
    if (violations.length > 50) console.error(`- and ${violations.length - 50} more`)
    process.exitCode = 1
  }
}
