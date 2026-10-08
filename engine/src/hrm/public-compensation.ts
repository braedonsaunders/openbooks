/** Authorized access to compensation architecture. */
export { requireBandsReadScope, listPayBandVersions, type PayBandDTO } from './compensation/bands.ts'
export { listJobLevels } from './compensation/architecture.ts'
export { compensationArchitectureSummary, compensationWageSummary, type CompensationArchitectureSummary, type CompensationWageSummary } from './compensation/overview.ts'
export { listJobFamilies } from './compensation/architecture.ts'
export { adoptSourceCompensationCycle, sourceCompensationCycleEvidence, type CompensationCycleEvidence, type SourceCompensationRow } from './compensation/source-cycles.ts'
export { getCycle, type CompCycleDTO } from './compensation/cycles.ts'
export { CompensationError } from './compensation/errors.ts'
/** Burden fraction for analytics consumers: compensation settings first, else labor-costing components. */
export { burdenRateFor } from './compensation/headcount-plans.ts'
export { employeeTotalCompensation, type TotalCompensation, type CompensationCategory } from './compensation/total-compensation.ts'
