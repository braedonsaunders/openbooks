import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
// Relative (not the bare workspace specifier): worktree node_modules resolves
// bare @openbooks/* to the main checkout, so engine predicates must bind this
// checkout by path — a bare import would scope reads by main's code.
import { apOpenAccountScope as sharedApOpenAccountScope } from '../../engine/src/records/open-item-scopes.ts'

/**
 * The one shared answer to "which ACCOUNTS carry open payables/receivables"
 * (0171, F-p3-001). Document-kind membership lives once in
 * engine/src/records/open-item-kinds.ts (AP_OPEN_ITEM_KINDS / AR_OPEN_ITEM_KINDS) —
 * this module never re-lists kinds, only the account side of the scope.
 *
 * An expense report contributes exactly its OUT-OF-POCKET portion by
 * construction: OOP legs post open to the designated employee-payable
 * control (admitted below), company-paid card legs are never stamped open,
 * and personal debits sit on the employee-receivable account outside the AP
 * scope — so no kind-list edit can ever route them into AP aging or a
 * reimbursement run.
 *
 * Deliberately NOT the client-safe AP_KINDS in web/lib/document-kinds.ts:
 * that list drives list/drawer routing (expense reports have their own
 * surface), while this one drives money. Merging them would reroute drawers.
 */

/**
 * AP-side open-item account scope over an accounts table expression (pass
 * sql`a` for a join aliased `a`). The predicate lives once in the engine
 * (./open-item-scopes.ts — the cash agent reads it directly and cannot
 * import this server-only module); this delegates so the web readers and the
 * agent can never disagree on which accounts carry payables.
 */
export function apOpenAccountScope(accounts: SQL, orgId: string): SQL {
  return sharedApOpenAccountScope(accounts, orgId)
}

/**
 * AR-side open-item account scope. Today this is exactly the historical
 * behavior (asset_receivable-typed accounts — the control policy admits no
 * other type for the AR control), stated here so both sides of every reader
 * derive from one module instead of one side being a bare literal.
 */
export function arOpenAccountScope(accounts: SQL): SQL {
  return sql`(${accounts}.type = 'asset_receivable')`
}

/**
 * AR-side CONTROL scope for the aging GL-tie residual (0171). Personal
 * employee-receivable debits age nowhere by design — they are open items on
 * a non-aging kind, collected through reimbursement offset or payroll, and
 * surfaced in the report drawer's net position — so the residual must not
 * count them, or every personal balance would land in AR aging as a
 * document-less row the AR tile (kind-filtered) never shows. `is distinct
 * from` keeps the predicate NULL-safe: with no designated receivable every
 * asset_receivable account still counts, exactly as before.
 */
export function arResidualAccountScope(accounts: SQL, orgId: string): SQL {
  return sql`(${accounts}.type = 'asset_receivable' and ${accounts}.id is distinct from (select (settings->'controlAccounts'->>'employeeReceivable')::uuid from orgs where id = ${orgId}))`
}
