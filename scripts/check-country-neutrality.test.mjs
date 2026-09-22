import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  auditCountryNeutrality,
  isPackPath,
  isScopedPath,
  isTaxLayerPath,
  isCountryLiteralLayerPath,
  staleCountryLiteralExemptions,
  PAYROLL_SHARED_COUNTRY_LITERAL_EXEMPTIONS,
} from './check-country-neutrality.mjs'

/**
 * The country-neutrality gate decides which files may branch on a pack form
 * code or (in the tax layer) a country literal, so a wrong decision there is
 * silent either way: too strict and it blocks the release train on pack
 * declarations and fixtures, too loose and the next hardcoded jurisdiction
 * lands in the generic layer with no automated walk failing — the exact gap
 * F-w4-001 names.
 *
 * These tests pin both edges: packs, conformance cases, and fixtures stay
 * inside scope, while generic branches still fail the audit.
 */

test('pack declarations and conformance cases keep their scope', () => {
  assert.equal(isPackPath('engine/src/country-tax-packs/ca-returns.ts'), true)
  assert.equal(isPackPath('engine/src/country-tax-packs/types.ts'), true)
  assert.equal(isPackPath('engine/src/conformance/cases/sales-tax.ts'), true)
})

test('the pack scope is anchored, so generic code cannot borrow a pack path', () => {
  assert.equal(isPackPath('engine/src/country-tax-packs-explainer.ts'), false)
  assert.equal(isPackPath('web/app/(app)/tax/pack-notes.ts'), false)
  assert.equal(isPackPath('engine/src/conformance-notes.ts'), false)
})

test('the tax layer scope covers the filing UI, its APIs, and provisioning', () => {
  assert.equal(isTaxLayerPath('web/app/(app)/tax/TaxFilingsView.tsx'), true)
  assert.equal(isTaxLayerPath('web/app/api/tax/returns/route.ts'), true)
  assert.equal(isTaxLayerPath('engine/src/tax/seed-tax-forms.ts'), true)
  assert.equal(isTaxLayerPath('engine/src/tax-returns/return.ts'), true)
  assert.equal(isTaxLayerPath('engine/src/tax/pack-provisioning.ts'), true)
})

test('the tax layer scope excludes payroll packs, but includes the shared payroll layer', () => {
  // A payroll PACK names its own country: every direct subdirectory of
  // engine/src/payroll/ is a pack and stays out of Rule 2.
  assert.equal(isCountryLiteralLayerPath('engine/src/payroll/canada/filings.ts'), false)
  assert.equal(isCountryLiteralLayerPath('engine/src/payroll/canada/quebec/tp1015.ts'), false)
  assert.equal(isCountryLiteralLayerPath('engine/src/payroll/us/pub15t.ts'), false)
  // The SHARED payroll layer — a file directly under engine/src/payroll/, and
  // the payroll API routes — is in scope.
  assert.equal(isCountryLiteralLayerPath('engine/src/payroll/run-calculation.ts'), true)
  assert.equal(isCountryLiteralLayerPath('web/app/api/payroll/subsidiary-scope.ts'), true)
  // The tax layer is unchanged.
  assert.equal(isCountryLiteralLayerPath('web/app/(app)/tax/TaxFilingsView.tsx'), true)
  // isTaxLayerPath stays tax-only (the payroll scope is a separate predicate).
  assert.equal(isTaxLayerPath('engine/src/payroll/run-calculation.ts'), false)
})

