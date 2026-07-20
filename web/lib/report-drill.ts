import type { StatementBasis, StatementDimFilter, StatementMode } from './statement-matrix'
import type { AgingBucket, AgingSide } from './reports'

export type ReportDrillTarget =
  | {
      kind: 'ledger'
      label: string
      accountIds?: string[]
      accountTypes?: string[]
      from?: string
      to: string
      mode: StatementMode
      dims?: StatementDimFilter
      subsidiaryId?: string
      basis?: StatementBasis
      partyIds?: string[]
      projectCustomerId?: string
      unassignedProjectCustomer?: boolean
      projectSearch?: string
      /** Revenue less debit-normal costs, used by profit subtotals. */
      profitSigned?: boolean
      /** Only journal entries that touch a bank account; used by Cash Flow. */
      cashOnly?: boolean
    }
  | {
      kind: 'aging'
      label: string
      side: AgingSide
      asOf: string
      dims?: StatementDimFilter
      partyId?: string
      bucket?: AgingBucket
    }
  | {
      kind: 'budget'
      label: string
      scenarioId: string
      scope: 'actual' | 'budget' | 'variance'
      accountIds?: string[]
      accountTypes?: string[]
      dims?: StatementDimFilter
    }
  | {
      kind: 'orders'
      label: string
      orderKind: 'quote' | 'sales_order' | 'purchase_order'
      scope: 'open' | 'converted' | 'conversion' | 'voided'
    }
  | {
      kind: 'time'
      label: string
      from: string
      to: string
      projectId?: string
      projectCustomerId?: string
      unassignedProjectCustomer?: boolean
      projectSearch?: string
    }
  | {
      kind: 'custom'
      label: string
      source: 'definition' | 'view'
      id: string
    }

export type ReportDrillCell = string | number | null

export type ReportDrillResponse = {
  title: string
  description?: string
  summary: { label: string; value: string }[]
  columns: { label: string; align?: 'left' | 'right' | 'center' }[]
  rows: {
    key: string
    cells: ReportDrillCell[]
    transaction?: { entryId: string; docKind?: string | null; docId?: string | null }
  }[]
  /** Cell that opens the native transaction drawer when transaction is set. */
  linkColumn?: number
  page: number
  perPage: number
  total: number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const ACCOUNT_TYPE = /^[a-z][a-z0-9_]{0,63}$/
const SEGMENT_KEY = /^[a-z][a-z0-9_]{0,63}$/
const AGING_BUCKETS = new Set<AgingBucket>(['current', 'b1', 'b2', 'b3', 'b4'])
const ORDER_KINDS = new Set(['quote', 'sales_order', 'purchase_order'])
const ORDER_SCOPES = new Set(['open', 'converted', 'conversion', 'voided'])

function stringValue(value: unknown, max = 200): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
}

function uuidValue(value: unknown): string | undefined {
  return typeof value === 'string' && UUID.test(value) ? value : undefined
}

function uuidList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) return undefined
  const ids = value.filter((item): item is string => typeof item === 'string' && UUID.test(item))
  return ids.length === value.length ? ids : undefined
}

function dimsValue(value: unknown): StatementDimFilter | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  let segments: Record<string, string> | undefined
  if (raw.segments && typeof raw.segments === 'object' && !Array.isArray(raw.segments)) {
    segments = {}
    for (const [key, entry] of Object.entries(raw.segments as Record<string, unknown>)) {
      if (Object.keys(segments).length === 20) break
      if (SEGMENT_KEY.test(key) && typeof entry === 'string' && UUID.test(entry)) segments[key] = entry
    }
  }
  return {
    departmentId: uuidValue(raw.departmentId),
    projectId: uuidValue(raw.projectId),
    locationId: uuidValue(raw.locationId),
    classId: uuidValue(raw.classId),
    ...(segments && Object.keys(segments).length ? { segments } : {}),
  }
}

export function encodeReportDrillTarget(target: ReportDrillTarget): string {
  return JSON.stringify(target)
}

