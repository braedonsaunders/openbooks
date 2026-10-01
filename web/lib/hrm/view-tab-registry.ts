import { HRM_LOCAL_NAVIGATION, type LocalNavigationTab } from '@openbooks/engine/navigation'
import type { ViewTabGroup } from '../../components/module-home/view-tab-match'

/** Compatibility exports for HR loaders; native destinations live in the application catalog. */
export const HRM_VIEW_TABS = HRM_LOCAL_NAVIGATION
export type ViewTabDef = LocalNavigationTab

export function hrmViewTabGroupsFor(
  allowed: (def: ViewTabDef) => boolean,
  label: (def: ViewTabDef) => string,
): ViewTabGroup[] {
  return Object.values(HRM_VIEW_TABS).map((defs) => defs.filter(allowed).map((def) => ({
    href: def.href, label: label(def),
    ...(def.prefix ? { prefix: true } : {}),
    ...(def.carry ? { carry: def.carry } : {}),
  })))
}
