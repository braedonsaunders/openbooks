import type {
  AccountScope,
  AllocationApplyPolicy,
  AllocationBasisKind,
  AllocationBookScope,
  AllocationDimension,
  AllocationDriverAsOf,
  AllocationImpact,
  AllocationResidualPolicy,
  AllocationRunPolicy,
  AllocationSolveMethod,
  AllocationSourceMeasure,
  AllocationTargetKind,
  DimensionFilters,
  DynamicTarget,
  UntaggableDimension,
} from '../../../../../../engine/src/allocations/types.ts'
import {
  allocationTargetBasisFromLine,
  type AllocationLine,
} from '../../../../../components/allocations/split-lines-model.ts'

/** Rule head fields the General tab edits (order stays text until save). */
export interface GeneralForm {
  name: string
  description: string
  sortOrder: string
  isActive: boolean
}

export function generalFormFromRule(rule: {
  name: string
  description?: string | null
  sortOrder: number
  isActive: boolean
}): GeneralForm {
  return {
    name: rule.name,
    description: rule.description ?? '',
    sortOrder: String(rule.sortOrder),
    isActive: rule.isActive,
  }
}

/** PATCH /rules/[id] body — the route coerces types, the drawer sends clean ones. */
export function generalPayload(form: GeneralForm, expectedRevision: string): Record<string, unknown> {
  return {
    name: form.name,
    description: form.description === '' ? null : form.description,
    sortOrder: Number(form.sortOrder),
    isActive: form.isActive,
    expectedRevision,
  }
}

/** One stepped tier as edited: empty bound means unbounded (last tier only). */
export interface TierForm {
  upTo: string
  targetKey: string
}

const FILTER_DIMS = ['department', 'location', 'class', 'project', 'subsidiary'] as const
type FilterDim = (typeof FILTER_DIMS)[number]

/** Draft version fields as edited — selects stay text, multi-selects id arrays. */
export interface DefinitionForm {
  effectiveFrom: string
  effectiveTo: string
  bookScope: AllocationBookScope
  bookIds: string[]
  documentKinds: string[]
  accountScopeKind: AccountScope['kind']
  accountIds: string[]
  accountGroupDimension: string
  accountGroupKey: string
  filterDepartmentIds: string[]
  filterLocationIds: string[]
  filterClassIds: string[]
  filterProjectIds: string[]
  filterSubsidiaryIds: string[]
  filterPartyIds: string[]
  filterItemIds: string[]
  /** Custom-segment key → selected value ids. */
  filterExtraDims: Record<string, string[]>
  requireUntagged: UntaggableDimension[]
  applyPolicy: AllocationApplyPolicy
  sourceMeasure: AllocationSourceMeasure
  basisKind: AllocationBasisKind
  driverId: string
  driverAsOf: AllocationDriverAsOf
  tiers: TierForm[]
  targetKind: AllocationTargetKind
  dynamicDimension: AllocationDimension | ''
  dynamicMinWeight: string
  dynamicInclude: string[]
  dynamicExclude: string[]
  dynamicTargetAccountId: string
  impact: AllocationImpact
  offsetAccountId: string
  residualPolicy: AllocationResidualPolicy
  residualTargetId: string
  solveMethod: AllocationSolveMethod
  runPolicy: AllocationRunPolicy
  runOffsetDays: string
  approvalFlowId: string
  memoTemplate: string
  lineDescriptionTemplate: string
}

