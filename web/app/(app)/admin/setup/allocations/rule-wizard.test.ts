import assert from 'node:assert/strict'
import test from 'node:test'
import {
  defaultSourceFilters,
  defaultWizardDraft,
  filledTargets,
  hrefWithRule,
  isRuleKey,
  keyFromName,
  percentInputsSum,
  percentsSumToHundred,
  previewSplitAmounts,
  ratioToFixedPercents,
  trimDecimal,
  wizardDefinitionForm,
  wizardStepComplete,
  wizardTargetPayload,
  wizardTargetPercents,
  wizardUsesExplicitTargets,
} from './rule-wizard.ts'

test('1:2:3:4 becomes 10/20/30/40 exactly', () => {
  assert.deepEqual(ratioToFixedPercents(['1', '2', '3', '4']), [
    '10.0000',
    '20.0000',
    '30.0000',
    '40.0000',
  ])
})

test('1:1:1 places the leftover hundredth on the last share', () => {
  assert.deepEqual(ratioToFixedPercents(['1', '1', '1']), ['33.3333', '33.3333', '33.3334'])
})

test('preview of 1000.00 at 1:2:3:4 is 100/200/300/400', () => {
  assert.deepEqual(previewSplitAmounts('1000.00', ['1', '2', '3', '4']), [
    '100.0000',
    '200.0000',
    '300.0000',
    '400.0000',
  ])
})

test('percent inputs that already sum to 100 stay 100', () => {
  assert.equal(percentInputsSum(['60', '30', '10']), '100.0000')
  assert.equal(percentsSumToHundred(['60', '30', '10']), true)
  assert.equal(percentsSumToHundred(['1', '2', '3', '4']), false)
})

test('keyFromName slugs to the API key contract', () => {
  assert.equal(keyFromName('Overhead rent split'), 'overhead-rent-split')
  assert.equal(keyFromName('  IT  '), 'it')
  assert.equal(keyFromName('---'), 'allocation')
  assert.equal(isRuleKey('overhead-rent-split'), true)
  assert.equal(isRuleKey('Overhead'), false)
})

test('trimDecimal never uses a float', () => {
  assert.equal(trimDecimal('10.0000'), '10')
  assert.equal(trimDecimal('33.3330'), '33.333')
  assert.equal(trimDecimal('0.0000'), '0')
})

test('hrefWithRule keeps the tab and sets the created rule', () => {
  assert.equal(
    hrefWithRule('/admin/setup/allocations?tab=rules', 'rule-1'),
    '/admin/setup/allocations?tab=rules&rule=rule-1',
  )
  assert.equal(hrefWithRule('/admin/setup/allocations', 'rule-1'), '/admin/setup/allocations?rule=rule-1')
})

test('period defaults department to the untagged pool; entry and post leave every dimension open', () => {
  assert.equal(defaultSourceFilters('period').department.mode, 'untagged')
  assert.equal(defaultSourceFilters('entry').department.mode, 'any')
  assert.equal(defaultSourceFilters('post').location.mode, 'any')
})

test('the 1:2:3:4 department split writes percents the kernel can publish', () => {
  const draft = defaultWizardDraft()
  draft.name = 'Overhead split'
  draft.key = 'overhead-split'
  draft.documentKinds = ['vendor_bill']
  draft.sourceFilters.department = { mode: 'specific', ids: ['dept-overhead'] }
  draft.targets = [
    { valueId: 'eng', weight: '1' },
    { valueId: 'sales', weight: '2' },
    { valueId: 'support', weight: '3' },
    { valueId: 'ops', weight: '4' },
  ]
  assert.equal(wizardStepComplete('targets', draft), true)
  assert.equal(wizardUsesExplicitTargets(draft), true)
  assert.deepEqual(wizardTargetPercents(draft), ['10.0000', '20.0000', '30.0000', '40.0000'])
  const targets = wizardTargetPayload(draft)
  assert.equal(targets.length, 4)
  assert.deepEqual(
    targets.map((row) => [row['departmentId'], row['fixedPercent']]),
    [
      ['eng', '10.0000'],
      ['sales', '20.0000'],
      ['support', '30.0000'],
      ['ops', '40.0000'],
    ],
  )
  const form = wizardDefinitionForm(draft, '2026-09-17', null)
  assert.deepEqual(form.documentKinds, ['vendor_bill'])
  assert.deepEqual(form.filterDepartmentIds, ['dept-overhead'])
  assert.equal(form.basisKind, 'fixed_percent')
  assert.equal(form.targetKind, 'explicit')
  assert.equal(form.applyPolicy, 'automatic')
  assert.equal(form.impact, 'reclass')
})

