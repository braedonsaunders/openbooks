"use client";

import { useEffect, useState } from "react";
import { Drawer, Button, Input, Select, Textarea } from "@openbooks/ui";
import { useBusinessToday } from "@/components/business-date-provider";
import type { Option } from "./workspace-ui";
import { Field } from "./workspace-ui";

export function CamDrawer({
  open,
  stacked,
  initialPropertyId,
  pool,
  onClose,
  data,
  expenseAccounts,
  busy,
  onSave,
}: any) {
  const today = useBusinessToday();
  const year = Number(today.slice(0, 4));
  const initial = {
    propertyId:
      pool?.propertyId ?? initialPropertyId ?? data.properties[0]?.id ?? "",
    name: pool?.name ?? "Operating expenses",
    fiscalYear: String(pool?.fiscalYear ?? year),
    periodStartsOn: pool?.periodStartsOn ?? `${year}-01-01`,
    periodEndsOn: pool?.periodEndsOn ?? `${year}-12-31`,
    allocationBasis: pool?.allocationBasis ?? "rentable_area",
    budgetAmount: pool?.budgetAmount ?? "",
    expenseAccountIds: (pool?.expenseAccountIds ?? []) as string[],
  };
  const [form, setForm] = useState(initial);
  useEffect(() => {
    if (open) setForm(initial);
  }, [open, pool?.id, initialPropertyId, data.properties.length]);
  const submit = () => onSave({ ...form, fiscalYear: Number(form.fiscalYear) });
  return (
    <Drawer
      open={open}
      stacked={stacked}
      onClose={onClose}
      title={pool ? "Edit CAM pool" : "New CAM pool"}
      description="CAM actuals are read from posted GL lines on the property's location and selected expense accounts."
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              busy ||
              !form.propertyId ||
              !form.name ||
              !form.budgetAmount ||
              !form.expenseAccountIds.length
            }
            onClick={submit}
          >
            {busy ? "Saving…" : pool ? "Save CAM pool" : "Create CAM pool"}
          </Button>
        </>
      }
    >
      <div className="space-y-4 p-1">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Property">
            <Select
              value={form.propertyId}
              disabled={!!initialPropertyId || !!pool}
              onChange={(e) => setForm({ ...form, propertyId: e.target.value })}
            >
              <option value="">Select property</option>
              {data.properties.map((o: any) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Pool name">
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="Fiscal year">
            <Input
              type="number"
              value={form.fiscalYear}
              onChange={(e) => setForm({ ...form, fiscalYear: e.target.value })}
            />
          </Field>
          <Field label="Allocation basis">
            <Select
              value={form.allocationBasis}
              onChange={(e) =>
                setForm({ ...form, allocationBasis: e.target.value })
              }
            >
              <option value="rentable_area">Rentable area</option>
              <option value="equal">Equal</option>
              <option value="custom">Lease CAM share</option>
            </Select>
          </Field>
          <Field label="Period starts">
            <Input
              type="date"
              value={form.periodStartsOn}
              onChange={(e) =>
                setForm({ ...form, periodStartsOn: e.target.value })
              }
            />
          </Field>
          <Field label="Period ends">
            <Input
              type="date"
              value={form.periodEndsOn}
              onChange={(e) =>
                setForm({ ...form, periodEndsOn: e.target.value })
              }
            />
          </Field>
          <Field label="Budget">
            <Input
              type="number"
              min="0"
              value={form.budgetAmount}
              onChange={(e) =>
                setForm({ ...form, budgetAmount: e.target.value })
              }
            />
          </Field>
        </div>
        <Field
          label="Recoverable expense accounts"
          hint="Only posted activity on these accounts and the property's location is included."
        >
          <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-slate-200 p-2 dark:border-slate-800">
            {expenseAccounts.map((o: Option) => (
              <label
                key={o.id}
                className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-slate-50 dark:hover:bg-slate-900"
              >
                <input
                  type="checkbox"
                  checked={form.expenseAccountIds.includes(o.id)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      expenseAccountIds: e.target.checked
                        ? [...form.expenseAccountIds, o.id]
                        : form.expenseAccountIds.filter((id) => id !== o.id),
                    })
                  }
                />
                {o.name}
              </label>
            ))}
          </div>
        </Field>
      </div>
    </Drawer>
  );
}

export function CamCorrectionDrawer({
  open,
  stacked,
  pool,
  busy,
  onClose,
  onSave,
}: any) {
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (open) setReason("");
  }, [open, pool?.id]);
  return (
    <Drawer
      open={open}
      stacked={stacked}
      onClose={onClose}
      title="Reopen CAM for correction"
      description={`${pool?.name ?? "CAM pool"} will return to open status and its calculated allocations will be removed.`}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || !reason.trim()}
            onClick={() => onSave(reason)}
          >
            {busy ? "Reopening…" : "Reopen pool"}
          </Button>
        </>
      }
    >
      <div className="p-1">
        <Field
          label="Correction reason"
          hint="This explanation is written to the audit trail. Invoiced CAM pools cannot be reopened."
        >
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Explain why the finalized allocation needs to be recalculated"
          />
        </Field>
      </div>
    </Drawer>
  );
}
