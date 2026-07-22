import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { postDocument } from '@openbooks/engine/src/posting.ts'
import { cmp, divRate, isZero, mul, sum } from '@openbooks/engine/src/money.ts'
import { nextDocumentNumber } from './bills'
import { controlDeps } from './documents'
import { resolveItemRate } from './item-rates'
import type { RatePrice } from '@openbooks/engine/src/item-rate-pricing.ts'

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
  referenceNumber?: string | null
  documentDate?: string | null
  lines: ChargeLineInput[]
}

export class ChargeError extends Error {}

export async function createProjectCharge(
  orgId: string,
  userId: string,
  input: ChargeInput,
  opts: { post?: boolean } = { post: true },
): Promise<{ id: string; documentNumber: string }> {
  if (!input.lines?.length) throw new ChargeError('A charge needs at least one line')

  const created = await db.transaction(async (tx) => {
    const proj = (await tx.execute(sql`
      select id, subsidiary_id from projects where id = ${input.projectId} and org_id = ${orgId}
    `)) as unknown as { rows: { id: string; subsidiary_id: string | null }[] }
    if (!proj.rows[0]) throw new ChargeError('Project not found')
    const subsidiaryId = proj.rows[0].subsidiary_id
    const org = (await tx.execute(sql`select base_currency from orgs where id = ${orgId}`)) as unknown as {
      rows: { base_currency: string }[]
    }
    const currency = org.rows[0]?.base_currency ?? 'CAD'
    const documentNumber = await nextDocumentNumber(orgId, 'project_charge', 'CHG-', subsidiaryId ?? undefined)
    const docDate = input.documentDate ?? new Date().toISOString().slice(0, 10)

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
      if (cmp(String(line.quantity), '0') <= 0) throw new ChargeError('Charge quantity must be greater than zero')
      const item = (await tx.execute(sql`
        select kind, default_cost, default_rate, expense_account_id, cost_recovery_account_id, tax_code_id, name, unit
          from items where id = ${line.itemId} and org_id = ${orgId}
      `)) as unknown as { rows: any[] }
      const it = item.rows[0]
      if (!it) throw new ChargeError('Item not found')
      if (line.equipmentUnitId) {
        const unit = (await tx.execute(sql`
          select charge_item_id, status, subsidiary_id from equipment_units
           where id = ${line.equipmentUnitId} and org_id = ${orgId}
        `)) as unknown as { rows: { charge_item_id: string; status: string; subsidiary_id: string }[] }
        if (!unit.rows[0]) throw new ChargeError('Equipment unit not found')
        if (unit.rows[0].status !== 'active') throw new ChargeError('Equipment unit is not active')
        if (unit.rows[0].charge_item_id !== line.itemId) throw new ChargeError('Equipment unit does not use the selected charge item')
        if (unit.rows[0].subsidiary_id !== subsidiaryId) throw new ChargeError('Equipment and project must use the same subsidiary')
      }

      const resolved = line.rateSnapshot ?? (line.costRate == null && line.billRate == null
        ? await resolveItemRate({
            orgId, projectId: input.projectId, itemId: line.itemId,
            equipmentUnitId: line.equipmentUnitId, onDate: docDate, baseQuantity: String(line.quantity),
          })
        : null)
      const costAmount = resolved?.cost.amount ?? mul(String(line.quantity), String(line.costRate ?? it.default_cost ?? '0'))
      const billAmount = resolved?.bill.amount ?? mul(String(line.quantity), String(line.billRate ?? it.default_rate ?? line.costRate ?? it.default_cost ?? '0'))
      const costRate = resolved ? divRate(costAmount, String(line.quantity)) : String(line.costRate ?? it.default_cost ?? '0')
      const billRate = resolved ? divRate(billAmount, String(line.quantity)) : String(line.billRate ?? it.default_rate ?? costRate)
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
              quantity, unit, unit_price, amount, is_billable, project_id, equipment_unit_id, rate_version_id,
              rate_presentation, base_quantity, base_unit, cost_rate, bill_rate, cost_amount, bill_amount, recovery_account_id, created_by)
        values (${orgId}, ${docId}, ${lineNo}, ${line.itemId}, ${accountId}, ${line.description ?? it.name},
              ${line.quantity}, ${resolved?.transactionUnitCode ?? resolved?.baseUnit ?? it.unit ?? null}, ${costRate}, ${costAmount}, ${isBillable}, ${input.projectId},
              ${line.equipmentUnitId ?? null}, ${resolved?.rateVersionId ?? null}, ${resolved?.invoicePresentation ?? 'summary'},
              ${resolved?.baseQuantity ?? line.quantity}, ${resolved?.baseUnit ?? it.unit ?? null},
              ${costRate}, ${billRate}, ${costAmount}, ${billAmount}, ${it.cost_recovery_account_id ?? null}, ${userId})
        returning id
      `)).rows as { id: string }[]

      const componentRows = [
        ...(resolved?.cost.components ?? [{ rateLineId: null, unitCode: resolved?.baseUnit ?? it.unit ?? 'unit', unitName: resolved?.baseUnit ?? it.unit ?? 'Unit', quantity: line.quantity, rate: costRate, amount: costAmount }]).map((c) => ({ ...c, role: 'cost' })),
        ...(resolved?.bill.components ?? [{ rateLineId: null, unitCode: resolved?.baseUnit ?? it.unit ?? 'unit', unitName: resolved?.baseUnit ?? it.unit ?? 'Unit', quantity: line.quantity, rate: billRate, amount: billAmount }]).map((c) => ({ ...c, role: 'bill' })),
      ]
      let componentSequence = 1
      for (const c of componentRows) {
        await tx.execute(sql`
          insert into charge_rate_components (org_id, document_line_id, role, rate_line_id, unit_code, unit_name,
                                               quantity, rate, amount, sequence, created_by)
          values (${orgId}, ${insertedLine.id}, ${c.role}, ${c.rateLineId}, ${c.unitCode}, ${c.unitName},
                  ${c.quantity}, ${c.rate}, ${c.amount}, ${componentSequence++}, ${userId})
        `)
      }
      amounts.push(costAmount)
      lineNo++
    }
    const subtotal = sum(amounts)
    await tx.execute(sql`update documents set subtotal = ${subtotal}, total = ${subtotal} where id = ${docId}`)
    return { id: docId, documentNumber, totalCost: subtotal }
  })

  // Post outside the create transaction (postDocument runs on the shared pool).
  if (opts.post !== false && !isZero(created.totalCost)) {
    const deps = await controlDeps(orgId)
    await postDocument(created.id, deps)
  } else if (opts.post !== false) {
    // A zero-cost, positive-bill charge is deliberately non-posting. It is
    // approved for T&M billing without fabricating zero-value journal lines.
    await db.execute(sql`update documents set status = 'approved', updated_by = ${userId} where id = ${created.id}`)
  }
  return { id: created.id, documentNumber: created.documentNumber }
}
