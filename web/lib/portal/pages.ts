import 'server-only'

import { notFound } from 'next/navigation'
import { portalHome, resolvePortalSession, type PortalHome, type PortalSection } from '@openbooks/engine/portal'
import { db, withOrgContext } from '@openbooks/engine/platform/database'

export type PortalPageContext = {
  token: string
  orgId: string
  partyId: string
  home: PortalHome
}

/** Load a portal section page: valid session, gate on, section on — else 404. */
export async function portalPage(token: string, section: PortalSection | null): Promise<PortalPageContext> {
  const session = await resolvePortalSession(token)
  if (!session) notFound()
  const home = await withOrgContext(session.orgId, () => portalHome(session.orgId, session.partyId, db))
  if (section && !home.settings.sections[section]) notFound()
  return { token, orgId: session.orgId, partyId: session.partyId, home }
}
