export { FEATURES, FEATURE_BY_KEY, featureEnabled, featureRequirements } from './feature-registry.ts'
export type { FeatureDef, FeatureState } from './feature-registry.ts'

export { acquireOrgFeatureGateLock, lockAndCheckOrgFeature, orgFeatureEnabled } from './org-feature-lock.ts'
