'use client'

import { DrawerTabStrip } from '../../../components/drawer-tab-strip'

/**
 * File Cabinet panel selector, using native pressed buttons because these
 * panels do not implement the tablist/tabpanel keyboard contract.
 */
export interface DrawerTab {
  key: string
  label: string
}

export function DrawerTabs({
  tabs,
  active,
  onSelect,
  ariaLabel,
}: {
  tabs: DrawerTab[]
  active: string
  onSelect: (key: string) => void
  ariaLabel: string
}) {
  return <DrawerTabStrip tabs={tabs} activeKey={active} onSelect={onSelect} ariaLabel={ariaLabel} />
}
