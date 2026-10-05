'use client'
import { useLocale, useTranslations } from 'next-intl'
import type { getTrainingParticipant } from '@openbooks/engine/hrm/training'
import { DirtyUrlDrawer } from '@/components/dirty-url-drawer'
import { TrainingActions } from '../../hrm/training/TrainingActions'
/** The fully authorized participant payload mounts the one native drawer shell. */
export function OwnTrainingDrawer({
  detail,
  canRespond,
  closeHref,
}: {
  detail: Awaited<ReturnType<typeof getTrainingParticipant>>
  canRespond: boolean
  closeHref: string
}) {
  const locale = useLocale(),
    t = useTranslations('admin.setup.training')
  const at = (instant: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: detail.session.timeZone,
    }).format(new Date(instant))
  return (
    <DirtyUrlDrawer open closeHref={closeHref} title={detail.session.name} size="2xl">
      <div className="space-y-4">
        <p className="text-sm">
          {at(detail.session.startsAt)} – {at(detail.session.endsAt)} · {detail.session.timeZone}
        </p>
        <p className="text-sm">
          {t('location')}: {detail.session.location}
        </p>
        <TrainingActions
          participant={detail.participant}
          session={detail.session}
          feedback={detail.feedback}
          canManage={canRespond}
          audience="self"
        />
      </div>
    </DirtyUrlDrawer>
  )
}