export function blankDefinitionForm(): DefinitionForm {
  return {
    effectiveFrom: '',
    effectiveTo: '',
    bookScope: 'primary',
    bookIds: [],
    documentKinds: [],
    accountScopeKind: 'any',
    accountIds: [],
    accountGroupDimension: '',
    accountGroupKey: '',
    filterDepartmentIds: [],
    filterLocationIds: [],
    filterClassIds: [],
    filterProjectIds: [],
    filterSubsidiaryIds: [],
    filterPartyIds: [],
    filterItemIds: [],
    filterExtraDims: {},
    requireUntagged: [],
    applyPolicy: 'automatic',
    sourceMeasure: 'period_activity',
    basisKind: 'fixed_percent',
    driverId: '',
    driverAsOf: 'period',
    tiers: [],
    targetKind: 'explicit',
    dynamicDimension: '',
    dynamicMinWeight: '',
    dynamicInclude: [],
    dynamicExclude: [],
    dynamicTargetAccountId: '',
    impact: 'reclass',
    offsetAccountId: '',
    residualPolicy: 'largest_share',
    residualTargetId: '',
    solveMethod: 'sequential',
    runPolicy: 'manual',
    runOffsetDays: '0',
    approvalFlowId: '',
    memoTemplate: '',
    lineDescriptionTemplate: '',
  }
}

function ids(value: readonly string[] | undefined): string[] {
  return [...(value ?? [])]
}

function tierForms(basisConfig: Record<string, unknown>): TierForm[] {
  const raw = basisConfig['tiers']
  if (!Array.isArray(raw)) return []
  return raw
    .filter((tier): tier is Record<string, unknown> => typeof tier === 'object' && tier !== null)
    .map((tier) => ({
      upTo: tier['upTo'] == null ? '' : String(tier['upTo']),
      targetKey: typeof tier['targetKey'] === 'string' ? tier['targetKey'] : '',
    }))
}

export function definitionFormFromVersion(version: {
  effectiveFrom: string
  effectiveTo?: string | null
  bookScope: AllocationBookScope
  bookIds: string[]
  documentKinds?: string[] | null
  accountScope: AccountScope
  dimensionFilters: DimensionFilters
  applyPolicy: AllocationApplyPolicy
  sourceMeasure: AllocationSourceMeasure
  basisKind: AllocationBasisKind
  driverId?: string | null
  driverAsOf: AllocationDriverAsOf
  basisConfig: Record<string, unknown>
  targetKind: AllocationTargetKind
  dynamicTarget: Partial<DynamicTarget>
  impact: AllocationImpact
  offsetAccountId?: string | null
  residualPolicy: AllocationResidualPolicy
  residualTargetId?: string | null
  solveMethod: AllocationSolveMethod
  runPolicy: AllocationRunPolicy
  runOffsetDays: number
  approvalFlowId?: string | null
  memoTemplate?: string | null
  lineDescriptionTemplate?: string | null
}): DefinitionForm {
  const filters = version.dimensionFilters
  return {
    ...blankDefinitionForm(),
    effectiveFrom: version.effectiveFrom,
    effectiveTo: version.effectiveTo ?? '',
    bookScope: version.bookScope,
    bookIds: ids(version.bookIds),
    documentKinds: ids(version.documentKinds ?? undefined),
    accountScopeKind: version.accountScope.kind,
    accountIds: version.accountScope.kind === 'accounts' ? ids(version.accountScope.accountIds) : [],
    accountGroupDimension: version.accountScope.kind === 'account_group' ? version.accountScope.dimension : '',
    accountGroupKey: version.accountScope.kind === 'account_group' ? version.accountScope.groupKey : '',
    filterDepartmentIds: ids(filters.departmentIds),
    filterLocationIds: ids(filters.locationIds),
    filterClassIds: ids(filters.classIds),
    filterProjectIds: ids(filters.projectIds),
    filterSubsidiaryIds: ids(filters.subsidiaryIds),
    filterPartyIds: ids(filters.partyIds),
    filterItemIds: ids(filters.itemIds),
    filterExtraDims: Object.fromEntries(
      Object.entries(filters.extraDims ?? {}).map(([segment, values]) => [segment, [...values]]),
    ),
    requireUntagged: [...(filters.requireUntagged ?? [])],
    applyPolicy: version.applyPolicy,
    sourceMeasure: version.sourceMeasure,
    basisKind: version.basisKind,
    driverId: version.driverId ?? '',
    driverAsOf: version.driverAsOf,
    tiers: tierForms(version.basisConfig),
    targetKind: version.targetKind,
    dynamicDimension: version.dynamicTarget.dimension ?? '',
    dynamicMinWeight: version.dynamicTarget.minWeight ?? '',
    dynamicInclude: ids(version.dynamicTarget.include),
    dynamicExclude: ids(version.dynamicTarget.exclude),
    dynamicTargetAccountId: version.dynamicTarget.targetAccountId ?? '',
    impact: version.impact,
    offsetAccountId: version.offsetAccountId ?? '',
    residualPolicy: version.residualPolicy,
    residualTargetId: version.residualTargetId ?? '',
    solveMethod: version.solveMethod,
    runPolicy: version.runPolicy,
    runOffsetDays: String(version.runOffsetDays),
    approvalFlowId: version.approvalFlowId ?? '',
    memoTemplate: version.memoTemplate ?? '',
    lineDescriptionTemplate: version.lineDescriptionTemplate ?? '',
  }
}

