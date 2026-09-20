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

test('the tax layer scope excludes payroll, so its slice cannot hide here', () => {
  assert.equal(isTaxLayerPath('web/app/(app)/payroll/_ui/EmployeesPanel.tsx'), false)
  assert.equal(isTaxLayerPath('web/app/api/payroll/subsidiary-scope.ts'), false)
  assert.equal(isTaxLayerPath('engine/src/payroll/run-calculation.ts'), false)
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
      [`${branched}:1: country branch in the indirect-tax layer (=== 'CA')`],
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
