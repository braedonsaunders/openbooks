import 'server-only'
import type { BillLineInput } from '@openbooks/engine/src/ledger/document-input.ts'
import { sql } from 'drizzle-orm'
import { db, type SqlExecutor } from '@openbooks/engine/src/platform/db.ts'
import { allocateDocumentNumber } from '@openbooks/engine/src/records/numbering.ts'
import { add, isZero, sum } from '@openbooks/engine/src/money/money.ts'
import {
  computeLineTaxes,
  type ComputedTaxComponent,
  type TaxCalculationType,
  type TaxComponentConfig,
} from '@openbooks/engine/src/tax/tax.ts'

/** One tax_codes row (or left-joined group member) as the profile loader reads it. */
interface TaxCodeProfileRow extends Record<string, unknown> {
  id: string | null
  code: string | null
  effective_rate: string | null
  recoverable_percent: string | null
  calculation_type: TaxCalculationType | null
  price_includes_tax: boolean | null
  compound_on_previous: boolean | null
  rounding_scale: number | null
  collected_account_id: string | null
  paid_account_id: string | null
  withholding_account_id: string | null
}
import {
  quoteExternalTax,
  readTaxRateProviderConfig,
  resolveCounterpartyTaxAddress,
  resolveEntityTaxAddress,
  resolveProviderTaxComponents,
  type Address,
  type ProviderDocumentKind,
  type TaxQuoteRequest,
  type TaxQuoteResult,
} from '@openbooks/engine/src/tax/rate-providers.ts'
import { resolveOrgId } from './org-scope'
import { requireEffectiveRateRow } from '@openbooks/engine/src/tax/persist.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'

export interface TaxProfiles {
  codes: Map<string, TaxComponentConfig[]>
  groups: Map<string, TaxComponentConfig[]>
}

