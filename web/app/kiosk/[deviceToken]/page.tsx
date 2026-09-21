import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { resolveKioskByToken } from '@openbooks/engine/src/hrm/field-time/kiosk.ts'
import { FieldTimeError } from '@openbooks/engine/src/hrm/field-time/errors.ts'
import { KioskTerminal } from '../../../components/field-time/KioskTerminal'

export const dynamic = 'force-dynamic'

/**
 * The site kiosk terminal — a full-screen page with no app shell. The
 * bearer token in the path authenticates the device; unknown or
 * retired tokens 404. The worker list is names only: whoever holds
 * the kiosk link stands at the kiosk.
 */
export default async function KioskPage({ params }: { params: Promise<{ deviceToken: string }> }) {
  const { deviceToken } = await params
  let kiosk
  try {
    kiosk = await resolveKioskByToken(deviceToken)
  } catch (error) {
    if (error instanceof FieldTimeError) notFound()
    throw error
  }
  const t = await getTranslations('timesheets')
  const workers = (await db.execute<{ id: string; name: string }>(sql`
    select p.id::text as id, p.display_name as name from parties p
     where p.org_id = ${kiosk.orgId} and p.is_active
     order by p.display_name limit 500`)).rows
  const projectName = kiosk.projectId
    ? ((await db.execute<{ name: string }>(sql`
      select name from projects where org_id = ${kiosk.orgId} and id = ${kiosk.projectId}`)).rows[0]?.name ?? null)
    : null
  const projects = kiosk.projectId
    ? []
    : (await db.execute<{ id: string; name: string }>(sql`
      select id::text as id, name from projects
       where org_id = ${kiosk.orgId} and is_active order by name limit 200`)).rows
  return (
    <main>
      <KioskTerminal
        deviceToken={deviceToken}
        kioskName={kiosk.name}
        projectId={kiosk.projectId}
        projectName={kiosk.projectId ? (projectName ?? t('field.kioskChooseProject')) : t('field.kioskChooseProject')}
        pinRequired={kiosk.pinRequired}
        workers={workers}
        projects={projects}
      />
    </main>
  )
}
