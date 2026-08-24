"use client";

import { useEffect, useState } from "react";
import { Drawer, Button, Input, Select } from "@openbooks/ui";
import type { Option } from "./workspace-ui";
import { Field } from "./workspace-ui";
import type { SaveAction, WorkspaceOptions } from "./types";

export function PropertyDrawer({ open, onClose, options, busy, onSave, fixedAssetsEnabled = false, multiCurrency = false }: { open: boolean; onClose: () => void; options: WorkspaceOptions; busy: boolean; onSave: SaveAction; fixedAssetsEnabled?: boolean; multiCurrency?: boolean }) {
  const initial = {
    code: "",
    name: "",
    propertyType: "residential",
    subsidiaryId: options.subsidiaries[0]?.id ?? "",
    currency: options.subsidiaries[0]?.currency ?? "CAD",
    locationId: "",
    fixedAssetId: "",
    rentIncomeAccountId: "",
    camIncomeAccountId: "",
    depositLiabilityAccountId: "",
    defaultBankAccountId: "",
    street: "",
    city: "",
    region: "",
    postalCode: "",
  };
  const [form, setForm] = useState(initial);
  useEffect(() => {
    if (open) setForm(initial);
  }, [open]);
  const submit = () => {
    const { currency, ...fields } = form;
    onSave({
      ...fields,
      ...(multiCurrency ? { currency } : {}),
      locationId: form.locationId || null,
      ...(fixedAssetsEnabled ? { fixedAssetId: form.fixedAssetId || null } : {}),
      camIncomeAccountId: form.camIncomeAccountId || null,
      depositLiabilityAccountId: form.depositLiabilityAccountId || null,
      defaultBankAccountId: form.defaultBankAccountId || null,
      address: {
        street: form.street,
        city: form.city,
        region: form.region,
        postalCode: form.postalCode,
      },
    });
  };
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="New property"
      description="Connect the operational property to its legal entity, accounting dimension, and control accounts."
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              busy ||
              !form.code ||
              !form.name ||
              !form.subsidiaryId ||
              !form.rentIncomeAccountId
            }
            onClick={submit}
          >
            {busy ? "Creating…" : "Create property"}
          </Button>
        </>
      }
    >
      <div className="space-y-4 p-1">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Code">
            <Input
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
            />
          </Field>
          <Field label="Name">
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="Type">
            <Select
              value={form.propertyType}
              onChange={(e) =>
                setForm({ ...form, propertyType: e.target.value })
              }
            >
              <option value="residential">Residential</option>
              <option value="commercial">Commercial</option>
              <option value="mixed_use">Mixed use</option>
              <option value="industrial">Industrial</option>
              <option value="other">Other</option>
            </Select>
          </Field>
          <Field label="Legal entity">
            <Select
              value={form.subsidiaryId}
              onChange={(e) => {
                const sub = options.subsidiaries.find(
                  (item: Option) => item.id === e.target.value,
                );
                setForm({
                  ...form,
                  subsidiaryId: e.target.value,
                  currency: sub?.currency ?? form.currency,
                });
              }}
            >
              <option value="">Select entity</option>
              {options.subsidiaries.map((o: Option) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Property location">
            <Select
              value={form.locationId}
              onChange={(e) => setForm({ ...form, locationId: e.target.value })}
            >
              <option value="">Not mapped</option>
              {options.locations.map((o: Option) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          {fixedAssetsEnabled ? <Field label="Fixed asset">
            <Select
              value={form.fixedAssetId}
              onChange={(e) =>
                setForm({ ...form, fixedAssetId: e.target.value })
              }
            >
              <option value="">Not owned / not linked</option>
              {options.assets.map((o: Option) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field> : null}
          <Field label="Rent income account">
            <Select
              value={form.rentIncomeAccountId}
              onChange={(e) =>
                setForm({ ...form, rentIncomeAccountId: e.target.value })
              }
            >
              <option value="">Select account</option>
              {options.incomeAccounts.map((o: Option) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="CAM income account">
            <Select
              value={form.camIncomeAccountId}
              onChange={(e) =>
                setForm({ ...form, camIncomeAccountId: e.target.value })
              }
            >
              <option value="">Select account</option>
              {options.incomeAccounts.map((o: Option) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Deposit liability">
            <Select
              value={form.depositLiabilityAccountId}
              onChange={(e) =>
                setForm({ ...form, depositLiabilityAccountId: e.target.value })
              }
            >
              <option value="">Select liability</option>
              {options.liabilityAccounts.map((o: Option) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Default deposit bank">
            <Select
              value={form.defaultBankAccountId}
              onChange={(e) =>
                setForm({ ...form, defaultBankAccountId: e.target.value })
              }
            >
              <option value="">Select bank</option>
              {options.bankAccounts.map((o: Option) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Street">
            <Input
              value={form.street}
              onChange={(e) => setForm({ ...form, street: e.target.value })}
            />
          </Field>
          <Field label="City">
            <Input
              value={form.city}
              onChange={(e) => setForm({ ...form, city: e.target.value })}
            />
          </Field>
          <Field label="Province / state">
            <Input
              value={form.region}
              onChange={(e) => setForm({ ...form, region: e.target.value })}
            />
          </Field>
          <Field label="Postal code">
            <Input
              value={form.postalCode}
              onChange={(e) => setForm({ ...form, postalCode: e.target.value })}
            />
          </Field>
        </div>
      </div>
    </Drawer>
  );
}
