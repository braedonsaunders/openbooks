import Link from 'next/link'
import type { ComponentProps } from 'react'
import { HomeStatTile } from '../module-home/client'
import { TieOutSection } from '../../app/(app)/resourcing/sections'
import { type WidgetRenderer } from './widget-props'

/**
 * Resourcing cockpit adapters. The tie-out body is the one shared section
 * component the cockpit composition renders, and the utilization tile is the
 * shared home stat tile wrapped in a link to the utilization report — the
 * registry cannot drift from the page on either. Registration of the
 * `resourcing-tieout` and `resourcing-utilization-tile` names and contracts
 * follows once the shared registry files are free.
 */
export const RESOURCING_COCKPIT_WIDGETS = {
  'resourcing-tieout': (props) => {
    const section = props as unknown as ComponentProps<typeof TieOutSection>
    return <TieOutSection {...section} />
  },
  'resourcing-utilization-tile': (props) => {
    const tile = props as unknown as { label: string; value: string; sub: string; href: string }
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
