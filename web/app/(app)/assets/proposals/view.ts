import "server-only";
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { loadProposals as loadProposalsData, type ProposalsData } from "./_data";

const f = ref<ProposalsData>();

export function loadProposals(
  sp: Record<string, string | string[] | undefined>,
): Promise<ProposalsData> {
  return loadProposalsData(sp);
}

export function proposalsSpec(data: ProposalsData): PageSpec {
  return page({
    route: "/assets/proposals",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actions: [widget("module-home-tabs", { tabs: data.tabs })],
      }),
    ],
    body: [widgetBlock("asset-proposals-workspace", { data, currentParams: data.currentParams })],
  });
}