function nullIfEmpty(value: string): string | null {
  return value === '' ? null : value
}

/**
 * PATCH /versions/[versionId] body — every DRAFT_FIELDS key the form owns.
 * Empty text becomes null (the server treats null as "clear"); dimension
 * filters omit empty arrays so untouched dimensions stay untouched, while the
 * untagged flags always send (clearing them is meaningful). Stepped tiers
 * only send for a stepped basis; other bases leave basis_config alone.
 */
export function definitionPayload(form: DefinitionForm, expectedRevision: string): Record<string, unknown> {
  const filters: Record<string, unknown> = {}
  const put = (key: string, values: string[]) => {
    if (values.length > 0) filters[key] = values
  }
  put('departmentIds', form.filterDepartmentIds)
  put('locationIds', form.filterLocationIds)
  put('classIds', form.filterClassIds)
  put('projectIds', form.filterProjectIds)
  put('subsidiaryIds', form.filterSubsidiaryIds)
  put('partyIds', form.filterPartyIds)
  put('itemIds', form.filterItemIds)
  const extraDims: Record<string, string[]> = {}
  for (const [segment, values] of Object.entries(form.filterExtraDims)) {
    if (values.length > 0) extraDims[segment] = [...values]
  }
  if (Object.keys(extraDims).length > 0) filters['extraDims'] = extraDims
  filters['requireUntagged'] = [...form.requireUntagged]

  const accountScope: AccountScope =
    form.accountScopeKind === 'accounts'
      ? { kind: 'accounts', accountIds: [...form.accountIds] }
      : form.accountScopeKind === 'account_group'
        ? { kind: 'account_group', dimension: form.accountGroupDimension, groupKey: form.accountGroupKey }
        : { kind: 'any' }

  const body: Record<string, unknown> = {
    effectiveFrom: form.effectiveFrom,
    effectiveTo: nullIfEmpty(form.effectiveTo),
    bookScope: form.bookScope,
    bookIds: [...form.bookIds],
    documentKinds: [...form.documentKinds],
    accountScope,
    dimensionFilters: filters,
    applyPolicy: form.applyPolicy,
    sourceMeasure: form.sourceMeasure,
    basisKind: form.basisKind,
    driverId: nullIfEmpty(form.driverId),
    driverAsOf: form.driverAsOf,
    targetKind: form.targetKind,
    dynamicTarget: {
      ...(form.dynamicDimension === '' ? {} : { dimension: form.dynamicDimension }),
      ...(nullIfEmpty(form.dynamicMinWeight) === null ? {} : { minWeight: form.dynamicMinWeight }),
      ...(form.dynamicInclude.length === 0 ? {} : { include: [...form.dynamicInclude] }),
      ...(form.dynamicExclude.length === 0 ? {} : { exclude: [...form.dynamicExclude] }),
      ...(nullIfEmpty(form.dynamicTargetAccountId) === null
        ? {}
        : { targetAccountId: form.dynamicTargetAccountId }),
    },
    impact: form.impact,
    offsetAccountId: nullIfEmpty(form.offsetAccountId),
    residualPolicy: form.residualPolicy,
    residualTargetId: nullIfEmpty(form.residualTargetId),
    solveMethod: form.solveMethod,
    runPolicy: form.runPolicy,
    runOffsetDays: Number(form.runOffsetDays),
    approvalFlowId: nullIfEmpty(form.approvalFlowId),
    memoTemplate: nullIfEmpty(form.memoTemplate),
    lineDescriptionTemplate: nullIfEmpty(form.lineDescriptionTemplate),
    expectedRevision,
  }
  if (form.basisKind === 'stepped') {
    body['basisConfig'] = {
      tiers: form.tiers.map((tier) => ({
        upTo: nullIfEmpty(tier.upTo),
        ...(tier.targetKey === '' ? {} : { targetKey: tier.targetKey }),
      })),
    }
  }
  return body
}

