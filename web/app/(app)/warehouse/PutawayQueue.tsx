"use client";

import { useState } from "react";
import { AsyncUrlDrawer } from "@/components/async-url-drawer";
import {
  DirectedExecutionForm,
  useDirectedExecution,
} from "@/components/directed-execution";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@openbooks/ui";
import { useBusinessToday } from "@/components/business-date-provider";
import { PagedTable } from "@/components/paged-table";

export interface StagedStockRowView {
  warehouseId: string;
  warehouseCode: string;
  stagingLocationId: string;
  stagingCode: string;
  itemId: string;
  itemLabel: string;
  subsidiaryId: string;
  quantity: string;
  lotId: string | null;
  serialId: string | null;
  lotNumber: string | null;
  serialNumber: string | null;
}

const rowId = (row: StagedStockRowView) =>
  `${row.stagingLocationId}:${row.itemId}:${row.subsidiaryId}:${row.lotId ?? ""}:${row.serialId ?? ""}`;

/**
 * Stock waiting in staging locations. "Put away" moves the whole staged
 * quantity to the location the warehouse's putaway rules resolve; a refusal
 * names every rule tried. One retry identity per row and quantity, so a lost
 * response replays instead of moving the stock twice.
 */
export function PutawayQueue({
  rows,
  canPost,
}: {
  rows: StagedStockRowView[];
  canPost: boolean;
}) {
  const t = useTranslations("warehouse");
  const router = useRouter();
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [postingDate] = useState(useBusinessToday());
  const execution = useDirectedExecution("/api/inventory/execution", () =>
    router.refresh(),
  );
  async function putAway(row: StagedStockRowView) {
    setBusyRow(rowId(row));
    await execution.prepare({
      action: "putaway",
      warehouseId: row.warehouseId,
      stagingLocationId: row.stagingLocationId,
      itemId: row.itemId,
      subsidiaryId: row.subsidiaryId,
      quantity: row.quantity,
      lotId: row.lotId,
      serialId: row.serialId,
      date: postingDate,
    });
    setBusyRow(null);
  }

  return (
    <>
      {execution.error && !execution.task ? (
        <p role="alert" className="text-sm text-destructive">
          {execution.error}
        </p>
      ) : null}
      <PagedTable<StagedStockRowView>
        source="warehouse_putaway"
        rows={rows}
        rowKey={rowId}
        searchable
        pageSize={10}
        emptyAsRow
        empty={
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t("putaway.empty")}
          </p>
        }
        columns={[
          {
            key: "warehouse",
            header: t("putaway.columns.warehouse"),
            cell: (row) => row.warehouseCode,
            search: (row) => row.warehouseCode,
          },
          {
            key: "staging",
            header: t("putaway.columns.staging"),
            cell: (row) => row.stagingCode,
            search: (row) => row.stagingCode,
          },
          {
            key: "item",
            header: t("putaway.columns.item"),
            cell: (row) => <span className="font-medium">{row.itemLabel}</span>,
            search: (row) => row.itemLabel,
          },
          {
            key: "tracking",
            header: "Lot / serial",
            cell: (row) =>
              [row.lotNumber, row.serialNumber].filter(Boolean).join(" / ") ||
              "—",
          },
          {
            key: "quantity",
            header: t("putaway.columns.quantity"),
            align: "right",
            cell: (row) => <span className="tabular-nums">{row.quantity}</span>,
          },
          ...(canPost
            ? [
                {
                  key: "action",
                  header: (
                    <span className="sr-only">
                      {t("putaway.columns.action")}
                    </span>
                  ),
                  align: "right" as const,
                  cell: (row: StagedStockRowView) => (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyRow !== null}
                      onClick={() => void putAway(row)}
                    >
                      {t("putaway.action")}
                    </Button>
                  ),
                },
              ]
            : []),
        ]}
      />
      <AsyncUrlDrawer
        open={execution.open}
        openKey={execution.selectionKey}
        pending={!execution.task && execution.busy}
        error={!execution.task ? execution.error : null}
        onRetry={execution.retry}
        onOpenChange={(open) => {
          if (!open && !execution.busy) execution.clear();
        }}
        title="Confirm putaway"
      >
        {execution.task ? (
          <DirectedExecutionForm
            key={execution.task.id}
            task={execution.task}
            busy={execution.busy}
            error={execution.error}
            onConfirm={execution.confirm}
            onBack={execution.clear}
          />
        ) : null}
      </AsyncUrlDrawer>
    </>
  );
}
