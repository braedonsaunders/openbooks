"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { MaintenanceQueueRow } from "@openbooks/engine/assets/asset-maintenance";
import { Badge, Button } from "@openbooks/ui";
import { PagedTable, type PagedColumn } from "@/components/paged-table";
import { FilterChips } from "@/components/filter-bar";
import { mergeHref } from "@/lib/list-params";
import type { MaintenanceData } from "./_data";
import { ScheduleDrawer } from "./ScheduleDrawer";

const STANDING_VARIANT = {
  scheduled: "secondary",
  due: "warning",
  overdue: "destructive",
} as const;

export function NewScheduleButton({
  currentParams,
}: {
  currentParams: Record<string, string | string[] | undefined>;
}) {
  const t = useTranslations("assets");
  const router = useRouter();
  return (
    <Button
      onClick={() =>
        router.push(mergeHref("/assets/maintenance", currentParams, { schedule: "new" }))
      }
    >
      {t("maintenance.new")}
    </Button>
  );
}

export function MaintenanceWorkspace({
  data,
  currentParams,
}: {
  data: MaintenanceData;
  currentParams: Record<string, string | string[] | undefined>;
}) {
  const t = useTranslations("assets");
  const router = useRouter();
  const columns: PagedColumn<MaintenanceQueueRow>[] = [
    {
      key: "asset",
      header: t("maintenance.columns.asset"),
      cell: (row) => (
        <span>
          <span className="font-mono text-[13px]">{row.assetNumber}</span> {row.assetName}
        </span>
      ),
      search: (row) => `${row.assetNumber} ${row.assetName}`,
    },
    {
      key: "name",
      header: t("maintenance.columns.task"),
      cell: (row) => row.name,
      search: (row) => row.name,
    },
    {
      key: "dueOn",
      header: t("maintenance.columns.nextDueOn"),
      cell: (row) => row.nextDueOn ?? "—",
    },
    {
      key: "dueUsage",
      header: t("maintenance.columns.nextDueUsage"),
      align: "right",
      cell: (row) => (row.nextDueUsage ? `${row.nextDueUsage} ${row.usageUnit ?? ""}` : "—"),
    },
    {
      key: "current",
      header: t("maintenance.columns.currentUsage"),
      align: "right",
      cell: (row) => (row.currentUsage ? `${row.currentUsage} ${row.usageUnit ?? ""}` : "—"),
    },
    {
      key: "standing",
      header: t("maintenance.columns.standing"),
      cell: (row) => (
        <Badge variant={STANDING_VARIANT[row.standing]}>
          {t(`maintenance.standing.${row.standing}`)}
        </Badge>
      ),
    },
  ];
  return (
    <div className="space-y-4">
      <PagedTable
        rows={data.rows}
        columns={columns}
        source="asset_maintenance_schedules"
        searchable
        pageSize={25}
        rowKey={(row) => row.scheduleId}
        onRowClick={(row) =>
          router.push(mergeHref("/assets/maintenance", currentParams, { schedule: row.scheduleId }))
        }
        rowLabel={(row) => `${row.assetNumber} ${row.name}`}
        rowSelected={(row) => row.scheduleId === data.selected?.id}
        empty={
          <p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
            {t("maintenance.empty")}
          </p>
        }
        emptyAsRow
        toolbarAfter={
          <FilterChips
            basePath="/assets/maintenance"
            currentParams={currentParams}
            paramKey="standing"
            label={t("maintenance.columns.standing")}
            allLabel={t("maintenance.standing.all")}
            options={(["due", "overdue"] as const).map((value) => ({
              value,
              label: t(`maintenance.standing.${value}`),
            }))}
          />
        }
      />
      {data.createMode ? (
        <ScheduleDrawer
          key="new"
          schedule={null}
          createMode
          data={data}
          closeHref={mergeHref("/assets/maintenance", currentParams, { schedule: undefined })}
        />
      ) : data.selected ? (
        <ScheduleDrawer
          key={data.selected.id}
          schedule={data.selected}
          data={data}
          closeHref={mergeHref("/assets/maintenance", currentParams, { schedule: undefined })}
        />
      ) : null}
    </div>
  );
}
