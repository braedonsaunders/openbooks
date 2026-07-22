import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { add, cmp, fromUnits, isZero, mulRate, roundDiv, sum, toUnits } from '@openbooks/engine/src/money.ts'
import { recognitionAccounts } from '@openbooks/engine/src/project-recognition.ts'
import { loadProjectType } from './project-type'
import { nextDocumentNumber } from './bills'

/**
 * Project billing engine — turns a billing_request (a pre-invoice work order)
 * into a `customer_invoice` DOCUMENT, modelled on order-cycle.ts convertOrder.
 * No parallel invoice table: the invoice is a document, posted later through the
 * existing kernel/customer_invoice rule. The generator consumes unbilled
 * billable time_entries + cost lines and stamps their provenance columns
 * (time_entries.invoiced_by_line_id, document_lines.billed_by_line_id) so
 * re-billing is idempotent — the same rows can never be billed twice.
 */

export class BillingError extends Error {}

interface GenerateResult {
  id: string
  documentNumber: string
  kind: string
}

/** Month/percent → multiplier string. markupPercent 15 → '1.15'. */
function markupMultiplier(markupPercent: unknown): string {
  try {
    const percentUnits = toUnits(String(markupPercent ?? '0'))
    if (percentUnits <= 0n) return '1.0000'
    return fromUnits(10_000n + roundDiv(percentUnits, 100n))
  } catch {
    return '1.0000'
  }
}

