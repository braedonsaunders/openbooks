import 'server-only'
import { sql } from 'drizzle-orm'
import { db, inDbTransaction } from '@openbooks/engine/src/db.ts'
import { postDocument } from '@openbooks/engine/src/posting.ts'
import { submitAndReleaseIfUngated } from '@openbooks/engine/src/flows/index.ts'
import { cmp, div, isZero, mul, normalizeMoney, sum } from '@openbooks/engine/src/money.ts'
import { nextDocumentNumber } from './bills'
import { controlDeps } from './documents'
import { resolveItemRate } from './item-rates'
import type { RatePrice } from '@openbooks/engine/src/item-rate-pricing.ts'
import { canonicalDecimal } from './exact-decimal'
import { isFeatureEnabled } from './features'
import { businessToday } from '@openbooks/engine/src/business-date.ts'

/**
 * Project charges / resource usage — the native replacement for source platform's
 * SO(price)+PO(cost) workaround. A project_charge allocates a pooled,
 * already-incurred cost (non-inventory materials, equipment, internal services)
 * onto a project at a cost rate, carrying a billable rate for T&M. It posts
 * DR project COGS / CR cost pool (see the project_charge posting rule), and its
 * billable lines feed the T&M billing engine at their independently snapshotted
 * bill amount.
 */

export interface ChargeLineInput {
  itemId: string
  /** Usage in the item's configured base unit. */
  quantity: string
  equipmentUnitId?: string | null
  /**
   * The OPERATOR who ran the unit (→ parties, the same identity payroll uses).
   *
   * Captured here rather than inferred later because there is nowhere honest to
   * infer it from: a unit has no standing operator, and a field ticket routinely
   * carries a whole crew, so "the ticket's employee" is ambiguous the moment
   * more than one person worked it. An equipment incentive pays this person a
   * share of what this line billed, so the answer has to be recorded at the
   * moment somebody knows it.
   */
  employeeId?: string | null
  /** Cost per unit (job cost). Defaults to the item's default_cost. */
  costRate?: string | null
  /** Bill rate per unit (T&M price). Defaults to the item's default_rate. */
  billRate?: string | null
  description?: string | null
  /** Target project-COGS account (debit). Defaults to the item's expense account. */
  accountId?: string | null
  isBillable?: boolean
  /** Previously resolved immutable rate snapshot (for example from a field
   * ticket). Keeps its package-tier decomposition through approval. */
  rateSnapshot?: {
    rateVersionId: string | null
    baseUnit: string
    /** Normalized usage and the package unit entered on the source line. */
    baseQuantity?: string
    transactionUnitCode?: string | null
    invoicePresentation: 'summary' | 'rate_components'
    cost: RatePrice
    bill: RatePrice
  } | null
}

export interface ChargeInput {
  projectId: string
  /** Field Ticket that authorized and originated this charge. */
  fieldTicketId?: string | null
  referenceNumber?: string | null
  documentDate?: string | null
  lines: ChargeLineInput[]
}

export class ChargeError extends Error {}

/** Quantity columns are numeric(28,8); do not force ledger money scale. */
function exactQuantity(value: unknown, label: string): string {
  const exact = canonicalDecimal(value, 8)
  if (exact === null) throw new ChargeError(`${label} must be an exact decimal`)
  return exact
}

function exactMoney(value: unknown, label: string): string {
  const exact = canonicalDecimal(value, 4)
  if (exact === null) throw new ChargeError(`${label} must be an exact decimal`)
  try {
    return normalizeMoney(exact)
  } catch {
    throw new ChargeError(`${label} must be an exact decimal`)
  }
}

function exactMoneyOrNull(value: unknown, label: string): string | null {
  if (value == null || value === '') return null
  return exactMoney(value, label)
}

function exactPrice(price: RatePrice, label: string): RatePrice {
  return {
    amount: exactMoney(price.amount, `${label} amount`),
    components: price.components.map((component) => ({
      ...component,
      quantity: exactQuantity(component.quantity, `${label} component quantity`),
      rate: exactMoney(component.rate, `${label} component rate`),
      amount: exactMoney(component.amount, `${label} component amount`),
    })),
  }
}

