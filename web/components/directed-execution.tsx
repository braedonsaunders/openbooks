"use client";
import { useRef, useState } from "react";
import { Button, Input, Label } from "@openbooks/ui";
import { readApiErrorMessage } from "@/lib/api-error";

export interface DirectedTask {
  id: string;
  stage: string;
  status: string;
  itemLabel: string;
  binCode: string;
  quantity: string;
  unit: string | null;
  baseQuantity: string;
  lotNumber: string | null;
  serialNumber: string | null;
  barcodeScanning: boolean;
}
export async function executionRequest<T>(
  url: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw Object.assign(
      new Error(
        await readApiErrorMessage(response, "Warehouse operation was refused"),
      ),
      { status: response.status },
    );
  return response.json() as Promise<T>;
}
function isConfirmedRefusal(error: unknown): boolean {
  const status =
    error instanceof Error
      ? (error as Error & { status?: number }).status
      : undefined;
  return typeof status === "number" && status >= 400 && status < 500;
}
/** The suggestion stays visible across mismatches and transport retries; scans never edit it. */
export function useDirectedExecution(endpoint: string, onDone: () => void) {
  const [task, setTask] = useState<DirectedTask | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const requestKeys = useRef(new Map<string, string>());
  const lastRequest = useRef<Record<string, unknown> | null>(null);
  const generation = useRef(0);
  const refused = useRef(false);
  const [open, setOpen] = useState(false);
  const [selectionKey, setSelectionKey] = useState("");
  async function prepare(body: Record<string, unknown>) {
    const current = ++generation.current;
    refused.current = false;
    lastRequest.current = body;
    setOpen(true);
    setSelectionKey(JSON.stringify(body));
    const identity = JSON.stringify(body),
      commandKey = requestKeys.current.get(identity) ?? crypto.randomUUID();
    requestKeys.current.set(identity, commandKey);
    setBusy(true);
    setError(null);
    try {
      const response = await executionRequest<{ task: DirectedTask }>(
        endpoint,
        { ...body, commandKey },
      );
      if (!response.task || typeof response.task.id !== "string")
        throw new Error(
          "Warehouse suggestion response was incomplete; retry the same request",
        );
      if (current === generation.current) setTask(response.task);
    } catch (cause) {
      if (current === generation.current) {
        refused.current = isConfirmedRefusal(cause);
        setError(
          cause instanceof Error
            ? cause.message
            : "Warehouse suggestion could not be loaded",
        );
      }
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  async function confirm(scan?: Record<string, string>) {
    if (!task) return;
    refused.current = false;
    setBusy(true);
    setError(null);
    try {
      const result = await executionRequest<{
        status: "done" | "exception";
        reason?: string;
      }>(endpoint, { action: "confirm", taskId: task.id, scan });
      if (result.status === "exception") {
        setError(result.reason ?? "Scan does not match the suggestion");
        return;
      }
      if (result.status !== "done")
        throw new Error(
          "Warehouse confirmation response was incomplete; retry the same confirmation",
        );
      setTask(null);
      setOpen(false);
      lastRequest.current = null;
      requestKeys.current.clear();
      onDone();
    } catch (cause) {
      refused.current = isConfirmedRefusal(cause);
      setError(
        cause instanceof Error
          ? cause.message
          : "Warehouse confirmation failed",
      );
    } finally {
      setBusy(false);
    }
  }
  return {
    task,
    open,
    selectionKey,
    retry: () => {
      if (lastRequest.current) void prepare(lastRequest.current);
    },
    busy,
    error,
    prepare,
    confirm,
    clear: () => {
      generation.current++;
      if (refused.current && lastRequest.current)
        requestKeys.current.delete(JSON.stringify(lastRequest.current));
      lastRequest.current = null;
      setOpen(false);
      setBusy(false);
      setTask(null);
      setError(null);
    },
  };
}
export function DirectedExecutionForm({
  task,
  busy,
  error,
  onConfirm,
  onBack,
}: {
  task: DirectedTask;
  busy: boolean;
  error: string | null;
  onConfirm: (scan?: Record<string, string>) => void;
  onBack: () => void;
}) {
  const [item, setItem] = useState(""),
    [bin, setBin] = useState(""),
    [quantity, setQuantity] = useState(""),
    [lot, setLot] = useState(""),
    [serial, setSerial] = useState("");
  const confirm = () =>
    onConfirm(
      task.barcodeScanning
        ? {
            item,
            bin,
            quantity,
            ...(task.lotNumber ? { lot } : {}),
            ...(task.serialNumber ? { serial } : {}),
          }
        : undefined,
    );
  return (
    <section
      className="space-y-4"
      aria-label="Confirm warehouse suggestion"
      onKeyDown={(event) => {
        if (
          event.key !== "Enter" ||
          !(event.target instanceof HTMLInputElement)
        )
          return;
        event.preventDefault();
        const fields = [
          ...event.currentTarget.querySelectorAll<HTMLInputElement>("input"),
        ];
        const next = fields[fields.indexOf(event.target) + 1];
        if (next) next.focus();
        else if (!busy) confirm();
      }}
    >
      <dl className="grid grid-cols-2 gap-3 rounded-md border p-3 text-sm">
        <div>
          <dt className="text-muted-foreground">Suggested item</dt>
          <dd className="font-medium">{task.itemLabel}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Suggested bin</dt>
          <dd className="font-mono">{task.binCode}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Quantity</dt>
          <dd>
            {task.quantity} {task.unit ?? ""}
            <span className="block text-xs text-muted-foreground">
              {task.baseQuantity} in base units
            </span>
          </dd>
        </div>
        {task.lotNumber ? (
          <div>
            <dt>Lot</dt>
            <dd>{task.lotNumber}</dd>
          </div>
        ) : null}
        {task.serialNumber ? (
          <div>
            <dt>Serial</dt>
            <dd>{task.serialNumber}</dd>
          </div>
        ) : null}
      </dl>
      {task.barcodeScanning ? (
        <div className="grid grid-cols-2 gap-3">
          <Label>
            Scan item
            <Input
              autoFocus
              value={item}
              onChange={(event) => setItem(event.target.value)}
              autoComplete="off"
            />
          </Label>
          <Label>
            Scan bin
            <Input
              value={bin}
              onChange={(event) => setBin(event.target.value)}
              autoComplete="off"
            />
          </Label>
          <Label>
            Confirm quantity in scanned item units
            <Input
              inputMode="decimal"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
          </Label>
          {task.lotNumber ? (
            <Label>
              Scan lot
              <Input
                value={lot}
                onChange={(event) => setLot(event.target.value)}
              />
            </Label>
          ) : null}
          {task.serialNumber ? (
            <Label>
              Scan serial
              <Input
                value={serial}
                onChange={(event) => setSerial(event.target.value)}
              />
            </Label>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button disabled={busy} onClick={confirm}>
          Confirm
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onBack}>
          Back
        </Button>
      </div>
    </section>
  );
}
