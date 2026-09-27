import { ApplicationError } from '../application/errors'

/**
 * Engine domain errors whose messages are written for the operator (payroll,
 * banking, close, tax, construction billing…). Their text is controlled
 * application feedback — "Committed payroll has an unknown historical filing
 * account" — and the model needs it to explain a refusal instead of reporting
 * an opaque tool_failed. Matched by constructor name so this module never
 * imports the (cyclic) engine modules that declare them. Anything not listed
 * stays private.
 */
const DOMAIN_ERROR_NAMES = new Set([
  'PayrollError',
  'BankingError',
  'CloseError',
  'ComplianceError',
  'ConsolidationError',
  'ConstructionBillingError',
  'CurrencyError',
  'DocumentCorrectionError',
  'TaxReturnError',
  'SubcontractError',
  'AssetLifecycleError',
  'BillingSourceIntegrityError',
  'DeleteError',
  'FulfillmentRefusal',
  'WarehouseRefusal',
  'BackorderRefusal',
  'AvailabilityRefusal',
  'ReturnRefusal',
  'DropShipRefusal',
  'ScanRefusal',
  'CustomerItemRefusal',
])

const MAX_DOMAIN_MESSAGE = 400

function domainErrorName(error: Error): string | null {
  // Walk the prototype chain so subclasses (`class X extends PayrollError`) match.
  let proto: unknown = Object.getPrototypeOf(error)
  while (proto && proto !== Error.prototype && proto !== Object.prototype) {
    const name = (proto as { constructor?: { name?: string } }).constructor?.name
    if (name && DOMAIN_ERROR_NAMES.has(name)) return name
    proto = Object.getPrototypeOf(proto)
  }
  return null
}

/** A named refusal's stable snake_case code, when it carries one. Only the
 *  `*Refusal` classes promise a code the operator's remedy is keyed to. */
function refusalCode(error: Error): string | null {
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : null
}

/** A refusal's remedy when the domain error carries one, so the model can
 *  tell the operator what to do rather than only what went wrong. */
function domainRemedy(error: Error): string | null {
  const remedy = (error as { remedy?: unknown }).remedy
  return typeof remedy === 'string' && remedy.trim() !== '' ? remedy.trim() : null
}

/** Application errors are safe API feedback; arbitrary exceptions stay private. */
export function safeApplicationToolError(error: unknown): string {
  if (error instanceof ApplicationError) {
    if (error.status >= 500) return 'tool_failed'
    if (error.code === 'forbidden' || error.code === 'unauthorized') return error.code
    return `${error.code}: ${error.message}`
  }
  if (error instanceof Error) {
    const name = domainErrorName(error)
    if (name && error.message) {
      const code = name.replace(/(Error|Refusal)$/, '').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()
      const remedy = domainRemedy(error)
      const named = name.endsWith('Refusal') ? refusalCode(error) : null
      const text = remedy ? `${error.message}. Remedy: ${remedy}` : error.message
      return `${named ? `${code}/${named}` : code}: ${text.slice(0, MAX_DOMAIN_MESSAGE)}`
    }
  }
  return 'tool_failed'
}
