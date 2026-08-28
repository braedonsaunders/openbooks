import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workspace = readFileSync('web/app/(app)/payroll/_ui/filing-workspace.tsx', 'utf8')
const route = readFileSync('web/app/api/payroll/year-end/file/route.ts', 'utf8')

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
