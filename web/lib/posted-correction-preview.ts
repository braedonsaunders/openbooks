import { postedCorrectionFieldClass } from '@openbooks/engine/src/ledger/posted-correction-fields.ts'

/**
 * Posted-document consequence preview for the drawer save flow. It answers
 * "what will this edit do" with the same engine classification the correct
 * route enforces (metadata correction vs reclass vs void-and-reissue), so
 * the confirm copy can never promise what the server refuses. The server
 * stays authoritative: it re-derives the touch set from stored rows, and a
 * dimension the preview calls a reclass may refine to a header-only link
 * when no posted leg carries it — both are non-void, so the preview never
 * understates the consequence.
 */
export type PostedCorrectionPreview = 'metadata-correction' | 'reclass' | 'void-and-reissue'

/** Drawer payload (camelCase) keys to loaded-document (snake_case) keys. */
const HEADER_MAP: Record<string, string> = {
  partyId: 'party_id',
  paymentCardId: 'payment_card_id',
  documentDate: 'document_date',
  dueDate: 'due_date',
  postingDate: 'posting_date',
  expectedPayDate: 'expected_pay_date',
  subsidiaryId: 'subsidiary_id',
  currency: 'currency',
  billingMethod: 'billing_method',
  isFinalInvoice: 'is_final_invoice',
  paymentHoldReason: 'payment_hold_reason',
  externalRef: 'external_ref',
  externalSource: 'external_source',
  memo: 'memo',
  referenceNumber: 'reference_number',
  internalNotes: 'internal_notes',
  workCompletedOn: 'work_completed_on',
  departmentId: 'department_id',
  projectId: 'project_id',
  locationId: 'location_id',
  classId: 'class_id',
}

/**
 * Drawer payload line (camelCase) keys to stored-line (snake_case) keys.
 * The payload amount is the gross input, which persists as tax_input_amount;
 * the net amount column is derived, so an untouched inclusive-tax row
 * compares gross-to-gross here exactly as the server does.
 */
const LINE_MAP: Record<string, string> = {
  accountId: 'account_id',
  itemId: 'item_id',
  description: 'description',
  quantity: 'quantity',
  unit: 'unit',
  unitPrice: 'unit_price',
  amount: 'tax_input_amount',
  taxCodeId: 'tax_code_id',
  taxGroupId: 'tax_group_id',
  taxOverridden: 'tax_overridden',
  taxAmount: 'tax_amount',
  partyId: 'party_id',
  departmentId: 'department_id',
  projectId: 'project_id',
  locationId: 'location_id',
  classId: 'class_id',
  workFrom: 'work_from',
  workTo: 'work_to',
}

const DECIMAL_FIELDS: ReadonlySet<string> = new Set([
  'quantity', 'unitPrice', 'amount', 'taxAmount',
])

function normalizeScalar(value: unknown): unknown {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed
  }
  return value
}

function normalizeDecimal(value: unknown): unknown {
  const scalar = normalizeScalar(value)
  if (typeof scalar !== 'string') return scalar
  if (!/^-?\d+(\.\d+)?$/.test(scalar)) return scalar
  const negated = scalar.startsWith('-')
  const digits = (negated ? scalar.slice(1) : scalar)
    .replace(/^0+(?=\d)/, '')
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '')
  return `${negated ? '-' : ''}${digits === '' ? '0' : digits}`
}

function normalizeLineValue(field: string, value: unknown): unknown {
  return DECIMAL_FIELDS.has(field) ? normalizeDecimal(value) : normalizeScalar(value)
}

function isEmptyValue(value: unknown): boolean {
  const scalar = normalizeScalar(value)
  if (scalar === null || scalar === false) return true
  if (Array.isArray(scalar)) return scalar.length === 0
  if (scalar !== null && typeof scalar === 'object') return Object.keys(scalar).length === 0
  return false
}

/** Supplied custom keys the stored bag does not already carry as-is. */
function changedCustomKeys(supplied: unknown, stored: unknown): string[] {
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) return []
  const bag = (stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}) as Record<string, unknown>
  return Object.keys(supplied as Record<string, unknown>).filter((key) => {
    const value = (supplied as Record<string, unknown>)[key]
    if (value === undefined) return false
    return JSON.stringify(value ?? null) !== JSON.stringify(bag[key] ?? null)
  })
}

