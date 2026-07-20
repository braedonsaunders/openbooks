'use client'

import type { ComponentProps } from 'react'
import {
  AreaChart,
  ArrowLeftRight,
  Building2,
  CheckCircle2,
  CreditCard,
  Landmark,
  ListChecks,
  TriangleAlert,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import { StatTile, CockpitPanel } from '../cockpit/ui'

/**
 * Client shims for the module-home pages. The home pages are SERVER
 * components, and component references can't cross the RSC boundary — so
 * these take string icon keys and resolve them client-side before handing the
 * component to the cockpit kit (the same trick NavIcon plays for the shell).
 * Extend HOME_ICONS as new module homes need more glyphs.
 */
const HOME_ICONS: Record<string, LucideIcon> = {
  landmark: Landmark,
  'credit-card': CreditCard,
  'list-checks': ListChecks,
  'check-circle': CheckCircle2,
  'arrow-left-right': ArrowLeftRight,
  building: Building2,
  'area-chart': AreaChart,
  'triangle-alert': TriangleAlert,
  wallet: Wallet,
}

export function HomeStatTile({
  icon,
  ...rest
}: Omit<ComponentProps<typeof StatTile>, 'icon'> & { icon: string }) {
  return <StatTile icon={HOME_ICONS[icon] ?? Landmark} {...rest} />
}

export function HomePanel({
  icon,
  ...rest
}: Omit<ComponentProps<typeof CockpitPanel>, 'icon'> & { icon?: string }) {
  return <CockpitPanel icon={icon ? (HOME_ICONS[icon] ?? Building2) : undefined} {...rest} />
}
