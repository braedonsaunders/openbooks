import 'server-only'
import { sql } from 'drizzle-orm'
import { db, type SqlExecutor } from '@openbooks/engine/src/db.ts'
import { allocateDocumentNumber } from '@openbooks/engine/src/document-numbering.ts'
import { add, sum } from '@openbooks/engine/src/money.ts'
import {
  computeLineTaxes,
  type ComputedTaxComponent,
  type TaxComponentConfig,
} from '@openbooks/engine/src/tax.ts'
import {
  quoteExternalTax,
  readTaxRateProviderConfig,
  type TaxQuoteRequest,
  type TaxQuoteResult,
} from '@openbooks/engine/src/tax-rate-providers.ts'
import { resolveOrgId } from './org-scope'
import { requireEffectiveRateRow } from '@openbooks/engine/src/tax-persist.ts'
import { businessToday } from '@openbooks/engine/src/business-date.ts'

export interface TaxProfiles {
  codes: Map<string, TaxComponentConfig[]>
  groups: Map<string, TaxComponentConfig[]>
}

/** Effective, ordered tax profiles for a transaction date. */
export async function taxProfileMap(orgId?: string, asOfDate?: string): Promise<TaxProfiles> {
  const resolvedOrgId = await resolveOrgId(orgId)
  const date = asOfDate ?? await businessToday(resolvedOrgId)
  const codeRows = (await db.execute<Record<string, unknown>>(sql`
    select tc.id, tc.code, tr.rate_percent::text as effective_rate,
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
  `))
  const config = (row: Record<string, any>, sequence: number, inclusive?: boolean): TaxComponentConfig => ({
    taxCodeId: String(row.id),
    code: String(row.code),
    sequence,
    // A NULL join result means "no rate row effective on the document date",
    // distinct from a matched statutory zero rate; the former is refused
    // instead of silently posting 0% tax with full calculation evidence.
    ratePercent: requireEffectiveRateRow(String(row.code), date, row.effective_rate),
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

  const groupRows = (await db.execute<Record<string, unknown>>(sql`
    select tg.id as group_id, tg.price_includes_tax as group_inclusive,
           tgm.sequence, tc.id, tc.code, tr.rate_percent::text as effective_rate,
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
  `))
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
  custom?: Record<string, unknown>
  /** Internal pre-persistence provider evidence; never accepted from API input. */
  providerQuote?: {
    providerConfigId: string
    request: TaxQuoteRequest
    result: TaxQuoteResult
  }
}

/** Pre-tax lines → per-line tax + document totals. Honors manual overrides. */
export function computeBillTotals(lines: BillLineInput[], profiles: TaxProfiles) {
  const computed = lines.map((l) => {
    // Provider evidence is minted by this module, never accepted from an API
    // caller. Strip the internal sidecar before carrying user line fields
    // forward into the persisted document shape.
    const line = { ...l }
    delete line.providerQuote
    if (line.taxCodeId && line.taxGroupId) throw new Error('select either a tax code or a tax group, not both')
    const config = line.taxGroupId
      ? profiles.groups.get(line.taxGroupId)
      : line.taxCodeId
        ? profiles.codes.get(line.taxCodeId)
        : []
    if ((line.taxCodeId || line.taxGroupId) && !config) throw new Error('selected tax profile is inactive or has no effective rate')
    const result = computeLineTaxes(line.amount, config ?? [], {
      overridden: line.taxOverridden,
      taxAmount: line.taxAmount,
    })
    return {
      ...line,
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

export interface ProviderBillTotalsOptions {
  orgId: string
  kind: string
  currency: string
  documentDate: string
  partyId?: string | null
}

const PROVIDER_DOCUMENT_KINDS = new Set([
  'customer_invoice',
  'customer_credit',
  'vendor_bill',
  'vendor_credit',
])

async function partyTaxAddress(orgId: string, partyId: string | null | undefined): Promise<Record<string, string | null>> {
  if (!partyId) return {}
  const result = await db.execute<Record<string, string | null>>(sql`
    select line1, city, region, postal_code as "postalCode", country
      from addresses
     where org_id = ${orgId} and party_id = ${partyId}
     order by is_default_shipping desc, is_default_billing desc, id asc
     limit 1
  `)
  return result.rows[0] ?? {}
}

/**
 * Compute document tax with the configured provider as the authoritative
 * source. Resolution is read/HTTP-only; callers persist the returned quote in
 * their own document transaction so an outage cannot leave partial writes.
 */
export async function computeBillTotalsWithProvider(
  lines: BillLineInput[],
  profiles: TaxProfiles,
  options: ProviderBillTotalsOptions,
) {
  const local = computeBillTotals(lines, profiles)
  if (!PROVIDER_DOCUMENT_KINDS.has(options.kind)) return local
  const provider = await readTaxRateProviderConfig(options.orgId)
  if (!provider?.isEnabled || !provider.preferProvider || provider.provider === 'manual') return local

  const partyAddress = await partyTaxAddress(options.orgId, options.partyId)
  const resolved = [] as typeof local.lines
  for (const line of local.lines) {
    if (!line.taxCodeId && !line.taxGroupId) {
      resolved.push(line)
      continue
    }
    const config = line.taxGroupId
      ? profiles.groups.get(line.taxGroupId)
      : line.taxCodeId
        ? profiles.codes.get(line.taxCodeId)
        : []
    if (!config?.length) throw new Error('selected tax profile is inactive or has no effective rate')
    const request: TaxQuoteRequest = {
      taxableAmount: line.taxInputAmount,
      currency: options.currency,
      shipFrom: options.kind === 'vendor_bill' || options.kind === 'vendor_credit' ? partyAddress : {},
      shipTo: options.kind === 'vendor_bill' || options.kind === 'vendor_credit' ? {} : partyAddress,
      itemCode: line.custom?.taxItemCode == null ? null : String(line.custom.taxItemCode),
      quotedOn: options.documentDate,
    }
    let quote: TaxQuoteResult & { quoteId: string | null }
    try {
      quote = await quoteExternalTax(options.orgId, request, null, { persist: false, config: provider })
    } catch (error) {
      throw new Error(
        `configured tax provider ${provider.provider} failed for line: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const calculated = computeLineTaxes(request.taxableAmount, config, {
      overridden: true,
      taxAmount: quote.taxAmount,
    })
    resolved.push({
      ...line,
      amount: calculated.netAmount,
      taxInputAmount: calculated.inputAmount,
      taxAmount: calculated.taxTotal,
      taxOverridden: true,
      taxComponents: calculated.components,
      providerQuote: { providerConfigId: provider.id, request, result: quote },
    })
  }
  const subtotal = sum(resolved.map((line) => line.amount))
  const taxTotal = sum(resolved.map((line) => line.taxAmount))
  return { lines: resolved, subtotal, taxTotal, total: add(subtotal, taxTotal) }
}

type SqlRunner = SqlExecutor

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

/**
 * The UI entry point for document numbering — a thin delegate to the ONE
 * canonical allocator (engine/src/document-numbering.ts). `subsidiaryId` is
 * accepted for call-site compatibility. When supplied, its ownership is
 * checked against the organization before allocation; it never picks a
 * sequence because document numbers are organization-wide identities — every
 * generator shares the single org-wide counter per kind.
 */
export async function nextDocumentNumber(orgId: string, kind: string, prefix: string, subsidiaryId?: string | null) {
  if (subsidiaryId != null) {
    const subsidiary = await db.execute<{ id: string }>(sql`
      select id
        from subsidiaries
       where id = ${subsidiaryId} and org_id = ${orgId}
       limit 1
    `)
    if (!subsidiary.rows[0]) throw new Error('subsidiary does not belong to organization')
  }
  return allocateDocumentNumber(db, orgId, kind, prefix)
}

/** Full bill payload for the drawer: header + lines. */
export async function loadBill(id: string, orgId?: string) {
  const resolvedOrgId = await resolveOrgId(orgId)
  const doc = (await db.execute<Record<string, unknown>>(sql`
    select d.*, p.display_name as vendor_name, e.id as entry_id
      from documents d
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
      left join journal_entries e on e.id = d.posted_entry_id and e.org_id = d.org_id
     where d.id = ${id} and d.org_id = ${resolvedOrgId} and d.kind = 'vendor_bill'
  `))
  if (!doc.rows[0]) return null
  const lines = (await db.execute<Record<string, unknown>>(sql`
    select l.id, l.line_number, l.account_id, l.description, l.amount, l.tax_code_id, l.tax_amount,
           l.tax_overridden, l.department_id, l.project_id, l.custom
      from document_lines l
     where l.document_id = ${id} and l.org_id = ${resolvedOrgId}
     order by l.line_number
  `))
  return { doc: doc.rows[0], lines: lines.rows }
}
