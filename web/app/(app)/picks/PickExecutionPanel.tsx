"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { RecordTabs } from "@/components/module-home/record-tabs";
import { Button, Input, Label, Select } from "@openbooks/ui";
import { PagedTable } from "@/components/paged-table";
import {
  DirectedExecutionForm,
  executionRequest,
  useDirectedExecution,
} from "@/components/directed-execution";
import type { FulfillmentDocumentView } from "@openbooks/engine/src/sales/fulfillment.ts";

function localCutoff(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

export function PickExecutionPanel({
  pick,
  canManage,
}: {
  pick: FulfillmentDocumentView;
  canManage: boolean;
}) {
  const router = useRouter(),
    execution = useDirectedExecution("/api/fulfillment/execution", () =>
      router.refresh(),
    );
  const [quantities, setQuantities] = useState<Record<string, string>>({}),
    [reasons, setReasons] = useState<Record<string, string>>({});
  const [priority, setPriority] = useState(String(pick.pickPriority ?? 0)),
    [cutoff, setCutoff] = useState(localCutoff(pick.releaseCutoffAt)),
    [mode, setMode] = useState("cutoff"),
    [error, setError] = useState<string | null>(null);
  const [dispatchTab, setDispatchTab] = useState("policy");
  const [busy, setBusy] = useState(false),
    [commandKey, setCommandKey] = useState(() => crypto.randomUUID());
  async function dispatch(action: "policy" | "release") {
    setBusy(true);
    setError(null);
    try {
      if (!cutoff) throw new Error("Choose the release cutoff");
      const cutoffAt = new Date(cutoff).toISOString();
      await executionRequest(
        "/api/fulfillment/waves",
        action === "policy"
          ? {
              action,
              pickListId: pick.id,
              priority: Number(priority),
              cutoffAt,
            }
          : {
              action,
              warehouseId: pick.warehouse.id,
              subsidiaryId: pick.subsidiaryId,
              mode,
              cutoffAt,
              commandKey,
            },
      );
      if (action === "release") setCommandKey(crypto.randomUUID());
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Pick dispatch was refused",
      );
    } finally {
      setBusy(false);
    }
  }
  if (execution.task)
    return (
      <DirectedExecutionForm
        key={execution.task.id}
        task={execution.task}
        busy={execution.busy}
        error={execution.error}
        onConfirm={execution.confirm}
        onBack={execution.clear}
      />
    );
  if (pick.status === "draft")
    return (
      <div className="space-y-3">
        <RecordTabs
          label="Pick dispatch"
          active={dispatchTab}
          onChange={setDispatchTab}
          tabs={[
            { key: "policy", label: "This pick" },
            { key: "wave", label: "Warehouse wave" },
          ]}
        />
        <p className="text-sm text-muted-foreground">
          {dispatchTab === "policy"
            ? "Set the priority and release cutoff for this pick."
            : "Release eligible draft picks in this warehouse and legal entity."}
        </p>
        {dispatchTab === "policy" ? (
          <Label>
            Priority
            <Input
              inputMode="numeric"
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
            />
          </Label>
        ) : null}
        <Label>
          Release cutoff
          <Input
            type="datetime-local"
            value={cutoff}
            onChange={(event) => setCutoff(event.target.value)}
          />
        </Label>
        {dispatchTab === "wave" ? (
          <Label>
            Wave sequence
            <Select
              value={mode}
              onChange={(event) => setMode(event.target.value)}
            >
              <option value="cutoff">Cutoff</option>
              <option value="priority">Priority</option>
            </Select>
          </Label>
        ) : null}
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        {canManage ? (
          <Button
            disabled={busy}
            onClick={() =>
              dispatch(dispatchTab === "policy" ? "policy" : "release")
            }
          >
            {dispatchTab === "policy"
              ? "Save dispatch policy"
              : "Release warehouse wave"}
          </Button>
        ) : null}
      </div>
    );
  return (
    <div className="space-y-3">
      {execution.error ? (
        <p role="alert" className="text-sm text-destructive">
          {execution.error}
        </p>
      ) : null}
      <PagedTable
        source="fulfillment_pick_execution"
        rows={pick.lines}
        rowKey={(line) => line.lineId}
        empty="No pick lines"
        columns={[
          { key: "item", header: "Item", cell: (line) => line.itemLabel },
          { key: "bin", header: "Suggested bin", cell: (line) => line.binCode },
          {
            key: "quantity",
            header: "Suggested quantity",
            cell: (line) => `${line.quantity} ${line.unit ?? ""}`,
          },
          {
            key: "actual",
            header: "Picked / short",
            cell: (line) =>
              line.pickedQuantity != null ? (
                `${line.pickedQuantity} / ${line.shortQuantity}`
              ) : (
                <div className="space-y-1">
                  <Input
                    aria-label={`Picked quantity for ${line.itemLabel}`}
                    inputMode="decimal"
                    value={quantities[line.lineId] ?? line.quantity}
                    onChange={(event) =>
                      setQuantities({
                        ...quantities,
                        [line.lineId]: event.target.value,
                      })
                    }
                  />
                  <Input
                    aria-label="Short-pick reason"
                    placeholder="Reason if short"
                    value={reasons[line.lineId] ?? ""}
                    onChange={(event) =>
                      setReasons({
                        ...reasons,
                        [line.lineId]: event.target.value,
                      })
                    }
                  />
                </div>
              ),
          },
          {
            key: "action",
            header: "",
            cell: (line) =>
              canManage &&
              pick.status === "approved" &&
              pick.stage === "open" &&
              line.pickedQuantity == null ? (
                <Button
                  size="sm"
                  disabled={execution.busy}
                  onClick={() =>
                    execution.prepare({
                      action: "pick",
                      lineId: line.lineId,
                      quantity: quantities[line.lineId] ?? line.quantity,
                      ...(reasons[line.lineId]
                        ? { reason: reasons[line.lineId] }
                        : {}),
                    })
                  }
                >
                  Confirm pick
                </Button>
              ) : null,
          },
        ]}
      />
    </div>
  );
}
