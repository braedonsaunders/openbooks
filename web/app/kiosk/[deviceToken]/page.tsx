import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { listKioskWorkers, resolveKioskByToken } from '@openbooks/engine/src/hrm/field-time/kiosk.ts'
import { FieldTimeError } from '@openbooks/engine/src/hrm/field-time/errors.ts'
import { KioskTerminal } from '../../../components/field-time/KioskTerminal'

export const dynamic = 'force-dynamic'

/**
 * The site kiosk terminal — a full-screen page with no app shell. The
 * bearer token in the path authenticates the device; unknown or
 * retired tokens 404. The worker list is active employees only (names):
 * whoever holds the kiosk link stands at the kiosk, and the PIN behind
 * each name proves which employee is clocking.
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
  // The device carries no session: listKioskWorkers scopes itself to the
  // kiosk's org and offers employees only (active employment, no row cap —
  // the client searches the list, so a cap would silently hide workers).
  // The project reads below run scoped the same way.
  const workers = await listKioskWorkers(kiosk.orgId)
  const { projectName, projects } = await withOrgTransaction(kiosk.orgId, async () => {
    const projectName = kiosk.projectId
      ? ((await db.execute<{ name: string }>(sql`
        select name from projects where org_id = ${kiosk.orgId} and id = ${kiosk.projectId}`)).rows[0]?.name ?? null)
      : null
    const projects = kiosk.projectId
      ? []
      : (await db.execute<{ id: string; name: string }>(sql`
        select id::text as id, name from projects
         where org_id = ${kiosk.orgId} and is_active order by name limit 200`)).rows
    return { projectName, projects }
  })
  return (
    <main>
      <KioskTerminal
        deviceToken={deviceToken}
        kioskName={kiosk.name}
        projectId={kiosk.projectId}
        projectName={kiosk.projectId ? (projectName ?? t('field.kioskChooseProject')) : t('field.kioskChooseProject')}
        pinRequired={kiosk.pinRequired}
        photoRequired={kiosk.photoRequired}
        workers={workers}
        projects={projects}
      />
    </main>
  )
}