/** Effective, ordered tax profiles for a transaction date. */
export async function taxProfileMap(orgId?: string, asOfDate?: string): Promise<TaxProfiles> {
  const resolvedOrgId = await resolveOrgId(orgId)
  const date = asOfDate ?? await businessToday(resolvedOrgId)
  const codeRows = (await db.execute<TaxCodeProfileRow>(sql`
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
  const config = (row: TaxCodeProfileRow, sequence: number, inclusive?: boolean): TaxComponentConfig => ({
    taxCodeId: String(row.id),
    code: String(row.code),
    sequence,
    // A NULL join result means "no rate row effective on the document date",
    // distinct from a matched statutory zero rate; the former is refused
    // instead of silently posting 0% tax with full calculation evidence.
    ratePercent: requireEffectiveRateRow(String(row.code), date, row.effective_rate),
    recoverablePercent: String(row.recoverable_percent),
    calculationType: row.calculation_type ?? undefined,
    priceIncludesTax: inclusive ?? Boolean(row.price_includes_tax),
    compoundOnPrevious: Boolean(row.compound_on_previous),
    roundingScale: Number(row.rounding_scale),
    collectedAccountId: row.collected_account_id,
    paidAccountId: row.paid_account_id,
    withholdingAccountId: row.withholding_account_id,
  })
  // A map may contain unrelated setup still awaiting its first rate. Omit
  // unusable profiles here; computeBillTotals refuses one only when selected.
  // A real zero-percent row remains usable.
  const codes = new Map<string, TaxComponentConfig[]>(codeRows.rows
    .filter((row) => row.effective_rate != null)
    .map((row) => [String(row.id), [config(row, 1)]]))

  const groupRows = (await db.execute<TaxCodeProfileRow>(sql`
    select tg.id as group_id, tg.price_includes_tax as group_inclusive,
           tgm.sequence, tc.id, tc.code, tc.is_active as code_active, tr.rate_percent::text as effective_rate,
           tc.recoverable_percent::text as recoverable_percent,
           tc.calculation_type, tc.compound_on_previous, tc.rounding_scale,
           tc.collected_account_id, tc.paid_account_id, tc.withholding_account_id
      from tax_groups tg
      join tax_group_members tgm on tgm.tax_group_id = tg.id
      left join tax_codes tc on tc.id = tgm.tax_code_id and tc.org_id = tg.org_id
      left join lateral (
        select rate_percent from tax_rates
         where org_id = ${resolvedOrgId} and tax_code_id = tc.id and effective_from <= ${date}
           and (effective_to is null or effective_to >= ${date})
         order by effective_from desc limit 1) tr on true
     where tg.org_id = ${resolvedOrgId} and tg.is_active
     order by tg.id, tgm.sequence
  `))
  const groups = new Map<string, TaxComponentConfig[]>()
  const unusableGroups = new Set<string>()
  for (const row of groupRows.rows) {
    const id = String(row.group_id)
    if (row.code_active !== true || row.effective_rate == null) {
      unusableGroups.add(id)
      continue
    }
    const members = groups.get(id) ?? []
    members.push(config(row, Number(row.sequence), Boolean(row.group_inclusive)))
    groups.set(id, members)
  }
  // Never turn a composite tax into a smaller tax by dropping an inactive,
  // missing or lapsed member. The entire selected group must be usable.
  for (const id of unusableGroups) groups.delete(id)
  return { codes, groups }
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
  subsidiaryId?: string | null
  /**
   * Document-level tax location override (documents.custom.taxProviderAddresses):
   * a side set here wins over the resolved snapshot for that side only, so an
   * explicit document location is quoted exactly as posting will replay it.
   */
  taxProviderAddresses?: {
    shipFrom?: Record<string, string | null>
    shipTo?: Record<string, string | null>
  } | null
  /**
   * Test-only local-stub switch, threaded to the provider fetch: lets tests
   * point the provider at a loopback stub. Never set by production callers
   * (document writers, the settings route).
   */
  allowPrivateEndpoints?: boolean
}

const PROVIDER_DOCUMENT_KINDS = new Set([
  'customer_invoice',
  'customer_credit',
  'vendor_bill',
  'vendor_credit',
])

const ADDRESS_KEYS = ['line1', 'city', 'region', 'postalCode', 'country'] as const

/** Shape-check a document-level address override; anything else refuses. */
function overrideAddress(
  value: unknown,
  side: string,
): Record<string, string | null> | null {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`document tax location override ${side} must be an address object`)
  }
  const cleaned: Record<string, string | null> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!(ADDRESS_KEYS as readonly string[]).includes(key)) {
      throw new Error(`document tax location override ${side} has an unknown field "${key}"`)
    }
    if (entry != null && typeof entry !== 'string') {
      throw new Error(`document tax location override ${side} field "${key}" must be text`)
    }
    cleaned[key] = entry ?? null
  }
  return Object.keys(cleaned).length ? cleaned : null
}

/**
 * Build BOTH sides of a provider request from real snapshots, by document
 * kind. Customer documents ship from the selling legal entity (the
 * document subsidiary, else the org) to the customer; vendor purchases ship
 * from the vendor to the receiving legal entity. Either side refuses by name
 * before any provider call when it cannot be resolved — an empty side used
 * to reach the adapters, which defaulted it to the US.
 */
async function providerRequestAddresses(
  options: ProviderBillTotalsOptions,
): Promise<{ shipFrom: Address; shipTo: Address }> {
  const isPurchase = options.kind === 'vendor_bill' || options.kind === 'vendor_credit'
  const counterparty = await resolveCounterpartyTaxAddress(
    options.orgId,
    options.partyId,
    isPurchase ? 'vendor' : 'customer',
  )
  const entity = await resolveEntityTaxAddress(options.orgId, options.subsidiaryId)
  let shipFrom: Address = isPurchase ? counterparty : entity.address
  let shipTo: Address = isPurchase ? entity.address : counterparty
  const customFrom = overrideAddress(options.taxProviderAddresses?.shipFrom, 'shipFrom')
  const customTo = overrideAddress(options.taxProviderAddresses?.shipTo, 'shipTo')
  if (customFrom) shipFrom = customFrom
  if (customTo) shipTo = customTo
  return { shipFrom, shipTo }
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

  const { shipFrom, shipTo } = await providerRequestAddresses(options)
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
      shipFrom,
      shipTo,
      // PROVIDER_DOCUMENT_KINDS gates this path to the four provider kinds,
      // so the kind always narrows to the request union here.
      documentKind: options.kind as ProviderDocumentKind,
      // The counterparty identity travels on every quote (the address
      // resolver above already refused a missing party), so the provider
      // keys exemption certificates per customer/vendor. For purchase kinds
      // this is the vendor id, which is what that provider type looks up.
      counterpartyCode: options.partyId ?? undefined,
      itemCode: line.custom?.taxItemCode == null ? null : String(line.custom.taxItemCode),
      quotedOn: options.documentDate,
    }
    let quote: TaxQuoteResult & { quoteId: string | null }
    try {
      quote = await quoteExternalTax(options.orgId, request, null, {
        persist: false,
        config: provider,
        ...(options.allowPrivateEndpoints ? { allowPrivateEndpoints: true } : {}),
      })
    } catch (error) {
      throw new Error(
        `configured tax provider ${provider.provider} failed for line: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    // Book the provider's per-jurisdiction amounts under their mapped tax
    // codes — never the local profile's split with a residual stuffed onto
    // the last component. A jurisdiction the mapping does not name refuses
    // here, before approval, instead of posting under the wrong code.
    let taxComponents: typeof line.taxComponents
    if (quote.components.length > 0) {
      try {
        taxComponents = await resolveProviderTaxComponents(
          options.orgId,
          request.taxableAmount,
          quote,
          provider.settings,
        )
      } catch (error) {
        throw new Error(
          `configured tax provider ${provider.provider} failed for line: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    } else if (isZero(quote.taxAmount)) {
      // A genuinely-nil quote (zero headline, no components) keeps the local
      // profile's zero booking so the line retains calculation evidence.
      const calculated = computeLineTaxes(request.taxableAmount, config, {
        overridden: true,
        taxAmount: quote.taxAmount,
      })
      taxComponents = calculated.components
    } else {
      throw new Error(
        `configured tax provider ${provider.provider} returned tax ${quote.taxAmount} with no components — recalculate the draft`,
      )
    }
    resolved.push({
      ...line,
      amount: line.amount,
      taxInputAmount: line.taxInputAmount,
      taxAmount: quote.taxAmount,
      taxOverridden: true,
      taxComponents,
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
 * canonical allocator (engine/src/records/numbering.ts). `subsidiaryId` is
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

