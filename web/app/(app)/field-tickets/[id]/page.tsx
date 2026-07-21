import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { can, requirePermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { loadFieldTicket, FieldTicketError } from '../../../../lib/field-tickets'
import { FieldTicketEditor } from './FieldTicketEditor'

export const dynamic = 'force-dynamic'

export default async function FieldTicketPage({ params }: { params: Promise<{ id: string }> }) {
  const authz = await requirePermission('time.read')
  const orgId = authz.user.orgId
  if (!(await isFeatureEnabled(orgId, 'fieldTickets'))) notFound()
  const { id } = await params

  let ticket
  try {
    ticket = await loadFieldTicket(orgId, id)
  } catch (e) {
    if (e instanceof FieldTicketError) notFound()
    throw e
  }

  const [employees, laborItems, timeTypes, otherItems] = await Promise.all([
    db.execute(sql`
      select p.id, p.display_name as name from parties p
       where p.org_id = ${orgId} and p.is_active
         and exists (select 1 from employee_roles r where r.party_id = p.id and r.org_id = ${orgId} and r.is_active)
       order by p.display_name`) as unknown as Promise<{ rows: { id: string; name: string }[] }>,
    db.execute(sql`
      select id, name from items where org_id = ${orgId} and is_active and kind in ('labor', 'service')
       order by name`) as unknown as Promise<{ rows: { id: string; name: string }[] }>,
    db.execute(sql`
      select id, name, bill_multiplier from time_types where org_id = ${orgId} and is_active
       order by bill_multiplier, name`) as unknown as Promise<{ rows: { id: string; name: string; bill_multiplier: string }[] }>,
    db.execute(sql`
      select i.id, i.name, i.kind, i.default_rate from items i
       where i.org_id = ${orgId} and i.is_active
         and i.kind in ('equipment_charge', 'non_inventory', 'other_charge', 'inventory', 'service')
       order by i.kind, i.name`) as unknown as Promise<{ rows: { id: string; name: string; kind: string; default_rate: string | null }[] }>,
  ])

  const canApprove = can(authz, 'time.approve')
  const canManage = can(authz, 'time.manage')

  return (
    <FieldTicketEditor
      initial={ticket}
      employees={employees.rows}
      laborItems={laborItems.rows}
      timeTypes={timeTypes.rows}
      catalogItems={otherItems.rows}
      canApprove={canApprove}
      canManage={canManage}
    />
  )
}
