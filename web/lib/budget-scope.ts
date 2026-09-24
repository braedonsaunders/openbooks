import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { BudgetMutationError } from './budget-mutations'

/**
 * Scenario-level subsidiary authority for budget scenarios.
 *
 * A scenario's lines can span subsidiaries, while the scenario-level
 * mutations (submit/approve/reject/archive, renames, deletes, cell saves,
 * imports, copies) act on the WHOLE scenario. A caller restricted to
 * subsidiary A must never decide, rename, delete or rewrite a scenario
 * that also carries B's lines — and must not learn a B-only scenario's
 * name, description or status through a read.
 *
 * Read routes (GET, export) answer 404 for a scenario with out-of-scope
 * lines — the caller sees only scenarios wholly within scope, matching the
 * house direct-record rule (guardSubsidiaryScope). Write routes refuse
 * with 403 naming the out-of-scope subsidiaries so the operator knows the
 * remedy (an in-scope approver must decide it).
 */

/** Distinct subsidiary ids a scenario's lines touch (null = unassigned). */
async function scenarioLineSubsidiaryIds(scenarioId: string, orgId: string): Promise<(string | null)[]> {
  const rows = (await db.execute<{ subsidiary_id: string | null }>(sql`
    select distinct subsidiary_id from budget_lines
     where org_id = ${orgId} and scenario_id = ${scenarioId}
  `))
  return rows.rows.map((row) => row.subsidiary_id)
}

/** The org's root subsidiary (the entity an unassigned line resolves to). */
async function rootSubsidiary(orgId: string): Promise<{ id: string; name: string } | null> {
  const rows = (await db.execute<{ id: string; name: string }>(sql`
    select id, name from subsidiaries
     where org_id = ${orgId}
       and parent_id is null and is_active and not is_elimination
     order by created_at, id
     limit 1
  `))
  return rows.rows[0] ?? null
}

/**
 * Names of the subsidiaries a scenario touches that sit outside the
 * caller's scope. Empty when the caller is unrestricted (null scope) or
 * the scenario is wholly within scope — including a line-less scenario,
 * which touches nothing. An unassigned (null) line resolves to the tenant
 * root, the same default the worksheet, import and storage trigger apply;
 * when the root itself is out of scope (or unresolvable) the line is
 * reported under the root's name (or 'unassigned').
 */
export async function scenarioOutOfScopeSubsidiaryNames(
  scenarioId: string,
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<string[]> {
  if (allowedSubsidiaryIds === null) return []
  const touched = await scenarioLineSubsidiaryIds(scenarioId, orgId)
  if (touched.length === 0) return []
  const outOfScopeIds = new Set<string>()
  let unassignedOutOfScope = false
  const root = touched.includes(null) ? await rootSubsidiary(orgId) : null
  for (const id of touched) {
    if (id === null) {
      if (!root || !allowedSubsidiaryIds.has(root.id)) unassignedOutOfScope = true
    } else if (!allowedSubsidiaryIds.has(id)) {
      outOfScopeIds.add(id)
    }
  }
  const names: string[] = []
  if (outOfScopeIds.size > 0) {
    const rows = (await db.execute<{ id: string; name: string }>(sql`
      select id, name from subsidiaries
       where org_id = ${orgId} and id = any(${`{${[...outOfScopeIds].join(',')}}`}::uuid[])
    `))
    const byId = new Map(rows.rows.map((row) => [row.id, row.name]))
    for (const id of [...outOfScopeIds].sort()) names.push(byId.get(id) ?? id)
  }
  if (unassignedOutOfScope) names.push(root?.name ?? 'unassigned')
  return names.sort()
}

/**
 * The named 403 refusal for a scenario-level write whose lines escape the
 * caller's scope. The message lists the out-of-scope subsidiaries so the
 * operator knows whose approver must act instead.
 */
export function outOfScopeScenarioError(names: string[]): BudgetMutationError {
  return new BudgetMutationError(`out_of_scope_subsidiaries: ${names.join(', ')}`, 403)
}