export async function createProjectCharge(
  orgId: string,
  userId: string,
  input: ChargeInput,
  opts: { post?: boolean } = { post: true },
): Promise<{ id: string; documentNumber: string; approvalPending: boolean }> {
  if (!(await isFeatureEnabled(orgId, 'projects'))) throw new ChargeError('Projects feature is disabled')
  if (!input.lines?.length) throw new ChargeError('A charge needs at least one line')

  const created = await inDbTransaction(async (tx) => {
    const proj = (await tx.execute<{ id: string; subsidiary_id: string | null }>(sql`
      select id, subsidiary_id from projects where id = ${input.projectId} and org_id = ${orgId}
    `))
    if (!proj.rows[0]) throw new ChargeError('Project not found')
    if (input.fieldTicketId) {
      const ticket = (await tx.execute<{ id: string }>(sql`
        select id
          from documents
         where id = ${input.fieldTicketId}
           and org_id = ${orgId}
           and project_id = ${input.projectId}
           and kind = 'field_ticket'
         for update
      `))
      if (!ticket.rows[0]) {
        throw new ChargeError('The source Field Ticket does not belong to this project')
      }
    }
    const subsidiaryId = proj.rows[0].subsidiary_id
    const org = (await tx.execute<{ base_currency: string }>(sql`select base_currency from orgs where id = ${orgId}`))
    const currency = org.rows[0]?.base_currency ?? 'CAD'
    const documentNumber = await nextDocumentNumber(orgId, 'project_charge', 'CHG-', subsidiaryId ?? undefined)
    const docDate = input.documentDate ?? await businessToday(orgId)

    const [doc] = (await tx.execute(sql`
      insert into documents (org_id, kind, document_number, document_date, currency, status, project_id,
                             subsidiary_id, reference_number, subtotal, tax_total, total, created_by)
      values (${orgId}, 'project_charge', ${documentNumber}, ${docDate}, ${currency}, 'draft', ${input.projectId},
              ${subsidiaryId}, ${input.referenceNumber ?? null}, '0', '0', '0', ${userId})
      returning id
    `)).rows as any[]
    const docId = doc.id

    const amounts: string[] = []
    let lineNo = 1
    for (const line of input.lines) {
      const quantity = exactQuantity(line.quantity, 'Charge quantity')
      if (cmp(quantity, '0') <= 0) throw new ChargeError('Charge quantity must be greater than zero')
      const enteredCostRate = exactMoneyOrNull(line.costRate, 'Cost rate')
      const enteredBillRate = exactMoneyOrNull(line.billRate, 'Bill rate')
      const rateSnapshot = line.rateSnapshot == null ? null : {
        ...line.rateSnapshot,
        baseQuantity: line.rateSnapshot.baseQuantity == null
          ? line.rateSnapshot.baseQuantity
          : exactQuantity(line.rateSnapshot.baseQuantity, 'Base quantity'),
        cost: exactPrice(line.rateSnapshot.cost, 'Cost'),
        bill: exactPrice(line.rateSnapshot.bill, 'Bill'),
      }
      const item = (await tx.execute<any>(sql`
        select kind, default_cost, default_rate, expense_account_id, cost_recovery_account_id, tax_code_id, name, unit
          from items where id = ${line.itemId} and org_id = ${orgId}
      `))
      const it = item.rows[0]
      if (!it) throw new ChargeError('Item not found')
      if (line.equipmentUnitId) {
        const unit = (await tx.execute<{ charge_item_id: string; status: string; subsidiary_id: string }>(sql`
          select charge_item_id, status, subsidiary_id from equipment_units
           where id = ${line.equipmentUnitId} and org_id = ${orgId}
        `))
        if (!unit.rows[0]) throw new ChargeError('Equipment unit not found')
        if (unit.rows[0].status !== 'active') throw new ChargeError('Equipment unit is not active')
        if (unit.rows[0].charge_item_id !== line.itemId) throw new ChargeError('Equipment unit does not use the selected charge item')
        if (unit.rows[0].subsidiary_id !== subsidiaryId) throw new ChargeError('Equipment and project must use the same subsidiary')
      }
      if (line.employeeId) {
        // Validated at the service boundary, not just in the picker: this
        // column feeds a payroll rule, so a bad id must fail here rather than
        // become an equipment charge nobody can ever be paid for.
        const operator = (await tx.execute(sql`
          select 1 from employee_roles
           where party_id = ${line.employeeId} and org_id = ${orgId}
        `))
        if (!operator.rows[0]) throw new ChargeError('The operator must be an employee of this organization')
        if (!line.equipmentUnitId) {
          // An operator on a material or service charge would look like an
          // equipment attribution to every reader and to the incentive rule,
          // which keys on the unit.
          throw new ChargeError('Only an equipment charge line can record an operator')
        }
      }

      const resolved = rateSnapshot ?? (enteredCostRate == null && enteredBillRate == null
        ? await resolveItemRate({
            orgId, projectId: input.projectId, itemId: line.itemId,
            equipmentUnitId: line.equipmentUnitId, onDate: docDate, baseQuantity: quantity,
          })
        : null)
      const costAmount = exactMoney(resolved?.cost.amount ?? mul(quantity, String(enteredCostRate ?? it.default_cost ?? '0')), 'Cost amount')
      const billAmount = exactMoney(resolved?.bill.amount ?? mul(quantity, String(enteredBillRate ?? it.default_rate ?? enteredCostRate ?? it.default_cost ?? '0')), 'Bill amount')
      // Unit rate back out of a resolved amount. A zero-quantity line has no
      // unit rate to derive, so fall back to the entered rate rather than
      // dividing by zero — which divRate reported as an invalid FX rate.
      const canDerive = resolved != null && !isZero(quantity)
      const costRate = normalizeMoney(canDerive ? div(costAmount, quantity) : String(enteredCostRate ?? it.default_cost ?? '0'))
      const billRate = normalizeMoney(canDerive ? div(billAmount, quantity) : String(enteredBillRate ?? it.default_rate ?? costRate))
      const accountId = line.accountId ?? it.expense_account_id
      if (!accountId) throw new ChargeError(`Item "${it.name}" needs an expense/COGS account to charge to a project`)
      if (!isZero(costAmount) && !it.cost_recovery_account_id) {
        throw new ChargeError(`Item "${it.name}" needs a cost recovery account for a nonzero cost charge`)
      }
      if (!isZero(costAmount) && it.cost_recovery_account_id === accountId) {
        throw new ChargeError(`Item "${it.name}" must use different cost and recovery accounts`)
      }
      const isBillable = line.isBillable ?? true
      const [insertedLine] = (await tx.execute(sql`
        insert into document_lines (org_id, document_id, line_number, item_id, account_id, description,
              quantity, unit, unit_price, amount, is_billable, project_id, equipment_unit_id, employee_id, rate_version_id,
              rate_presentation, base_quantity, base_unit, cost_rate, bill_rate, cost_amount, bill_amount,
              recovery_account_id, field_ticket_id, created_by)
        values (${orgId}, ${docId}, ${lineNo}, ${line.itemId}, ${accountId}, ${line.description ?? it.name},
              ${quantity}, ${resolved?.transactionUnitCode ?? resolved?.baseUnit ?? it.unit ?? null}, ${costRate}, ${costAmount}, ${isBillable}, ${input.projectId},
              ${line.equipmentUnitId ?? null}, ${line.employeeId ?? null}, ${resolved?.rateVersionId ?? null}, ${resolved?.invoicePresentation ?? 'summary'},
              ${resolved?.baseQuantity != null ? exactQuantity(resolved.baseQuantity, 'Base quantity') : quantity}, ${resolved?.baseUnit ?? it.unit ?? null},
              ${costRate}, ${billRate}, ${costAmount}, ${billAmount}, ${it.cost_recovery_account_id ?? null},
              ${input.fieldTicketId ?? null}, ${userId})
        returning id
      `)).rows as { id: string }[]

      const componentRows = [
        ...(resolved?.cost.components ?? [{ rateLineId: null, unitCode: resolved?.baseUnit ?? it.unit ?? 'unit', unitName: resolved?.baseUnit ?? it.unit ?? 'Unit', quantity, rate: costRate, amount: costAmount }]).map((c) => ({ ...c, role: 'cost' })),
        ...(resolved?.bill.components ?? [{ rateLineId: null, unitCode: resolved?.baseUnit ?? it.unit ?? 'unit', unitName: resolved?.baseUnit ?? it.unit ?? 'Unit', quantity, rate: billRate, amount: billAmount }]).map((c) => ({ ...c, role: 'bill' })),
      ]
      let componentSequence = 1
      for (const c of componentRows) {
        await tx.execute(sql`
          insert into charge_rate_components (org_id, document_line_id, role, rate_line_id, unit_code, unit_name,
                                               quantity, rate, amount, sequence, created_by)
          values (${orgId}, ${insertedLine.id}, ${c.role}, ${c.rateLineId}, ${c.unitCode}, ${c.unitName},
                  ${exactQuantity(c.quantity, 'Component quantity')}, ${exactMoney(c.rate, 'Component rate')},
                  ${exactMoney(c.amount, 'Component amount')}, ${componentSequence++}, ${userId})
        `)
      }
      amounts.push(costAmount)
      lineNo++
    }
    const subtotal = sum(amounts)
    await tx.execute(sql`update documents set subtotal = ${subtotal}, total = ${subtotal} where id = ${docId} and org_id = ${orgId}`)
    return { id: docId, documentNumber, totalCost: subtotal }
  })

  let approvalPending = false
  if (opts.post !== false) {
    const submission = await submitAndReleaseIfUngated('project_charge', created.id, userId)
    if (submission.flowError) {
      throw new ChargeError(`approval could not be routed: ${submission.flowError}`)
    }
    approvalPending = submission.gated
  }

  // Post outside the create transaction (postDocument runs on the shared pool).
  if (opts.post !== false && !approvalPending && !isZero(created.totalCost)) {
    const deps = await controlDeps(orgId)
    await postDocument(created.id, deps)
  }
  return { id: created.id, documentNumber: created.documentNumber, approvalPending }
}
