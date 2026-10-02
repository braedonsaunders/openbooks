import 'server-only'

import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { page, ref, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../lib/authz'
import { isFeatureEnabled } from '../../../lib/features'

/** The shell composes shared page chrome, registered lists and domain editors.
 * Permissions and feature dependencies are resolved before reaching the client. */

export interface CollectionsOption {
  id: string
  name?: string
  label?: string
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
}

export async function loadCollections(): Promise<CollectionsData> {
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
    ],
  })
}
