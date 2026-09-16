/**
 * Tab-strip fragment for the Allocations setup workspace (A8 contribution).
 *
 * A7 owns `page.tsx`/`view.ts` and the Rules tab; these entries plug the
 * Drivers and Runs islands into that strip (`?tab=` routing, same as the
 * overhead workspace). The temporary `page.tsx` next to this file renders
 * the same strip until A7's shell replaces it.
 */

export const ALLOCATION_SETUP_TAB_PARAM = 'tab'

export interface AllocationSetupTab {
  key: string
  labelKey: string
  href: string
}

export const A8_SETUP_TABS: AllocationSetupTab[] = [
  { key: 'drivers', labelKey: 'tabs.drivers', href: '/admin/setup/allocations?tab=drivers' },
  { key: 'runs', labelKey: 'tabs.runs', href: '/admin/setup/allocations?tab=runs' },
]

export type A8TabKey = 'drivers' | 'runs'

export function parseA8Tab(raw: string | string[] | undefined): A8TabKey {
  return raw === 'runs' ? 'runs' : 'drivers'
}