/** Parse URL-provided drill state fail-closed before it reaches SQL helpers. */
export function parseReportDrillTarget(raw: string | null): ReportDrillTarget | null {
  if (!raw || raw.length > 8_000) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  const label = stringValue(input.label)
  if (!label) return null

  if (input.kind === 'ledger') {
    const to = stringValue(input.to, 10)
    const from = input.from === undefined ? undefined : stringValue(input.from, 10) ?? undefined
    const accountIds = uuidList(input.accountIds)
    const partyIds = uuidList(input.partyIds)
    const projectCustomerId = uuidValue(input.projectCustomerId)
    const projectSearch = input.projectSearch === undefined ? undefined : stringValue(input.projectSearch) ?? undefined
    const rawAccountTypes = Array.isArray(input.accountTypes) ? input.accountTypes : undefined
    const accountTypes = rawAccountTypes && rawAccountTypes.length <= 50
      ? rawAccountTypes.filter((type): type is string => typeof type === 'string' && ACCOUNT_TYPE.test(type))
      : undefined
    if (!to || !ISO_DATE.test(to) || (from && !ISO_DATE.test(from))) return null
    if (input.accountIds !== undefined && !accountIds) return null
    if (input.partyIds !== undefined && !partyIds) return null
    if (input.projectCustomerId !== undefined && !projectCustomerId) return null
    if (input.projectSearch !== undefined && !projectSearch) return null
    if (projectCustomerId && input.unassignedProjectCustomer === true) return null
    if (input.accountTypes !== undefined && (!accountTypes || !rawAccountTypes || accountTypes.length !== rawAccountTypes.length)) return null
    return {
      kind: 'ledger',
      label,
      accountIds,
      accountTypes,
      from,
      to,
      mode: input.mode === 'balance' ? 'balance' : 'flow',
      dims: dimsValue(input.dims),
      subsidiaryId: uuidValue(input.subsidiaryId),
      basis: input.basis === 'cash' ? 'cash' : 'accrual',
      partyIds,
      projectCustomerId,
      unassignedProjectCustomer: input.unassignedProjectCustomer === true,
      projectSearch,
      profitSigned: input.profitSigned === true,
      cashOnly: input.cashOnly === true,
    }
  }

  if (input.kind === 'aging') {
    const asOf = stringValue(input.asOf, 10)
    const side = input.side === 'ap' ? 'ap' : input.side === 'ar' ? 'ar' : null
    const bucket = typeof input.bucket === 'string' && AGING_BUCKETS.has(input.bucket as AgingBucket)
      ? (input.bucket as AgingBucket)
      : undefined
    if (!asOf || !ISO_DATE.test(asOf) || !side) return null
    return { kind: 'aging', label, side, asOf, dims: dimsValue(input.dims), partyId: uuidValue(input.partyId), bucket }
  }

  if (input.kind === 'budget') {
    const scenarioId = uuidValue(input.scenarioId)
    const accountIds = uuidList(input.accountIds)
    const rawAccountTypes = Array.isArray(input.accountTypes) ? input.accountTypes : undefined
    const accountTypes = rawAccountTypes && rawAccountTypes.length <= 50
      ? rawAccountTypes.filter((type): type is string => typeof type === 'string' && ACCOUNT_TYPE.test(type))
      : undefined
    if (!scenarioId || !['actual', 'budget', 'variance'].includes(String(input.scope))) return null
    if (input.accountIds !== undefined && !accountIds) return null
    if (input.accountTypes !== undefined && (!accountTypes || !rawAccountTypes || accountTypes.length !== rawAccountTypes.length)) return null
    return {
      kind: 'budget',
      label,
      scenarioId,
      scope: input.scope as 'actual' | 'budget' | 'variance',
      accountIds,
      accountTypes,
      dims: dimsValue(input.dims),
    }
  }

  if (input.kind === 'orders') {
    if (!ORDER_KINDS.has(String(input.orderKind)) || !ORDER_SCOPES.has(String(input.scope))) return null
    return {
      kind: 'orders',
      label,
      orderKind: input.orderKind as 'quote' | 'sales_order' | 'purchase_order',
      scope: input.scope as 'open' | 'converted' | 'conversion' | 'voided',
    }
  }

  if (input.kind === 'time') {
    const from = stringValue(input.from, 10)
    const to = stringValue(input.to, 10)
    const projectId = uuidValue(input.projectId)
    const projectCustomerId = uuidValue(input.projectCustomerId)
    const projectSearch = input.projectSearch === undefined ? undefined : stringValue(input.projectSearch) ?? undefined
    if (!from || !to || !ISO_DATE.test(from) || !ISO_DATE.test(to)) return null
    if (input.projectId !== undefined && !projectId) return null
    if (input.projectCustomerId !== undefined && !projectCustomerId) return null
    if (input.projectSearch !== undefined && !projectSearch) return null
    if ((projectId || projectCustomerId) && input.unassignedProjectCustomer === true) return null
    return {
      kind: 'time', label, from, to, projectId, projectCustomerId,
      unassignedProjectCustomer: input.unassignedProjectCustomer === true,
      projectSearch,
    }
  }

  if (input.kind === 'custom') {
    const id = uuidValue(input.id)
    if (!id || (input.source !== 'definition' && input.source !== 'view')) return null
    return { kind: 'custom', label, source: input.source, id }
  }

  return null
}
