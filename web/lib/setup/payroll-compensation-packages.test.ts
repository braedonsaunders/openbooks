import assert from 'node:assert/strict'
import test from 'node:test'
import { packageVersionPresentation } from './payroll-compensation-packages'
import { setupAggregatePayload, setupDomainPayload } from './domain-payload'
import { definitionSchema } from '../../app/api/payroll/compensation-packages/contracts'
import { validateCompensationPackage } from '@openbooks/engine/src/payroll/compensation-package.ts'

const orgId = '10000000-0000-4000-8000-000000000001', componentId = '10000000-0000-4000-8000-000000000002'
const pack = { id: '10000000-0000-4000-8000-000000000003', subsidiaryId: '10000000-0000-4000-8000-000000000004', code: 'POLICY', name: 'Employer policy', description: null, country: 'CA', currency: 'CAD', currencyMinorUnits: 2, status: 'active' as const, revision: 1 }

test('all guided package patterns cross the native structured form and strict API without changing their policy', () => {
  const entity = packageVersionPresentation(pack, orgId, true)
  assert.equal(entity.createChooser?.options.length, 4)
  const definitionField = entity.fields.find(field => field.key === 'definition')!
  const rounding = definitionField.fields!.find(field => field.key === 'rules')!.fields!.find(field => field.key === 'rounding')!
  assert.deepEqual(rounding.defaultValue, { scale: 2, mode: 'half_away_from_zero', maxWholeDigits: 15 })
  assert.equal(rounding.fields!.find(field => field.key === 'scale')!.max, 2)
  for (const choice of entity.createChooser!.options) {
    const definition = structuredClone(choice.values.definition) as { inputs: { type: { kind: string }; maximum?: string }[]; rules: { componentId: string }[] }
    for (const input of definition.inputs) if (input.type.kind !== 'boolean') input.maximum = '100000'
    definition.rules[0]!.componentId = componentId
    const form = setupDomainPayload(entity, { packageId: pack.id, effectiveFrom: '2026-01-01', effectiveTo: '', definition, reason: 'Employer-approved pattern bounds' })
    assert.ok(form.ok, form.ok ? 'The native package form must accept its declared policy' : form.error)
    const request = setupAggregatePayload(entity, form.body, null)
    assert.ok(request.ok)
    assert.deepEqual(Object.keys(request.body).sort(), ['definition', 'effectiveFrom', 'effectiveTo', 'reason'])
    const parsed = definitionSchema.parse(request.body.definition)
    assert.equal(parsed.rules[0]!.rounding.scale, 2, 'guided native money must be payable in its registered currency')
    assert.match(validateCompensationPackage(parsed, [{ orgId, id: componentId, code: 'ALLOWANCE', kind: 'earning', country: 'CA', systemKey: null, isActive: true }]), /^[a-f0-9]{64}$/)
    assert.equal(parsed.rules[0]!.expression, (choice.values.definition as { rules: { expression: string }[] }).rules[0]!.expression)
  }
})

test('a guided package cannot save with undeclared bounds or a decimal-comma amount', () => {
  const entity = packageVersionPresentation(pack, orgId, true)
  const definition = structuredClone(entity.createChooser!.options[0]!.values.definition) as { inputs: { maximum: string }[]; rules: { componentId: string }[] }
  definition.rules[0]!.componentId = componentId
  const values = { packageId: pack.id, effectiveFrom: '2026-01-01', effectiveTo: '', definition, reason: 'Policy proposal' }
  let result = setupDomainPayload(entity, values)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /maximum.*required/)
  definition.inputs[0]!.maximum = '12,34'
  result = setupDomainPayload(entity, values)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /12,34.*12.34/)
})
