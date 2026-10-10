'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'

/**
 * A board whose scope holds nobody. Membership is board configuration, so
 * the empty state says who changes it: a board administrator gets the link to
 * this board's settings, everyone else is told to ask whoever manages
 * schedule boards to add them or their team.
 */
export function EmptyBoardScope({ settingsHref }: { settingsHref: string | null }) {
  const t = useTranslations('scheduling')
  return (
    <span className="pointer-events-auto inline-flex max-w-md flex-col items-center gap-1">
      <span>{t('grid.noPeople')}</span>
      {settingsHref ? (
        <Link href={settingsHref as never} className="text-xs font-medium text-teal-700 hover:underline dark:text-teal-400">
          {t('grid.noPeopleEditScope')}
        </Link>
      ) : (
        <span className="text-xs text-slate-400">{t('grid.noPeopleAsk')}</span>
      )}
    </span>
  )
}
