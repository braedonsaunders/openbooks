"use client";

import { createContext, Suspense, useContext, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { ModuleHomeTabs } from "./tabs";
import { resolveViewTabs, type ViewTabGroup } from "./view-tab-match";

/**
 * Sibling-view strips, owned by a route layout and placed by the page
 * layout.
 *
 * A module's layout resolves its jobs' sibling views ONCE — permission and
 * feature filtered — and provides them here. ListPageLayout and
 * DetailPageLayout render `PageViewTabs` directly under the page header, so
 * every page in a job shows the same strip in the same place, and no page
 * can forget it, move it, or drop it into a flex column where it lands at
 * the bottom. Pages never pass view tabs themselves.
 *
 * The active tab is read from the URL on the client: a layout does not
 * re-render between its sibling pages, and `?tab=` views never reach it.
 */
const ViewTabsContext = createContext<readonly ViewTabGroup[] | null>(null);

export function ViewTabsProvider({
  groups,
  children,
}: {
  groups: readonly ViewTabGroup[];
  children: ReactNode;
}) {
  return (
    <ViewTabsContext.Provider value={groups}>{children}</ViewTabsContext.Provider>
  );
}

function ResolvedViewTabs({ groups }: { groups: readonly ViewTabGroup[] }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const tabs = resolveViewTabs(
    groups,
    pathname,
    new URLSearchParams(search?.toString() ?? ""),
  );
  // A flex row, so the strip sizes to its tabs (and still shrinks into its
  // More menu) instead of stretching across the header as a block.
  return tabs ? (
    <div className="flex">
      <ModuleHomeTabs tabs={tabs} />
    </div>
  ) : null;
}

export function PageViewTabs() {
  const groups = useContext(ViewTabsContext);
  if (!groups?.length) return null;
  return (
    <Suspense fallback={null}>
      <ResolvedViewTabs groups={groups} />
    </Suspense>
  );
}
