import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { add, sum } from '@openbooks/engine/src/money.ts'
import {
  computeLineTaxes,
  type ComputedTaxComponent,
  type TaxComponentConfig,
} from '@openbooks/engine/src/tax.ts'
import { resolveOrgId } from './org-scope'

export interface TaxProfiles {
  codes: Map<string, TaxComponentConfig[]>
  groups: Map<string, TaxComponentConfig[]>
}

/** Effective, ordered tax profiles for a transaction date. */
export async function taxProfileMap(orgId?: string, asOfDate?: string): Promise<TaxProfiles> {
  const resolvedOrgId = await resolveOrgId(orgId)
  const date = asOfDate ?? new Date().toISOString().slice(0, 10)
  const codeRows = (await db.execute(sql`
    select tc.id, tc.code, coalesce(tr.rate_percent, 0)::text as rate,
           tc.recoverable_percent::text as recoverable_percent,
           tc.calculation_type, tc.price_includes_tax, tc.compound_on_previous,
           tc.rounding_scale, tc.collected_account_id, tc.paid_account_id,
           tc.withholding_account_id
      from tax_codes tc
      left join lateral (
        select rate_percent from tax_rates
         where org_id = ${resolvedOrgId} and tax_code_id = tc.id and effective_from <= ${date}
           and (effective_to is null or effective_to >= ${date})
         order by effective_from desc limit 1) tr on true
     where tc.org_id = ${resolvedOrgId} and tc.is_active
  `)) as unknown as { rows: Record<string, any>[] }
  const config = (row: Record<string, any>, sequence: number, inclusive?: boolean): TaxComponentConfig => ({
    taxCodeId: String(row.id),
    code: String(row.code),
    sequence,
    ratePercent: String(row.rate),
    recoverablePercent: String(row.recoverable_percent),
    calculationType: row.calculation_type,
    priceIncludesTax: inclusive ?? Boolean(row.price_includes_tax),
    compoundOnPrevious: Boolean(row.compound_on_previous),
    roundingScale: Number(row.rounding_scale),
    collectedAccountId: row.collected_account_id,
    paidAccountId: row.paid_account_id,
    withholdingAccountId: row.withholding_account_id,
  })
  const codes = new Map<string, TaxComponentConfig[]>(codeRows.rows.map((row) => [String(row.id), [config(row, 1)]]))

  const groupRows = (await db.execute(sql`
    select tg.id as group_id, tg.price_includes_tax as group_inclusive,
           tgm.sequence, tc.id, tc.code, coalesce(tr.rate_percent, 0)::text as rate,
           tc.recoverable_percent::text as recoverable_percent,
           tc.calculation_type, tc.compound_on_previous, tc.rounding_scale,
           tc.collected_account_id, tc.paid_account_id, tc.withholding_account_id
      from tax_groups tg
      join tax_group_members tgm on tgm.tax_group_id = tg.id
      join tax_codes tc on tc.id = tgm.tax_code_id and tc.org_id = tg.org_id and tc.is_active
      left join lateral (
        select rate_percent from tax_rates
         where org_id = ${resolvedOrgId} and tax_code_id = tc.id and effective_from <= ${date}
           and (effective_to is null or effective_to >= ${date})
         order by effective_from desc limit 1) tr on true
     where tg.org_id = ${resolvedOrgId} and tg.is_active
     order by tg.id, tgm.sequence
  `)) as unknown as { rows: Record<string, any>[] }
  const groups = new Map<string, TaxComponentConfig[]>()
  for (const row of groupRows.rows) {
    const id = String(row.group_id)
    const members = groups.get(id) ?? []
    members.push(config(row, Number(row.sequence), Boolean(row.group_inclusive)))
    groups.set(id, members)
  }
  return { codes, groups }
}

export interface BillLineInput {
  accountId: string
  description?: string | null
  amount: string
  taxCodeId?: string | null
  taxGroupId?: string | null
  /** Manual tax override: when true, `taxAmount` is honored instead of computed. */
  taxOverridden?: boolean
  taxAmount?: string | null
}

