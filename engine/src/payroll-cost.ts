import { sql } from 'drizzle-orm'
import { db } from './db.ts'
import { abs, add, fromUnits, isZero, mulRate, neg, sum, toUnits } from './money.ts'
import { postProjectGlEntryInTransaction, recognitionAccounts } from './project-recognition.ts'

type SqlExecutor = { execute(query: unknown): Promise<unknown> }
const resultRows = <T>(result: unknown) => (result as { rows: T[] }).rows

/** Largest-remainder allocation in numeric(19,4) units. It preserves the exact
 * signed total and uses input order as the deterministic final tie-break. */
export function allocateExact(total: string, weights: string[]): string[] {
  if (weights.length === 0) return []
  const totalUnits = toUnits(total)
  const sign = totalUnits < 0n ? -1n : 1n
  const target = totalUnits < 0n ? -totalUnits : totalUnits
  const units = weights.map((weight) => {
    const value = toUnits(weight)
    if (value < 0n) throw new Error('allocation weights cannot be negative')
    return value
  })
  const denominator = units.reduce((value, weight) => value + weight, 0n)
  if (denominator === 0n) throw new Error('allocation weights must include a positive value')
  const allocations = units.map((weight, index) => ({
    index,
    value: (target * weight) / denominator,
    remainder: (target * weight) % denominator,
  }))
  let remaining = target - allocations.reduce((value, item) => value + item.value, 0n)
  for (const item of [...allocations].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1)) {
    if (remaining === 0n) break
    item.value += 1n
    remaining -= 1n
  }
  return allocations.sort((a, b) => a.index - b.index).map((item) => fromUnits(item.value * sign))
}

export interface ExternalPayrollValidationResult {
  valid: boolean
  errors: string[]
  actualTotal: string
  actualTotalBase: string
}

export interface ExternalPayrollVarianceSource {
  projectId: string
  departmentId: string | null
  locationId: string | null
  amount: string
}

export interface ExternalPayrollVarianceLine {
  accountId: string
  amount: string
  projectId?: string | null
  departmentId?: string | null
  locationId?: string | null
  memo: string
}

export function externalPayrollClearingMatches(clearingDebit: string, actualEmployerCostBase: string): boolean {
  return toUnits(clearingDebit) === toUnits(actualEmployerCostBase)
}

/** Pure, exact projection used by the posting path and invariant tests. */
export function buildExternalPayrollVarianceLines(
  rows: ExternalPayrollVarianceSource[],
  projectCostAccountId: string,
  payrollClearingAccountId: string,
): ExternalPayrollVarianceLine[] {
  const projectLines = rows.filter((row) => !isZero(row.amount)).map((row) => ({
    accountId: projectCostAccountId,
    amount: row.amount,
    projectId: row.projectId,
    departmentId: row.departmentId,
    locationId: row.locationId,
    memo: 'External payroll actual-to-standard variance',
  }))
  if (!projectLines.length) return []
  return [
    ...projectLines,
    { accountId: payrollClearingAccountId, amount: neg(sum(projectLines.map((line) => line.amount))), memo: 'External payroll clearing' },
  ]
}

async function payrollFx(executor: SqlExecutor, orgId: string, currency: string, postingDate: string): Promise<string> {
  const org = resultRows<{ base_currency: string }>(await executor.execute(sql`select base_currency from orgs where id = ${orgId}`))[0]
  if (!org) throw new Error('organization not found')
  if (currency === org.base_currency) return '1.0000000000'
  const direct = resultRows<{ rate: string }>(await executor.execute(sql`
    select rate from fx_rates where org_id = ${orgId} and from_currency = ${currency} and to_currency = ${org.base_currency}
      and rate_type = 'spot' and as_of <= ${postingDate} order by as_of desc limit 1`))[0]
  if (direct) return String(direct.rate)
  const inverse = resultRows<{ rate: string }>(await executor.execute(sql`
    select (1 / rate)::numeric(19,10) as rate from fx_rates
     where org_id = ${orgId} and from_currency = ${org.base_currency} and to_currency = ${currency}
       and rate_type = 'spot' and as_of <= ${postingDate} order by as_of desc limit 1`))[0]
  if (inverse) return String(inverse.rate)
  throw new Error(`no spot FX rate converts ${currency} to ${org.base_currency} on or before ${postingDate}`)
}

