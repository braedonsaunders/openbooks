/**
 * Db-free driver form shaping (A8): drawer state → API payloads. Money and
 * weights stay exact decimal TEXT end to end — parsing them through Number
 * here would round before the server validator canonicalizes.
 */

export type DriverSourceKind =
  | 'statistical_journal'
  | 'gl_activity'
  | 'gl_balance'
  | 'native_measure'
  | 'manual'
  | 'report_definition'

export interface DriverFormState {
  key: string
  name: string
  description: string
  unit: string
  dimension: string
  sourceKind: DriverSourceKind
  isActive: boolean
  accountIds: string[]
  accountScopeAny: boolean
  measure: string
  reportDefinitionId: string
  dimensionColumn: string
  valueColumn: string
}

export function newDriverForm(): DriverFormState {
  return {
    key: '',
    name: '',
    description: '',
    unit: '',
    dimension: 'department',
    sourceKind: 'manual',
    isActive: true,
    accountIds: [],
    accountScopeAny: true,
    measure: 'headcount',
    reportDefinitionId: '',
    dimensionColumn: '',
    valueColumn: '',
  }
}

/** Config payload for the active source kind; unknown fields never leak in. */
export function driverConfigFromForm(form: DriverFormState): Record<string, unknown> {
  switch (form.sourceKind) {
    case 'statistical_journal': {
      const config: Record<string, unknown> = { unit: form.unit.trim() }
      if (form.accountIds.length > 0) config.accountIds = [...form.accountIds]
      return config
    }
    case 'gl_activity':
    case 'gl_balance':
      return form.accountScopeAny || form.accountIds.length === 0
        ? { accountScope: { kind: 'any' } }
        : { accountScope: { kind: 'accounts', accountIds: [...form.accountIds] } }
    case 'native_measure':
      return { measure: form.measure }
    case 'manual':
      return {}
    case 'report_definition':
      return {
        reportDefinitionId: form.reportDefinitionId,
        dimensionColumn: form.dimensionColumn.trim(),
        valueColumn: form.valueColumn.trim(),
      }
  }
}

export interface StoredDriver {
  key: string
  name: string
  description: string | null
  unit: string | null
  dimension: string
  sourceKind: DriverSourceKind
  isActive: boolean
  config: Record<string, unknown>
}

/** Rehydrate drawer state from a stored driver (edit path). */
export function formFromDriver(row: StoredDriver): DriverFormState {
  const form = { ...newDriverForm() }
  form.key = row.key
  form.name = row.name
  form.description = row.description ?? ''
  form.unit = row.unit ?? ''
  form.dimension = row.dimension
  form.sourceKind = row.sourceKind
  form.isActive = row.isActive
  const config = row.config ?? {}
  if (row.sourceKind === 'statistical_journal') {
    if (typeof config.unit === 'string') form.unit = config.unit
    if (Array.isArray(config.accountIds)) {
      form.accountIds = config.accountIds.filter((id): id is string => typeof id === 'string')
    }
  }
  if ((row.sourceKind === 'gl_activity' || row.sourceKind === 'gl_balance') && typeof config.accountScope === 'object' && config.accountScope !== null) {
    const scope = config.accountScope as { kind?: string; accountIds?: unknown }
    if (scope.kind === 'accounts' && Array.isArray(scope.accountIds)) {
      form.accountScopeAny = false
      form.accountIds = scope.accountIds.filter((id): id is string => typeof id === 'string')
    } else {
      form.accountScopeAny = true
    }
  }
  if (row.sourceKind === 'native_measure' && typeof config.measure === 'string') form.measure = config.measure
  if (row.sourceKind === 'report_definition') {
    if (typeof config.reportDefinitionId === 'string') form.reportDefinitionId = config.reportDefinitionId
    if (typeof config.dimensionColumn === 'string') form.dimensionColumn = config.dimensionColumn
    if (typeof config.valueColumn === 'string') form.valueColumn = config.valueColumn
  }
  return form
}

export function driverPayloadFromForm(form: DriverFormState): Record<string, unknown> {
  return {
    key: form.key.trim(),
    name: form.name.trim(),
    description: form.description.trim() || null,
    unit: form.unit.trim() || null,
    dimension: form.dimension,
    sourceKind: form.sourceKind,
    config: driverConfigFromForm(form),
    isActive: form.isActive,
  }
}

export interface DriverValueFormState {
  dimensionValueId: string
  effectiveFrom: string
  effectiveTo: string
  /** Exact decimal text; never coerced through Number. */
  value: string
  note: string
}

export function valuePayloadFromForm(form: DriverValueFormState): Record<string, unknown> {
  return {
    dimensionValueId: form.dimensionValueId,
    effectiveFrom: form.effectiveFrom,
    effectiveTo: form.effectiveTo || null,
    value: form.value.trim(),
    note: form.note.trim() || null,
  }
}
