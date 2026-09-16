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
])

const MAX_DOMAIN_MESSAGE = 400

function domainErrorCode(error: Error): string | null {
  // Walk the prototype chain so subclasses (`class X extends PayrollError`) match.
  let proto: unknown = Object.getPrototypeOf(error)
  while (proto && proto !== Error.prototype && proto !== Object.prototype) {
    const name = (proto as { constructor?: { name?: string } }).constructor?.name
    if (name && DOMAIN_ERROR_NAMES.has(name)) {
      return name.replace(/Error$/, '').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()
    }
    proto = Object.getPrototypeOf(proto)
  }
  return null
}

/** Application errors are safe API feedback; arbitrary exceptions stay private. */
export function safeApplicationToolError(error: unknown): string {
  if (error instanceof ApplicationError) {
    if (error.status >= 500) return 'tool_failed'
    if (error.code === 'forbidden' || error.code === 'unauthorized') return error.code
    return `${error.code}: ${error.message}`
  }
  if (error instanceof Error) {
    const code = domainErrorCode(error)
    if (code && error.message) return `${code}: ${error.message.slice(0, MAX_DOMAIN_MESSAGE)}`
  }
  return 'tool_failed'
}