/** Validate imported employer-cost detail against approved project time and,
 * in variance mode, the already-posted external payroll journal. No allocation
 * is created until every exception is resolved. */
export async function validatePayrollCostBatch(
  orgId: string,
  actorId: string,
  batchId: string,
): Promise<ExternalPayrollValidationResult> {
  return db.transaction(async (tx) => {
    const executor = tx as unknown as SqlExecutor
    const batch = resultRows<any>(await executor.execute(sql`
      select b.*, s.accounting_mode, s.payroll_clearing_account_id, s.require_posted_journal, s.is_active as source_active,
             o.settings #>> '{controlAccounts,laborClearing}' as standard_labor_clearing_account_id
        from payroll_cost_batches b join external_payroll_sources s on s.id = b.source_id and s.org_id = b.org_id
        join orgs o on o.id = b.org_id
       where b.id = ${batchId} and b.org_id = ${orgId} for update`))[0]
    if (!batch) throw new Error('external payroll cost batch not found')
    if (batch.status !== 'draft') throw new Error('only draft external payroll batches can be validated')
    const lines = resultRows<any>(await executor.execute(sql`
      select l.*, p.display_name
        from payroll_cost_lines l
        join parties p on p.id = l.employee_party_id and p.org_id = l.org_id
       where l.batch_id = ${batchId} and l.org_id = ${orgId}
         and exists (select 1 from employee_roles er where er.party_id = p.id and er.org_id = p.org_id and er.is_active)
       order by l.employee_party_id, l.external_line_id`))
    const errors: string[] = []
    if (!batch.source_active) errors.push('The external payroll source is inactive.')
    if (!lines.length) errors.push('Import at least one external payroll cost line.')
    const fxRate = await payrollFx(executor, orgId, batch.currency, String(batch.posting_date)).catch((error) => {
      errors.push((error as Error).message)
      return null
    })
    const actualTotal = sum(lines.map((line) => String(line.amount)))
    const actualTotalBase = fxRate ? sum(lines.map((line) => mulRate(String(line.amount), fxRate))) : '0.0000'
    const employees = [...new Set(lines.map((line) => String(line.employee_party_id)))]
    for (const employeeId of employees) {
      const time = resultRows<{ count: number; missing_snapshot: number; already_allocated: number; display_name: string }>(
        await executor.execute(sql`
          select count(*)::int as count,
                 count(*) filter (where te.standard_cost_amount is null)::int as missing_snapshot,
                 count(*) filter (where exists (
                   select 1 from payroll_time_allocations pa join payroll_cost_lines other_line on other_line.id = pa.payroll_line_id
                    where pa.time_entry_id = te.id and other_line.batch_id <> ${batchId}
                 ))::int as already_allocated,
                 max(p.display_name) as display_name
            from time_entries te
            join parties p on p.id = te.employee_party_id and p.org_id = te.org_id
            join projects pr on pr.id = te.project_id and pr.org_id = te.org_id
           where te.org_id = ${orgId} and te.employee_party_id = ${employeeId}
             and te.worked_on >= ${batch.period_start} and te.worked_on <= ${batch.period_end}
             and te.status = 'approved' and pr.subsidiary_id = ${batch.subsidiary_id}`))[0]
      const label = time?.display_name ?? employeeId
      if (!time || Number(time.count) === 0) errors.push(`${label} has no approved project time in this period and subsidiary.`)
      if (Number(time?.missing_snapshot ?? 0) > 0) errors.push(`${label} has approved time without a standard-cost snapshot.`)
      if (Number(time?.already_allocated ?? 0) > 0) errors.push(`${label} has time already reconciled by another external payroll batch.`)
    }
    if (batch.accounting_mode === 'variance_to_clearing') {
      if (!batch.payroll_clearing_account_id) {
        errors.push('Select a payroll clearing account on the external payroll source.')
      }
      if (!batch.standard_labor_clearing_account_id) {
        errors.push('Configure the company labor clearing account before using variance accounting.')
      } else if (batch.payroll_clearing_account_id !== batch.standard_labor_clearing_account_id) {
        errors.push('The external payroll source clearing account must match the company labor clearing account.')
      }
      if (batch.require_posted_journal && !batch.source_journal_document_id) {
        errors.push('Link the posted external payroll journal before validation.')
      }
      if (batch.source_journal_document_id) {
        const journal = resultRows<any>(await executor.execute(sql`
          select d.status, d.kind, d.subsidiary_id,
                 coalesce(sum(jl.amount) filter (where jl.account_id = ${batch.payroll_clearing_account_id}), 0)::numeric(19,4) as clearing_total
            from documents d left join journal_lines jl on jl.entry_id = d.posted_entry_id and jl.org_id = d.org_id
           where d.id = ${batch.source_journal_document_id} and d.org_id = ${orgId}
           group by d.id`))[0]
        if (!journal || journal.kind !== 'journal' || journal.status !== 'posted') {
          errors.push('The linked source transaction must be a posted journal.')
        } else {
          if (journal.subsidiary_id && journal.subsidiary_id !== batch.subsidiary_id) {
            errors.push('The source journal subsidiary does not match the external payroll batch.')
          }
          if (batch.payroll_clearing_account_id && !externalPayrollClearingMatches(String(journal.clearing_total), actualTotalBase)) {
            errors.push(`The source journal payroll-clearing debit (${journal.clearing_total}) must equal imported employer cost (${actualTotalBase}) in base currency.`)
          }
        }
      }
    }
    await executor.execute(sql`
      update payroll_cost_batches
         set status = ${errors.length ? 'draft' : 'validated'}, actual_total = ${actualTotal}, actual_total_base = ${actualTotalBase},
             exception_count = ${errors.length}, validation_errors = ${JSON.stringify(errors)}::jsonb,
             updated_at = now(), updated_by = ${actorId}
       where id = ${batchId} and org_id = ${orgId}`)
    return { valid: errors.length === 0, errors, actualTotal, actualTotalBase }
  })
}

