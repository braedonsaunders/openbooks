import 'server-only'

import { getMoneyFormatter } from '../../../lib/money-server'
import { orgInfo } from '../../../lib/data'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { grid, page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { subsidiaryVisibleFilter } from '../../../lib/subsidiaries'
import { StoredValueError } from '@openbooks/engine/stored-value'
import { withScopeSnapshot } from '@openbooks/engine/organization/scope'
import { isUuid, mergeHref, pickString } from '../../../lib/list-params'

/**
 * The stored-value register, split into a loader and a spec.
 *
 * Everyday path: KPIs + the masked-code account list + "Sell a gift card".
 * Configure depth (drawer tabs, Setup → Sales → programs) holds breakage
 * policy, expiry, and the liability home. Advanced depth (a collapsed
 * DisclosureSection in the drawer) holds journal links and the immutability
 * note. The list itself is the universal EntityListView
 * (`stored_value_account`); the spec carries only the record type, current
 * params, and drawer payloads — never an org id or a code secret.
 */

export interface StoredValueEntryRow {
  id: string
  kind: string
  kindLabel: string
  amountDisplay: string
  balanceAfterDisplay: string
  /** The same movement in the entity's functional currency, with its rate. */
  functionalDisplay: string
  rateDisplay: string
  reason: string | null
  documentId: string | null
  journalEntryId: string | null
  createdAt: string
}

export interface StoredValueAccountPayload {
  id: string
  kind: string
  kindLabel: string
  codeLast4: string
  customerName: string | null
  currency: string
  subsidiaryName: string
  functionalCurrency: string
  issuedDisplay: string
  balanceDisplay: string
  balanceFunctionalDisplay: string
  breakageDisplay: string
  status: string
  statusLabel: string
  expiresOn: string | null
  lastActivityOn: string
}

export interface StoredValueProgramPayload {
  id: string
  name: string
  kindLabel: string
  liabilityAccountName: string | null
  breakageIncomeAccountName: string | null
  breakagePolicyLabel: string
  breakageRateDisplay: string
  expiryMonths: number | null
  inactivityMonths: number
}

export interface StoredValueDrawerData {
  remountKey: string
  account: StoredValueAccountPayload
  program: StoredValueProgramPayload | null
  entries: StoredValueEntryRow[]
  /** Correction + offset pickers for the adjust tab (adjust permission only). */
  offsetAccounts: { id: string; name: string }[]
  canManage: boolean
  canAdjust: boolean
  closeHref: string
}

export interface StoredValueIssueData {
  programs: { id: string; name: string; kind: string; kindLabel: string; currency: string }[]
  customers: { id: string; name: string }[]
  debitAccounts: { id: string; name: string }[]
  /** Legal entities the caller may issue into: the only subsidiary options the form offers. */
  subsidiaries: { id: string; name: string }[]
  closeHref: string
}

export interface StoredValueData {
  title: string
  description: string
  emptyTitle: string
  emptyDescription: string
  issueLabel: string
  currentParams: Record<string, string | string[] | undefined>
  canManage: boolean
  kpis: { label: string; value: string }[]
  drawer: StoredValueDrawerData | null
  issue: StoredValueIssueData | null
}

/** Ledger precision is ten-thousandths: render minor units as an exact decimal string, never a float. */
function minorToDecimal(minor: bigint | string): string {
  const v = typeof minor === 'bigint' ? minor : BigInt(minor)
  const negative = v < 0n
  const abs = negative ? -v : v
  const whole = abs / 10000n
  const frac = (abs % 10000n).toString().padStart(4, '0').replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole.toString()}${frac ? `.${frac}` : ''}`
}

type KpiRow = { outstanding: string; issued: string; redeemed: string; breakage: string }
type AccountRow = {
  id: string; kind: string; code_last4: string; customer_name: string | null
  currency: string; issued_minor: string; balance_minor: string; breakage_recognized_minor: string
  subsidiary_name: string; functional_currency: string; functional_total: string
  status: string; expires_on: string | null; last_activity_on: string
  program_id: string; program_name: string; program_kind: string
  liability_account_name: string | null; breakage_income_account_name: string | null
  breakage_policy: string; breakage_rate: string; expiry_months: number | null; inactivity_months: number
}
type EntryRow = {
  id: string; kind: string; amount_minor: string; balance_after: string
  functional_amount_minor: string; fx_rate: string
  reason: string | null; document_id: string | null; journal_entry_id: string | null; created_at: string
}

export async function loadStoredValuePage(
  sp: Record<string, string | string[] | undefined>,
): Promise<StoredValueData> {
  const authz = await requirePermission('stored_value.read')
  await requireFeatureEnabled(authz.user.orgId, 'storedValue')
  const orgId = authz.user.orgId
  const canManage = can(authz, 'stored_value.manage')
  const canAdjust = can(authz, 'stored_value.adjust')
  const [t, org] = await Promise.all([getTranslations('storedValue'), orgInfo(orgId)])
  // No invented fallback currency: without the org row there is nothing to
  // sum in, so the page boundary renders this named refusal instead.
  const baseCurrency = org?.base_currency
  if (!baseCurrency) {
    throw new StoredValueError({
      message: 'The organization cannot be read, so stored-value balances have no currency to render in.',
      status: 422,
      code: 'stored_value_org_unreadable',
      remedy: 'Ask an administrator to verify the organization, then retry.',
    })
  }
  const { money } = await getMoneyFormatter(orgId)
  const accountId = pickString(sp.account)
  const issuing = pickString(sp.issue) === '1' && canManage
  // A restricted caller reads only their entities: every balance below
  // carries the visibility predicate, so KPIs can never expose foreign debt.
  // Unknown scope fails closed inside the shared filter, never as null.
  const scope = authz.allowedSubsidiaryIds

  // KPIs count base-currency accounts only: foreign-currency balances cannot
  // be summed without a rate, and a converted total would misstate the debt.
  // The fan-out reads run in one repeatable-read snapshot: every query still
  // carries its own visibility predicate, and the snapshot pins the state so
  // a concurrent entity rehome cannot mix visibility across the reads.
  const [summary, open, pickers, issuePickers] = await withScopeSnapshot(orgId, () => Promise.all([
    db.execute<KpiRow>(sql`
      select coalesce((select sum(balance_minor) from stored_value_accounts
        where org_id = ${orgId} and currency = ${baseCurrency} and status in ('active','frozen')
        ${subsidiaryVisibleFilter(sql`subsidiary_id`, scope)}), 0) as outstanding,
      coalesce((select sum(e.amount_minor) from stored_value_entries e
        where e.org_id = ${orgId} and e.currency = ${baseCurrency} and e.kind = 'issue'
          and e.created_at >= date_trunc('month', now())
          and exists (select 1 from stored_value_accounts a
            where a.org_id = e.org_id and a.id = e.account_id
            ${subsidiaryVisibleFilter(sql`a.subsidiary_id`, scope)})), 0) as issued,
      coalesce((select -sum(e.amount_minor) from stored_value_entries e
        where e.org_id = ${orgId} and e.currency = ${baseCurrency} and e.kind = 'redeem'
          and e.created_at >= date_trunc('month', now())
          and exists (select 1 from stored_value_accounts a
            where a.org_id = e.org_id and a.id = e.account_id
            ${subsidiaryVisibleFilter(sql`a.subsidiary_id`, scope)})), 0) as redeemed,
      coalesce((select -sum(e.amount_minor) from stored_value_entries e
        where e.org_id = ${orgId} and e.currency = ${baseCurrency} and e.kind = 'breakage'
          and e.created_at >= date_trunc('month', now())
          and exists (select 1 from stored_value_accounts a
            where a.org_id = e.org_id and a.id = e.account_id
            ${subsidiaryVisibleFilter(sql`a.subsidiary_id`, scope)})), 0) as breakage`),
    accountId && isUuid(accountId)
      ? db.execute<AccountRow>(sql`
          select sva.id, sva.kind, sva.code_last4, cust.display_name as customer_name,
                 sva.currency, sva.issued_minor, sva.balance_minor, sva.breakage_recognized_minor,
                 sub.name as subsidiary_name, sub.base_currency as functional_currency,
                 (select coalesce(sum(x.functional_amount_minor), 0)::text
                    from stored_value_entries x
                   where x.org_id = sva.org_id and x.account_id = sva.id) as functional_total,
                 sva.status, sva.expires_on::text, sva.last_activity_on::text,
                 svp.id as program_id, svp.name as program_name, svp.kind as program_kind,
                 la.name as liability_account_name, ba.name as breakage_income_account_name,
                 svp.breakage_policy, svp.breakage_rate, svp.expiry_months, svp.inactivity_months
            from stored_value_accounts sva
            join stored_value_programs svp on svp.org_id = sva.org_id and svp.id = sva.program_id
            join subsidiaries sub on sub.org_id = sva.org_id and sub.id = sva.subsidiary_id
            left join parties cust on cust.org_id = sva.org_id and cust.id = sva.customer_party_id
            left join accounts la on la.org_id = sva.org_id and la.id = svp.liability_account_id
            left join accounts ba on ba.org_id = sva.org_id and ba.id = svp.breakage_income_account_id
           where sva.org_id = ${orgId} and sva.id = ${accountId}
           ${subsidiaryVisibleFilter(sql`sva.subsidiary_id`, scope)}`)
      : null,
    accountId && isUuid(accountId)
      ? Promise.all([
        db.execute<EntryRow>(sql`
          select id, kind, amount_minor, balance_after, functional_amount_minor, fx_rate::text as fx_rate,
                 reason, document_id, journal_entry_id,
                 created_at::text from stored_value_entries
           where org_id = ${orgId} and account_id = ${accountId}
             and exists (select 1 from stored_value_accounts a
               where a.org_id = ${orgId} and a.id = ${accountId}
               ${subsidiaryVisibleFilter(sql`a.subsidiary_id`, scope)})
           order by created_at desc limit 100`),
        canAdjust
          ? db.execute<{ id: string; name: string }>(sql`
              select id, concat_ws(' · ', number, name) as name from accounts
               where org_id = ${orgId} and is_active and not is_summary
               order by number nulls last`)
          : { rows: [] as { id: string; name: string }[] },
      ])
      : null,
    issuing
      ? Promise.all([
        db.execute<{ id: string; name: string; kind: string; currency: string }>(sql`
          select id, name, kind, currency from stored_value_programs
           where org_id = ${orgId} and is_active order by name`),
        // Customer choices follow the shared org-wide party rule: parties
        // without an entity stay eligible to every caller, while entity-bound
        // parties stay inside their entity — no foreign customer names leak
        // into the picker.
        db.execute<{ id: string; name: string }>(sql`
          select id, display_name as name from parties
           where org_id = ${orgId} and is_active
           ${subsidiaryVisibleFilter(sql`subsidiary_id`, scope, { orgWideNull: true })}
           order by display_name limit 2000`),
        db.execute<{ id: string; name: string }>(sql`
          select id, concat_ws(' · ', number, name) as name from accounts
           where org_id = ${orgId} and is_active and not is_summary
             and type in ('bank','cash','undeposited') order by number nulls last`),
        // The only issuing entities the caller may use: elimination entities
        // never issue, and a restricted caller sees their allowed set alone.
        db.execute<{ id: string; name: string }>(sql`
          select id, name from subsidiaries
           where org_id = ${orgId} and is_active and not is_elimination
           ${subsidiaryVisibleFilter(sql`id`, scope)}
           order by name`),
      ])
      : null,
  ]))

  const closeHref = mergeHref('/stored-value', sp, { account: undefined, issue: undefined })
  const row = open?.rows[0] ?? null
  const drawer: StoredValueData['drawer'] = row && pickers
    ? {
      remountKey: String(row.id),
      account: {
        id: String(row.id),
        kind: String(row.kind),
        kindLabel: t(`kind.${row.kind}`),
        codeLast4: String(row.code_last4),
        customerName: row.customer_name,
        currency: String(row.currency),
        subsidiaryName: String(row.subsidiary_name),
        functionalCurrency: String(row.functional_currency),
        issuedDisplay: money(minorToDecimal(row.issued_minor), { currency: String(row.currency) }),
        balanceDisplay: money(minorToDecimal(row.balance_minor), { currency: String(row.currency) }),
        balanceFunctionalDisplay: money(minorToDecimal(row.functional_total), { currency: String(row.functional_currency) }),
        breakageDisplay: money(minorToDecimal(row.breakage_recognized_minor), { currency: String(row.currency) }),
        status: String(row.status),
        statusLabel: t(`status.${row.status}`),
        expiresOn: row.expires_on,
        lastActivityOn: String(row.last_activity_on),
      },
      program: {
        id: String(row.program_id),
        name: String(row.program_name),
        kindLabel: t(`kind.${row.program_kind}`),
        liabilityAccountName: row.liability_account_name,
        breakageIncomeAccountName: row.breakage_income_account_name,
        breakagePolicyLabel: t(`breakagePolicy.${row.breakage_policy}`),
        breakageRateDisplay: `${Number(row.breakage_rate) * 100}%`,
        expiryMonths: row.expiry_months,
        inactivityMonths: Number(row.inactivity_months),
      },
      entries: pickers[0].rows.map((e) => ({
        id: String(e.id),
        kind: String(e.kind),
        kindLabel: t(`entryKind.${e.kind}`),
        amountDisplay: money(minorToDecimal(e.amount_minor), { currency: String(row.currency) }),
        balanceAfterDisplay: money(minorToDecimal(e.balance_after), { currency: String(row.currency) }),
        functionalDisplay: money(minorToDecimal(e.functional_amount_minor), { currency: String(row.functional_currency) }),
        rateDisplay: String(e.fx_rate),
        reason: e.reason,
        documentId: e.document_id ? String(e.document_id) : null,
        journalEntryId: e.journal_entry_id ? String(e.journal_entry_id) : null,
        createdAt: String(e.created_at),
      })),
      offsetAccounts: pickers[1].rows,
      canManage,
      canAdjust,
      closeHref,
    }
    : null

  return {
    title: t('list.title'),
    description: t('list.description'),
    issueLabel: t('list.emptyAction'),
    emptyTitle: t('list.emptyTitle'),
    emptyDescription: t('list.emptyDescription'),
    currentParams: sp,
    canManage,
    kpis: [
      { label: t('kpi.outstanding'), value: money(minorToDecimal(summary.rows[0]?.outstanding ?? '0')) },
      { label: t('kpi.issuedThisPeriod'), value: money(minorToDecimal(summary.rows[0]?.issued ?? '0')) },
      { label: t('kpi.redeemedThisPeriod'), value: money(minorToDecimal(summary.rows[0]?.redeemed ?? '0')) },
      { label: t('kpi.breakageRecognized'), value: money(minorToDecimal(summary.rows[0]?.breakage ?? '0')) },
    ],
    drawer,
    issue: issuing && issuePickers
      ? {
        programs: issuePickers[0].rows.map((p) => ({
          id: String(p.id), name: String(p.name), kind: String(p.kind),
          kindLabel: t(`kind.${p.kind}`), currency: String(p.currency),
        })),
        customers: issuePickers[1].rows.map((c) => ({ id: String(c.id), name: String(c.name) })),
        debitAccounts: issuePickers[2].rows,
        subsidiaries: issuePickers[3].rows.map((s) => ({ id: String(s.id), name: String(s.name) })),
        closeHref,
      }
      : null,
  }
}

const f = ref<StoredValueData>()

export function storedValueSpec(data: StoredValueData): PageSpec {
  return page({
    route: '/stored-value',
    layout: 'list',
    header: [
      pageHeader({
        title: data.title,
        description: data.description,
        actionsClassName: 'flex flex-wrap items-center justify-end gap-2',
        actions: [
          widget('link-button', {
            href: mergeHref('/stored-value', data.currentParams, { issue: '1' }),
            label: data.issueLabel,
            iconKey: 'plus',
            variant: 'default',
          }, f('canManage')),
        ],
      }),
    ],
    body: [
      grid('space-y-5', [
        widgetBlock('kpi-strip', { items: data.kpis }),
        widgetBlock('entity-list-view', {
          recordType: 'stored_value_account',
          sp: data.currentParams,
          drawer: data.drawer ? { widget: 'stored-value-drawer', props: { drawer: data.drawer } } : null,
          emptyTitle: f('emptyTitle'),
          emptyDescription: f('emptyDescription'),
          emptyAction: data.canManage
            ? { widget: 'link-button', props: { href: '/stored-value?issue=1', label: data.issueLabel } }
            : null,
        }),
        ...(data.issue ? [widgetBlock('stored-value-issue', { issue: data.issue })] : []),
      ]),
    ],
  })
}
