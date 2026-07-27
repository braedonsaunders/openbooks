import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { add, cmp, fromUnits, isZero, mulDecimal, mulPercent, roundDiv, sum, toUnits } from '@openbooks/engine/src/money.ts'
import { findLapsedRateCard, mergeCharges, priceAdjustments, resolveRateAdjustments } from './rate-adjustments'

/** Round money to the currency's minor unit, half away from zero. */
function toCents(amount: string): string {
  const units = toUnits(amount)
  const negative = units < 0n
  const magnitude = negative ? -units : units
  const rounded = roundDiv(magnitude, 100n) * 100n
  return fromUnits(negative ? -rounded : rounded)
}

/** The day the invoice is cut, or the period it closes. */
function invoiceDateOf(req: { cutoff_date?: string | null }): string {
  return req.cutoff_date ?? new Date().toISOString().slice(0, 10)
}

/** Prices are negotiated as of the date work was PERFORMED, not the day billed. */
function rateDateOf(lines: { workedOn?: string | null }[]): string | null {
  return lines.reduce<string | null>(
    (latest, l) => (l.workedOn && (!latest || l.workedOn > latest) ? l.workedOn : latest), null,
  )
}

/** Map a time type's name onto the buckets a rate-card adjustment can exclude. */
function timeKindOf(name: unknown): 'regular' | 'overtime' | 'double_time' | null {
  const n = String(name ?? '').toLowerCase()
  if (!n) return null
  if (n.includes('double')) return 'double_time'
  if (n.includes('over')) return 'overtime'
  return 'regular'
}
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

