export { FEATURES, featureEnabled } from './feature-registry.ts'
export type { FeatureState } from './feature-registry.ts'

export { acquireOrgFeatureGateLock, lockAndCheckOrgFeature } from './org-feature-lock.ts'
