import "server-only";

import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { loadInventory as loadInventoryData } from "./loader";
import type { InventoryWorkspaceData } from "./InventoryWorkspace";

export interface InventoryPageData {
  title: string;
  description: string;
  newCountLabel: string;
  setupNewLabel: string;
  workspace: InventoryWorkspaceData;
}

const f = ref<InventoryPageData>();

export function loadInventory(
  sp: Record<string, string | string[] | undefined>,
): Promise<InventoryPageData> {
  return loadInventoryData(sp);
}

/** The URL-driven inventory workspace: the shared page shell owns chrome and
 * the native inventory widgets keep their domain-specific workflows intact. */
export function inventorySpec(_data: InventoryPageData): PageSpec {
  return page({
    route: "/inventory",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actionsClassName: "flex items-center gap-3",
        actions: [
          widget("inventory-header-actions", {
            workspace: f("workspace"),
            newCountLabel: f("newCountLabel"),
            setupNewLabel: f("setupNewLabel"),
          }),
        ],
      }),
    ],
    body: [
      widgetBlock("inventory-workspace", {
        workspace: f("workspace"),
      }),
    ],
  });
}