/** Negate a decimal safely — prefixing '-' breaks when the value is already negative. */
function negate(v: string): string {
  return fromUnits(-toUnits(String(v ?? '0')))
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
    const projectGate = (await tx.execute(sql`
      select coalesce((settings->'features'->>'projects')::boolean, true) as enabled
        from orgs where id = ${orgId}
    `)) as unknown as { rows: { enabled: boolean }[] }
    if (!projectGate.rows[0]?.enabled) throw new BillingError('Projects feature is disabled')
    // Lock the request; only an open request can be invoiced.
    const reqRes = (await tx.execute(sql`
      select * from billing_requests where id = ${requestId} and org_id = ${orgId} for update
    `)) as unknown as { rows: any[] }
    const req = reqRes.rows[0]
    if (!req) throw new BillingError('Billing request not found')
    if (req.status !== 'open') throw new BillingError('This billing request has already been invoiced')

    const projRes = (await tx.execute(sql`
      select p.id, p.customer_id, p.customer_po_number, p.subsidiary_id, p.custom,
             coalesce(s.base_currency,o.base_currency) as billing_currency
        from projects p join orgs o on o.id=p.org_id left join subsidiaries s on s.id=p.subsidiary_id
       where p.id = ${req.project_id} and p.org_id = ${orgId}
    `)) as unknown as { rows: any[] }
    const project = projRes.rows[0]
    if (!project) throw new BillingError('Project not found')
    if (!project.customer_id) throw new BillingError('The project has no customer to invoice')

    const markup = markupMultiplier((project.custom ?? {}).markupPercent)
    // The project type governs line building, the credit account, and the coarse
    // billing-method label snapshotted onto the invoice document.
    const ptype = await loadProjectType(orgId, project.id)
    const invoicing = ptype.invoicingProfile
    const billingMethod: string = req.billing_method_snapshot ?? ptype.billingMethod ?? 'time_and_materials'
    if (invoicing.billingProcedure === 'application_for_payment') {
      throw new BillingError('This project bills through applications for payment')
    }

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
      /** Pre-markup amount + whether this line is labor — for lump-sum markup. */
      baseAmount?: string
      isLabor?: boolean
      /** Item classification + time bucket, for rate-card adjustment targeting. */
      itemKind?: string | null
      itemCategory?: string | null
      departmentId?: string | null
      /** Date the work happened — the date its price is negotiated as of. */
      workedOn?: string | null
      /** True when the source line carried its own negotiated markup. */
      hasLineMarkup?: boolean
      timeKind?: 'regular' | 'overtime' | 'double_time' | null
    }
    const built: BuiltLine[] = []

    // A request that names a work-based basis is billing actual work, so it must
    // build from that work even when the project type defaults to milestones —
    // an explicit basis outranks the type's default line builder.
    const billsActualWork = req.basis === 'field_ticket' || req.basis === 'time_selection' || req.basis === 'date_range'

    if (req.basis === 'draw_amount') {
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
    } else if (req.basis === 'milestone' || (invoicing.lineBuilder === 'milestone' && !billsActualWork)) {
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
      // A field-ticket basis bills a SELECTION OF SIGNED CREW TICKETS as the unit
      // of work — the crew's week, approved and signed by the customer — rather
      // than an arbitrary date window. The tickets carry the labor; their span
      // scopes the cost billed alongside it.
      const ticketIds: string[] =
        req.basis === 'field_ticket' && Array.isArray((req.custom ?? {}).fieldTicketIds)
          ? ((req.custom as { fieldTicketIds: string[] }).fieldTicketIds ?? [])
          : []
      const ticketFilter = ticketIds.length
        ? sql` and te.field_ticket_id = any(${`{${ticketIds.join(',')}}`}::uuid[])`
        : sql``

      const timeRows = (await tx.execute(sql`
        select te.id, te.hours, te.cost_rate, te.bill_rate, te.item_id, te.time_type_id,
               te.employee_party_id, te.memo, te.department_id, te.worked_on,
               i.income_account_id, i.default_rate, i.tax_code_id, i.name as item_name,
               i.kind as item_kind, i.category as item_category, tt.name as time_type_name
          from time_entries te
          left join items i on i.id = te.item_id
          left join time_types tt on tt.id = te.time_type_id
         where te.org_id = ${orgId} and te.project_id = ${req.project_id}
           and te.status = 'approved' and te.is_billable and te.invoiced_by_line_id is null
           ${dateFilter}${selFilter}${ticketFilter}
         order by te.worked_on
      `)) as unknown as { rows: any[] }

      for (const te of timeRows.rows) {
        const rate =
          invoicing.lineBuilder === 'cost_plus'
            ? mulDecimal(String(te.cost_rate ?? '0'), markup)
            : String(te.bill_rate ?? te.default_rate ?? '0')
        const amount = mulDecimal(String(te.hours ?? '0'), rate)
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
          baseAmount: amount,
          isLabor: true,
          itemKind: te.item_kind ?? 'labor',
          itemCategory: te.item_category ?? null,
          timeKind: timeKindOf(te.time_type_name),
          departmentId: te.department_id ?? null,
          workedOn: te.worked_on ? String(te.worked_on).slice(0, 10) : null,
        })
      }

      // Cost is billed for the SAME period as the labor. Without this a progress
      // invoice cut for one month would sweep in every later month's unbilled
      // materials, because only the time query honoured the request's range.
      // On a field-ticket basis the cost billed alongside the labor is scoped by
      // the selected tickets' own span, so a ticket's materials travel with it.
      // Crews attach materials and equipment to the ticket they were consumed on,
      // so follow that link. Only fall back to the tickets' date span for lines
      // that carry no ticket of their own, or a ticket's own costs would be lost.
      const ticketSpan = ticketIds.length
        ? invoicing.ticketCostScope === 'ticket_or_period'
          ? sql` and (dl.field_ticket_id = any(${`{${ticketIds.join(',')}}`}::uuid[])
                or (dl.field_ticket_id is null and d.document_date between
                      (select min(document_date) from documents where org_id = ${orgId} and id = any(${`{${ticketIds.join(',')}}`}::uuid[]))
                  and (select max(document_date) from documents where org_id = ${orgId} and id = any(${`{${ticketIds.join(',')}}`}::uuid[]))))`
          : sql` and dl.field_ticket_id = any(${`{${ticketIds.join(',')}}`}::uuid[])`
        : sql``
      const costDateFilter = sql.join(
        [
          req.start_date ? sql` and d.document_date >= ${req.start_date}` : sql``,
          req.cutoff_date ? sql` and d.document_date <= ${req.cutoff_date}` : sql``,
        ],
        sql``,
      )
      // Billable cost lines (materials/subs/equipment) on the document kinds this
      // project type treats as cost sources — configurable, because tenants stage
      // priced billable items differently (purchase docs, or e.g. sales orders).
      const costKinds = invoicing.costSourceKinds?.length
        ? invoicing.costSourceKinds
        : ["vendor_bill", "expense_report", "card_charge", "check"]

      const costRows = (await tx.execute(sql`
        select dl.id,
               -- Order-family documents record the opposite sign to purchase
               -- documents (a sales-order line is revenue-side, so it is stored
               -- negative). Normalize to a positive "value to bill" so a
               -- configured order cost-source adds to the invoice instead of
               -- subtracting from it; a genuine credit still flips negative.
               (case when d.kind in ('sales_order','purchase_order') then -dl.amount else dl.amount end) as amount,
               dl.cost_multiplier, dl.markup_percent, dl.description, dl.item_id, dl.quantity, dl.unit,
               dl.bill_rate, dl.bill_amount, dl.equipment_unit_id, dl.rate_version_id, d.kind,
               coalesce(dl.department_id, d.department_id) as department_id, d.document_date,
               dl.rate_presentation, i.income_account_id, i.tax_code_id, i.name as item_name,
               i.kind as item_kind, i.category as item_category,
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
           -- An ORDER line is a commitment to bill the customer: that is what
           -- ordering the work means, so it carries no separate billable flag
           -- and source systems do not set one. Requiring the flag silently
           -- dropped every consumable and equipment charge staged on an order.
           and (dl.is_billable or d.kind in ('sales_order', 'purchase_order'))
           and dl.billed_by_line_id is null
           ${costDateFilter}${ticketSpan}
           and ((d.kind = 'project_charge' and d.status in ('approved','posted'))
             or (d.status in ('posted','approved') and d.kind = any(${`{${costKinds.join(",")}}`}::text[])))
      `)) as unknown as { rows: any[] }

      for (const cl of costRows.rows) {
        const isProjectCharge = cl.kind === 'project_charge'
        // A markup recorded ON THE LINE is the deal struck for that line and
        // wins outright — including an explicit zero, which bills at cost. Only
        // a line that says nothing falls back to the project type's markup.
        const base = String(cl.amount ?? '0')
        const amount = isProjectCharge
          ? String(cl.bill_amount ?? '0')
          : cl.markup_percent != null
            ? add(base, mulPercent(base, String(cl.markup_percent), 4))
            : mulDecimal(base, markup)
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
            itemKind: cl.item_kind ?? null,
            departmentId: cl.department_id ?? null,
            hasLineMarkup: cl.markup_percent != null,
            workedOn: cl.document_date ? String(cl.document_date).slice(0, 10) : null,
            unit: cl.unit,
            equipmentUnitId: cl.equipment_unit_id,
            rateVersionId: cl.rate_version_id,
            // Pre-markup base (cost documents only; project charges carry their own price).
            baseAmount: isProjectCharge ? amount : String(cl.amount ?? '0'),
          })
        }
      }

      // -- generalized invoice shaping (all config-driven; empty by default) ---
      // (1) Lump-sum markup: bill the cost lines at base and add ONE markup line
      //     for the aggregate markup, instead of embedding it in each line.
      if (invoicing.markupPresentation === 'lump_sum') {
        let markupTotal = '0'
        for (const l of built) {
          if (l.baseAmount == null || l.isLabor) continue
          const delta = add(l.amount, negate(l.baseAmount))
          if (cmp(delta, '0') > 0) {
            markupTotal = add(markupTotal, delta)
            l.amount = l.baseAmount
            l.unitPrice = l.baseAmount
            l.quantity = '1'
          }
        }
        if (cmp(markupTotal, '0') > 0) {
          built.push({
            itemId: null, accountId: defaultIncomeId, description: 'Markup', quantity: '1',
            unitPrice: markupTotal, amount: markupTotal, taxCodeId: null, employeeId: null,
            timeEntryId: null, timeTypeId: null, sourceCostLineId: null,
          })
        }
      }

    }

    // Rebill markup is NOT taken from the rate card's markup term: that term is
    // presentation 'included', meaning it is already embedded in the negotiated
    // labor rates rather than layered onto rebilled cost. Applying it to cost
    // lines double-charges it. A line's OWN markup is what prices that line.

    // An invoice is payable in the currency's minor unit, so every billed line
    // is rounded to the cent. Rate and markup arithmetic runs at four decimals
    // and legitimately lands on fractions of a cent; carrying those through to
    // the customer leaves an invoice that cannot actually be paid, and summing
    // them drifts the total against the same invoice cut anywhere else.
    for (const l of built) {
      l.amount = toCents(l.amount)
      if (l.baseAmount != null) l.baseAmount = toCents(l.baseAmount)
      if (l.quantity === '1') l.unitPrice = l.amount
    }

    // (2a) Present the same item as one line. Cost arrives one line per source
    //      document line — a welder issued three times is three lines — but the
    //      customer is billed for the item, so sum them. Labor keeps its own
    //      lines: hours are read per employee and day.
    if (invoicing.lineGrouping === 'per_item') {
      const grouped = new Map<string, (typeof built)[number]>()
      const kept: typeof built = []
      for (const l of built) {
        const key = l.isLabor || !l.itemId ? null : `${l.itemId}|${l.unitPrice}|${l.accountId}|${l.taxCodeId}`
        if (!key) { kept.push(l); continue }
        const prior = grouped.get(key)
        if (!prior) { grouped.set(key, l); kept.push(l); continue }
        prior.quantity = add(prior.quantity, l.quantity)
        prior.amount = add(prior.amount, l.amount)
        if (prior.baseAmount != null && l.baseAmount != null) prior.baseAmount = add(prior.baseAmount, l.baseAmount)
      }
      built.length = 0
      built.push(...kept)
    }

    const invoiceDate = invoiceDateOf(req)
    // Prices are negotiated as of the date work is PERFORMED, not the day the
    // invoice happens to be cut: re-billing or catching up on old work must not
    // silently apply today's card. Latest work date on the invoice wins, so a
    // period bills at the rates in force at its end.
    const rateDate = rateDateOf(built) ?? invoiceDate

    // (2b) Commercial adjustments from the customer's rate card — fuel/shift
    //      surcharges, negotiated markups, per-diem. Which lines each one
    //      measures, and whether it bills separately at all, is card
    //      configuration; nothing here is specific to a trade or tenant.
    if (built.length) {
      const lapsed = await findLapsedRateCard({ orgId, projectId: req.project_id, onDate: rateDate })
      if (lapsed && invoicing.rateCardLapse !== 'carry_forward') {
        throw new BillingError(
          `This customer's rate card expired on ${lapsed.lastEffectiveTo ?? 'an earlier date'} and none covers ${rateDate}. ` +
          'Extend or add a rate card before invoicing — billing now would drop the negotiated surcharges and markups.',
        )
      }
      // Carrying forward prices the work at the last card in force, never at a
      // later one: a card that starts after the work was done was not the deal.
      const cardDate = lapsed?.lastEffectiveTo ?? rateDate

      const departments = [...new Set(built.map((l) => l.departmentId ?? null))]
      const charges = mergeCharges(
        (await Promise.all(departments.map(async (departmentId) =>
          priceAdjustments(
            built.filter((l) => (l.departmentId ?? null) === departmentId).map((l) => ({
              amount: l.amount, itemId: l.itemId, itemKind: l.itemKind ?? null,
              departmentId, isLabor: l.isLabor === true, timeKind: l.timeKind ?? null,
            })),
            await resolveRateAdjustments({ orgId, projectId: req.project_id, onDate: cardDate, departmentId }),
          )))).flat(),
      )
      for (const c of charges) {
        const item = c.adjustment.itemId
          ? ((await tx.execute(sql`
              select income_account_id, tax_code_id from items
               where id = ${c.adjustment.itemId} and org_id = ${orgId}
            `)) as unknown as { rows: { income_account_id: string | null; tax_code_id: string | null }[] }).rows[0]
          : undefined
        built.push({
          itemId: c.adjustment.itemId, accountId: item?.income_account_id ?? defaultIncomeId,
          description: c.adjustment.name, quantity: '1', unitPrice: c.amount, amount: c.amount,
          taxCodeId: item?.tax_code_id ?? null, employeeId: null, timeEntryId: null,
          timeTypeId: null, sourceCostLineId: null,
        })
      }
    }

    // (3) Not-to-exceed cap: trim the cumulative invoiced total to the contract.
    if (invoicing.notToExceed && built.length) {
      const contractRes = (await tx.execute(sql`
        select coalesce(contract_value, 0)::text as contract from projects where id = ${req.project_id} and org_id = ${orgId}
      `)) as unknown as { rows: { contract: string }[] }
      const contract = contractRes.rows[0]?.contract ?? '0'
      if (cmp(contract, '0') > 0) {
        const invRes = (await tx.execute(sql`
          select coalesce(sum(subtotal), 0)::text as inv from documents
           where org_id = ${orgId} and project_id = ${req.project_id} and kind = 'customer_invoice' and status = 'posted'
        `)) as unknown as { rows: { inv: string }[] }
        const invoicedToDate = invRes.rows[0]?.inv ?? '0'
        const running = sum(built.map((l) => l.amount))
        const remaining = add(contract, negate(invoicedToDate))
        if (cmp(remaining, '0') <= 0) throw new BillingError('The not-to-exceed budget is fully invoiced')
        const over = add(running, negate(remaining))
        if (cmp(over, '0') > 0) {
          built.push({
            itemId: invoicing.notToExceedItemId ?? null, accountId: defaultIncomeId,
            description: 'Not-to-exceed cap adjustment', quantity: '1', unitPrice: negate(over),
            amount: negate(over), taxCodeId: null, employeeId: null, timeEntryId: null,
            timeTypeId: null, sourceCostLineId: null,
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
              ${invoiceDate}, ${currency}, 'draft', ${req.project_id},
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
    if (req.basis === 'milestone' || (invoicing.lineBuilder === 'milestone' && !billsActualWork)) {
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
