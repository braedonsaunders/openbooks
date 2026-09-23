import { ControlAccountsIncompleteError } from '@openbooks/engine/src/records/control-accounts.ts'
import { PostingError } from "@openbooks/engine/src/ledger/posting-contracts.ts";
import { PayrollError } from '@openbooks/engine/src/payroll/error.ts'

/**
 * Map an action failure to its response (F-t06-002). Typed kernel, control-
 * account, payroll, and invoice-backup refusals keep their message (422) —
 * the operator can act on them. Anything else is a server defect: the detail
 * goes to the server log and the client gets a stable code, never driver
 * text, bind params, or internal ids. Clients render their own localized
 * fallback for the code and pin it beside the record.
 *
 * The backup gate's error class lives in invoice-backup next to the packet
 * assembler (which pulls PDF rendering this route must not load), so it is
 * matched by its stable code, not by instanceof.
 */
export function toActionFailure(error: unknown): { status: 422 | 500; body: { error?: string; code?: string } } {
  if (
    error instanceof PostingError ||
    error instanceof ControlAccountsIncompleteError ||
    error instanceof PayrollError ||
    (error instanceof Error && (error as { code?: unknown }).code === 'invoice_backup_required')
  ) {
    return { status: 422, body: { error: (error as Error).message } }
  }
  return { status: 500, body: { code: 'internal_error' } }
}
