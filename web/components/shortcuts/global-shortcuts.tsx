"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { queryDrawerRouteGuard } from "@openbooks/ui";
import { useGlobalCreate, type GlobalCreatePermissions } from "../global-create-menu";
import type { SidebarNavGroup } from "../sidebar-nav";
import { useShortcuts } from "./shortcut-provider";
import { GLOBAL_CREATE_SHORTCUTS, GLOBAL_GO_SHORTCUTS } from "./shortcut-catalog";
import type { ShortcutCommand } from "./shortcut-keys";

/** Whether the reader's resolved navigation offers `href` (permission, feature and tenant menu applied). */
function navigationOffers(groups: readonly SidebarNavGroup[], href: string): boolean {
  return groups.some(
    (group) => group.groupHref === href || group.items.some((item) => item.href === href),
  );
}

/**
 * Application-wide Ctrl+Alt (⌃⌥) commands. A create command exists only
 * when the shell's create menu offers it (the same permission and feature
 * resolution), and runs the menu's own create path; a go-to command exists
 * only when the reader's navigation includes the destination.
 */
export function GlobalShortcuts({
  permissions,
  groups,
}: {
  permissions: GlobalCreatePermissions;
  groups: readonly SidebarNavGroup[];
}) {
  const t = useTranslations("shell.shortcuts.commands");
  const router = useRouter();
  const { available, create } = useGlobalCreate(permissions);
  const offered = new Set(available.map((action) => action.key));

  const commands: ShortcutCommand[] = [
    ...GLOBAL_CREATE_SHORTCUTS.filter((shortcut) => offered.has(shortcut.create)).map(
      (shortcut): ShortcutCommand => ({
        id: shortcut.id,
        label: t(shortcut.id),
        binding: { modifier: "chord", code: shortcut.code },
        scope: "global",
        run: () => void create(shortcut.create),
      }),
    ),
    ...GLOBAL_GO_SHORTCUTS.filter((shortcut) => navigationOffers(groups, shortcut.href)).map(
      (shortcut): ShortcutCommand => ({
        id: shortcut.id,
        label: t(shortcut.id),
        binding: { modifier: "chord", code: shortcut.code },
        scope: "global",
        run: () => {
          void queryDrawerRouteGuard().then((allowed) => {
            if (allowed) router.push(shortcut.href as never);
          });
        },
      }),
    ),
  ];
  useShortcuts(commands);
  return null;
}
