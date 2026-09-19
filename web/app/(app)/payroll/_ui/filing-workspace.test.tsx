import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workspace = readFileSync('web/app/(app)/payroll/_ui/filing-workspace.tsx', 'utf8')
const route = readFileSync('web/app/api/payroll/year-end/file/route.ts', 'utf8')

test('the year picker offers server-derived years, never a calendar window', () => {
  // A picker built from the calendar year hides a fiscal pack's posted year
  // (AU September posts to the next calendar year). The list arrives in the
  // `years` prop, derived server-side from the packs and the org's data.
  assert.match(workspace, /years: number\[\]/)
  assert.doesNotMatch(workspace, /currentYear - i/)
  assert.doesNotMatch(workspace, /getFullYear\(\)/)
})

test('issue filing declarations use a bounded POST body, never a GET query', () => {
  assert.match(workspace, /method: 'POST'/)
  assert.match(workspace, /body: JSON\.stringify\(/)
  assert.match(workspace, /selectedCount > section\.issue\.maxSelection/)
  assert.doesNotMatch(workspace, /fileHref\(section, year, /)

  assert.match(route, /export async function POST\(req: Request\)/)
  assert.match(route, /parseJsonBody\(req, jsonObject\)/)
  assert.match(route, /issue filing selections must be submitted in a POST body/)
  assert.match(route, /maxSelection/)
  assert.match(route, /maxEncodedSelectionLength/)
})
