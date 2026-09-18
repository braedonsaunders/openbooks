import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { page, pageHeader, ref, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { pickString } from '../../../../lib/list-params'
import { crmSharedScope } from '../../../../lib/crm-scope'
import { loadCustomer360, type Customer360Data } from '../../../../lib/customer-360'

export interface Customer360ViewData {
  title: string
  description: string
  emptyTitle: string
  emptyDescription: string
  customers: Array<{ id: string; name: string }>
  selectedCustomerId: string | null
  cockpit: Customer360Data | null
}

export async function loadCustomer360View(
  sp: Record<string, string | string[] | undefined>,
): Promise<Customer360ViewData> {
  const authz = await requirePermission('crm.accounts.read')
  const t = await getTranslations('crm')

  // The dropdown is the gate: a subsidiary-restricted caller only ever sees
  // (and can only select) customers in their own scope, using the same
  // predicate the detail loader applies, so a listed customer is loadable.
  const customersResult = await db.execute<{ id: string; name: string }>(sql`
    select p.id, p.display_name as name
      from parties p
      join customer_roles cr on cr.party_id = p.id and cr.org_id = p.org_id
     where p.org_id = ${authz.user.orgId} and p.is_active and cr.is_active
       ${crmSharedScope(sql`p.subsidiary_id`, authz.allowedSubsidiaryIds)}
     order by p.display_name
     limit 2000
  `)

  const customers = customersResult.rows
  const requestedId = pickString(sp.customer)
  const selectedCustomerId =
    requestedId && customers.some((c) => c.id === requestedId)
      ? requestedId
      : customers[0]?.id ?? null

  let cockpit: Customer360Data | null = null
  if (selectedCustomerId) {
    cockpit = await loadCustomer360(selectedCustomerId, authz.user.orgId, authz.allowedSubsidiaryIds)
  }

  return {
    title: t('customer360.title'),
    description: t('customer360.description'),
    emptyTitle: t('customer360.emptyTitle'),
    emptyDescription: t('customer360.emptyDescription'),
    customers,
    selectedCustomerId,
    cockpit,
  }
}

const f = ref<Customer360ViewData>()

export function customer360Spec(data: Customer360ViewData): PageSpec {
  return page({
    route: '/crm/customer-360',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
      }),
    ],
    body: [
      data.cockpit
        ? widgetBlock('customer-360-cockpit', {
            data: data.cockpit,
          })
        : widgetBlock('empty-state', {
            title: f('emptyTitle'),
            description: f('emptyDescription'),
          }),
    ],
  })
}