/**
 * Material line fields, mirroring the server canonicalizer field-for-field.
 * `custom` compares separately (supplied-only merge); `taxAmount` without an
 * override is derived. Lines replace wholesale (delete + reinsert with null
 * defaults), so an absent key reads as null exactly as the writer persists
 * it — the drawer omits work-date and return-source keys on kinds that do
 * not offer them, and those must compare equal to stored nulls.
 */
const LINE_MATERIAL_FIELDS = [
  // taxInputAmount excluded like the server canonicalizer: never operator
  // input, so it can never name a touch the body did not carry as amount.
  'accountId', 'itemId', 'description', 'quantity', 'unit', 'unitPrice',
  'amount', 'taxCodeId', 'taxGroupId', 'taxAmount',
  'taxOverridden', 'partyId', 'departmentId', 'projectId', 'locationId',
  'classId', 'workFrom', 'workTo',
] as const

function canonicalPreviewLine(line: Record<string, unknown>): Record<string, unknown> {
  const canonical: Record<string, unknown> = {}
  const overridden = (line.taxOverridden ?? null) === true
  for (const field of LINE_MATERIAL_FIELDS) {
    if (field === 'taxAmount' && !overridden) {
      canonical[field] = null
      continue
    }
    canonical[field] = normalizeLineValue(field, line[field] ?? null)
  }
  return canonical
}

/** Stored snake_case row into the payload camelCase shape for one canonicalizer. */
function storedLineToBody(stored: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const [from, to] of Object.entries(LINE_MAP)) {
    if (from === 'amount') {
      body[from] = stored.tax_input_amount ?? stored.amount
      continue
    }
    if (from === 'taxAmount') {
      body[from] = stored[to]
      continue
    }
    body[from] = stored[to]
  }
  return body
}

function linesChanged(
  payloadLines: unknown,
  storedLines: Array<Record<string, unknown>>,
): boolean {
  if (!Array.isArray(payloadLines)) return false
  if (payloadLines.length !== storedLines.length) return true
  return payloadLines.some((raw, index) => {
    const line = raw as Record<string, unknown>
    const stored = storedLines[index] ?? {}
    if (JSON.stringify(canonicalPreviewLine(line)) !== JSON.stringify(canonicalPreviewLine(storedLineToBody(stored)))) {
      return true
    }
    if (changedCustomKeys(line.custom, stored.custom).length > 0) return true
    return Object.entries(line).some(([key, value]) =>
      key !== 'lineId' && key !== 'custom' && !(key in LINE_MAP) && !isEmptyValue(value),
    )
  })
}

export function previewPostedCorrection(input: {
  /** Loaded document header (snake_case, as the document loader returns it). */
  doc: Record<string, unknown>
  /** Stored document lines (snake_case) from the last persisted snapshot. */
  storedLines: Array<Record<string, unknown>>
  /** The save payload the drawer is about to send (camelCase). */
  payload: Record<string, unknown>
  /** Tenant custom-field keys for the document kind, when known. */
  customDefKeys?: string[]
}): PostedCorrectionPreview {
  const { doc, storedLines, payload } = input
  const defKeys = input.customDefKeys ? new Set(input.customDefKeys) : undefined
  const touched: string[] = []
  for (const [from, to] of Object.entries(HEADER_MAP)) {
    if (payload[from] === undefined) continue
    if (JSON.stringify(normalizeScalar(payload[from])) !== JSON.stringify(normalizeScalar(doc[to]))) {
      touched.push(from)
    }
  }
  if (payload.extraDims !== undefined &&
    JSON.stringify(payload.extraDims ?? {}) !== JSON.stringify(doc.extra_dims ?? {})) {
    touched.push('extraDims')
  }
  for (const key of changedCustomKeys(payload.custom, doc.custom)) {
    touched.push(`custom.${key}`)
  }
  if (linesChanged(payload.lines, storedLines)) touched.push('lines')
  const classes = touched.map((field) => postedCorrectionFieldClass(field, defKeys))
  if (classes.some((value) => value === 'financial')) return 'void-and-reissue'
  if (classes.some((value) => value === 'dimension')) return 'reclass'
  return 'metadata-correction'
}
