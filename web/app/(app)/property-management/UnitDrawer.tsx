"use client";

import { useEffect, useState } from "react";
import { Drawer, Button, Input } from "@openbooks/ui";
import { Field } from "./workspace-ui";

export function UnitDrawer({ propertyId, onClose, busy, onSave }: any) {
  const [form, setForm] = useState({
    code: "",
    name: "",
    unitType: "",
    rentableArea: "",
    bedrooms: "",
  });
  useEffect(() => {
    if (propertyId)
      setForm({
        code: "",
        name: "",
        unitType: "",
        rentableArea: "",
        bedrooms: "",
      });
  }, [propertyId]);
  const submit = () =>
    onSave({
      propertyId,
      ...form,
      rentableArea: form.rentableArea || null,
      bedrooms: form.bedrooms ? Number(form.bedrooms) : null,
    });
  return (
    <Drawer
      open={!!propertyId}
      onClose={onClose}
      stacked
      title="Add rentable unit"
      description="Units carry occupancy and rentable-area evidence for CAM allocation."
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !form.code} onClick={submit}>
            {busy ? "Adding…" : "Add unit"}
          </Button>
        </>
      }
    >
      <div className="space-y-4 p-1">
        <Field label="Unit code">
          <Input
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value })}
          />
        </Field>
        <Field label="Display name">
          <Input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Unit type">
            <Input
              value={form.unitType}
              onChange={(e) => setForm({ ...form, unitType: e.target.value })}
            />
          </Field>
          <Field label="Rentable area">
            <Input
              type="number"
              min="0"
              value={form.rentableArea}
              onChange={(e) =>
                setForm({ ...form, rentableArea: e.target.value })
              }
            />
          </Field>
          <Field label="Bedrooms">
            <Input
              type="number"
              min="0"
              value={form.bedrooms}
              onChange={(e) => setForm({ ...form, bedrooms: e.target.value })}
            />
          </Field>
        </div>
      </div>
    </Drawer>
  );
}