/** Stored target → editor line (empty account = same account; sequence rides along, ignored). */
export function targetToLine(target: {
  sequence?: number
  targetAccountId?: string | null
  departmentId?: string | null
  locationId?: string | null
  classId?: string | null
  projectId?: string | null
  fixedPercent?: string | null
  weight?: string | null
  isRemainder?: boolean
  label?: string | null
}): AllocationLine {
  const portion: AllocationLine['portion'] = target.isRemainder
    ? { kind: 'remainder' }
    : target.fixedPercent != null
      ? { kind: 'percent', value: Number(target.fixedPercent) }
      : { kind: 'weight', value: target.weight ?? '' }
  return {
    accountId: target.targetAccountId ?? '',
    portion,
    departmentId: target.departmentId ?? null,
    locationId: target.locationId ?? null,
    classId: target.classId ?? null,
    projectId: target.projectId ?? null,
    label: target.label ?? null,
  }
}

/**
 * Editor lines → replace-targets input, merged positionally with the loaded
 * targets so server-only fields (subsidiary, extra dims) survive a save that
 * never shows them. New lines take the next sequence.
 */
export function mergeLinesToTargets(
  original: {
    sequence?: number
    subsidiaryId?: string | null
    extraDims?: Record<string, string>
    label?: string | null
  }[],
  lines: AllocationLine[],
): Record<string, unknown>[] {
  return lines.map((line, index) => {
    const basis = allocationTargetBasisFromLine(line)
    const kept = original[index] ?? {}
    return {
      sequence: index,
      targetAccountId: basis.targetAccountId,
      departmentId: line.departmentId ?? null,
      locationId: line.locationId ?? null,
      classId: line.classId ?? null,
      projectId: line.projectId ?? null,
      subsidiaryId: kept.subsidiaryId ?? null,
      extraDims: kept.extraDims ?? {},
      fixedPercent: basis.fixedPercent,
      weight: basis.weight,
      isRemainder: basis.isRemainder,
      label: basis.label,
    }
  })
}

/** Sample line coordinate for POST test-match (empty inputs stay absent/null). */
export function testLinePayload(form: {
  accountId: string
  documentKind: string
  dims: Partial<Record<'departmentId' | 'locationId' | 'classId' | 'projectId' | 'subsidiaryId' | 'partyId' | 'itemId', string>>
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    accountId: form.accountId,
    documentKind: form.documentKind === '' ? null : form.documentKind,
  }
  for (const [key, value] of Object.entries(form.dims)) {
    if (value !== undefined && value !== '') body[key] = value
  }
  return body
}

export interface ApiError {
  message: string
  stale: boolean
  problems: { code?: string; message?: string; field?: string }[]
}

/** Normalize a rule-API failure: server message wins, 409/STALE asks for reload. */
export function apiError(status: number, body: unknown, fallback: string): ApiError {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null
  const message = typeof record?.['error'] === 'string' && record['error'] !== '' ? record['error'] : fallback
  const problems = Array.isArray(record?.['problems'])
    ? (record['problems'] as ApiError['problems'])
    : []
  return { message, stale: status === 409 || record?.['code'] === 'STALE', problems }
}

/** Built-in filter dimensions sharing one picker shape (party/item/extra have their own). */
export const EDITABLE_FILTER_DIMS: readonly FilterDim[] = FILTER_DIMS