export async function reconcilePayrollCostBatch(orgId: string, actorId: string, batchId: string): Promise<{ allocations: number; varianceTotal: string }> {
  return db.transaction(async (tx) => {
    const executor = tx as unknown as SqlExecutor
    const batch = resultRows<any>(await executor.execute(sql`
      select * from payroll_cost_batches where id = ${batchId} and org_id = ${orgId} for update`))[0]
    if (!batch) throw new Error('external payroll cost batch not found')
    if (batch.status !== 'validated') throw new Error('validate the external payroll batch before reconciliation')
    const lines = resultRows<any>(await executor.execute(sql`
      select * from payroll_cost_lines where batch_id = ${batchId} and org_id = ${orgId} order by employee_party_id, id`))
    if (!lines.length) throw new Error('add payroll cost lines before reconciliation')
    const fxRate = await payrollFx(executor, orgId, batch.currency, String(batch.posting_date))
    const employees = [...new Set(lines.map((line) => String(line.employee_party_id)))]
    const allTimes = resultRows<any>(await executor.execute(sql`
      select te.id, te.employee_party_id, te.project_id, te.project_task_id, te.department_id, te.location_id,
             te.hours, te.standard_cost_amount
        from time_entries te join projects p on p.id = te.project_id and p.org_id = te.org_id
       where te.org_id = ${orgId} and te.employee_party_id = any(${`{${employees.join(',')}}`}::uuid[])
         and te.worked_on >= ${batch.period_start} and te.worked_on <= ${batch.period_end}
         and te.status = 'approved' and p.subsidiary_id = ${batch.subsidiary_id}
         and not exists (
           select 1 from payroll_time_allocations pa join payroll_cost_lines pl on pl.id = pa.payroll_line_id
            where pa.time_entry_id = te.id and pl.batch_id <> ${batchId}
         ) order by te.employee_party_id, te.worked_on, te.id`))
    await executor.execute(sql`delete from payroll_time_allocations where payroll_line_id in (select id from payroll_cost_lines where batch_id = ${batchId})`)

    let allocationCount = 0
    const actualByTime = new Map<string, string>()
    const varianceByTime = new Map<string, string>()
    for (const employeeId of employees) {
      const employeeLines = lines.filter((line) => String(line.employee_party_id) === employeeId)
      const times = allTimes.filter((time) => String(time.employee_party_id) === employeeId)
      if (!times.length) throw new Error(`employee ${employeeId} has no approved project time in this batch period and subsidiary`)
      if (times.some((time) => time.standard_cost_amount == null)) throw new Error(`employee ${employeeId} has approved time without a standard-cost snapshot`)
      const actualLineTotals = employeeLines.map((line) => mulRate(String(line.amount), fxRate))
      const lineWeights = actualLineTotals.map(abs)
      const fallbackLineWeights = lineWeights.every(isZero) ? lineWeights.map((_, index) => index === 0 ? '1.0000' : '0.0000') : lineWeights
      const actualAllocations = employeeLines.map((_, lineIndex) => allocateExact(actualLineTotals[lineIndex], times.map((time) => String(time.hours))))
      const standardAllocations = times.map((time) => allocateExact(String(time.standard_cost_amount), fallbackLineWeights))
      for (let lineIndex = 0; lineIndex < employeeLines.length; lineIndex++) {
        for (let timeIndex = 0; timeIndex < times.length; timeIndex++) {
          const actualAmount = actualAllocations[lineIndex][timeIndex]
          const standardAmount = standardAllocations[timeIndex][lineIndex]
          const varianceAmount = add(actualAmount, neg(standardAmount))
          const line = employeeLines[lineIndex]
          const time = times[timeIndex]
          await executor.execute(sql`
            insert into payroll_time_allocations
              (org_id, payroll_line_id, time_entry_id, project_id, project_task_id, department_id, location_id,
               allocated_amount, standard_amount, variance_amount,
               created_by, updated_by)
            values (${orgId}, ${line.id}, ${time.id}, ${time.project_id}, ${time.project_task_id}, ${time.department_id}, ${time.location_id},
                    ${actualAmount}, ${standardAmount}, ${varianceAmount},
                    ${actorId}, ${actorId})`)
          actualByTime.set(time.id, add(actualByTime.get(time.id) ?? '0', actualAmount))
          varianceByTime.set(time.id, add(varianceByTime.get(time.id) ?? '0', varianceAmount))
          allocationCount++
        }
      }
    }
    for (const time of allTimes) {
      await executor.execute(sql`
        update time_entries set actual_cost_amount = ${actualByTime.get(time.id) ?? '0'},
                                cost_variance_amount = ${varianceByTime.get(time.id) ?? '0'},
                                payroll_batch_ref = ${batch.code}, updated_at = now(), updated_by = ${actorId}
         where id = ${time.id} and org_id = ${orgId}`)
    }
    const actualTotal = sum(lines.map((line) => String(line.amount)))
    const actualTotalBase = sum(lines.map((line) => mulRate(String(line.amount), fxRate)))
    const varianceTotal = sum([...varianceByTime.values()])
    await executor.execute(sql`
      update payroll_cost_batches set status = 'reconciled', actual_total = ${actualTotal}, actual_total_base = ${actualTotalBase},
                                      variance_total = ${varianceTotal}, exception_count = 0, validation_errors = '[]'::jsonb,
                                      updated_at = now(), updated_by = ${actorId}
       where id = ${batchId} and org_id = ${orgId}`)
    return { allocations: allocationCount, varianceTotal }
  })
}

