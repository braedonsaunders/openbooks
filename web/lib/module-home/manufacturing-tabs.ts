import type { ModuleHomeTab } from "@/components/module-home/tab-types";

export type ManufacturingTabKey =
  "home" | "work-orders" | "work-centers" | "routings" | "mrp" | "quality" | "genealogy" | "time";

export type ManufacturingTabLabels = Record<ManufacturingTabKey, string>;

/** One permission-filtered route strip shared by the manufacturing pages. */
export function manufacturingModuleTabs(
  active: ManufacturingTabKey,
  labels: ManufacturingTabLabels,
  options: {
    mrp: boolean;
    quality: boolean;
    genealogy: boolean;
    time: boolean;
    subsidiaryId?: string;
  },
): ModuleHomeTab[] {
  const query = options.subsidiaryId ? `?sub=${encodeURIComponent(options.subsidiaryId)}` : "";
  const entries: Array<[ManufacturingTabKey, string, string, boolean]> = [
    ["home", "/manufacturing", labels.home, true],
    ["work-orders", "/manufacturing/work-orders", labels["work-orders"], true],
    ["work-centers", "/manufacturing/work-centers", labels["work-centers"], true],
    ["routings", "/manufacturing/routings", labels.routings, true],
    ["mrp", "/manufacturing/mrp", labels.mrp, options.mrp],
    ["quality", "/manufacturing/quality", labels.quality, options.quality],
    ["genealogy", "/manufacturing/genealogy", labels.genealogy, options.genealogy],
    ["time", "/manufacturing/time", labels.time, options.time],
  ];
  return entries
    .filter(([, , , visible]) => visible)
    .map(([key, href, label]) => ({
      href: href + query,
      label,
      active: key === active,
    }));
}
