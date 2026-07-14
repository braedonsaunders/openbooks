'use client'

// openbooks has a single nav universe (no super-admin platform area yet), so
// the hook the shell components share is a pass-through. Kept so AppSidebar /
// MobileNavToggle / MobileTabBar stay byte-compatible with the beaconhs shell.

import type { SidebarNavGroup } from './sidebar-nav'

export function useNavGroups(groups: SidebarNavGroup[]): SidebarNavGroup[] {
  return groups
}
