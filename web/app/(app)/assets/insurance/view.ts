import "server-only";
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { loadInsurance as loadInsuranceData, type InsuranceData } from "./_data";

const f = ref<InsuranceData>();

export function loadInsurance(
  sp: Record<string, string | string[] | undefined>,
): Promise<InsuranceData> {
  return loadInsuranceData(sp);
}

export function insuranceSpec(data: InsuranceData): PageSpec {
  return page({
    route: "/assets/insurance",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actionsClassName: "flex flex-wrap items-center justify-end gap-2",
        actions: [
          widget(
            "new-insurance-policy-button",
            { currentParams: data.currentParams },
            f("canMaintain"),
          ),
          widget("module-home-tabs", { tabs: data.tabs }),
        ],
      }),
    ],
    body: [widgetBlock("asset-insurance-workspace", { data, currentParams: data.currentParams })],
  });
}
