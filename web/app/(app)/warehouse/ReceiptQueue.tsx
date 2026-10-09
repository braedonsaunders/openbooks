"use client";
import { useRouter } from "next/navigation";
import { Button } from "@openbooks/ui";
import { AsyncUrlDrawer } from "@/components/async-url-drawer";
import { PagedTable } from "@/components/paged-table";
import {
  DirectedExecutionForm,
  useDirectedExecution,
} from "@/components/directed-execution";
export interface ReceiptQueueRow {
  lineId: string;
  number: string;
  itemLabel: string;
  binCode: string;
  quantity: string;
  confirmed: boolean;
}
export function ReceiptQueue({
  rows,
  canPost,
}: {
  rows: ReceiptQueueRow[];
  canPost: boolean;
}) {
  const router = useRouter(),
    execution = useDirectedExecution("/api/inventory/execution", () =>
      router.refresh(),
    );
  return (
    <>
      {execution.error && !execution.task ? (
        <p role="alert" className="text-sm text-destructive">
          {execution.error}
        </p>
      ) : null}
      <PagedTable
        source="warehouse_receipts"
        rows={rows}
        rowKey={(row) => row.lineId}
        searchable
        empty="No purchase receipts awaiting confirmation"
        columns={[
          {
            key: "receipt",
            header: "Purchase receipt",
            cell: (row) => row.number,
            search: (row) => row.number,
          },
          {
            key: "item",
            header: "Item",
            cell: (row) => row.itemLabel,
            search: (row) => row.itemLabel,
          },
          { key: "bin", header: "Suggested bin", cell: (row) => row.binCode },
          { key: "quantity", header: "Quantity", cell: (row) => row.quantity },
          {
            key: "action",
            header: "",
            cell: (row) =>
              row.confirmed ? (
                "Confirmed"
              ) : canPost ? (
                <Button
                  size="sm"
                  disabled={execution.busy}
                  onClick={() =>
                    execution.prepare({ action: "receive", lineId: row.lineId })
                  }
                >
                  Confirm receipt
                </Button>
              ) : null,
          },
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
        title="Confirm purchase receipt"
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
