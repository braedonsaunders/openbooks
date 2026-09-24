'use client'

import { DrawerTabStrip } from '../../../../components/drawer-tab-strip'

/**
 * Shared presentational cells for /admin/apps, used by the native page and
 * the ViewSpec path alike so the two renders stay byte-identical.
 */

export function AppKeyCell({ appKey }: { appKey: string }) {
  return <code className="text-xs text-slate-500">{appKey}</code>
}

/** One tab strip for installed app workspaces and pending package review. */
export function AppWorkspaceTabs<T extends string>({ tabs, selected, onSelect, label }: {
  tabs: { key: T; label: string }[]; selected: T; onSelect: (key: T) => void; label: string
}) {
  return <DrawerTabStrip tabs={tabs} activeKey={selected} onSelect={onSelect} ariaLabel={label} />
}
