import { FundDrawer } from '../../app/(app)/nonprofit/funds/FundDrawer'
import { ReleaseDrawer } from '../../app/(app)/nonprofit/releases/ReleaseDrawer'
import type { FundDrawerData } from '../../app/(app)/nonprofit/funds/view'
import type { ReleaseDrawerData } from '../../app/(app)/nonprofit/releases/view'
import { type WidgetRenderer } from './widget-props'

/** Nonprofit fund drawers. Compose the fund record drawers without changing their props or boundaries. */
export const NONPROFIT_WIDGETS = {
  'fund-drawer': (props) => {
    const drawer = props.drawer as FundDrawerData | null
    if (!drawer) return null
    return <FundDrawer drawer={drawer} />
  },
  'release-drawer': (props) => {
    const drawer = props.drawer as ReleaseDrawerData | null
    if (!drawer) return null
    return <ReleaseDrawer drawer={drawer} />
  },
} satisfies Record<string, WidgetRenderer>
