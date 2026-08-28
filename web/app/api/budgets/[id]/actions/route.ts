import { jsonObject, parseJsonBody } from "../../../../../lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { can, subsidiariesInScope } from '../../../../../lib/authz'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'
import { subsidiaryVisibleFilter } from '../../../../../lib/subsidiaries'
import { BudgetMutationError } from '../../../../../lib/budget-mutations'

export const runtime = 'nodejs'

type Action = 'archive' | 'copy' | 'copy_prior_actuals' | 'apply_source'

function dims(body: Record<string, unknown>) {
  const value = (key: string) => typeof body[key] === 'string' && isUuid(body[key] as string) ? body[key] as string : null
  return {
    subsidiaryId: value('subsidiaryId'),
    departmentId: value('departmentId'),
    projectId: value('projectId'),
    locationId: value('locationId'),
    classId: value('classId'),
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('budgets.read', 'budgets')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Record<string, unknown>
  const action = body.action as Action
  if (!['archive', 'copy', 'copy_prior_actuals', 'apply_source'].includes(action)) {
    return NextResponse.json({ error: 'invalid_action' }, { status: 422 })
  }
  if (!can(gate, 'budgets.manage')) {
    return NextResponse.json({ error: 'missing permission: budgets.manage' }, { status: 403 })
  }
  const expectedRevision = Number(body.expectedRevision)
  if (!Number.isInteger(expectedRevision)) return NextResponse.json({ error: 'invalid_revision' }, { status: 422 })

  try {
    const result = await db.transaction(async (tx) => {
      const locked = (await tx.execute<Record<string, any>>(sql`
        select id, name, description, book_id, fiscal_year, kind, status, revision
          from budget_scenarios where id = ${id} and org_id = ${user.orgId} for update
      `))
      const scenario = locked.rows[0]
      if (!scenario) throw new BudgetMutationError('not_found', 404)
      if (Number(scenario.revision) !== expectedRevision) throw new BudgetMutationError('revision_conflict', 409)

      if (action === 'copy') {
        const targetYearRaw = Number(body.fiscalYear)
        const targetYear = Number.isInteger(targetYearRaw) ? targetYearRaw : Number(scenario.fiscal_year)
        const periods = (await tx.execute(sql`
          select 1 from accounting_periods
           where org_id = ${user.orgId} and fiscal_year = ${targetYear} and not is_adjustment limit 1
        `))
        if (!periods.rows[0]) throw new BudgetMutationError('target_year_has_no_periods')
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${user.orgId}:${scenario.book_id}:${targetYear}:${scenario.kind}`}, 0))`)
        const baseName = `${scenario.name} Copy`
        const existing = (await tx.execute<{ name: string }>(sql`
          select name from budget_scenarios
           where org_id = ${user.orgId} and book_id = ${scenario.book_id}
             and fiscal_year = ${targetYear} and kind = ${scenario.kind}
             and (name = ${baseName} or name like ${`${baseName} (%`})
        `))
        const used = new Set(existing.rows.map((row) => row.name))
        let name = baseName
        for (let i = 2; used.has(name); i++) name = `${baseName} (${i})`
        const created = (await tx.execute<{ id: string }>(sql`
          insert into budget_scenarios
            (org_id, book_id, fiscal_year, name, description, kind, status, created_by, updated_by)
          values (${user.orgId}, ${scenario.book_id}, ${targetYear}, ${name}, ${scenario.description},
                  ${scenario.kind}, 'draft', ${user.id}, ${user.id})
          returning id
        `))
        const newId = created.rows[0]!.id
        await tx.execute(sql`
          insert into budget_lines
            (org_id, scenario_id, account_id, period_id, subsidiary_id, department_id, project_id, location_id, class_id,
             amount, note, created_by, updated_by)
          select ${user.orgId}, ${newId}, bl.account_id, destination.id,
                 bl.subsidiary_id, bl.department_id, bl.project_id, bl.location_id, bl.class_id,
                 bl.amount, bl.note, ${user.id}, ${user.id}
            from budget_lines bl
            join accounting_periods source_period on source_period.id = bl.period_id and source_period.org_id = bl.org_id
            join accounting_periods destination
              on destination.org_id = ${user.orgId}
             and destination.fiscal_calendar_id = source_period.fiscal_calendar_id
             and destination.fiscal_year = ${targetYear}
             and destination.period_number = source_period.period_number
           where bl.org_id = ${user.orgId} and bl.scenario_id = ${id}
             ${subsidiaryVisibleFilter(sql`bl.subsidiary_id`, gate.allowedSubsidiaryIds)}
        `)
        await tx.execute(sql`
          insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
          values (${user.orgId}, 'budget_scenarios', ${newId}, 'insert',
            ${JSON.stringify({ copiedFrom: id, targetYear })}::jsonb, ${user.id})
        `)
        return { id: newId, revision: 1 }
      }

      if (action === 'copy_prior_actuals') {
        if (scenario.status !== 'draft') throw new BudgetMutationError('budget_is_locked', 409)
        const selected = dims(body)
        if (selected.subsidiaryId !== null && !subsidiariesInScope(gate, [selected.subsidiaryId])) {
          throw new BudgetMutationError('invalid_subsidiary')
        }
        // A selected dimension filters the source activity and stamps its value
        // onto every copied line. An unselected dimension is copied through:
        // each source line keeps its own value instead of being silently
        // collapsed into the NULL-dimension bucket.
        const sourceDimFilters = [
          selected.subsidiaryId === null ? null : sql`l.subsidiary_id is not distinct from ${selected.subsidiaryId}`,
          selected.departmentId === null ? null : sql`l.department_id is not distinct from ${selected.departmentId}`,
          selected.projectId === null ? null : sql`l.project_id is not distinct from ${selected.projectId}`,
          selected.locationId === null ? null : sql`l.location_id is not distinct from ${selected.locationId}`,
          selected.classId === null ? null : sql`l.class_id is not distinct from ${selected.classId}`,
        ].filter((predicate) => predicate !== null)
        // Clear exactly what this copy replaces: the selected dimensions'
        // existing lines, or the whole scenario when nothing narrows the scope.
        const clearDimFilters = [
          selected.subsidiaryId === null ? null : sql`subsidiary_id is not distinct from ${selected.subsidiaryId}`,
          selected.departmentId === null ? null : sql`department_id is not distinct from ${selected.departmentId}`,
          selected.projectId === null ? null : sql`project_id is not distinct from ${selected.projectId}`,
          selected.locationId === null ? null : sql`location_id is not distinct from ${selected.locationId}`,
          selected.classId === null ? null : sql`class_id is not distinct from ${selected.classId}`,
        ].filter((predicate) => predicate !== null)
        await tx.execute(sql`
          delete from budget_lines
           where org_id = ${user.orgId} and scenario_id = ${id}
             ${clearDimFilters.length > 0 ? sql`and ${sql.join(clearDimFilters, sql` and `)}` : sql``}
             ${subsidiaryVisibleFilter(sql`subsidiary_id`, gate.allowedSubsidiaryIds)}
        `)
        await tx.execute(sql`
          insert into budget_lines
            (org_id, scenario_id, account_id, period_id, subsidiary_id, department_id, project_id, location_id, class_id,
             amount, created_by, updated_by)
          select ${user.orgId}, ${id}, l.account_id, destination.id,
                 l.subsidiary_id, l.department_id, l.project_id, l.location_id, l.class_id,
                 sum(l.amount), ${user.id}, ${user.id}
            from journal_lines l
            join journal_entries e on e.id = l.entry_id and e.org_id = ${user.orgId} and e.status in ('posted', 'reversed')
            join accounts a on a.id = l.account_id and a.org_id = ${user.orgId}
            join accounting_periods source_period on source_period.id = e.period_id and source_period.org_id = e.org_id and source_period.fiscal_year = ${Number(scenario.fiscal_year) - 1}
            join accounting_periods destination
              on destination.org_id = ${user.orgId}
             and destination.fiscal_calendar_id = source_period.fiscal_calendar_id
             and destination.fiscal_year = ${scenario.fiscal_year}
             and destination.period_number = source_period.period_number
           where e.book_id = ${scenario.book_id}
             and a.type in ('income','income_other','cogs','expense','expense_other','expense_deferred')
             ${sourceDimFilters.length > 0 ? sql`and ${sql.join(sourceDimFilters, sql` and `)}` : sql``}
             ${subsidiaryVisibleFilter(sql`l.subsidiary_id`, gate.allowedSubsidiaryIds)}
           group by l.account_id, destination.id, l.subsidiary_id, l.department_id, l.project_id, l.location_id, l.class_id
          having sum(l.amount) <> 0
        `)
        const nextRevision = expectedRevision + 1
        await tx.execute(sql`
          update budget_scenarios set revision = ${nextRevision}, updated_at = now(), updated_by = ${user.id}
           where id = ${id} and org_id = ${user.orgId}
        `)
        await tx.execute(sql`
          insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
          values (${user.orgId}, 'budget_scenarios', ${id}, 'update',
            ${JSON.stringify({ action, sourceFiscalYear: Number(scenario.fiscal_year) - 1, dimensions: selected })}::jsonb,
            ${user.id})
        `)
        return { revision: nextRevision }
      }

      if (action === 'apply_source') {
        if (scenario.status !== 'draft') throw new BudgetMutationError('budget_is_locked', 409)
        const sourceScenarioId = typeof body.sourceScenarioId === 'string' && isUuid(body.sourceScenarioId)
          ? body.sourceScenarioId
          : null
        if (!sourceScenarioId || sourceScenarioId === id) throw new BudgetMutationError('invalid_source_scenario')
        const source = (await tx.execute<{ id: string }>(sql`
          select id from budget_scenarios where id = ${sourceScenarioId} and org_id = ${user.orgId}
        `))
        if (!source.rows[0]) throw new BudgetMutationError('invalid_source_scenario')
        await tx.execute(sql`
          delete from budget_lines
           where scenario_id = ${id} and org_id = ${user.orgId}
             ${subsidiaryVisibleFilter(sql`subsidiary_id`, gate.allowedSubsidiaryIds)}
        `)
        await tx.execute(sql`
          insert into budget_lines
            (org_id, scenario_id, account_id, period_id, subsidiary_id, department_id, project_id, location_id, class_id,
             amount, note, created_by, updated_by)
          select ${user.orgId}, ${id}, bl.account_id, destination.id,
                 bl.subsidiary_id, bl.department_id, bl.project_id, bl.location_id, bl.class_id,
                 bl.amount, bl.note, ${user.id}, ${user.id}
            from budget_lines bl
            join accounting_periods source_period on source_period.id = bl.period_id and source_period.org_id = bl.org_id
            join accounting_periods destination
              on destination.org_id = ${user.orgId}
             and destination.fiscal_calendar_id = source_period.fiscal_calendar_id
             and destination.fiscal_year = ${scenario.fiscal_year}
             and destination.period_number = source_period.period_number
           where bl.org_id = ${user.orgId} and bl.scenario_id = ${sourceScenarioId}
             ${subsidiaryVisibleFilter(sql`bl.subsidiary_id`, gate.allowedSubsidiaryIds)}
        `)
        const nextRevision = expectedRevision + 1
        await tx.execute(sql`
          update budget_scenarios set revision = ${nextRevision}, updated_at = now(), updated_by = ${user.id}
           where id = ${id} and org_id = ${user.orgId}
        `)
        await tx.execute(sql`
          insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
          values (${user.orgId}, 'budget_scenarios', ${id}, 'update',
            ${JSON.stringify({ action, sourceScenarioId })}::jsonb, ${user.id})
        `)
        return { revision: nextRevision, status: 'draft' }
      }

      if (!['draft', 'pending_approval', 'approved'].includes(scenario.status)) {
        throw new BudgetMutationError('invalid_status_transition', 409)
      }
      if (scenario.status === 'approved' && !can(gate, 'budgets.approve')) {
        throw new BudgetMutationError('approved_budget_requires_approver', 403)
      }
      const nextRevision = expectedRevision + 1
      await tx.execute(sql`
        update budget_scenarios set
          status = 'archived', revision = ${nextRevision},
          updated_at = now(), updated_by = ${user.id}
        where id = ${id} and org_id = ${user.orgId}
      `)
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${user.orgId}, 'budget_scenarios', ${id}, 'update',
          ${JSON.stringify({ action: 'archive', from: scenario.status, to: 'archived' })}::jsonb, ${user.id})
      `)
      return { revision: nextRevision, status: 'archived' }
    })
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof BudgetMutationError) return NextResponse.json({ error: error.message }, { status: error.status })
    throw error
  }
}
