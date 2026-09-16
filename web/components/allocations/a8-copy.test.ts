import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * A8 Drivers/Runs/lineage UI renders every string through
 * `allocations.{tabs,drivers,runs,lineage}.*` (plus shared common.* action
 * labels) — no literals in JSX. A missing key renders the raw path, so the
 * contract is pinned here, mirroring entry-copy.test.ts.
 */
const catalog = JSON.parse(
  readFileSync(new URL('../../messages/en/allocations.json', import.meta.url), 'utf8'),
) as Record<string, Record<string, unknown>>

function assertStrings(ns: string, keys: readonly string[], path = ''): void {
  const node = path
    ? (Object.entries(catalog[ns] ?? {}).find(([k]) => k === path)?.[1] as Record<string, unknown>)
    : (catalog[ns] as Record<string, unknown>)
  assert.ok(node, `allocations.json must carry ${ns}${path ? `.${path}` : ''}`)
  for (const key of keys) {
    assert.equal(typeof node[key], 'string', `allocations.${ns}.${path ? `${path}.` : ''}${key} must exist`)
    assert.ok(
      ((node[key] as string) ?? '').trim().length > 0,
      `allocations.${ns}.${path ? `${path}.` : ''}${key} must not be empty`,
    )
  }
}

const DRIVER_KEYS = [
  'title', 'description', 'newDriver', 'editDriver', 'key', 'keyHint', 'name',
  'dimension', 'sourceKind', 'unit', 'active', 'showInactive', 'empty',
  'deleteConfirm', 'unitPlaceholder', 'accountsHint', 'anyAccountScope',
  'measureLabel', 'reportLabel', 'dimensionColumn', 'valueColumn', 'valuesTitle',
  'valuesHint', 'dimensionValue', 'effectiveFrom', 'effectiveTo', 'openEnded',
  'value', 'note', 'addValue', 'noValues', 'endValue', 'deleteValueConfirm',
  'preview', 'previewTitle', 'asOfPeriod', 'asOfDate', 'weight', 'share',
  'noPreviewRows', 'enginePending', 'loadFailed', 'saveFailed', 'deleteFailed', 'previewFailed',
] as const

const RUN_KEYS = [
  'title', 'description', 'filterRule', 'filterPeriod', 'filterStatus', 'all',
  'empty', 'allSubsidiaries', 'previewRun', 'runDetail', 'sources',
  'driverVector', 'targets', 'target', 'weight', 'share', 'amount', 'residual',
  'lines', 'account', 'memo', 'computationEmpty', 'version', 'definitionHash',
  'trigger', 'started', 'completed', 'runError', 'post', 'reverse', 'rerun',
  'postReasonPrompt', 'reverseReasonPrompt', 'reasonRequired', 'postFailed',
  'reverseFailed', 'rerunFailed', 'enginePending', 'journalEntry',
  'reversalEntry', 'loadFailed', 'detailFailed', 'pendingApprovalNotice',
  'viewApproval',
] as const

test('drivers + runs + lineage copy exists and is non-empty', () => {
  assertStrings('tabs', ['workspace', 'drivers', 'runs'])
  assertStrings('drivers', DRIVER_KEYS)
  assertStrings('drivers', ['department', 'location', 'class', 'project', 'subsidiary'], 'dimensions')
  assertStrings(
    'drivers',
    ['statistical_journal', 'gl_activity', 'gl_balance', 'native_measure', 'manual', 'report_definition'],
    'sourceKinds',
  )
  assertStrings(
    'drivers',
    ['statistical_journal', 'gl_activity', 'gl_balance', 'native_measure', 'manual', 'report_definition'],
    'sourceHints',
  )
  assertStrings(
    'drivers',
    ['headcount', 'labor_hours', 'billed_hours', 'labor_cost', 'revenue', 'direct_cost', 'rentable_area'],
    'measures',
  )
  assertStrings('runs', RUN_KEYS)
  assertStrings('runs', ['rule', 'period', 'book', 'subsidiary', 'status', 'sourceTotal', 'allocated', 'residual', 'journal', 'requestedBy', 'created'], 'columns')
  assertStrings(
    'runs',
    ['previewed', 'pending_approval', 'posted', 'reversed', 'failed', 'superseded'],
    'statuses',
  )
  assertStrings('lineage', ['title', 'rule', 'driver', 'amount', 'share', 'empty', 'viewJournal', 'loadFailed'])
})

test('a8 copy carries no interpolation other than named {args}', () => {
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      for (const match of node.match(/\{[^}]*\}/g) ?? []) {
        assert.match(match, /^\{[a-zA-Z][a-zA-Z0-9]*\}$/, `${path} has a malformed placeholder ${match}`)
      }
      return
    }
    if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) walk(value, `${path}.${key}`)
    }
  }
  for (const ns of ['tabs', 'drivers', 'runs', 'lineage']) walk(catalog[ns] ?? {}, `allocations.${ns}`)
})
