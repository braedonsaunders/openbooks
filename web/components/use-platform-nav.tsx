"use client";

import { usePathname } from "next/navigation";
import type { SidebarNavGroup } from "./sidebar-nav";

const PLATFORM_NAV_GROUPS: SidebarNavGroup[] = [
  {
    id: "platform",
    label: "Platform",
    iconKey: "shield",
    groupHref: "/platform",
    items: [
      { href: "/platform", label: "Overview", iconKey: "grid", exact: true },
      {
        href: "/platform/organizations",
        label: "Organizations",
        iconKey: "building",
      },
      { href: "/platform/users", label: "Users", iconKey: "users" },
      { href: "/platform/access", label: "Cross-org access", iconKey: "key" },
      { href: "/platform/email-log", label: "Email log", iconKey: "mail" },
      {
        href: "/",
        label: "Organization workspace",
        iconKey: "chevron-right",
        exact: true,
      },
    ],
  },
];

/**
 * The platform console is a separate workspace, not a child of Admin Center.
 * Replace the tenant-configurable application menu while the operator is under
 * `/platform`; the account menu is the deliberate entry point.
 */
export function useNavGroups(groups: SidebarNavGroup[]): SidebarNavGroup[] {
  return (usePathname() ?? "").startsWith("/platform")
    ? PLATFORM_NAV_GROUPS
    : groups;
}