test('a country literal in the shared payroll layer is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'country-neutrality-audit-'))
  try {
    const branched = join(dir, 'run-calculation.ts')
    writeFileSync(branched, `if (province === 'QC') return null\n`)
    // The real payroll shared path is in scope; a synthetic file stands in for
    // it via the layer override, proving the audit refuses what the predicate
    // admits.
    assert.deepEqual(
      auditCountryNeutrality([branched], { roots: [dir], taxLayer: [/run-calculation/] }),
      [`${branched}:1: country branch in the generic country-branching layer (=== 'QC')`],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the shared-payroll exemption list is empty — every F-f7 site is fixed', () => {
  // All six are gone: rl1/rl1xml/t4xml/roexml moved into the CA pack, and
  // remittance.ts, yearend.ts and the year-end file route read pack
  // declarations instead of comparing against a country. An entry reappearing
  // here is a deliberate, reviewable act, not a quiet re-grant.
  assert.deepEqual(PAYROLL_SHARED_COUNTRY_LITERAL_EXEMPTIONS, [])
})

test('a stale exemption (a path that no longer names a country) fails the ratchet', () => {
  // The live list is empty, so the ratchet is exercised against an injected
  // one. Asserting it over the real (empty) list would pass while proving
  // nothing — a guard that is green about what it cannot see.
  const entries = [
    { path: 'engine/src/payroll/fixed.ts', reason: 'fixture' },
    { path: 'engine/src/payroll/still-branching.ts', reason: 'fixture' },
  ]
  const stale = staleCountryLiteralExemptions(
    entries.map((entry) => entry.path),
    (file) => (file.endsWith('fixed.ts') ? 'const clean = 1\n' : "if (province === 'QC') return\n"),
    entries,
  )
  assert.equal(stale.length, 1)
  assert.match(stale[0], /fixed\.ts: no longer names a country/)
})

test('an exemption naming a file that does not exist is itself stale', () => {
  const entries = [{ path: 'engine/src/payroll/deleted.ts', reason: 'fixture' }]
  const stale = staleCountryLiteralExemptions([], () => '', entries)
  assert.equal(stale.length, 1)
  assert.match(stale[0], /deleted\.ts: listed exemption is not a tracked file/)
})

test('the audit accepts the real pack and conformance files, branch literals included', () => {
  assert.deepEqual(
    auditCountryNeutrality([
      'engine/src/country-tax-packs/ca-returns.ts',
      'engine/src/conformance/cases/sales-tax.ts',
    ]),
    [],
  )
})

test('the audit accepts the fixed prepare panel', () => {
  assert.deepEqual(auditCountryNeutrality(['web/app/(app)/tax/TaxFilingsView.tsx']), [])
})

test('the audit rejects a form-code branch in generic content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'country-neutrality-audit-'))
  try {
    const branched = join(dir, 'filing-panel.tsx')
    writeFileSync(
      branched,
      `{code === 'CA_GST34' ? (\n  <Notice />\n) : null}\n`,
    )
    const clean = join(dir, 'other-panel.tsx')
    writeFileSync(clean, `{form.noticeKey ? (\n  <Notice />\n) : null}\n`)

    assert.deepEqual(auditCountryNeutrality([branched, clean], { roots: [dir] }), [
      `${branched}:1: pack form-code branch outside packs and fixtures (=== 'CA_GST34')`,
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the audit rejects !== and case variants of the same branch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'country-neutrality-audit-'))
  try {
    const notEqual = join(dir, 'a.ts')
    writeFileSync(notEqual, `if (code !== "US_941") return null\n`)
    const switched = join(dir, 'b.ts')
    writeFileSync(switched, `switch (code) {\n  case 'DE_USTVA':\n    return 1\n}\n`)

    assert.deepEqual(auditCountryNeutrality([notEqual, switched], { roots: [dir] }), [
      `${notEqual}:1: pack form-code branch outside packs and fixtures (!== "US_941")`,
      `${switched}:2: pack form-code branch outside packs and fixtures (case 'DE_USTVA':)`,
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('two-letter literals stay legal outside the tax layer', () => {
  // A repo-wide two-letter ban would false-positive on ordinary code ("NO"
  // nullability checks, "IF" keywords) and teach everyone to ignore the
  // gate — so Rule 2 holds only inside the tax layer, where it is exact.
  const dir = mkdtempSync(join(tmpdir(), 'country-neutrality-audit-'))
  try {
    const generic = join(dir, 'generic.ts')
    writeFileSync(generic, `if (c.is_nullable === "NO" && keyword === "IF") return\n`)

    assert.deepEqual(auditCountryNeutrality([generic], { roots: [dir] }), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the audit rejects a country branch inside the tax layer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'country-neutrality-audit-'))
  try {
    const branched = join(dir, 'prepare-panel.tsx')
    writeFileSync(branched, `{country === 'CA' ? (\n  <Notice />\n) : null}\n`)

    assert.deepEqual(
      auditCountryNeutrality([branched], { roots: [dir], taxLayer: [/prepare-panel/] }),
      [`${branched}:1: country branch in the generic country-branching layer (=== 'CA')`],
    )
    // Same content outside the layer is not this gate's business.
    assert.deepEqual(auditCountryNeutrality([branched], { roots: [dir] }), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('isScopedPath is unscoped', () => {
  assert.equal(isScopedPath('scripts/check-country-neutrality.mjs'), false)
  assert.equal(isScopedPath('schema/migrations/generated/0147_gst34_box_basis_heal.sql'), false)
})
