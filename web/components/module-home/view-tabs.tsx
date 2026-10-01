"use client";

import { Suspense, useContext } from "react";
import { ViewTabsContext } from "./navigation-context";
export { ViewTabsProvider } from "./navigation-context";
import { usePathname, useSearchParams } from "next/navigation";
import { ModuleHomeTabs } from "./tabs";
import { resolveViewTabs, type ViewTabGroup, type ViewTabOwnership } from "./view-tab-match";

/**
 * The app shell resolves authorized local destinations once. Shared page
 * layouts place the switch in the top-right header action rail. Selection follows the
 * live URL, including query views, as retained layouts do not reload on a
 * sibling navigation. The shared component manages overflow without changing destination order.
 */
function ResolvedViewTabs({ groups, ownership }: { groups: readonly ViewTabGroup[]; ownership?: readonly ViewTabOwnership[] }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const tabs = resolveViewTabs(
    groups,
    pathname,
    new URLSearchParams(search?.toString() ?? ""),
    ownership,
  );
  return tabs ? (
    <ModuleHomeTabs tabs={tabs} placement="local" />
  ) : null;
}

export function PageViewTabs() {
  const { groups, ownership } = useContext(ViewTabsContext) ?? {};
  if (!groups?.length) return null;
  return (
    <Suspense fallback={null}>
      <ResolvedViewTabs groups={groups} ownership={ownership} />
    </Suspense>
  );
}
