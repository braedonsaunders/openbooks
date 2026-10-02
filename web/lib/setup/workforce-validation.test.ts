import assert from 'node:assert/strict'
import test from 'node:test'
import { setupEntityWithValidationHook } from './entities/customer-item-refs.ts'
import { SETUP_ENTITY_BY_KEY } from './registry.ts'
import { validateContributionWrite, validateServiceCredit, validateServiceTier, validateVacationTerm } from './workforce-validation.ts'

const expectedHooks = [
  ['payroll-service-credits', validateServiceCredit],
  ['payroll-vacation-terms', validateVacationTerm],
  ['entitlement-service-tiers', validateServiceTier],
  ['benefit-recovery-sources', validateContributionWrite],
  ['benefit-contribution-rules', validateContributionWrite],
  ['benefit-contribution-classes', validateContributionWrite],
  ['benefit-contribution-tiers', validateContributionWrite],
  ['benefit-enrollment-configuration', validateContributionWrite],
  ['benefit-enrollment-terms', validateContributionWrite],
] as const

for (const [key, expectedHook] of expectedHooks) {
  test(`${key} keeps server validation without exposing it in the browser descriptor`, () => {
    const descriptor = SETUP_ENTITY_BY_KEY.get(key)
    assert.ok(descriptor, `${key} must remain in the shared setup registry`)
    assert.equal(descriptor.validateWrite, undefined)
    const serverEntity = setupEntityWithValidationHook(descriptor)
    assert.equal(serverEntity.validateWrite, expectedHook)
    assert.equal(serverEntity.fields, descriptor.fields)
    assert.equal(serverEntity.writePermission, descriptor.writePermission)
    assert.equal(descriptor.validateWrite, undefined)
    assert.equal(setupEntityWithValidationHook(serverEntity), serverEntity)
  })
}

test('server hook attachment retains existing item validation and embedded hooks', () => {
  for (const key of ['item-identifiers', 'customer-item-refs']) {
    const descriptor = SETUP_ENTITY_BY_KEY.get(key)
    assert.ok(descriptor)
    assert.equal(typeof setupEntityWithValidationHook(descriptor).validateWrite, 'function')
  }
  const descriptor = SETUP_ENTITY_BY_KEY.get('payroll-service-credits')!
  const validateWrite = async () => 'Configuration refused; reopen its owning record'
  const serverEntity = { ...descriptor, validateWrite }
  assert.equal(setupEntityWithValidationHook(serverEntity), serverEntity)
})
