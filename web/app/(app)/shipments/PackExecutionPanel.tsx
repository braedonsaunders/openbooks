"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Label, Select } from "@openbooks/ui";
import { PagedTable } from "@/components/paged-table";
import {
  DirectedExecutionForm,
  executionRequest,
  useDirectedExecution,
} from "@/components/directed-execution";
import { readApiErrorMessage } from "@/lib/api-error";
import { useBusinessToday } from "@/components/business-date-provider";
import type { FulfillmentDocumentView } from "@openbooks/engine/src/sales/fulfillment.ts";
export interface UnitView {
  id: string;
  code: string;
  status: string;
  binId: string;
  binCode: string;
  version: string;
  lines: {
    lineId: string;
    itemId: string;
    quantity: string;
    confirmed: boolean;
  }[];
}
export function PackExecutionPanel({
  shipment,
  canManage,
  canMove,
}: {
  shipment: FulfillmentDocumentView;
  canManage: boolean;
  canMove: boolean;
}) {
  const router = useRouter(),
    today = useBusinessToday();
  const [units, setUnits] = useState<UnitView[]>([]),
    [selected, setSelected] = useState(""),
    [code, setCode] = useState("");
  const [bin, setBin] = useState(shipment.lines[0]?.binId ?? ""),
    [lineIds, setLineIds] = useState<string[]>([]);
  const [bins, setBins] = useState<{ id: string; code: string }[]>([]);
  const [destination, setDestination] = useState(""),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [moveKey, setMoveKey] = useState(() => crypto.randomUUID());
  const load = useCallback(async () => {
    const response = await fetch(
      `/api/shipping/handling-units?shipmentId=${shipment.id}`,
      { cache: "no-store" },
    );
    if (!response.ok)
      throw new Error(
        await readApiErrorMessage(response, "Cartons could not be loaded"),
      );
    const result = (await response.json()) as {
      units: UnitView[];
      bins: { id: string; code: string }[];
    };
    setUnits(result.units);
    setBins(result.bins);
  }, [shipment.id]);
  useEffect(() => {
    let active = true;
    void load().catch((cause) => {
      if (active) setError(cause.message);
    });
    return () => {
      active = false;
    };
  }, [load]);
  const execution = useDirectedExecution("/api/fulfillment/execution", () => {
    void load().catch((cause) => setError(cause.message));
    router.refresh();
  });
  const unit = units.find((row) => row.id === selected),
    assigned = new Set(
      units.flatMap((row) => row.lines.map((line) => line.lineId)),
    );
  const binOptions = bins.map((bin) => ({ id: bin.id, label: bin.code }));
  async function command(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const result = await executionRequest<{ id?: string }>(
        "/api/shipping/handling-units",
        body,
      );
      await load();
      if (body.action === "create" && result.id) setSelected(result.id);
      if (body.action === "move") setMoveKey(crypto.randomUUID());
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Carton operation was refused",
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
  return (
    <div className="space-y-4">
      {error || execution.error ? (
        <p role="alert" className="text-destructive text-sm">
          {error ?? execution.error}
        </p>
      ) : null}
      <Label>
        Handling unit
        <Select
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
        >
          <option value="">New carton</option>
          {units.map((row) => (
            <option key={row.id} value={row.id}>
              {row.code} · {row.status} · {row.binCode}
            </option>
          ))}
        </Select>
      </Label>
      {!unit ? (
        <div className="space-y-3">
          {canManage ? (
            <>
              <Label>
                Carton code
                <Input
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </Label>
              <Label>
                Packing bin
                <Select
                  value={bin}
                  onChange={(event) => setBin(event.target.value)}
                >
                  {binOptions.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.label}
                    </option>
                  ))}
                </Select>
              </Label>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">
                  Assign shipment contents
                </legend>
                {shipment.lines
                  .filter((line) => !assigned.has(line.lineId))
                  .map((line) => (
                    <label
                      key={line.lineId}
                      className="flex items-center gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={lineIds.includes(line.lineId)}
                        onChange={(event) =>
                          setLineIds(
                            event.target.checked
                              ? [...lineIds, line.lineId]
                              : lineIds.filter((id) => id !== line.lineId),
                          )
                        }
                      />
                      {line.itemLabel} · {line.quantity} {line.unit ?? ""} ·{" "}
                      {line.binCode}
                    </label>
                  ))}
              </fieldset>
              <Button
                disabled={busy || !code.trim() || !lineIds.length}
                onClick={() =>
                  command({
                    action: "create",
                    shipmentId: shipment.id,
                    code,
                    binId: bin,
                    lineIds,
                  })
                }
              >
                Create handling unit
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Select a carton to review its contents.
            </p>
          )}
        </div>
      ) : (
        <>
          <p className="text-sm">
            {unit.code} · {unit.binCode} · {unit.status}
          </p>
          <PagedTable
            source="handling_unit_contents"
            rows={unit.lines}
            rowKey={(line) => line.lineId}
            empty="No carton contents"
            columns={[
              {
                key: "item",
                header: "Item",
                cell: (line) =>
                  shipment.lines.find((row) => row.lineId === line.lineId)
                    ?.itemLabel ?? line.itemId,
              },
              { key: "qty", header: "Quantity", cell: (line) => line.quantity },
              {
                key: "confirmation",
                header: "Confirmation",
                cell: (line) =>
                  line.confirmed ? (
                    "Confirmed"
                  ) : canManage && unit.status === "open" ? (
                    <Button
                      size="sm"
                      disabled={execution.busy}
                      onClick={() =>
                        execution.prepare({
                          action: "pack",
                          unitId: unit.id,
                          lineId: line.lineId,
                        })
                      }
                    >
                      Confirm contents
                    </Button>
                  ) : (
                    "Awaiting confirmation"
                  ),
              },
            ]}
          />
          {canManage && unit.status === "open" ? (
            <Button
              disabled={busy}
              onClick={() => command({ action: "seal", unitId: unit.id })}
            >
              Mark carton packed
            </Button>
          ) : null}
          {canMove && unit.status === "packed" ? (
            <fieldset className="space-y-2 rounded-md border p-3">
              <legend className="text-sm font-medium">
                Move handling unit
              </legend>
              <Label>
                Destination bin
                <Select
                  value={destination}
                  onChange={(event) => setDestination(event.target.value)}
                >
                  <option value="">Choose a bin</option>
                  {bins
                    .filter((bin) => bin.id !== unit.binId)
                    .map((bin) => (
                      <option key={bin.id} value={bin.id}>
                        {bin.code}
                      </option>
                    ))}
                </Select>
              </Label>
              <Label>
                Reason
                <Input
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </Label>
              <Button
                disabled={busy || !destination || reason.trim().length < 5}
                onClick={() =>
                  command({
                    action: "move",
                    unitId: unit.id,
                    toBinId: destination,
                    date: today,
                    reason,
                    commandKey: moveKey,
                  })
                }
              >
                Move carton
              </Button>
            </fieldset>
          ) : null}
        </>
      )}
    </div>
  );
}
