'use client'

import { useTranslations } from 'next-intl'
import { UrlDrawer } from '@openbooks/ui'
import { useRouter } from 'next/navigation'
import { ChoiceCards } from '../../../../components/builder/builder-kit'
import {
  ChartLine,
  Gift,
  HeartPulse,
  PiggyBank,
  Shapes,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import type { OverviewCard } from '../../../../lib/hrm/benefits-portfolio'

/**
 * Program-type cards: the six portfolio entries as one panel body. Health
 * and retirement resolve to the existing insured-plan Setup drawers rehomed
 * onto the programs view; allowances, rewards, incentives, and custom open
 * the program builder with their family preselected. A card never renders
 * without a working destination — no dead links, no coming-soon tiles.
 */

const CARD_ICONS: Record<string, LucideIcon> = {
  'heart-pulse': HeartPulse,
  'piggy-bank': PiggyBank,
  wallet: Wallet,
  gift: Gift,
  'chart-line': ChartLine,
  shapes: Shapes,
}

export function BenefitTypeCards({ cards, closeHref, title }: { cards: OverviewCard[]; closeHref?: string; title?: string }) {
  const router = useRouter()
  const t = useTranslations('hrm')
  const choices = (
    <ChoiceCards
      value=""
      ariaLabel={cards.map((card) => card.title).join(', ')}
      options={cards.map((card) => {
        const Icon = CARD_ICONS[card.iconKey] ?? Shapes
        return {
          value: card.key,
          label: card.title,
          description: [card.description, card.countLabel].filter(Boolean).join(' · '),
          icon: <Icon size={18} />,
        }
      })}
      onChange={(key) => {
        const card = cards.find((candidate) => candidate.key === key)
        if (card) router.push(card.href as never)
      }}
    />
  )
  return closeHref ? <UrlDrawer open closeHref={closeHref} title={title ?? ''} size="lg"><div className="space-y-5 p-4"><p className="text-sm text-slate-500 dark:text-slate-400">{t('portfolio.scopeHint')}</p>{choices}</div></UrlDrawer> : choices
}
