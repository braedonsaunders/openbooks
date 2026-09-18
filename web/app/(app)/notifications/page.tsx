import { ModuleView } from '../../../components/viewspec/module-view'
import { loadNotifications, notificationsSpec } from './view'

export const dynamic = 'force-dynamic'

/**
 * My in-app inbox — flow notify actions, approval assignment/reminder/
 * escalation, delegation, close automations, payment supersessions.
 */
export default async function Notifications({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadNotifications(sp)
  return <ModuleView spec={notificationsSpec(data)} data={data} searchParams={sp} trusted />
}
