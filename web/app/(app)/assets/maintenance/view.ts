import "server-only";
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { loadMaintenance as loadMaintenanceData, type MaintenanceData } from "./_data";

const f = ref<MaintenanceData>();

export function loadMaintenance(
  sp: Record<string, string | string[] | undefined>,
): Promise<MaintenanceData> {
  return loadMaintenanceData(sp);
}

export function maintenanceSpec(data: MaintenanceData): PageSpec {
  return page({
    route: "/assets/maintenance",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actionsClassName: "flex flex-wrap items-center justify-end gap-2",
        actions: [
          widget(
            "new-maintenance-schedule-button",
            { currentParams: data.currentParams },
            f("canMaintain"),
          ),
          widget("module-home-tabs", { tabs: data.tabs }),
        ],
      }),
    ],
    body: [widgetBlock("asset-maintenance-workspace", { data, currentParams: data.currentParams })],
  });
}
