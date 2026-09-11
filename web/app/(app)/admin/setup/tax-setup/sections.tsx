import 'server-only'

import Link from 'next/link'
import { ArrowRight, BadgeCheck, MapPin } from 'lucide-react'
import { Button, Card, CardContent } from '@openbooks/ui'
import type { SupportedCountry } from '@openbooks/engine/src/tax-pack-provisioning.ts'
import { TaxSetupGuide } from './TaxSetupGuide'

/**
 * Shared chrome for the tax-setup workspace, plus the guide slot.
 *
 * The page owns a plain `<header>` (h1 + subtitle) rather than the
 * `PageHeader` component, so the whole header is one shared component over
 * loader-resolved strings. The widget registry renders it, so one implementation
 * paths share one implementation.
 *
 * The guide body is a client component (search filtering, checkbox/select
 * state, expand/collapse, and the provision fetch flow are useState a spec
 * cannot name), so it renders through a WHOLE-COMPONENT slot: the loader
 * resolves every prop the guide needs (`countries`, `installedCodes`, and
 * the preformatted step-2/step-3 strings) to presentation-ready data, and
 * the slot spreads that one object onto the same component. No org id, no
 * Authz, no actions travel through the spec —
 * the props are data, not capabilities. Country display names stay
 * client-side (`countryOptions(locale)` inside the component —
 * browser-locale formatting, so the loader passes the raw
 * `SupportedCountry` records), and the search filter runs client-side too
 * (per-keystroke useState, not a `?q=` param).
 *
 * `StepLink` moves here from `TaxSetupGuide.tsx` (the brief's shared-
 * implementation rule) with its step-2/step-3 strings threaded as props:
 * the server-formatted step-stat strings are the only copy the spec must
 * resolve (ICU plurals evaluated in the loader, exactly as the native page
 * does before handing them to `StepLink`); everything else the steps render
 * (icons, hrefs, CTA labels) travels as data.
 */

export interface TaxSetupGuideProps {
  countries: SupportedCountry[]
  installedCodes: string[]
  step2Title: string
  step2Description: string
  step2Stat: string
  step2Href: string
  step2Cta: string
  step3Title: string
  step3Description: string
  step3Stat: string
  step3Href: string
  step3Cta: string
}

export function TaxSetupHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header>
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{title}</h1>
      <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>
    </header>
  )
}

export function TaxSetupGuideSlot({ guide }: { guide: TaxSetupGuideProps }) {
  const {
    step2Title,
    step2Description,
    step2Stat,
    step2Href,
    step2Cta,
    step3Title,
    step3Description,
    step3Stat,
    step3Href,
    step3Cta,
    ...guideProps
  } = guide
  // No wrapper element: the guide owns its own `<div className="space-y-5">`
  // root, and an extra div here would break the native/spec byte comparison.
  return (
    <TaxSetupGuide
      {...guideProps}
      step2={
        <StepLink
          n={2}
          icon={<MapPin size={18} />}
          title={step2Title}
          description={step2Description}
          stat={step2Stat}
          href={step2Href}
          cta={step2Cta}
        />
      }
      step3={
        <StepLink
          n={3}
          icon={<BadgeCheck size={18} />}
          title={step3Title}
          description={step3Description}
          stat={step3Stat}
          href={step3Href}
          cta={step3Cta}
        />
      }
    />
  )
}

export function StepLink({
  n,
  icon,
  title,
  description,
  stat,
  href,
  cta,
}: {
  n: number
  icon: React.ReactNode
  title: string
  description: string
  stat: string
  href: string
  cta: string
}) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4 py-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-bold text-slate-700 dark:bg-slate-700 dark:text-slate-200">{n}</span>
          <div>
            <div className="flex items-center gap-2 font-medium text-slate-900 dark:text-slate-100">
              <span className="text-slate-400">{icon}</span>
              {title}
            </div>
            <p className="mt-0.5 max-w-xl text-sm text-slate-500 dark:text-slate-400">{description}</p>
            <p className="mt-1 text-xs font-medium text-teal-700 dark:text-teal-300">{stat}</p>
          </div>
        </div>
        <Button asChild variant="outline" className="shrink-0">
          <Link href={href as never}>
            {cta}
            <ArrowRight size={14} />
          </Link>
        </Button>
      </CardContent>
    </Card>
  )
}
