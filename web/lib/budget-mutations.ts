import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { normalizeMoney, toUnits } from '@openbooks/engine/src/money.ts'
import type { BudgetDimensions } from './budgets'
import { canonicalDecimal } from './exact-decimal'

export type BudgetCellInput = BudgetDimensions & {
  accountId: string
  periodId: string
  amount: string
  note?: string | null
}

export class BudgetMutationError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message)
  }
}

const MAX_UNITS = 9_999_999_999_999_999_999n

export function normalizeBudgetAmount(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') throw new BudgetMutationError('invalid_amount')
  const exact = canonicalDecimal(value, 4)
  if (exact === null) throw new BudgetMutationError('invalid_amount')
  let normalized: string
  try {
    normalized = normalizeMoney(exact)
  } catch {
    throw new BudgetMutationError('invalid_amount')
  }
  const units = toUnits(normalized)
  if (units > MAX_UNITS || units < -MAX_UNITS) throw new BudgetMutationError('amount_out_of_range')
  return normalized
}

function cellKey(cell: Pick<BudgetCellInput, 'accountId' | 'periodId'> & Partial<BudgetDimensions>) {
  return [
    cell.accountId,
    cell.periodId,
    cell.departmentId ?? '',
    cell.projectId ?? '',
    cell.locationId ?? '',
    cell.classId ?? '',
  ].join('|')
}

function uuidArray(ids: string[]) {
  return `{${[...new Set(ids)].join(',')}}`
}

/**
 * Transactional budget-cell save with optimistic concurrency and exact
 * before/after evidence. Approved/pending scenarios are rejected here and by
 * the database trigger installed with the budget-management migration.
 */
