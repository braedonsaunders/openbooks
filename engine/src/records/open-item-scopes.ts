import { sql, type SQL } from "drizzle-orm";

/**
 * The one shared answer to "which ACCOUNTS carry open payables" — the
 * account side of the open-item scope. (Document-kind membership lives once
 * in ./open-item-kinds.ts; this module never re-lists kinds, only the
 * account side.)
 *
 * A payable-side balance lives on a liability_payable account OR on the
 * org's designated employee-payable control, which the industry presets type
 * liability_current_other. An expense report contributes exactly its
 * OUT-OF-POCKET portion by construction: OOP legs post open to the
 * designated control (admitted here), company-paid card legs are never
 * stamped open, and personal debits sit on the employee-receivable account
 * outside the AP scope — so no kind-list edit can ever route them into AP
 * aging or a reimbursement run.
 *
 * Read by the web readers through web/lib/ledger-scope.ts (which delegates
 * here — never a second copy) and directly by the cash agent, which cannot
 * import the server-only web module. A bare `type = 'liability_payable'`
 * anywhere else silently drops every reimbursement payable from that reader.
 *
 * The settings writer validates the stored mapping, so the scalar
 * subquery's uuid cast cannot meet garbage — the same trust the document
 * posting places on it.
 */
export function apOpenAccountScope(accounts: SQL, orgId: string): SQL {
  return sql`(${accounts}.type = 'liability_payable' or ${accounts}.id = (select (settings->'controlAccounts'->>'employeePayable')::uuid from orgs where id = ${orgId}))`;
}
