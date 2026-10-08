import Link from 'next/link'
import type { ComponentProps } from 'react'
import {
  HomeStatTile,
  BusySeasonSection,
} from './native-widgets.client'
import { TieOutSection } from '../../app/(app)/resourcing/sections'
import { type WidgetRenderer } from './widget-props'

/**
 * Resourcing cockpit adapters. The tie-out body is the one shared section
 * component the cockpit composition renders, and the utilization tile is the
 * shared home stat tile wrapped in a link to the utilization report — the
 * registry cannot drift from the page on either. Named adapter parameters
 * let the registry generator enforce the exact prop contracts consumed by
 * these shared components.
 */
export const RESOURCING_COCKPIT_WIDGETS = {
  'resourcing-tieout': ({ rows, labels, empty }) => {
    const section = { rows, labels, empty } as ComponentProps<typeof TieOutSection>
    return <TieOutSection {...section} />
  },
  'resourcing-busy-season': ({ gaps, projects, labels, canCreateDraft }) => {
    const section = { gaps, projects, labels, canCreateDraft } as ComponentProps<typeof BusySeasonSection>
    return <BusySeasonSection {...section} />
  },
  'resourcing-utilization-tile': ({ label, value, sub, href }) => {
    const tile = { label, value, sub, href } as { label: string; value: string; sub: string; href: string }
    return (
      <Link
        href={tile.href as never}
        aria-label={tile.label}
        className="block rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
      >
        <HomeStatTile icon="trending-up" accent="emerald" label={tile.label} value={tile.value} sub={tile.sub} />
      </Link>
    )
  },
} satisfies Record<string, WidgetRenderer>