export async function generateInvoiceFromBillingRequest(
  orgId: string,
  userId: string,
  requestId: string,
): Promise<GenerateResult> {
  return db.transaction(async (tx) => {
    // Lock the request; only an open request can be invoiced.
    const reqRes = (await tx.execute(sql`
      select * from billing_requests where id = ${requestId} and org_id = ${orgId} for update
    `)) as unknown as { rows: any[] }
    const req = reqRes.rows[0]
    if (!req) throw new BillingError('Billing request not found')
    if (req.status !== 'open') throw new BillingError('This billing request has already been invoiced')

    const projRes = (await tx.execute(sql`
      select p.id, p.customer_id, p.billing_method, p.customer_po_number, p.subsidiary_id, p.custom,
             coalesce(s.base_currency,o.base_currency) as billing_currency
        from projects p join orgs o on o.id=p.org_id left join subsidiaries s on s.id=p.subsidiary_id
       where p.id = ${req.project_id} and p.org_id = ${orgId}
    `)) as unknown as { rows: any[] }
    const project = projRes.rows[0]
    if (!project) throw new BillingError('Project not found')
    if (!project.customer_id) throw new BillingError('The project has no customer to invoice')

    const billingMethod: string = req.billing_method_snapshot ?? project.billing_method ?? 'time_and_materials'
    const markup = markupMultiplier((project.custom ?? {}).markupPercent)
    // The project type's invoicing profile governs line building + the credit
    // account. Built-in types reproduce the legacy billing_method behaviour.
    const ptype = await loadProjectType(orgId, project.id)
    const invoicing = ptype.invoicingProfile

    const currency = project.billing_currency
    if (!currency) throw new BillingError('The project subsidiary has no functional currency')

    // A deterministic fallback income account (lowest number) for lines whose
    // item has no income account, and for draw-amount invoices.
    const defIncome = (await tx.execute(sql`
      select id from accounts where org_id = ${orgId} and type in ('income', 'income_other') and is_active
       order by number nulls last limit 1
    `)) as unknown as { rows: { id: string }[] }
    const defaultIncomeId = defIncome.rows[0]?.id ?? null

    // Fixed-price with revenue recognition configured: the invoice must relieve
    // the Unbilled receivable (contract asset) rather than credit income — the
    // revenue was already recognized over-time, so crediting income again would
    // double-count. Inert (falls back to income) unless the account is mapped.
    const recog = await recognitionAccounts(orgId)
    const fixedPriceCreditAcct =
      invoicing.revenueAccount === 'unbilled_receivable' && recog.unbilledReceivable ? recog.unbilledReceivable : defaultIncomeId

    // -- build the invoice lines ------------------------------------------
    interface BuiltLine {
      itemId: string | null
      accountId: string | null
      description: string | null
      quantity: string
      unitPrice: string
      amount: string
      taxCodeId: string | null
      employeeId: string | null
      timeEntryId: string | null
      timeTypeId: string | null
      /** Source cost line to stamp billed_by_line_id on (materials billing). */
      sourceCostLineId: string | null
      unit?: string | null
      equipmentUnitId?: string | null
      rateVersionId?: string | null
    }
    const built: BuiltLine[] = []

    if (billingMethod === 'draw_amount' || req.basis === 'draw_amount') {
      const amt = String(req.draw_amount ?? '0')
      if (!amt || isZero(amt)) throw new BillingError('Enter a draw amount to bill')
      if (!fixedPriceCreditAcct) throw new BillingError('No income account is configured to post the draw to')
      built.push({
        itemId: null,
        accountId: fixedPriceCreditAcct,
        description: req.invoice_description ?? 'Progress draw',
        quantity: '1',
        unitPrice: amt,
        amount: amt,
        taxCodeId: null,
        employeeId: null,
        timeEntryId: null,
        timeTypeId: null,
        sourceCostLineId: null,
      })
    } else if (req.basis === 'milestone' || invoicing.lineBuilder === 'milestone') {
      // Bill the selected (or all open) milestone schedule rows.
      const scheds = (await tx.execute(sql`
        select id, name, amount_billed from billing_schedules
         where org_id = ${orgId} and project_id = ${req.project_id} and billing_request_id is null
         order by sort_order
      `)) as unknown as { rows: any[] }
      if (scheds.rows.length === 0) throw new BillingError('No open milestones to bill on this project')
      if (!fixedPriceCreditAcct) throw new BillingError('No income account is configured to post milestones to')
      for (const m of scheds.rows) {
        const amt = String(m.amount_billed ?? '0')
        if (isZero(amt)) continue
        built.push({
          itemId: null,
          accountId: fixedPriceCreditAcct,
          description: m.name,
          quantity: '1',
          unitPrice: amt,
          amount: amt,
          taxCodeId: null,
          employeeId: null,
          timeEntryId: null,
          timeTypeId: null,
          sourceCostLineId: null,
        })
      }
    } else {
      // Time & materials / cost-plus: unbilled billable time + billable cost lines.
      const selected: string[] | null =
        req.basis === 'time_selection' && Array.isArray(req.selected_time_entry_ids)
          ? (req.selected_time_entry_ids as string[])
          : null
      const dateFilter = sql.join(
        [
          req.start_date ? sql` and te.worked_on >= ${req.start_date}` : sql``,
          req.cutoff_date ? sql` and te.worked_on <= ${req.cutoff_date}` : sql``,
        ],
        sql``,
      )
      const selFilter =
        selected && selected.length
          ? sql` and te.id = any(${`{${selected.join(',')}}`}::uuid[])`
          : sql``

      const timeRows = (await tx.execute(sql`
        select te.id, te.hours, te.cost_rate, te.bill_rate, te.item_id, te.time_type_id,
               te.employee_party_id, te.memo,
               i.income_account_id, i.default_rate, i.tax_code_id, i.name as item_name
          from time_entries te
          left join items i on i.id = te.item_id
         where te.org_id = ${orgId} and te.project_id = ${req.project_id}
           and te.status = 'approved' and te.is_billable and te.invoiced_by_line_id is null
           ${dateFilter}${selFilter}
         order by te.worked_on
      `)) as unknown as { rows: any[] }

      for (const te of timeRows.rows) {
        const rate =
          invoicing.lineBuilder === 'cost_plus'
            ? mulRate(String(te.cost_rate ?? '0'), markup)
            : String(te.bill_rate ?? te.default_rate ?? '0')
        const amount = mulRate(String(te.hours ?? '0'), rate)
        built.push({
          itemId: te.item_id,
          accountId: te.income_account_id ?? defaultIncomeId,
          description: te.memo || te.item_name || null,
          quantity: String(te.hours ?? '0'),
          unitPrice: rate,
          amount,
          taxCodeId: te.tax_code_id,
          employeeId: te.employee_party_id,
          timeEntryId: te.id,
          timeTypeId: te.time_type_id,
          sourceCostLineId: null,
        })
      }

      // Billable cost lines (materials/subs) on posted cost documents.
      const costRows = (await tx.execute(sql`
        select dl.id, dl.amount, dl.cost_multiplier, dl.description, dl.item_id, dl.quantity, dl.unit,
               dl.bill_rate, dl.bill_amount, dl.equipment_unit_id, dl.rate_version_id, d.kind,
               dl.rate_presentation, i.income_account_id, i.tax_code_id, i.name as item_name,
               coalesce(rc.components, '[]'::jsonb) as bill_components
          from document_lines dl
          join documents d on d.id = dl.document_id
          left join items i on i.id = dl.item_id
          left join lateral (
            select jsonb_agg(jsonb_build_object(
              'unitCode', c.unit_code, 'unitName', c.unit_name, 'quantity', c.quantity,
              'rate', c.rate, 'amount', c.amount
            ) order by c.sequence) as components
              from charge_rate_components c
             where c.document_line_id = dl.id and c.role = 'bill'
          ) rc on true
         where dl.org_id = ${orgId} and dl.project_id = ${req.project_id}
           and dl.is_billable and dl.billed_by_line_id is null
           and ((d.kind = 'project_charge' and d.status in ('approved','posted'))
             or (d.status = 'posted' and d.kind in ('vendor_bill', 'expense_report', 'card_charge', 'check')))
      `)) as unknown as { rows: any[] }

      for (const cl of costRows.rows) {
        const isProjectCharge = cl.kind === 'project_charge'
        const mult = cl.cost_multiplier && cmp(String(cl.cost_multiplier), '0') > 0 ? String(cl.cost_multiplier) : markup
        const amount = isProjectCharge ? String(cl.bill_amount ?? '0') : mulRate(String(cl.amount ?? '0'), mult)
        const components = isProjectCharge && cl.rate_presentation === 'rate_components' && Array.isArray(cl.bill_components)
          ? cl.bill_components
          : []
        if (components.length) {
          components.forEach((component: any, index: number) => built.push({
            itemId: cl.item_id,
            accountId: cl.income_account_id ?? defaultIncomeId,
            description: `${cl.description || cl.item_name || ''}${component.unitName ? ` — ${component.unitName}` : ''}` || null,
            quantity: String(component.quantity),
            unitPrice: String(component.rate),
            amount: String(component.amount),
            taxCodeId: cl.tax_code_id,
            employeeId: null,
            timeEntryId: null,
            timeTypeId: null,
            sourceCostLineId: index === 0 ? cl.id : null,
            unit: component.unitName ?? component.unitCode ?? cl.unit,
            equipmentUnitId: cl.equipment_unit_id,
            rateVersionId: cl.rate_version_id,
          }))
        } else {
          built.push({
            itemId: cl.item_id,
            accountId: cl.income_account_id ?? defaultIncomeId,
            description: cl.description || cl.item_name || null,
            quantity: isProjectCharge ? String(cl.quantity ?? '1') : '1',
            unitPrice: isProjectCharge ? String(cl.bill_rate ?? amount) : amount,
            amount,
            taxCodeId: cl.tax_code_id,
            employeeId: null,
            timeEntryId: null,
            timeTypeId: null,
            sourceCostLineId: cl.id,
            unit: cl.unit,
            equipmentUnitId: cl.equipment_unit_id,
            rateVersionId: cl.rate_version_id,
          })
        }
      }
    }

    if (built.length === 0) throw new BillingError('Nothing available to bill for the selected criteria')
    if (built.some((l) => !l.accountId)) {
      throw new BillingError('An income account is required — configure income accounts on the billable items')
    }

    // -- create the customer_invoice draft --------------------------------
    const documentNumber = await nextDocumentNumber(orgId, 'customer_invoice', 'INV-', project.subsidiary_id ?? undefined)
    const [created] = (await tx.execute(sql`
      insert into documents (org_id, kind, document_number, party_id, document_date, currency,
                             status, project_id, subsidiary_id, billing_method, is_final_invoice,
                             reference_number, memo, subtotal, tax_total, total, created_by)
      values (${orgId}, 'customer_invoice', ${documentNumber}, ${project.customer_id},
              ${new Date().toISOString().slice(0, 10)}, ${currency}, 'draft', ${req.project_id},
              ${project.subsidiary_id}, ${billingMethod === 'cost_plus' ? 'time_and_materials' : billingMethod},
              ${req.invoice_type === 'final'}, ${req.customer_po ?? project.customer_po_number},
              ${req.invoice_description}, '0', '0', '0', ${userId})
      returning id
    `)).rows as any[]
    const invoiceId = created.id

    const amounts: string[] = []
    let lineNo = 1
    for (const l of built) {
      const [line] = (await tx.execute(sql`
        insert into document_lines (org_id, document_id, line_number, item_id, account_id, description,
              quantity, unit, unit_price, amount, tax_code_id, employee_id, time_entry_id, time_type_id,
              is_billable, equipment_unit_id, rate_version_id, bill_rate, bill_amount, created_by)
        values (${orgId}, ${invoiceId}, ${lineNo}, ${l.itemId}, ${l.accountId}, ${l.description},
              ${l.quantity}, ${l.unit ?? null}, ${l.unitPrice}, ${l.amount}, ${l.taxCodeId}, ${l.employeeId},
              ${l.timeEntryId}, ${l.timeTypeId}, true, ${l.equipmentUnitId ?? null}, ${l.rateVersionId ?? null},
              ${l.unitPrice}, ${l.amount}, ${userId})
        returning id
      `)).rows as any[]
      const newLineId = line.id
      amounts.push(l.amount)
      // Write provenance so these rows can't be billed again.
      if (l.timeEntryId) {
        await tx.execute(sql`update time_entries set invoiced_by_line_id = ${newLineId} where id = ${l.timeEntryId} and org_id = ${orgId}`)
      }
      if (l.sourceCostLineId) {
        await tx.execute(sql`update document_lines set billed_by_line_id = ${newLineId} where id = ${l.sourceCostLineId} and org_id = ${orgId}`)
      }
      lineNo++
    }

    const subtotal = sum(amounts)
    await tx.execute(sql`
      update documents set subtotal = ${subtotal}, tax_total = '0', total = ${add(subtotal, '0')}, updated_by = ${userId}
      where id = ${invoiceId}
    `)

    // Advance milestone schedules consumed by this request.
    if (req.basis === 'milestone' || invoicing.lineBuilder === 'milestone') {
      await tx.execute(sql`
        update billing_schedules set billing_request_id = ${requestId}, percent_billed = coalesce(percent_complete, percent_billed), updated_by = ${userId}
         where org_id = ${orgId} and project_id = ${req.project_id} and billing_request_id is null
      `)
    }

    await tx.execute(sql`
      update billing_requests set status = 'invoiced', invoice_document_id = ${invoiceId}, updated_by = ${userId}
      where id = ${requestId}
    `)

    return { id: invoiceId, documentNumber, kind: 'customer_invoice' }
  })
}

// The delete/void provenance-release hook lives in engine (billing-provenance.ts)
// so every delete path can reach it; deleteDocument calls it for invoices.
