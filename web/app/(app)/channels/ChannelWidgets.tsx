'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import { Button } from '@openbooks/ui'
import { ModuleHomeTabs } from '../../../components/module-home/ui'
import { useAppAction } from '@/lib/use-app-action'
import { channelRequest } from './channel-client'
import { ChannelOrderDrawer } from './ChannelOrderDrawer'
import type { ChannelOrderDrawerData } from './order-detail'

export type ChannelTab = { href: string; label: string; active: boolean; count?: number }

/** Orders ↔ Exceptions ↔ Posting strip, shared by the three channel pages. */
export function ChannelTabs({ tabs }: { tabs: ChannelTab[] }) {
  return <ModuleHomeTabs tabs={tabs} />
}

/** Fix-all-similar: replay every exception, or every exception with one cause. */
export function ChannelReplayAll({
  channelId,
  code,
  scope,
}: {
  channelId?: string | null
  code?: string | null
  scope?: 'orders' | 'events' | null
}) {
  const t = useTranslations('channels')
  const router = useRouter()
  const { busy, refusal, execute } = useAppAction()
  const events = scope === 'events'
  const label = events ? t('drawer.replayAllEvents') : t('drawer.replayAll')

  const onReplay = async () => {
    await execute(
      () =>
        channelRequest<{ replayed: number; posted: number; parked: number; waiting: number }>(
          events ? '/api/channels/exceptions/events/replay' : '/api/channels/exceptions/replay',
          { method: 'POST', body: { channelId: channelId ?? null, code: code ?? null } },
          label,
        ),
      {
        fallbackMessage: label,
        onOk: (outcome) => {
          router.refresh()
          toast.success(
            t('drawer.replayed', { count: outcome.replayed, posted: outcome.posted, parked: outcome.parked }),
          )
        },
      },
    )
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <ActionAlert error={refusal} fallbackMessage={label} />
      <Button variant="outline" disabled={busy} onClick={onReplay}>
        {label}
      </Button>
    </div>
  )
}

/** Drawer slot for the channel order entity lists. */
export function ChannelOrderDrawerSlot({
  drawer,
  closeHref,
}: {
  drawer: ChannelOrderDrawerData
  closeHref: string
}) {
  return <ChannelOrderDrawer key={drawer.remountKey} drawer={drawer} closeHref={closeHref} />
}
