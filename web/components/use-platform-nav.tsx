"use client";

import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { selectPlatformNav } from "@braedonsaunders/appkit-superadmin";
import { createOpenBooksPlatformNav } from "../lib/platform-console";
import type { SidebarNavGroup } from "./sidebar-nav";

/**
 * The platform console is a separate workspace, not a child of Admin Center.
 * Replace the tenant-configurable application menu while the operator is under
 * `/platform`; the account menu is the entry point.
 */
export function useNavGroups(groups: SidebarNavGroup[]): SidebarNavGroup[] {
  const t = useTranslations("platform");
  const platformNav = createOpenBooksPlatformNav(t);
  return selectPlatformNav(usePathname() ?? "", groups, platformNav.groups as SidebarNavGroup[]);
}
