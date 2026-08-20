import 'server-only'
import { NextResponse } from 'next/server'
import { REPORT_ENTITY_MAP } from '@openbooks/reports'
import { can, type Authz } from './authz'

/**
 * The entity gate for every path that can EXECUTE a stored report plan.
 *
 * `reports.read` says "you may use the reporting tools". It does not say which
 * data those tools may reach: the entity catalog marks sensitive entities with
 * their own `requiredPermission` (payroll registers, journals, employee totals
 * all demand `payroll.read`), and the built-in descriptions promise exactly
 * that — "Requires the payroll permission."
 *
 * The promise only holds if EVERY execution path checks it. Running a plan,
 * exporting it to CSV/XLSX/PDF, and drilling into its supporting rows all
 * return the same underlying rows, so all three owe the same gate; a saved view
 * owes it too (see `viewEntityPermission`, the sibling for the views catalog).
 * Enforcing it in one place is what keeps a new report surface from quietly
 * becoming a wage leak.
 *
 * Statement definitions carry no entity plan and are gated by the statement's
 * own permissions, so they return null here rather than being refused.
 */
export function reportEntityPermission(query: unknown): string | null {
  const entity = (query as { entity?: unknown } | null | undefined)?.entity
  if (typeof entity !== 'string') return null
  return REPORT_ENTITY_MAP[entity]?.requiredPermission ?? null
}

/** True when `authz` may execute a plan against this entity. */
export function canRunReportEntity(authz: Authz, query: unknown): boolean {
  const required = reportEntityPermission(query)
  return !required || can(authz, required)
}

/**
 * Refuse a plan whose entity demands more than the caller holds. Returns null
 * when allowed, so a route reads `const denied = guardReportEntity(...); if
 * (denied) return denied`.
 */
export function guardReportEntity(authz: Authz, query: unknown): NextResponse | null {
  if (canRunReportEntity(authz, query)) return null
  return NextResponse.json({ error: 'you do not have access to this data' }, { status: 403 })
}
