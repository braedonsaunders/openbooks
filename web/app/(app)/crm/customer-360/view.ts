import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { page, pageHeader, ref, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { pickString } from '../../../../lib/list-params'
import { loadCustomer360, type Customer360Data } from '../../../../lib/customer-360'

export interface Customer360ViewData {
  title: string
  description: string
  customers: Array<{ id: string; name: string }>
  selectedCustomerId: string | null
  cockpit: Customer360Data | null
}

export async function loadCustomer360View(
  sp: Record<string, string | string[] | undefined>,
): Promise<Customer360ViewData> {
  const authz = await requirePermission('crm.accounts.read')

  const customersResult = await db.execute<{ id: string; name: string }>(sql`
    select p.id, p.display_name as name
      from parties p
      join customer_roles cr on cr.party_id = p.id and cr.org_id = p.org_id
     where p.org_id = ${authz.user.orgId} and p.is_active and cr.is_active
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
    title: 'Customer 360',
    description: 'Unified commercial pipeline, receivables aging, credit limit, DSO, and interaction telemetry.',
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
        : widgetBlock('empty-state-view', {
            title: 'No customers found',
            description: 'Add a customer to view their Customer 360 telemetry.',
          }),
    ],
  })
}
