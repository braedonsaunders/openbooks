import assert from 'node:assert/strict'
import test from 'node:test'

import {
  apiError,
  blankDefinitionForm,
  definitionFormFromVersion,
  definitionPayload,
  generalFormFromRule,
  generalPayload,
  mergeLinesToTargets,
  targetToLine,
  testLinePayload,
  type DefinitionForm,
} from './rule-drawer-form.ts'

test('general payload nulls an empty description and numbers the order', () => {
  const payload = generalPayload(
    { name: 'Rent', description: '', sortOrder: '10', isActive: true },
    'rev-1',
  )
  assert.deepEqual(payload, {
    name: 'Rent',
    description: null,
    sortOrder: 10,
    isActive: true,
    expectedRevision: 'rev-1',
  })
})

test('general form reads the head with the order as text', () => {
  const form = generalFormFromRule({
    name: 'Rent',
    description: null,
    sortOrder: 3,
    isActive: false,
  })
  assert.deepEqual(form, { name: 'Rent', description: '', sortOrder: '3', isActive: false })
})

test('definition form reads the version with multi-selects as id arrays', () => {
  const form = definitionFormFromVersion({
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    bookScope: 'books',
    bookIds: ['b1'],
    documentKinds: ['journal'],
    accountScope: { kind: 'accounts', accountIds: ['a1'] },
    dimensionFilters: {
      departmentIds: ['d1'],
      partyIds: ['p1'],
      itemIds: ['i1'],
      extraDims: { region: ['r1', 'r2'] },
      requireUntagged: ['project'],
    },
    applyPolicy: 'automatic',
    sourceMeasure: 'period_activity',
    basisKind: 'stepped',
    driverId: null,
    driverAsOf: 'period',
    basisConfig: { tiers: [{ upTo: '1000.00', targetKey: 'base' }, { upTo: null }] },
    targetKind: 'explicit',
    dynamicTarget: {},
    impact: 'reclass',
    offsetAccountId: null,
    residualPolicy: 'largest_share',
    residualTargetId: null,
    solveMethod: 'sequential',
    runPolicy: 'manual',
    runOffsetDays: 0,
    approvalFlowId: null,
    memoTemplate: '',
    lineDescriptionTemplate: null,
  })
  assert.equal(form.effectiveTo, '')
  assert.deepEqual(form.bookIds, ['b1'])
  assert.deepEqual(form.documentKinds, ['journal'])
  assert.equal(form.accountScopeKind, 'accounts')
  assert.deepEqual(form.accountIds, ['a1'])
  assert.deepEqual(form.filterDepartmentIds, ['d1'])
  assert.deepEqual(form.filterPartyIds, ['p1'])
  assert.deepEqual(form.filterItemIds, ['i1'])
  assert.deepEqual(form.filterExtraDims, { region: ['r1', 'r2'] })
  assert.deepEqual(form.requireUntagged, ['project'])
  assert.deepEqual(form.tiers, [
    { upTo: '1000.00', targetKey: 'base' },
    { upTo: '', targetKey: '' },
  ])
})

test('definition payload nulls empties and only sends tiers when stepped', () => {
  const base: DefinitionForm = {
    ...blankDefinitionForm(),
    effectiveFrom: '2026-01-01',
    effectiveTo: '',
    basisKind: 'driver',
    driverId: 'drv-1',
    memoTemplate: '',
    runOffsetDays: '5',
    approvalFlowId: '',
    tiers: [{ upTo: '10', targetKey: '' }],
  }
  const payload = definitionPayload(base, 'rev-2') as Record<string, unknown>
  assert.equal(payload['effectiveTo'], null)
  assert.equal(payload['memoTemplate'], null)
  assert.equal(payload['runOffsetDays'], 5)
  assert.equal(payload['approvalFlowId'], null)
  assert.ok(!('basisConfig' in payload), 'non-stepped versions leave basis_config alone')
  assert.equal(payload['expectedRevision'], 'rev-2')

  const stepped = definitionPayload({ ...base, basisKind: 'stepped' }, 'rev-2') as Record<string, unknown>
  assert.deepEqual(stepped['basisConfig'], { tiers: [{ upTo: '10' }] })
})

test('definition payload omits empty dimension filters but keeps the untagged flags', () => {
  const payload = definitionPayload(
    { ...blankDefinitionForm(), effectiveFrom: '2026-01-01', requireUntagged: ['class'] },
    'rev-3',
  ) as Record<string, unknown>
  assert.deepEqual(payload['dimensionFilters'], { requireUntagged: ['class'] })
})

test('definition payload round-trips party, item and custom-segment filters', () => {
  const payload = definitionPayload(
    {
      ...blankDefinitionForm(),
      filterPartyIds: ['p1'],
      filterItemIds: ['i1', 'i2'],
      filterExtraDims: { region: ['r1'], empty: [] },
    },
    'rev-4',
  ) as Record<string, unknown>
  assert.deepEqual(payload['dimensionFilters'], {
    partyIds: ['p1'],
    itemIds: ['i1', 'i2'],
    extraDims: { region: ['r1'] },
    requireUntagged: [],
  })
})

test('targets round-trip through editor lines preserving server-only fields', () => {
  const line = targetToLine({
    sequence: 0,
    targetAccountId: null,
    departmentId: 'd1',
    fixedPercent: '25.5',
    weight: null,
    isRemainder: false,
    label: 'Share',
  })
  assert.equal(line.accountId, '')
  assert.deepEqual(line.portion, { kind: 'percent', value: 25.5 })
  assert.equal(line.departmentId, 'd1')
  assert.equal(line.label, 'Share')

  const remainder = targetToLine({ sequence: 1, isRemainder: true })
  assert.deepEqual(remainder.portion, { kind: 'remainder' })
  assert.equal(remainder.accountId, '')

  const merged = mergeLinesToTargets(
    [{ sequence: 0, subsidiaryId: 's9', extraDims: { region: 'emea' }, label: 'old' }],
    [{ ...line, label: 'new', accountId: 'a2' }],
  )
  assert.deepEqual(merged, [
    {
      sequence: 0,
      targetAccountId: 'a2',
      departmentId: 'd1',
      locationId: null,
      classId: null,
      projectId: null,
      subsidiaryId: 's9',
      extraDims: { region: 'emea' },
      fixedPercent: '25.5',
      weight: null,
      isRemainder: false,
      label: 'new',
    },
  ])
})

test('test line payload nulls every empty coordinate', () => {
  assert.deepEqual(testLinePayload({ accountId: 'a1', documentKind: '', dims: {} }), {
    accountId: 'a1',
    documentKind: null,
  })
  assert.deepEqual(
    testLinePayload({ accountId: 'a1', documentKind: 'bill', dims: { departmentId: 'd1' } }),
    { accountId: 'a1', documentKind: 'bill', departmentId: 'd1' },
  )
})

test('api errors surface the server message and flag stale revisions', () => {
  assert.deepEqual(apiError(409, { error: 'changed', code: 'STALE' }, 'fallback'), {
    message: 'changed',
    stale: true,
    problems: [],
  })
  const invalid = apiError(422, { error: 'bad', problems: [{ code: 'x' }] }, 'fallback')
  assert.equal(invalid.message, 'bad')
  assert.equal(invalid.stale, false)
  assert.deepEqual(invalid.problems, [{ code: 'x' }])
  assert.equal(apiError(500, null, 'fallback').message, 'fallback')
})
