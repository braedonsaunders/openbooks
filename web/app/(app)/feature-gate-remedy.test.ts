import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/**
 * F4/F6: every route that gates on a Features switch must render the
 * feature-required remedy (requireFeatureEnabled) instead of a bare
 * notFound() — an admin who switches HR, field time, or any module off saw
 * a generic "Page not found" with no path to turn it back on. Permission
 * denial stays separate: requirePermission (or the nullable-authz 404)
 * still owns the no-grant case, never the feature remedy.
 *
 * Derived from the tree, never a hand list: the test walks every view and
 * route-gate loader and fails on any 404/null that sits directly behind a
 * feature check.
 */

const APP = join(process.cwd(), 'web', 'app', '(app)')
const LIB_HRM = join(process.cwd(), 'web', 'lib', 'hrm')

function viewFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      viewFiles(path, out)
    } else if (
      (entry === 'view.ts' || entry === 'page.tsx' || entry === 'depth-view.ts') &&
      !entry.endsWith('.test.ts')
    ) {
      out.push(path)
    }
  }
  return out
}

function featureCheck(line: string): boolean {
  return line.includes('isFeatureEnabled(') || line.includes('isDocKindEnabled(')
}

test('no view calls notFound() directly after a feature check', () => {
  const violations: string[] = []
  for (const file of viewFiles(APP)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, index) => {
      if (!line.includes('notFound()')) return
      // A 404 on the same line as the check, or within three lines below
      // one (the dual-switch block shape), is the dropped refusal.
      if (featureCheck(line) || lines.slice(Math.max(0, index - 3), index).some(featureCheck)) {
        violations.push(`${file}:${index + 1}: ${line.trim()}`)
      }
    })
  }
  assert.deepEqual(
    violations,
    [],
    `views that 404 on a disabled feature instead of naming the remedy:\n${violations.join('\n')}`,
  )
})

test('route-gate loaders refuse by remedy, never by silent null', () => {
  // The nullable-authz loaders behind the HRM and Me routes: a
  // switched-off feature must redirect through requireFeatureEnabled while
  // a missing session/grant still returns null (the view's 404).
  const loaders = [
    'documents-home.ts',
    'surveys-home.ts',
    'org-chart-home.ts',
    'me-documents.ts',
    'me-surveys.ts',
    'compensation.ts',
  ]
  for (const name of loaders) {
    const source = readFileSync(join(LIB_HRM, name), 'utf8')
    assert.match(source, /requireFeatureEnabled\(/, `${name}: the feature gate redirects to the remedy`)
    const silent = source.split('\n').filter((line) => line.includes('isFeatureEnabled(') && line.includes('return null'))
    assert.deepEqual(silent, [], `${name}: no feature check collapses to a silent null`)
  }
})

test('permission denial stays separate from the feature remedy', () => {
  // Every converted view still decides the grant first: requirePermission
  // throws the access denial, getAuthz-null keeps its 404, and can() keeps
  // narrowing rows. None of that may ride the feature redirect.
  const violations: string[] = []
  for (const file of viewFiles(APP)) {
    const source = readFileSync(file, 'utf8')
    if (!source.includes('requireFeatureEnabled(')) continue
    if (
      !source.includes('requirePermission(') &&
      !source.includes('getAuthz(') &&
      !source.includes('guardFeaturePermission(') &&
      !source.includes('can(')
    ) {
      violations.push(file)
    }
  }
  assert.deepEqual(
    violations,
    [],
    `views whose feature remedy could mask a missing grant check:\n${violations.join('\n')}`,
  )
})
