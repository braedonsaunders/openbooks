/** Authorized access to compensation architecture. */
export { requireBandsReadScope, listPayBandVersions, type PayBandDTO } from './compensation/bands.ts'
export { listJobLevels } from './compensation/architecture.ts'
export { compensationWageSummary } from './compensation/overview.ts'
export { listJobFamilies } from './compensation/architecture.ts'
export { adoptSourceCompensationCycle, sourceCompensationCycleEvidence, type CompensationCycleEvidence, type SourceCompensationRow } from './compensation/source-cycles.ts'
export { getCycle, type CompCycleDTO } from './compensation/cycles.ts'
export { CompensationError } from './compensation/errors.ts'
