"use client";

import { usePathname } from "next/navigation";
import { selectPlatformNav } from "@braedonsaunders/appkit-superadmin";
import { OPENBOOKS_PLATFORM_NAV } from "../lib/platform-console";
import type { SidebarNavGroup } from "./sidebar-nav";

/**
 * The platform console is a separate workspace, not a child of Admin Center.
 * Replace the tenant-configurable application menu while the operator is under
 * `/platform`; the account menu is the entry point.
 */
export function useNavGroups(groups: SidebarNavGroup[]): SidebarNavGroup[] {
  return selectPlatformNav(
    usePathname() ?? "",
    groups,
    OPENBOOKS_PLATFORM_NAV.groups as SidebarNavGroup[],
  );
}
