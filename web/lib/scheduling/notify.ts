import 'server-only'

import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { deriveEmailDeliveryKey, scheduleChangeEmail, sendVia } from '@openbooks/emails'
import { appBaseUrl } from '@openbooks/engine/flows'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { insertEmailLog, markEmailFailed, markEmailSent, markEmailUncertain, resolveOrgEmailTransport } from '@openbooks/engine/src/delivery/email-config.ts'
import { writeNotification } from '@openbooks/engine/src/inbox/adapters/notification.ts'
import type { ScheduleNotice } from '@openbooks/engine/src/schedule-boards/entries.ts'

export interface ScheduleDelivery {
  readonly people: number
  readonly notified: number
  readonly emailed: number
  /** Why email was not sent, when the organization has no email transport. */
  readonly emailSkipped: string | null
}

/**
 * Tell each person what changed on their published schedule: an in-app
 * notification when they sign in to OpenBooks, and an email when they have
 * an address and the organization has configured email. Runs after the
 * booking command committed; a delivery failure never undoes a booking and
 * is recorded in the email log.
 */
export async function deliverScheduleNotices(args: {
  orgId: string
  actorId: string
  boardName: string
  notices: readonly ScheduleNotice[]
}): Promise<ScheduleDelivery> {
  if (args.notices.length === 0) return { people: 0, notified: 0, emailed: 0, emailSkipped: null }
  const t = await getTranslations('scheduling')
  const byPerson = new Map<string, ScheduleNotice[]>()
  for (const notice of args.notices) {
    // A person never notifies themselves about their own edit.
    const list = byPerson.get(notice.workerPartyId) ?? []
    list.push(notice)
    byPerson.set(notice.workerPartyId, list)
  }
  const ids = [...byPerson.keys()]
  const recipients = (await db.execute<{ partyId: string; email: string | null; userId: string | null; name: string }>(sql`
    select p.id as "partyId", p.email, p.display_name as name,
           (select u.id from users u where u.org_id = p.org_id and u.party_id = p.id and u.is_active order by u.created_at limit 1) as "userId"
      from parties p where p.org_id = ${args.orgId} and p.id = any(${`{${ids.join(',')}}`}::uuid[])
  `)).rows
  const org = (await db.execute<{ name: string }>(sql`select name from orgs where id = ${args.orgId}`)).rows[0]?.name ?? ''
  const transport = await resolveOrgEmailTransport(args.orgId)
  const link = `${appBaseUrl().replace(/\/$/, '')}/me/schedule`
  const day = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
  let notified = 0
  let emailed = 0
  for (const recipient of recipients) {
    const notices = (byPerson.get(recipient.partyId) ?? []).sort((a, b) => a.onDate.localeCompare(b.onDate))
    const lines = notices.map((notice) => t(`notify.${notice.change}`, {
      date: day.format(new Date(`${notice.onDate}T00:00:00Z`)),
      target: notice.label,
      hours: notice.hours ?? '',
    }))
    const subject = t('notify.subject', { board: args.boardName })
    if (recipient.userId && recipient.userId !== args.actorId) {
      await writeNotification(db, {
        orgId: args.orgId,
        userId: recipient.userId,
        kind: 'schedule.changed',
        title: subject,
        body: lines.join('\n'),
        href: '/me/schedule',
        actorId: args.actorId,
      })
      notified++
    }
    if (!transport || !recipient.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient.email)) continue
    const mail = scheduleChangeEmail({
      orgName: org,
      subject,
      intro: t('notify.intro', { name: recipient.name, count: notices.length }),
      lines,
      linkLabel: t('notify.link'),
      link,
      footer: t('notify.footer', { board: args.boardName }),
    })
    const logId = await insertEmailLog({
      orgId: args.orgId, jobId: null, provider: null, recipients: [recipient.email], fromAddr: null, replyToAddr: null,
      subject: mail.subject, status: 'queued', categoryKey: 'schedule.change', meta: {}, actor: { kind: 'user', userId: args.actorId },
    })
    try {
      const outcome = await sendVia(transport, { to: recipient.email, subject: mail.subject, html: mail.html, text: mail.text }, {
        deliveryKey: deriveEmailDeliveryKey({ orgId: args.orgId, scope: `direct:${logId}`, to: recipient.email }),
      })
      if (outcome.kind === 'sent') {
        await markEmailSent(args.orgId, logId, outcome.providerMessageId)
        emailed++
      } else {
        await markEmailUncertain(args.orgId, logId, outcome.reason)
      }
    } catch (error) {
      await markEmailFailed(args.orgId, logId, error instanceof Error ? error.message : String(error))
    }
  }
  return { people: recipients.length, notified, emailed, emailSkipped: transport ? null : t('notify.noTransport') }
}
