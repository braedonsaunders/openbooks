import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { postDocument } from '@openbooks/engine/src/posting.ts'
import { mulRate, divRate, sum } from '@openbooks/engine/src/money.ts'
import { nextDocumentNumber } from './bills'
import { controlDeps } from './documents'

/**
 * Project charges / resource usage — the native replacement for NetSuite's
 * SO(price)+PO(cost) workaround. A project_charge allocates a pooled,
 * already-incurred cost (non-inventory materials, equipment, internal services)
 * onto a project at a cost rate, carrying a billable rate for T&M. It posts
 * DR project COGS / CR cost pool (see the project_charge posting rule), and its
 * billable lines feed the T&M billing engine (billed at cost × markup).
 */

export interface ChargeLineInput {
  itemId: string
  quantity: string
  /** Cost per unit (job cost). Defaults to the item's default_cost. */
  costRate?: string | null
  /** Bill rate per unit (T&M price). Defaults to the item's default_rate. */
  billRate?: string | null
  description?: string | null
  /** Target project-COGS account (debit). Defaults to the item's expense account. */
  accountId?: string | null
  isBillable?: boolean
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
      const item = (await tx.execute(sql`
        select default_cost, default_rate, expense_account_id, cost_recovery_account_id, tax_code_id, name
          from items where id = ${line.itemId} and org_id = ${orgId}
      `)) as unknown as { rows: any[] }
      const it = item.rows[0]
      if (!it) throw new ChargeError('Item not found')
      const costRate = String(line.costRate ?? it.default_cost ?? '0')
      const billRate = String(line.billRate ?? it.default_rate ?? costRate)
      const amount = mulRate(String(line.quantity), costRate) // cost — what posts
      const accountId = line.accountId ?? it.expense_account_id
      if (!accountId) throw new ChargeError(`Item "${it.name}" needs an expense/COGS account to charge to a project`)
      // markup so the billing engine (cost × cost_multiplier) yields qty × billRate.
      const markup = Number(costRate) !== 0 ? divRate(billRate, costRate) : '1'
      const isBillable = line.isBillable ?? true
      await tx.execute(sql`
        insert into document_lines (org_id, document_id, line_number, item_id, account_id, description,
              quantity, unit_price, amount, cost_multiplier, is_billable, project_id, custom, created_by)
        values (${orgId}, ${docId}, ${lineNo}, ${line.itemId}, ${accountId}, ${line.description ?? it.name},
              ${line.quantity}, ${costRate}, ${amount}, ${markup}, ${isBillable}, ${input.projectId},
              ${JSON.stringify({ recoveryAccountId: it.cost_recovery_account_id ?? null, billRate, costRate })}::jsonb, ${userId})
      `)
      amounts.push(amount)
      lineNo++
    }
    const subtotal = sum(amounts)
    await tx.execute(sql`update documents set subtotal = ${subtotal}, total = ${subtotal} where id = ${docId}`)
    return { id: docId, documentNumber }
  })

  // Post outside the create transaction (postDocument runs on the shared pool).
  if (opts.post !== false) {
    const deps = await controlDeps(orgId)
    await postDocument(created.id, deps)
  }
  return created
}
