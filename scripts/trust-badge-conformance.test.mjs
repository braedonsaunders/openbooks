import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildConformanceBadge, countsAgree, parseBadgeCounts, parseMatrixCounts } from './trust-badge.mjs'

const repositoryRoot = dirname(dirname(fileURLToPath(new URL('./trust-badge.mjs', import.meta.url))))
const trustDir = join(repositoryRoot, 'docs', 'trust')

function loadArtefacts() {
  const badge = JSON.parse(readFileSync(join(trustDir, 'badge-conformance.json'), 'utf8'))
  const conformance = JSON.parse(readFileSync(join(trustDir, 'conformance.json'), 'utf8'))
  const matrix = readFileSync(join(trustDir, 'conformance-matrix.md'), 'utf8')
  return { badge, conformance, matrix }
}

function totalsLine(totals) {
  return `${totals.pass} passing, ${totals.fail} failing, ${totals.gap} gaps, ${totals.skipped} not run`
}

test('the public badge states the same counts as the published corpus', () => {
  const { badge, conformance } = loadArtefacts()
  const stated = parseBadgeCounts(badge.message)
  assert.ok(
    stated,
    `badge-conformance.json message ${JSON.stringify(badge.message)} is unparseable — ` +
      `regenerate it with scripts/publish-trust.mjs so the badge restates the corpus totals.`,
  )
  assert.ok(
    countsAgree(stated, conformance.totals),
    `badge/matrix drift: badge-conformance.json says ${JSON.stringify(badge.message)} but ` +
      `conformance.json totals are ${totalsLine(conformance.totals)} — regenerate the badge from the ` +
      `same corpus run (scripts/publish-trust.mjs); never hand-edit one artefact.`,
  )
})

test('the matrix header states the same counts as the published corpus', () => {
  const { conformance, matrix } = loadArtefacts()
  const header = parseMatrixCounts(matrix)
  assert.ok(
    header,
    'conformance-matrix.md carries no **P passing · F failing · G gaps · S not run** header — ' +
      're-run the conformance corpus (engine/src/conformance/cli.ts report) so both renderings come from one run.',
  )
  assert.ok(
    countsAgree(header, conformance.totals),
    `badge/matrix drift: conformance-matrix.md says ${header.pass} passing, ${header.fail} failing, ` +
      `${header.gap} gaps, ${header.skipped} not run but conformance.json totals are ${totalsLine(conformance.totals)} — ` +
      're-run the conformance corpus so both inputs come from one run; never hand-edit one artefact.',
  )
})

test('the committed badge is exactly what the shared derivation produces', () => {
  // One derivation, two renderings: the publisher and any regeneration build
  // the badge with buildConformanceBadge. Recomputing here with the REAL
  // builder (not a copy) pins the committed file to that derivation — a
  // hand-typed message with the right numbers but the wrong shape still fails.
  const { badge, conformance } = loadArtefacts()
  assert.deepEqual(badge, buildConformanceBadge(conformance.totals, badge.gitSha ?? null))
})

test('the badge names the corpus run it was derived from', () => {
  const { badge } = loadArtefacts()
  assert.match(
    String(badge.gitSha ?? ''),
    /^[0-9a-f]{40}$/,
    `badge-conformance.json carries no generation commit (gitSha: ${JSON.stringify(badge.gitSha)}) — ` +
      'an unstamped badge cannot be checked against the tree. Regenerate it with ' +
      'scripts/publish-trust.mjs --sha <tested commit> so the stamp names the corpus run.',
  )
})

test('the published totals recount from the published cases', () => {
  // Independent oracle: the totals must be derived from the live corpus rows
  // in the same file, not hand-typed. Gaps and skips count exactly as the
  // corpus reports them — never folded into passing.
  const { conformance } = loadArtefacts()
  const recounted = { pass: 0, fail: 0, gap: 0, skipped: 0 }
  for (const kase of conformance.cases) {
    assert.ok(
      Object.hasOwn(recounted, kase.status),
      `conformance.json case ${JSON.stringify(kase.id)} has status ${JSON.stringify(kase.status)} — ` +
        'every case must report pass, fail, gap, or skipped.',
    )
    recounted[kase.status] += 1
  }
  assert.deepEqual(
    conformance.totals,
    recounted,
    `conformance.json totals (${totalsLine(conformance.totals)}) do not recount from its ` +
      `${conformance.cases.length} cases (${totalsLine(recounted)}) — the totals were not derived ` +
      'from the live corpus. Re-run the conformance corpus instead of editing the totals.',
  )
})
