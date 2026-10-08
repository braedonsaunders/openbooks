import 'server-only'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { writeNotification } from '@openbooks/engine/src/inbox/adapters/notification.ts'
import type { ScheduleNotice } from '@openbooks/engine/src/schedule-boards/entries.ts'
export interface ScheduleDelivery {
  readonly people: number
  readonly notified: number
  readonly emailed: number
  readonly emailSkipped: string | null
}
/** In-app change notices remain distinct from reviewed email distribution through native Flows. */
export async function deliverScheduleNotices(args: {
  orgId: string
  actorId: string
  boardName: string
  notices: readonly ScheduleNotice[]
}): Promise<ScheduleDelivery> {
  if (!args.notices.length)
    return { people: 0, notified: 0, emailed: 0, emailSkipped: null }
  const t = await getTranslations('scheduling'),
    groups = new Map<string, ScheduleNotice[]>()
  for (const notice of args.notices)
    groups.set(notice.workerPartyId, [
      ...(groups.get(notice.workerPartyId) ?? []),
      notice,
    ])
  const recipients = (
    await db.execute<{ partyId: string; userId: string | null }>(
      sql`select p.id as "partyId",(select u.id from users u where u.org_id=p.org_id and u.party_id=p.id and u.is_active order by u.created_at limit 1) as "userId" from parties p where p.org_id=${args.orgId} and p.id in (select jsonb_array_elements_text(${JSON.stringify([...groups.keys()])}::jsonb)::uuid)`,
    )
  ).rows
  const day = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
  let notified = 0
  for (const recipient of recipients)
    if (recipient.userId && recipient.userId !== args.actorId) {
      const lines = (groups.get(recipient.partyId) ?? [])
        .sort((a, b) => a.onDate.localeCompare(b.onDate))
        .map((notice) =>
          t(`notify.${notice.change}`, {
            date: day.format(new Date(`${notice.onDate}T00:00:00Z`)),
            target: notice.label,
            hours: notice.hours ?? '',
          }),
        )
      await writeNotification(db, {
        orgId: args.orgId,
        userId: recipient.userId,
        kind: 'schedule_change',
        title: t('notify.subject', { board: args.boardName }),
        body: lines.join('\n'),
        href: '/me/schedule',
        actorId: args.actorId,
      })
      notified++
    }
  return {
    people: recipients.length,
    notified,
    emailed: 0,
    emailSkipped: t('notify.nativeDistribution'),
  }
}
