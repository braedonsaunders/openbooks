"use client";

import { useEffect, useState } from "react";
import { Drawer, Button, Input, Select } from "@openbooks/ui";
import { useBusinessToday } from "@/components/business-date-provider";
import type { Option } from "./workspace-ui";
import { Field } from "./workspace-ui";
import type { PropertyWorkspace, SaveAction } from "./types";

export function LeaseDrawer({ open, stacked, initialPropertyId, initialUnitId, onClose, data, tenants, busy, onSave }: {
  open: boolean;
  stacked?: boolean;
  initialPropertyId?: string;
  initialUnitId?: string | null;
  onClose: () => void;
  data: PropertyWorkspace;
  tenants: Option[];
  busy: boolean;
  onSave: SaveAction;
}) {
  const today = useBusinessToday();
  const initial = {
    propertyId: initialPropertyId ?? data.properties[0]?.id ?? "",
    unitId: initialUnitId ?? "",
    tenantId: "",
    leaseNumber: "",
    startsOn: today,
    endsOn: "",
    baseRent: "",
    billingDay: "1",
    paymentTermsDays: "0",
    securityDepositRequired: "0",
    camMethod: "none",
    camSharePercent: "",
    lateFeeType: "none",
    lateFeeValue: "0",
    graceDays: "0",
    autoInvoice: true,
    autoPost: false,
  };
  const [form, setForm] = useState(initial);
  useEffect(() => {
    if (open)
      setForm({
        ...initial,
        propertyId: initialPropertyId ?? data.properties[0]?.id ?? "",
        unitId: initialUnitId ?? "",
      });
  }, [open, initialPropertyId, initialUnitId, data.properties.length]);
  const units = data.units.filter(
    (unit) => unit.propertyId === form.propertyId && unit.status === "vacant",
  );
  const submit = () =>
    onSave({
      ...form,
      unitId: form.unitId || null,
      endsOn: form.endsOn || null,
      billingDay: Number(form.billingDay),
      paymentTermsDays: Number(form.paymentTermsDays),
      graceDays: Number(form.graceDays),
      camSharePercent: form.camSharePercent || null,
    });
  return (
    <Drawer
      open={open}
      onClose={onClose}
      stacked={stacked}
      title="New tenant lease"
      description="The draft freezes commercial policy before activation creates the rent schedule."
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              busy ||
              !form.leaseNumber ||
              !form.propertyId ||
              !form.tenantId ||
              !form.startsOn ||
              !form.baseRent
            }
            onClick={submit}
          >
            {busy ? "Creating…" : "Create draft lease"}
          </Button>
        </>
      }
    >
      <div className="space-y-4 p-1">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Lease number">
            <Input
              value={form.leaseNumber}
              onChange={(e) =>
                setForm({ ...form, leaseNumber: e.target.value })
              }
            />
          </Field>
          <Field label="Tenant">
            <Select
              value={form.tenantId}
              onChange={(e) => setForm({ ...form, tenantId: e.target.value })}
            >
              <option value="">Select tenant</option>
              {tenants.map((o: Option) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Property">
            <Select
              value={form.propertyId}
              onChange={(e) =>
                setForm({ ...form, propertyId: e.target.value, unitId: "" })
              }
            >
              <option value="">Select property</option>
              {data.properties.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Unit">
            <Select
              value={form.unitId}
              onChange={(e) => setForm({ ...form, unitId: e.target.value })}
            >
              <option value="">Whole property / no unit</option>
              {units.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.code}
                  {o.name ? ` · ${o.name}` : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Starts">
            <Input
              type="date"
              value={form.startsOn}
              onChange={(e) => setForm({ ...form, startsOn: e.target.value })}
            />
          </Field>
          <Field label="Ends">
            <Input
              type="date"
              value={form.endsOn}
              onChange={(e) => setForm({ ...form, endsOn: e.target.value })}
            />
          </Field>
          <Field label="Monthly base rent">
            <Input
              type="number"
              min="0"
              step="0.01"
              value={form.baseRent}
              onChange={(e) => setForm({ ...form, baseRent: e.target.value })}
            />
          </Field>
          <Field label="Billing day">
            <Input
              type="number"
              min="1"
              max="31"
              value={form.billingDay}
              onChange={(e) => setForm({ ...form, billingDay: e.target.value })}
            />
          </Field>
          <Field label="Security deposit required">
            <Input
              type="number"
              min="0"
              value={form.securityDepositRequired}
              onChange={(e) =>
                setForm({ ...form, securityDepositRequired: e.target.value })
              }
            />
          </Field>
          <Field label="Payment terms days">
            <Input
              type="number"
              min="0"
              value={form.paymentTermsDays}
              onChange={(e) =>
                setForm({ ...form, paymentTermsDays: e.target.value })
              }
            />
          </Field>
          <Field label="CAM method">
            <Select
              value={form.camMethod}
              onChange={(e) => setForm({ ...form, camMethod: e.target.value })}
            >
              <option value="none">None</option>
              <option value="fixed">Fixed estimate</option>
              <option value="pro_rata">Pro rata reconciliation</option>
            </Select>
          </Field>
          <Field label="CAM share %">
            <Input
              type="number"
              min="0"
              max="100"
              value={form.camSharePercent}
              onChange={(e) =>
                setForm({ ...form, camSharePercent: e.target.value })
              }
            />
          </Field>
          <Field label="Late fee">
            <Select
              value={form.lateFeeType}
              onChange={(e) =>
                setForm({ ...form, lateFeeType: e.target.value })
              }
            >
              <option value="none">None</option>
              <option value="fixed">Fixed amount</option>
              <option value="percent">Percent of charge</option>
            </Select>
          </Field>
          <Field label="Late fee value">
            <Input
              type="number"
              min="0"
              value={form.lateFeeValue}
              onChange={(e) =>
                setForm({ ...form, lateFeeValue: e.target.value })
              }
            />
          </Field>
          <Field label="Grace days">
            <Input
              type="number"
              min="0"
              value={form.graceDays}
              onChange={(e) => setForm({ ...form, graceDays: e.target.value })}
            />
          </Field>
        </div>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.autoInvoice}
              onChange={(e) =>
                setForm({ ...form, autoInvoice: e.target.checked })
              }
            />
            Automatically invoice due charges
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.autoPost}
              onChange={(e) => setForm({ ...form, autoPost: e.target.checked })}
            />
            Automatically post when ungated
          </label>
        </div>
      </div>
    </Drawer>
  );
}
