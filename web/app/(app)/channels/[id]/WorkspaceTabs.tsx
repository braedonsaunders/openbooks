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
 * concept keeps its own addressable body. Hrefs arrive prebuilt with
 * unrelated filters preserved; switching sections drops row params,
 * exactly like switching workspace tabs closes drawers.
 */
export function SettingsSubTabs({
  activeSection,
  sections,
  ariaLabel,
}: {
  activeSection: string;
  sections: { key: string; label: string; href: string }[];
  ariaLabel: string;
}) {
  const router = useRouter();
  const byKey = new Map(sections.map((section) => [section.key, section.href]));
  return (
    <DrawerTabStrip
      tabs={sections}
      activeKey={activeSection}
      onSelect={(key) => {
        const href = byKey.get(key);
        if (href) router.push(href);
      }}
      ariaLabel={ariaLabel}
    />
  );
}
