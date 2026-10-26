import "server-only";
import {
  column,
  link,
  page,
  pageHeader,
  ref,
  text,
  widget,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import type { ListToolbarFilter } from "@/components/list-toolbar";
import type { ModuleHomeTab } from "@/components/module-home/tab-types";
import { registeredListTable } from "@/lib/list/prepared-spec";
import type { ManufacturingView } from "@openbooks/engine/manufacturing/workspace";

export type ManufacturingWorkspaceRow = { id: string; href: string; [key: string]: string };
export type ManufacturingWorkspaceData = {
  view: ManufacturingView;
  title: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
  newLabel: string;
  newRecordHref: string;
  canCreate: boolean;
  basePath: string;
  currentParams: Record<string, string | string[] | undefined>;
  rows: ManufacturingWorkspaceRow[];
  total: number;
  page: number;
  perPage: number;
  tabs: ModuleHomeTab[];
  columns: { key: string; label: string; linked?: boolean }[];
  searchPlaceholder: string;
  filters: ListToolbarFilter[];
};

const f = ref<ManufacturingWorkspaceData>();
const row = ref<ManufacturingWorkspaceRow>();

const SOURCES = {
  "work-orders": "manufacturing_work_orders",
  "work-centers": "manufacturing_work_centers",
  routings: "manufacturing_routings",
  mrp: "manufacturing_mrp",
} as const;

export function manufacturingWorkspaceSpec(data: ManufacturingWorkspaceData): PageSpec {
  return page({
    route: data.basePath,
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actionsClassName: "flex flex-wrap items-center gap-2",
        actions: [
          widget("module-home-tabs", { tabs: f("tabs") }),
          widget(
            "link-button",
            {
              href: f("newRecordHref"),
              label: f("newLabel"),
              iconKey: "plus",
            },
            f("canCreate"),
          ),
        ],
      }),
    ],
    body: [
      registeredListTable(
        SOURCES[data.view],
        {
          variant: "app",
          rows: f("rows"),
          rowKey: row("id"),
          empty: { title: f("emptyTitle"), description: f("emptyDescription") },
          columns: data.columns.map((definition) =>
            column(
              definition.label,
              definition.linked
                ? link(row(definition.key), row("href"))
                : text(row(definition.key)),
              definition.linked ? { className: "font-medium" } : undefined,
            ),
          ),
        },
        [
          widget("list-toolbar", {
            basePath: f("basePath"),
            currentParams: f("currentParams"),
            search: { placeholder: f("searchPlaceholder") },
            filters: f("filters"),
          }),
        ],
      ),
    ],
  });
}
