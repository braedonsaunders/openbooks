import 'server-only'

import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { page, ref, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { requirePermission } from '../../../lib/authz'
import { isFeatureEnabled } from '../../../lib/features'

/**
 * Recurring billing + dunning, split into a loader and a spec.
 *
 * The body is one client island: `CollectionsClient` owns the tab state
 * (recurring / subscriptions / advanced / dunning), every list fetch
 * (`/api/recurring`, `/api/subscriptions`, `/api/dunning`), all four create
 * forms and every row action. Both the tab pair (a button when its feature
 * flag is on, nothing otherwise) and the visible panel (a four-way
 * conditional on client state) are conditionals a spec cannot express, so
 * the body stays whole — the same call the AR cockpit made for its
 * position-fetching client component. The spec places the one shell widget;
 * the loader does the gate, the feature probes and the option queries.
 *
 * Loader work copied verbatim from page.tsx: the documents.manage gate
 * (redirect to /dashboard when absent — a redirect, never a flag), the
 * subscriptionBilling / advancedSubscriptions feature probes, and the
 * customers + income-accounts option queries that only run when
 * subscriptionBilling is on (empty arrays otherwise).
 */

export interface CollectionsOption {
  id: string
  name?: string
  label?: string
}

export interface CollectionsData {
  title: string
  description: string
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

  const subscriptionsEnabled = await isFeatureEnabled(authz.user.orgId, 'subscriptionBilling')
  const advancedSubscriptionsEnabled =
    subscriptionsEnabled && (await isFeatureEnabled(authz.user.orgId, 'advancedSubscriptions'))
  const [customers, incomeAccounts] = subscriptionsEnabled
    ? await Promise.all([
        db.execute<any>(sql`
          select p.id, p.display_name as "name" from parties p
           where p.org_id = ${authz.user.orgId} and p.is_active
             and exists (select 1 from customer_roles cr where cr.party_id = p.id and cr.org_id = p.org_id)
           order by p.display_name
        `),
        db.execute<any>(sql`
          select id, number, name from accounts
           where org_id = ${authz.user.orgId} and type in ('income', 'income_other') and is_active
           order by number nulls last
        `),
      ])
    : [{ rows: [] }, { rows: [] }]

  return {
    title: tNav('modules.collections'),
    description: tAr('cockpit.description'),
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
    // The native page renders its own `mx-auto max-w-6xl` container, which
    // no list/detail shell reproduces. The spec places the container whole
    // (it lives in sections.tsx, placed by the widget registry) rather
    // than composing a wrong-width page around the widget.
    layout: 'bare',
    header: [],
    body: [
      widgetBlock('collections-shell', {
        title: f('title'),
        description: f('description'),
        subscriptionsEnabled: f('subscriptionsEnabled'),
        advancedSubscriptionsEnabled: f('advancedSubscriptionsEnabled'),
        customers: f('customers'),
        incomeAccounts: f('incomeAccounts'),
      }),
    ],
  })
}
