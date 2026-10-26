import { ControlAccountsIncompleteError } from "@openbooks/engine/records/control-accounts";
import { PostingError } from "@openbooks/engine/journal/contracts";
import { PayrollError } from "@openbooks/engine/payroll/error";
import {
  InventoryError,
  InventoryOwnershipError,
} from "@openbooks/engine/inventory/contracts/module";
import { SubmitError } from "@openbooks/engine/flows/submit";

/**
 * Map an action failure to its response. Typed kernel, inventory, control-
 * account, payroll, submission (including a before_submit script veto), and
 * invoice-backup refusals keep their message (422) —
 * the operator can act on them. Anything else is a server defect: the detail
 * goes to the server log and the client gets a stable code, never driver
 * text, bind params, or internal ids. Clients render their own localized
 * fallback for the code and pin it beside the record.
 *
 * The backup gate's error class lives in invoice-backup next to the packet
 * assembler (which pulls PDF rendering this route must not load), so it is
 * matched by its stable code, not by instanceof.
 */
export function toActionFailure(error: unknown): {
  status: 403 | 404 | 422 | 500;
  body: { error?: string; code?: string; remedy?: string };
} {
  if (error instanceof PayrollError && error.message === "pay run not found") {
    return { status: 404, body: { error: "not_found" } };
  }
  // A stock movement touching another legal entity's stock is an
  // authorization boundary, not a validation miss.
  if (error instanceof InventoryOwnershipError) {
    return { status: 403, body: { error: error.message } };
  }
  if (
    error instanceof InventoryError ||
    error instanceof PostingError ||
    error instanceof ControlAccountsIncompleteError ||
    error instanceof PayrollError ||
    error instanceof SubmitError ||
    (error instanceof Error && (error as { code?: unknown }).code === "invoice_backup_required")
  ) {
    // A typed refusal may carry its machine identity for the operator's
    // next step (a bill refused until its lines are matched names the
    // match code and remedy the drawer offers). Only string codes and
    // remedies pass through — never driver text or internal ids.
    const record = error as { code?: unknown; remedy?: unknown };
    const body: { error?: string; code?: string; remedy?: string } = {
      error: (error as Error).message,
    };
    if (typeof record.code === "string" && record.code.trim() !== "") body.code = record.code;
    if (typeof record.remedy === "string" && record.remedy.trim() !== "")
      body.remedy = record.remedy;
    return { status: 422, body };
  }
  return { status: 500, body: { code: "internal_error" } };
}
