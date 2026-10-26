import "server-only";
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { loadConstruction as loadConstructionData, type ConstructionData } from "./_data";

const f = ref<ConstructionData>();

export function loadConstruction(
  sp: Record<string, string | string[] | undefined>,
): Promise<ConstructionData> {
  return loadConstructionData(sp);
}

export function constructionSpec(data: ConstructionData): PageSpec {
  return page({
    route: "/assets/construction",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actionsClassName: "flex flex-wrap items-center justify-end gap-2",
        actions: [
          widget("new-cip-button", { currentParams: data.currentParams }, f("canCapitalize")),
          widget("module-home-tabs", { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      widgetBlock("asset-construction-workspace", { data, currentParams: data.currentParams }),
    ],
  });
}
