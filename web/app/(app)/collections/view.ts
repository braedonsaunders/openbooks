import 'server-only'

import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { page, ref, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../lib/authz'
import { isFeatureEnabled } from '../../../lib/features'
import { isUuid, pickString } from '../../../lib/list-params'

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
    receiptId: string | null
    attemptedAt: string
  }
  canRetry: boolean
  closeHref: string
}

export interface CollectionsData {
  title: string
  description: string
  /** Availability of the receivables worklist, independently of configuration. */
  worklistHref: string | null
  worklistLabel: string
  subscriptionsEnabled: boolean
  advancedSubscriptionsEnabled: boolean
  customers: CollectionsOption[]
  incomeAccounts: CollectionsOption[]
  /** The automatic-collection queue renders only while the surface is on. */
  autopayOn: boolean
  currentParams: Record<string, string | string[] | undefined>
  attemptDrawer: ({ widget: 'collection-attempt-drawer'; props: { drawer: AttemptDrawerData & { remountKey: string } } }) | null
  attemptsEmptyTitle: string
  attemptsEmptyDescription: string
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
