import assert from 'node:assert/strict'
import test from 'node:test'
import { onboardingRecord, onboardingStatus } from './onboarding.ts'

test('requires setup when onboarding state is missing or malformed', () => {
  assert.equal(onboardingStatus(undefined), 'required')
  assert.equal(onboardingStatus({}), 'required')
  assert.equal(onboardingStatus({ onboarding: 'invalid' }), 'required')
  assert.deepEqual(onboardingRecord({ onboarding: [] }), {})
})

test('distinguishes a truthful deferral from completion', () => {
  assert.equal(
    onboardingStatus({
      onboarding: {
        setupComplete: false,
        deferredAt: '2026-07-30T12:00:00.000Z',
      },
    }),
    'deferred',
  )
  assert.equal(
    onboardingStatus({
      onboarding: {
        setupComplete: true,
        deferredAt: '2026-07-30T12:00:00.000Z',
      },
    }),
    'complete',
  )
})

test('does not accept truthy non-boolean completion values', () => {
  assert.equal(onboardingStatus({ onboarding: { setupComplete: 'true' } }), 'required')
  assert.equal(onboardingStatus({ onboarding: { setupComplete: 1 } }), 'required')
})
