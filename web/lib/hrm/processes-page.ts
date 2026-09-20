import 'server-only'

import { getTranslations } from 'next-intl/server'
import { hrmGroupTabs } from '../../components/module-home/group-tabs'
import type { Authz } from '../authz'

/**
 * Process checklists page loader — tabs plus titles only. The list itself
 * is interactive (segments switch client-side), so it fetches the
 * /api/hrm/processes collection behind the same double gate this page
 * carries; the loader resolves no rows and issues no table reads.
 */

export interface ProcessesPageData {
  title: string
  description: string
  tabs: Awaited<ReturnType<typeof hrmGroupTabs>>
  listTitle: string
}

export async function loadProcessesPage(authz: Authz): Promise<ProcessesPageData> {
  // The caller (the /hrm/processes view) owns the page gate —
  // requirePermission plus the hrm switch with a 404. This loader never
  // re-checks either; it resolves chrome for the authorized session it is
  // given.
  const t = await getTranslations('hrm')
  return {
    title: t('processes.title'),
    description: t('processes.description'),
    tabs: await hrmGroupTabs(authz, '/hrm/processes'),
    listTitle: t('processes.listTitle'),
  }
}
