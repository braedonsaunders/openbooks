import { EncumbranceDrawer } from '../../app/(app)/nonprofit/encumbrances/EncumbranceDrawer'
import { FundDrawer } from '../../app/(app)/nonprofit/funds/FundDrawer'
import { GrantDrawer } from '../../app/(app)/nonprofit/grants/GrantDrawer'
import { ReleaseDrawer } from '../../app/(app)/nonprofit/releases/ReleaseDrawer'
import type { EncumbranceDrawerData } from '../../app/(app)/nonprofit/encumbrances/view'
import type { FundDrawerData } from '../../app/(app)/nonprofit/funds/view'
import type { GrantDrawerData } from '../../app/(app)/nonprofit/grants/view'
import type { ReleaseDrawerData } from '../../app/(app)/nonprofit/releases/view'
import { type WidgetRenderer } from './widget-props'

/** Nonprofit record drawers. Compose native drawers without changing their props or boundaries. */
export const NONPROFIT_WIDGETS = {
  'encumbrance-drawer': (props) => {
    const drawer = props.drawer as EncumbranceDrawerData | null
    if (!drawer) return null
    return <EncumbranceDrawer drawer={drawer} />
  },
  'fund-drawer': (props) => {
    const drawer = props.drawer as FundDrawerData | null
    if (!drawer) return null
    return <FundDrawer drawer={drawer} />
  },
  'grant-drawer': (props) => {
    const drawer = props.drawer as GrantDrawerData | null
    if (!drawer) return null
    return <GrantDrawer drawer={drawer} />
  },
  'release-drawer': (props) => {
    const drawer = props.drawer as ReleaseDrawerData | null
    if (!drawer) return null
    return <ReleaseDrawer drawer={drawer} />
  },
} satisfies Record<string, WidgetRenderer>