export async function postPayrollCostBatch(orgId: string, actorId: string, batchId: string): Promise<string | null> {
  return db.transaction(async (tx) => {
    const executor = tx as unknown as SqlExecutor
    const batch = resultRows<any>(await executor.execute(sql`
      select b.*, s.accounting_mode, s.payroll_clearing_account_id, s.require_posted_journal,
             o.settings #>> '{controlAccounts,laborClearing}' as standard_labor_clearing_account_id
        from payroll_cost_batches b join external_payroll_sources s on s.id = b.source_id and s.org_id = b.org_id
        join orgs o on o.id = b.org_id
       where b.id = ${batchId} and b.org_id = ${orgId} for update`))[0]
    if (!batch) throw new Error('external payroll cost batch not found')
    if (batch.status === 'posted') return batch.variance_journal_entry_id
    if (batch.status !== 'reconciled') throw new Error('reconcile the external payroll batch before posting')
    const projectRows = resultRows<{ project_id: string; department_id: string | null; location_id: string | null; amount: string }>(await executor.execute(sql`
      select pa.project_id, pa.department_id, pa.location_id, sum(pa.variance_amount)::numeric(19,4) as amount
        from payroll_time_allocations pa join payroll_cost_lines pl on pl.id = pa.payroll_line_id
       where pl.batch_id = ${batchId} and pa.org_id = ${orgId} and pa.project_id is not null
       group by pa.project_id, pa.department_id, pa.location_id
       order by pa.project_id, pa.department_id nulls first, pa.location_id nulls first`))
    const nonzero = projectRows.filter((row) => !isZero(String(row.amount)))
    let journalEntryId: string | null = null
    if (batch.accounting_mode === 'variance_to_clearing') {
      if (!batch.payroll_clearing_account_id) throw new Error('the external payroll source has no payroll clearing account')
      if (batch.payroll_clearing_account_id !== batch.standard_labor_clearing_account_id) {
        throw new Error('the external payroll source clearing account must match the company labor clearing account')
      }
      if (batch.require_posted_journal || batch.source_journal_document_id) {
        const sourceJournal = resultRows<{ status: string; clearing_total: string }>(await executor.execute(sql`
          select d.status, coalesce(sum(jl.amount) filter (where jl.account_id = ${batch.payroll_clearing_account_id}), 0)::numeric(19,4) as clearing_total
            from documents d left join journal_lines jl on jl.entry_id = d.posted_entry_id and jl.org_id = d.org_id
           where d.id = ${batch.source_journal_document_id} and d.org_id = ${orgId}
           group by d.id`))[0]
        if (!sourceJournal || sourceJournal.status !== 'posted') throw new Error('the linked external payroll journal is not posted')
        if (!externalPayrollClearingMatches(String(sourceJournal.clearing_total), String(batch.actual_total_base))) {
          throw new Error('the external payroll journal no longer agrees with the validated employer-cost total')
        }
      }
    }
    if (batch.accounting_mode === 'variance_to_clearing' && nonzero.length) {
      const accounts = await recognitionAccounts(orgId, executor)
      if (!accounts.laborWip) throw new Error('the labor WIP control account must be configured')
      const lines = buildExternalPayrollVarianceLines(nonzero.map((row) => ({
        projectId: row.project_id,
        departmentId: row.department_id,
        locationId: row.location_id,
        amount: String(row.amount),
      })), accounts.laborWip, batch.payroll_clearing_account_id)
      journalEntryId = await postProjectGlEntryInTransaction(executor, {
        orgId,
        actorId,
        origin: 'payroll',
        entryNumber: `PAYVAR-${batch.code}`,
        postingDate: String(batch.posting_date),
        memo: `Payroll actual-to-standard variance ${batch.code}`,
        subsidiaryId: batch.subsidiary_id,
        lines,
      })
    }
    await executor.execute(sql`
      update payroll_cost_batches set status = 'posted', variance_journal_entry_id = ${journalEntryId},
                                      updated_at = now(), updated_by = ${actorId}
       where id = ${batchId} and org_id = ${orgId}`)
    return journalEntryId
  })
}