export async function saveBudgetCells(input: {
  scenarioId: string
  orgId: string
  actorId: string
  expectedRevision: number
  cells: BudgetCellInput[]
  source?: string
}): Promise<{ revision: number; changed: number }> {
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new BudgetMutationError('invalid_revision')
  }
  if (input.cells.length === 0 || input.cells.length > 1_000) {
    throw new BudgetMutationError('cells_must_contain_1_to_1000_rows')
  }

  const normalized = input.cells.map((cell) => ({
    ...cell,
    amount: normalizeBudgetAmount(cell.amount),
    note: typeof cell.note === 'string' ? cell.note.trim().slice(0, 2_000) || null : null,
    departmentId: cell.departmentId ?? null,
    projectId: cell.projectId ?? null,
    locationId: cell.locationId ?? null,
    classId: cell.classId ?? null,
  }))
  if (new Set(normalized.map(cellKey)).size !== normalized.length) {
    throw new BudgetMutationError('duplicate_cells_in_request')
  }

  return db.transaction(async (tx) => {
    const locked = (await tx.execute<{ status: string; revision: number; fiscal_year: number }>(sql`
      select id, status, revision, fiscal_year
        from budget_scenarios
       where id = ${input.scenarioId} and org_id = ${input.orgId}
       for update
    `))
    const scenario = locked.rows[0]
    if (!scenario) throw new BudgetMutationError('not_found', 404)
    if (scenario.status !== 'draft') throw new BudgetMutationError('budget_is_locked', 409)
    if (Number(scenario.revision) !== input.expectedRevision) throw new BudgetMutationError('revision_conflict', 409)

    const accountIds = normalized.map((cell) => cell.accountId)
    const periodIds = normalized.map((cell) => cell.periodId)
    const [accounts, periods] = (await Promise.all([
      tx.execute<{ id: string }>(sql`
        select id from accounts
         where org_id = ${input.orgId} and id = any(${uuidArray(accountIds)}::uuid[])
           and is_active and not is_summary
      `),
      tx.execute<{ id: string }>(sql`
        select id from accounting_periods
         where org_id = ${input.orgId} and id = any(${uuidArray(periodIds)}::uuid[])
           and fiscal_year = ${scenario.fiscal_year} and not is_adjustment
      `),
    ]))
    if (new Set(accounts.rows.map((row) => row.id)).size !== new Set(accountIds).size) {
      throw new BudgetMutationError('invalid_account')
    }
    if (new Set(periods.rows.map((row) => row.id)).size !== new Set(periodIds).size) {
      throw new BudgetMutationError('invalid_period')
    }

    const dimensionIds = {
      departmentId: [...new Set(normalized.map((cell) => cell.departmentId).filter((id): id is string => !!id))],
      projectId: [...new Set(normalized.map((cell) => cell.projectId).filter((id): id is string => !!id))],
      locationId: [...new Set(normalized.map((cell) => cell.locationId).filter((id): id is string => !!id))],
      classId: [...new Set(normalized.map((cell) => cell.classId).filter((id): id is string => !!id))],
    }
    const dimensionQueries = [
      dimensionIds.departmentId.length
        ? tx.execute<{ id: string }>(sql`select id from departments where org_id = ${input.orgId} and id = any(${uuidArray(dimensionIds.departmentId)}::uuid[])`)
        : Promise.resolve({ rows: [] as { id: string }[] }),
      dimensionIds.projectId.length
        ? tx.execute<{ id: string }>(sql`select id from projects where org_id = ${input.orgId} and id = any(${uuidArray(dimensionIds.projectId)}::uuid[])`)
        : Promise.resolve({ rows: [] as { id: string }[] }),
      dimensionIds.locationId.length
        ? tx.execute<{ id: string }>(sql`select id from locations where org_id = ${input.orgId} and id = any(${uuidArray(dimensionIds.locationId)}::uuid[])`)
        : Promise.resolve({ rows: [] as { id: string }[] }),
      dimensionIds.classId.length
        ? tx.execute<{ id: string }>(sql`select id from classes where org_id = ${input.orgId} and id = any(${uuidArray(dimensionIds.classId)}::uuid[])`)
        : Promise.resolve({ rows: [] as { id: string }[] }),
    ]
    const dimensionResults = await Promise.all(dimensionQueries)
    const dimensionExpected = [dimensionIds.departmentId, dimensionIds.projectId, dimensionIds.locationId, dimensionIds.classId]
    dimensionResults.forEach((result, index) => {
      if (result.rows.length !== dimensionExpected[index]!.length) throw new BudgetMutationError('invalid_dimension')
    })

    const beforeRows = (await tx.execute<Record<string, any>>(sql`
      select account_id, period_id, department_id, project_id, location_id, class_id, amount::text, note
        from budget_lines
       where org_id = ${input.orgId} and scenario_id = ${input.scenarioId}
         and account_id = any(${uuidArray(accountIds)}::uuid[])
         and period_id = any(${uuidArray(periodIds)}::uuid[])
    `))
    const before = new Map(
      beforeRows.rows.map((row) => [
        cellKey({
          accountId: row.account_id,
          periodId: row.period_id,
          departmentId: row.department_id,
          projectId: row.project_id,
          locationId: row.location_id,
          classId: row.class_id,
        }),
        { amount: row.amount, note: row.note },
      ]),
    )

    const evidence: Record<string, unknown>[] = []
    for (const cell of normalized) {
      const old = before.get(cellKey(cell)) ?? null
      if (toUnits(cell.amount) === 0n && !cell.note) {
        await tx.execute(sql`
          delete from budget_lines
           where org_id = ${input.orgId} and scenario_id = ${input.scenarioId}
             and account_id = ${cell.accountId} and period_id = ${cell.periodId}
             and department_id is not distinct from ${cell.departmentId}
             and project_id is not distinct from ${cell.projectId}
             and location_id is not distinct from ${cell.locationId}
             and class_id is not distinct from ${cell.classId}
        `)
        evidence.push({ ...cell, before: old, after: null })
      } else {
        await tx.execute(sql`
          insert into budget_lines
            (org_id, scenario_id, account_id, period_id, department_id, project_id, location_id, class_id,
             amount, note, created_by, updated_by)
          values
            (${input.orgId}, ${input.scenarioId}, ${cell.accountId}, ${cell.periodId}, ${cell.departmentId},
             ${cell.projectId}, ${cell.locationId}, ${cell.classId}, ${cell.amount}, ${cell.note},
             ${input.actorId}, ${input.actorId})
          on conflict on constraint budget_lines_cell do update set
            amount = excluded.amount, note = excluded.note, updated_at = now(), updated_by = excluded.updated_by
        `)
        evidence.push({ ...cell, before: old, after: { amount: cell.amount, note: cell.note } })
      }
    }

    const nextRevision = input.expectedRevision + 1
    await tx.execute(sql`
      update budget_scenarios
         set revision = ${nextRevision}, updated_at = now(), updated_by = ${input.actorId}
       where id = ${input.scenarioId} and org_id = ${input.orgId}
    `)
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${input.orgId}, 'budget_scenarios', ${input.scenarioId}, 'update',
        ${JSON.stringify({
          source: input.source ?? 'worksheet',
          revisionBefore: input.expectedRevision,
          revisionAfter: nextRevision,
          cells: evidence,
        })}::jsonb,
        ${input.actorId})
    `)
    return { revision: nextRevision, changed: normalized.length }
  })
}
