'use client'

import { useRouter } from "next/navigation";
import { DrawerTabStrip } from "../../../../components/drawer-tab-strip";

/**
 * Workspace tabs ride the URL (`?tab=`), so a delivery, a mapping, or an
 * event deep-links to the exact tab that owns it.
 */
export function WorkspaceTabs({
  basePath,
  activeTab,
  tabs,
}: {
  basePath: string;
  activeTab: string;
  tabs: { key: string; label: string; disabled?: boolean }[];
}) {
  const router = useRouter();
  return (
    <DrawerTabStrip
      tabs={tabs}
      activeKey={activeTab}
      onSelect={(key) => router.push(`${basePath}?tab=${encodeURIComponent(key)}`)}
      ariaLabel="Channel workspace"
    />
  );
}

/**
 * Settings subsections ride the URL (`?tab=settings&section=`), so each
 * entity section keeps its own addressable body. Switching sections drops
 * row params, exactly like switching workspace tabs closes drawers.
 */
export function SettingsSubTabs({
  channelId,
  activeSection,
  sections,
  ariaLabel,
}: {
  channelId: string;
  activeSection: string;
  sections: { key: string; label: string }[];
  ariaLabel: string;
}) {
  const router = useRouter();
  return (
    <DrawerTabStrip
      tabs={sections}
      activeKey={activeSection}
      onSelect={(key) => router.push(`/channels/${channelId}?tab=settings&section=${encodeURIComponent(key)}`)}
      ariaLabel={ariaLabel}
    />
  );
}