test('a month-end untagged sweep with a driver uses dynamic targets', () => {
  const draft = defaultWizardDraft()
  draft.mode = 'period'
  draft.name = 'IT by headcount'
  draft.key = 'it-headcount'
  draft.sourceFilters.department = { mode: 'untagged', ids: [] }
  draft.splitKind = 'driver'
  draft.driverId = 'drv-1'
  assert.equal(wizardUsesExplicitTargets(draft), false)
  assert.equal(wizardStepComplete('targets', draft), true)
  const form = wizardDefinitionForm(draft, '2026-09-17', {
    id: 'drv-1',
    key: 'headcount',
    name: 'Headcount',
    dimension: 'department',
    isActive: true,
  })
  assert.deepEqual(form.requireUntagged, ['department'])
  assert.equal(form.basisKind, 'driver')
  assert.equal(form.driverId, 'drv-1')
  assert.equal(form.targetKind, 'dynamic')
  assert.equal(form.dynamicDimension, 'department')
  assert.equal(form.driverAsOf, 'period')
  assert.equal(form.sourceMeasure, 'period_activity')
})

test('subsidiary and custom-segment destinations write the matching target field', () => {
  const draft = defaultWizardDraft()
  draft.targetDimension = 'subsidiary'
  draft.targets = [
    { valueId: 'sub-a', weight: '1' },
    { valueId: 'sub-b', weight: '1' },
  ]
  assert.deepEqual(
    wizardTargetPayload(draft).map((row) => row['subsidiaryId']),
    ['sub-a', 'sub-b'],
  )
  draft.targetDimension = 'extra:region'
  draft.targets = [
    { valueId: 'east', weight: '1' },
    { valueId: 'west', weight: '1' },
  ]
  assert.deepEqual(
    wizardTargetPayload(draft).map((row) => row['extraDims']),
    [{ region: 'east' }, { region: 'west' }],
  )
})

test('source filters write every matcher dimension, not only department', () => {
  const draft = defaultWizardDraft()
  draft.name = 'Multi filter'
  draft.key = 'multi-filter'
  draft.sourceFilters.department = { mode: 'specific', ids: ['dept-1'] }
  draft.sourceFilters.location = { mode: 'untagged', ids: [] }
  draft.sourceFilters.party = { mode: 'specific', ids: ['party-1'] }
  draft.sourceExtraDims = { region: { mode: 'specific', ids: ['east'] } }
  const form = wizardDefinitionForm(draft, '2026-09-17', null)
  assert.deepEqual(form.filterDepartmentIds, ['dept-1'])
  assert.deepEqual(form.requireUntagged, ['location'])
  assert.deepEqual(form.filterPartyIds, ['party-1'])
  assert.deepEqual(form.filterExtraDims, { region: ['east'] })
})

test('filledTargets drops blank rows and next weight follows the count', () => {
  const draft = defaultWizardDraft()
  draft.targets[0] = { valueId: 'a', weight: '1' }
  draft.targets[1] = { valueId: '', weight: '2' }
  assert.deepEqual(filledTargets(draft), [{ valueId: 'a', weight: '1' }])
  assert.equal(wizardStepComplete('targets', draft), false)
})
