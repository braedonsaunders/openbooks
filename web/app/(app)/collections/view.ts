import 'server-only'

import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { page, ref, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../lib/authz'
import { isFeatureEnabled } from '../../../lib/features'
import { isUuid, pickString } from '../../../lib/list-params'
import { addCalendarDays } from '@openbooks/engine/platform/civil-date'
import { businessToday } from '@openbooks/engine/platform/business-date'
import { findCardsExpiringSoon, getRecoveryMetrics, MISSING_COLLECTION_POLICY } from '@openbooks/engine/payments/autopay'

/** The shell composes shared page chrome, registered lists and domain editors.
 * Permissions and feature dependencies are resolved before reaching the client. */

export interface CollectionsOption {
  id: string
  name?: string
  label?: string
}

export interface AttemptDrawerData {
  attempt: {
    id: string
    invoiceId: string
    invoiceNumber: string
    customerName: string
    amount: string
    currency: string
    provider: string
    providerRef: string | null
    methodLabel: string | null
    status: string
    declineCode: string | null
    declineKind: string | null
    retryPosition: number
    nextRetryOn: string | null
    authUrl: string | null
    usedBackup: boolean
    receiptId: string | null
    attemptedAt: string
  }
  canRetry: boolean
  closeHref: string
}

export interface RecoveryDashboardData {
  window: { from: string; to: string }
  metrics: {
    attempts: number
    invoicesWithFailures: number
    recoveredInvoices: number
    recoveredAmount: string
    recoveredByCurrency: { currency: string; amount: string }[]
    recoveryRate: number | null
    churnPrevented: number
    awaitingAuthentication: number
    byDeclineClass: { declineClass: string; failedAttempts: number; recoveredInvoices: number; recoveryRate: number | null }[]
    byProvider: { provider: string; failedAttempts: number; recoveredInvoices: number; recoveryRate: number | null }[]
  }
  awaitingAuth: {
    attemptId: string
    invoiceId: string
    invoiceNumber: string
    customerName: string
    amount: string
    currency: string
    authUrl: string | null
    attemptedAt: string
  }[]
  expiring: {
    methodId: string
    partyId: string
    partyName: string | null
    provider: string
    brand: string | null
    last4: string | null
    expiresOn: string
    currency: string
  }[]
  hardStuck: {
    attemptId: string
    invoiceNumber: string
    customerName: string
    amount: string
    currency: string
    declineCode: string | null
  }[]
}

/** A missing prerequisite rendered as a calm notice, never a page crash. */
export interface CollectionPolicyNotice {
  title: string
  description: string
  actionLabel: string
  actionHref: string
}

/**
 * The engine refuses recovery facts without an active collection policy;
 * that refusal carries a stable code (the message stays human copy) and the
 * page renders it as a notice while the rest of the worklist loads. Anything
 * else still throws.
 */
export function isMissingCollectionPolicy(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === MISSING_COLLECTION_POLICY
}

export interface CollectionsData {
  title: string
  description: string
  /** Availability of the receivables worklist, independently of configuration. */
  worklistHref: string | null
  worklistLabel: string
  /** Present while automatic collection is on but no collection policy is. */
  policyNotice: CollectionPolicyNotice | null
  subscriptionsEnabled: boolean
  advancedSubscriptionsEnabled: boolean
  customers: CollectionsOption[]
  incomeAccounts: CollectionsOption[]
  /** The automatic-collection queue renders only while the surface is on. */
  autopayOn: boolean
  /** Recovery facts for the dashboard; null while the surface is off. */
  recovery: RecoveryDashboardData | null
  currentParams: Record<string, string | string[] | undefined>
  attemptDrawer: ({ widget: 'collection-attempt-drawer'; props: { drawer: AttemptDrawerData & { remountKey: string } } }) | null
  attemptsEmptyTitle: string
  attemptsEmptyDescription: string
}

/**
 * Recovery facts for the dashboard cockpit: trailing-90-day metrics off
 * stored attempts, the authentication queue, cards nearing expiry and hard
 * declines with no backup on file. Bounded lists — the Reports hub owns the
 * full history.
 */
async function loadRecovery(orgId: string): Promise<RecoveryDashboardData> {
  const today = await businessToday(orgId)
  const window = { from: addCalendarDays(today, -89), to: addCalendarDays(today, 1) }
  const [metrics, expiringCards, awaitingAuthRows, hardStuckRows] = await Promise.all([
    getRecoveryMetrics(orgId, window),
    findCardsExpiringSoon(orgId, { asOf: today }),
    db.execute<{
      attemptId: string
      invoiceId: string
      invoiceNumber: string
      customerName: string
      amount: string
      currency: string
      authUrl: string | null
      attemptedAt: string
    }>(sql`
      select a.id as "attemptId", a.invoice_id as "invoiceId", d.document_number as "invoiceNumber",
             p.display_name as "customerName", a.amount::text as "amount", a.currency,
             a.auth_url as "authUrl",
             to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "attemptedAt"
        from collection_attempts a
        join documents d on d.id = a.invoice_id and d.org_id = a.org_id
        join parties p on p.id = d.party_id and p.org_id = d.org_id
       where a.org_id = ${orgId} and a.status = 'failed'
         and a.decline_kind = 'needs_authentication' and a.next_retry_on is null
       order by a.created_at desc
       limit 8
    `),
    db.execute<{
      attemptId: string
      invoiceNumber: string
      customerName: string
      amount: string
      currency: string
      declineCode: string | null
    }>(sql`
      select a.id as "attemptId", d.document_number as "invoiceNumber",
             p.display_name as "customerName", a.amount::text as "amount", a.currency,
             a.decline_code as "declineCode"
        from collection_attempts a
        join documents d on d.id = a.invoice_id and d.org_id = a.org_id
        join parties p on p.id = d.party_id and p.org_id = d.org_id
       where a.org_id = ${orgId} and a.status = 'failed' and a.decline_kind = 'hard'
         and a.next_retry_on is null and a.created_at >= ${addCalendarDays(today, -30)}::timestamptz
         and not exists (
           select 1 from customer_payment_methods m
            where m.org_id = a.org_id and m.party_id = d.party_id and m.status = 'active'
              and m.id <> a.payment_method_id
         )
       order by a.created_at desc
       limit 8
    `),
  ])
  const expiring = expiringCards.slice(0, 8)
  const awaitingAuth = awaitingAuthRows.rows
  const hardStuck = hardStuckRows.rows
  const invoiceCurrency = (await db.execute<{ currency: string }>(sql`
    select d.currency from documents d
     where d.org_id = ${orgId} and d.kind = 'customer_invoice'
     order by d.document_date desc limit 1
  `)).rows[0]?.currency ?? 'USD'
  return {
    window,
    metrics: {
      attempts: metrics.attempts,
      invoicesWithFailures: metrics.invoicesWithFailures,
      recoveredInvoices: metrics.recoveredInvoices,
      recoveredAmount: metrics.recoveredAmount,
      recoveredByCurrency: metrics.recoveredByCurrency,
      recoveryRate: metrics.recoveryRate,
      churnPrevented: metrics.churnPrevented,
      awaitingAuthentication: metrics.awaitingAuthentication,
      byDeclineClass: metrics.byDeclineClass.map((row) => ({
        declineClass: row.declineClass,
        failedAttempts: row.failedAttempts,
        recoveredInvoices: row.recoveredInvoices,
        recoveryRate: row.recoveryRate,
      })),
      byProvider: metrics.byProvider.map((row) => ({
        provider: row.provider,
        failedAttempts: row.failedAttempts,
        recoveredInvoices: row.recoveredInvoices,
        recoveryRate: row.recoveryRate,
      })),
    },
    awaitingAuth,
    expiring: expiring.map((row) => ({
      methodId: row.methodId,
      partyId: row.partyId,
      partyName: row.partyName,
      provider: row.provider,
      brand: row.brand,
      last4: row.last4,
      expiresOn: row.expiresOn,
      currency: invoiceCurrency,
    })),
    hardStuck,
  }
}

export async function loadCollections(
  sp: Record<string, string | string[] | undefined> = {},
): Promise<CollectionsData> {
  const [tNav, tAr] = await Promise.all([
    getTranslations('nav'),
    getTranslations('ar'),
  ])
  const authz = await requirePermission('documents.manage').catch(() => null)
  if (!authz) redirect('/dashboard')

  const subscriptionsEnabled =
    can(authz, 'ar.read') && (await isFeatureEnabled(authz.user.orgId, 'subscriptionBilling'))
  const advancedSubscriptionsEnabled =
    subscriptionsEnabled && (await isFeatureEnabled(authz.user.orgId, 'advancedSubscriptions'))
  const [customers, incomeAccounts] = subscriptionsEnabled
    ? await Promise.all([
        db.execute<{ id: string; name: string }>(sql`
          select p.id, p.display_name as "name" from parties p
           where p.org_id = ${authz.user.orgId} and p.is_active
             and exists (select 1 from customer_roles cr where cr.party_id = p.id and cr.org_id = p.org_id)
           order by p.display_name
        `),
        db.execute<{ id: string; number: string | null; name: string }>(sql`
          select id, number, name from accounts
           where org_id = ${authz.user.orgId} and type in ('income', 'income_other') and is_active
           order by number nulls last
        `),
      ])
    : [{ rows: [] }, { rows: [] }]

  const autopayOn = await isFeatureEnabled(authz.user.orgId, 'autopay')
  let recovery: RecoveryDashboardData | null = null
  let policyNotice: CollectionPolicyNotice | null = null
  if (autopayOn) {
    try {
      recovery = await loadRecovery(authz.user.orgId)
    } catch (error) {
      if (!isMissingCollectionPolicy(error)) throw error
      policyNotice = {
        title: tAr('collections.recovery.policyNotice.title'),
        description: tAr('collections.recovery.policyNotice.description'),
        actionLabel: tAr('collections.recovery.policyNotice.action'),
        // Collection policies are maintained in the Collections Policies
        // view (the entity is rehomed there, so no /admin/setup page exists).
        actionHref: '/collections?view=policies',
      }
    }
  }
  const attemptId = pickString(sp.attempt)
  let attemptDrawer: CollectionsData['attemptDrawer'] = null
  if (autopayOn && attemptId && isUuid(attemptId)) {
    const rows = (await db.execute(sql`
      select a.id, a.invoice_id as "invoiceId", d.document_number as "invoiceNumber",
             p.display_name as "customerName", a.amount::text as "amount", a.currency,
             a.provider, a.provider_ref as "providerRef",
             case when m.brand is null then null
                  else m.brand || coalesce(' •••• ' || m.last4, '') end as "methodLabel",
             a.status, a.decline_code as "declineCode", a.decline_kind as "declineKind",
             a.retry_position as "retryPosition",
             a.next_retry_on::text as "nextRetryOn",
             a.auth_url as "authUrl",
             (a.fallback_method_id is not null) as "usedBackup",
             a.receipt_document_id::text as "receiptId",
             to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "attemptedAt"
        from collection_attempts a
        join documents d on d.id = a.invoice_id and d.org_id = a.org_id
        join parties p on p.id = d.party_id and p.org_id = d.org_id
        left join customer_payment_methods m on m.id = a.payment_method_id and m.org_id = a.org_id
       where a.id = ${attemptId} and a.org_id = ${authz.user.orgId}
       limit 1
    `)).rows as AttemptDrawerData['attempt'][]
    const attempt = rows[0]
    if (attempt) {
      attemptDrawer = {
        widget: 'collection-attempt-drawer',
        props: {
          drawer: {
            attempt,
            canRetry: can(authz, 'autopay.manage'),
            closeHref: '/collections',
            remountKey: attempt.id,
          },
        },
      }
    }
  }

  return {
    title: tNav('modules.collections'),
    description: tAr('collections.pageDescription'),
    worklistHref: can(authz, 'ar.read') ? '/ar' : null,
    worklistLabel: tAr('collections.worklistCta'),
    subscriptionsEnabled,
    advancedSubscriptionsEnabled,
    customers: customers.rows.map((c) => ({ id: c.id, name: c.name })),
    incomeAccounts: incomeAccounts.rows.map((a) => ({
      id: a.id,
      label: [a.number, a.name].filter(Boolean).join(' · '),
    })),
    autopayOn,
    recovery,
    policyNotice,
    currentParams: sp,
    attemptDrawer,
    attemptsEmptyTitle: tAr('collections.attempts.emptyTitle'),
    attemptsEmptyDescription: tAr('collections.attempts.emptyDescription'),
  }
}

const f = ref<CollectionsData>()

export function collectionsSpec(data: CollectionsData): PageSpec {
  void data
  return page({
    route: '/collections',
    layout: 'bare',
    header: [],
    body: [
      {
        // Recovery vitals sit above the console: the dashboard owns the
        // recovery facts while the shell owns the operational queue, and a
        // block the shell does not know never disturbs its tab state.
        ...widgetBlock('recovery-dashboard', {
          data: f('recovery'),
          notice: f('policyNotice'),
        }),
        when: f('autopayOn'),
      },
      widgetBlock('collections-shell', {
        title: f('title'),
        description: f('description'),
        worklistHref: f('worklistHref'),
        worklistLabel: f('worklistLabel'),
        subscriptionsEnabled: f('subscriptionsEnabled'),
        advancedSubscriptionsEnabled: f('advancedSubscriptionsEnabled'),
        customers: f('customers'),
        incomeAccounts: f('incomeAccounts'),
      }),
      {
        // The automatic-collection queue shares the page with the shell: the
        // shell owns `view` for its panel switch while the list reads every
        // other key, and saved-view ids the shell does not know are uuids the
        // shell ignores — so neither surface breaks the other.
        ...widgetBlock('entity-list-view', {
          recordType: 'collection_attempt',
          sp: f('currentParams'),
          drawer: f('attemptDrawer'),
          emptyTitle: f('attemptsEmptyTitle'),
          emptyDescription: f('attemptsEmptyDescription'),
        }),
        when: f('autopayOn'),
      },
    ],
  })
}
