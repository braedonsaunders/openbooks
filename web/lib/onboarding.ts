export const ONBOARDING_SCHEMA_VERSION = 1

export type OnboardingStatus = 'required' | 'deferred' | 'complete'

type JsonObject = Record<string, unknown>

function objectValue(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {}
}

export function onboardingRecord(settings: unknown): JsonObject {
  return objectValue(objectValue(settings).onboarding)
}

/**
 * First-run state is explicit and fail-safe. Only a recorded completion closes
 * onboarding permanently; deferral suppresses the automatic overlay while
 * keeping the setup wizard available from Company Settings.
 */
export function onboardingStatus(settings: unknown): OnboardingStatus {
  const onboarding = onboardingRecord(settings)
  if (onboarding.setupComplete === true) return 'complete'
  if (typeof onboarding.deferredAt === 'string' && onboarding.deferredAt.length > 0) {
    return 'deferred'
  }
  return 'required'
}