/** Pre-tax lines → per-line tax + document totals. Honors manual overrides. */
export function computeBillTotals(lines: BillLineInput[], profiles: TaxProfiles) {
  const computed = lines.map((l) => {
    if (l.taxCodeId && l.taxGroupId) throw new Error('select either a tax code or a tax group, not both')
    const config = l.taxGroupId
      ? profiles.groups.get(l.taxGroupId)
      : l.taxCodeId
        ? profiles.codes.get(l.taxCodeId)
        : []
    if ((l.taxCodeId || l.taxGroupId) && !config) throw new Error('selected tax profile is inactive or has no effective rate')
    const result = computeLineTaxes(l.amount, config ?? [], {
      overridden: l.taxOverridden,
      taxAmount: l.taxAmount,
    })
    return {
      ...l,
      amount: result.netAmount,
      taxInputAmount: result.inputAmount,
      taxAmount: result.taxTotal,
      taxOverridden: result.overridden,
      taxComponents: result.components,
    }
  })
  const subtotal = sum(computed.map((l) => l.amount))
  const taxTotal = sum(computed.map((l) => l.taxAmount))
  return { lines: computed, subtotal, taxTotal, total: add(subtotal, taxTotal) }
}

type SqlRunner = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> }

/** Persist the immutable calculation snapshot immediately after its document line. */
export async function persistLineTaxComponents(
  runner: SqlRunner,
  args: {
    orgId: string
    documentLineId: string
    components: ComputedTaxComponent[]
    actorId: string | null
  },
): Promise<void> {
  for (const component of args.components) {
    await runner.execute(sql`
      insert into document_line_tax_components
        (org_id, document_line_id, tax_code_id, sequence, rate_percent,
         taxable_amount, tax_amount, recoverable_amount, nonrecoverable_amount,
         calculation_type, price_includes_tax, compound_on_previous, rounding_scale,
         collected_account_id, paid_account_id, withholding_account_id, overridden,
         created_by, updated_by)
      values (${args.orgId}, ${args.documentLineId}, ${component.taxCodeId}, ${component.sequence},
              ${component.ratePercent}, ${component.taxableAmount}, ${component.taxAmount},
              ${component.recoverableAmount}, ${component.nonrecoverableAmount},
              ${component.calculationType}, ${component.priceIncludesTax},
              ${component.compoundOnPrevious}, ${component.roundingScale},
              ${component.collectedAccountId}, ${component.paidAccountId},
              ${component.withholdingAccountId}, ${component.overridden},
              ${args.actorId}, ${args.actorId})`)
  }
}

export async function nextDocumentNumber(orgId: string, kind: string, prefix: string, subsidiaryId?: string | null) {
  const requested = subsidiaryId ?? ((await db.execute(sql`
    select id from subsidiaries where org_id = ${orgId} and parent_id is null`)) as any).rows[0]?.id ?? null
  const configured = requested
    ? ((await db.execute(sql`
        select 1 from number_sequences
         where org_id = ${orgId} and document_kind = ${kind} and subsidiary_id = ${requested}
         limit 1`)) as any).rows.length > 0
    : false
  const sequenceSubsidiaryId = configured ? requested : null
  const seq = (await db.execute(sql`
    insert into number_sequences (org_id, document_kind, subsidiary_id, prefix)
    values (${orgId}, ${kind}, ${sequenceSubsidiaryId}, ${prefix})
    on conflict on constraint sequences_org_kind_sub
    do update set next_number = number_sequences.next_number + 1
    returning prefix, next_number, padding
  `)) as unknown as { rows: { prefix: string; next_number: number; padding: number }[] }
  const s = seq.rows[0]!
  return `${s.prefix}${String(s.next_number).padStart(s.padding, '0')}`
}

/** Full bill payload for the drawer: header + lines. */
export async function loadBill(id: string, orgId?: string) {
  const resolvedOrgId = await resolveOrgId(orgId)
  const doc = (await db.execute(sql`
    select d.*, p.display_name as vendor_name, e.id as entry_id
      from documents d
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
      left join journal_entries e on e.id = d.posted_entry_id and e.org_id = d.org_id
     where d.id = ${id} and d.org_id = ${resolvedOrgId} and d.kind = 'vendor_bill'
  `)) as unknown as { rows: Record<string, unknown>[] }
  if (!doc.rows[0]) return null
  const lines = (await db.execute(sql`
    select l.id, l.line_number, l.account_id, l.description, l.amount, l.tax_code_id, l.tax_amount,
           l.tax_overridden, l.department_id, l.project_id, l.custom
      from document_lines l
     where l.document_id = ${id} and l.org_id = ${resolvedOrgId}
     order by l.line_number
  `)) as unknown as { rows: Record<string, unknown>[] }
  return { doc: doc.rows[0], lines: lines.rows }
}
