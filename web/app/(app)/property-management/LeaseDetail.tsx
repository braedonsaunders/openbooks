"use client";

import type { Dispatch, SetStateAction } from "react";
import { Button, Card, CardContent, Input, Select } from "@openbooks/ui";
import { Read, Small } from "./workspace-ui";
import { Field } from "./workspace-ui";
import { ChargesSection, DepositSection, EscalationsSection } from "./LeaseSections";
import type { LeaseForm, LeaseRow, Money, PropertyAction, PropertyPermissions, PropertyWorkspace, WorkspaceOptions } from "./types";

function LeaseEditFields({ lease, data, options, form, setForm }: {
  lease: LeaseRow;
  data: PropertyWorkspace;
  options: WorkspaceOptions;
  form: LeaseForm;
  setForm: Dispatch<SetStateAction<LeaseForm>>;
}) {
  const draft = lease.status === "draft";
  const units = data.units.filter(
    (unit) =>
      unit.propertyId === form.propertyId &&
      (unit.status === "vacant" || unit.id === form.unitId),
  );
  return (
    <div className="space-y-4">
      {!draft ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Activated leases keep their property, unit, tenant, start date, billing day, and rent evidence. Use an escalation for a rent change.
        </div>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Lease number">
          <Input value={form.leaseNumber} onChange={(e) => setForm({ ...form, leaseNumber: e.target.value })} />
        </Field>
        <Field label="Tenant">
          <Select disabled={!draft} value={form.tenantId} onChange={(e) => setForm({ ...form, tenantId: e.target.value })}>
            <option value="">Select tenant</option>
            {options.tenants.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
          </Select>
        </Field>
        <Field label="Property">
          <Select disabled={!draft} value={form.propertyId} onChange={(e) => setForm({ ...form, propertyId: e.target.value, unitId: "" })}>
            {data.properties.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}
          </Select>
        </Field>
        <Field label="Unit">
          <Select disabled={!draft} value={form.unitId} onChange={(e) => setForm({ ...form, unitId: e.target.value })}>
            <option value="">Whole property / no unit</option>
            {units.map((unit) => <option key={unit.id} value={unit.id}>{unit.code}{unit.name ? ` · ${unit.name}` : ""}</option>)}
          </Select>
        </Field>
        <Field label="Starts">
          <Input disabled={!draft} type="date" value={form.startsOn} onChange={(e) => setForm({ ...form, startsOn: e.target.value })} />
        </Field>
        <Field label="Ends">
          <Input disabled={!draft && !lease.endsOn} type="date" value={form.endsOn} onChange={(e) => setForm({ ...form, endsOn: e.target.value })} />
        </Field>
        <Field label="Monthly base rent" hint={draft ? undefined : "Use an escalation to change active rent."}>
          <Input disabled={!draft} type="number" min="0" step="0.01" value={form.baseRent} onChange={(e) => setForm({ ...form, baseRent: e.target.value })} />
        </Field>
        <Field label="Billing day">
          <Input disabled={!draft} type="number" min="1" max="31" value={form.billingDay} onChange={(e) => setForm({ ...form, billingDay: e.target.value })} />
        </Field>
        <Field label="Security deposit required">
          <Input type="number" min="0" step="0.01" value={form.securityDepositRequired} onChange={(e) => setForm({ ...form, securityDepositRequired: e.target.value })} />
        </Field>
        <Field label="Payment terms days">
          <Input type="number" min="0" step="1" value={form.paymentTermsDays} onChange={(e) => setForm({ ...form, paymentTermsDays: e.target.value })} />
        </Field>
        <Field label="CAM method">
          <Select value={form.camMethod} onChange={(e) => setForm({ ...form, camMethod: e.target.value })}>
            <option value="none">None</option>
            <option value="fixed">Fixed estimate</option>
            <option value="pro_rata">Pro rata reconciliation</option>
          </Select>
        </Field>
        <Field label="CAM share %">
          <Input disabled={form.camMethod === "none"} type="number" min="0" max="100" value={form.camSharePercent} onChange={(e) => setForm({ ...form, camSharePercent: e.target.value })} />
        </Field>
        <Field label="Late fee">
          <Select value={form.lateFeeType} onChange={(e) => setForm({ ...form, lateFeeType: e.target.value, lateFeeValue: e.target.value === "none" ? "0" : form.lateFeeValue })}>
            <option value="none">None</option>
            <option value="fixed">Fixed amount</option>
            <option value="percent">Percent of open charge</option>
          </Select>
        </Field>
        <Field label="Late fee value">
          <Input disabled={form.lateFeeType === "none"} type="number" min="0" value={form.lateFeeValue} onChange={(e) => setForm({ ...form, lateFeeValue: e.target.value })} />
        </Field>
        <Field label="Grace days">
          <Input type="number" min="0" step="1" value={form.graceDays} onChange={(e) => setForm({ ...form, graceDays: e.target.value })} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-5 rounded-md border border-slate-200 p-3 text-sm dark:border-slate-800">
        <label className="flex items-center gap-2"><input type="checkbox" checked={form.autoInvoice} onChange={(e) => setForm({ ...form, autoInvoice: e.target.checked })} /> Auto-create invoices</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={form.autoPost} onChange={(e) => setForm({ ...form, autoPost: e.target.checked })} /> Auto-post invoices</label>
      </div>
    </div>
  );
}

export function LeaseDetail({
  lease,
  data,
  options,
  permissions,
  busy,
  tab,
  act,
  money,
  editing,
  form,
  setForm,
}: {
  lease: LeaseRow;
  data: PropertyWorkspace;
  options: WorkspaceOptions;
  permissions: PropertyPermissions;
  busy: boolean;
  tab: string;
  act: PropertyAction;
  money: Money;
  editing: boolean;
  form: LeaseForm;
  setForm: Dispatch<SetStateAction<LeaseForm>>;
}) {
  const charges = data.charges.filter((row) => row.leaseId === lease.id);
  const escalations = data.escalations.filter(
    (row) => row.leaseId === lease.id,
  );
  const deposits = data.deposits.filter((row) => row.leaseId === lease.id);
  const schedules = data.schedules.filter(
    (row) => row.leaseId === lease.id,
  );
  return (
    <div className="space-y-5 p-1">
      {!editing ? (
        <div className="flex flex-wrap items-center justify-end gap-3">
          <div className="flex flex-wrap gap-2">
          {lease.status === "draft" && permissions.manage ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                act(
                  { action: "activateLease", leaseId: lease.id },
                  "Lease activated and scheduled",
                )
              }
            >
              Activate lease
            </Button>
          ) : null}
          {["active", "notice"].includes(lease.status) && permissions.bill ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  act(
                    { action: "scheduleLease", leaseId: lease.id },
                    "Rent schedule extended",
                  )
                }
              >
                Extend schedule
              </Button>
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  act(
                    { action: "billRent", leaseId: lease.id },
                    "Due rent billed",
                  )
                }
              >
                Bill due rent
              </Button>
            </>
          ) : null}
          </div>
        </div>
      ) : null}
      {tab === "overview" ? (
        editing ? (
          <LeaseEditFields
            lease={lease}
            data={data}
            options={options}
            form={form}
            setForm={setForm}
          />
        ) : (
          <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Small
              label="Term"
              value={`${lease.startsOn} – ${lease.endsOn || "Open"}`}
            />
            <Small
              label="Deposit required"
              value={money(lease.securityDepositRequired, {
                currency: lease.currency,
              })}
            />
            <Small
              label="Deposit held"
              value={money(lease.depositBalance, { currency: lease.currency })}
            />
          </div>
          <Card>
            <CardContent className="grid gap-4 p-4 sm:grid-cols-2">
              <Read label="Property" value={lease.propertyName} />
              <Read label="Unit" value={lease.unitCode || "Whole property"} />
              <Read label="Tenant" value={lease.tenantName} />
              <Read
                label="CAM"
                value={`${lease.camMethod.replaceAll("_", " ")}${lease.camSharePercent ? ` · ${lease.camSharePercent}%` : ""}`}
              />
              <Read
                label="Late fee"
                value={
                  lease.lateFeeType === "none"
                    ? "None"
                    : `${lease.lateFeeValue} ${lease.lateFeeType}`
                }
              />
              <Read
                label="Scheduled periods"
                value={String(schedules.length)}
              />
            </CardContent>
          </Card>
          </div>
        )
      ) : null}
      {tab === "charges" ? (
        <ChargesSection
          lease={lease}
          charges={charges}
          permissions={permissions}
          busy={busy}
          act={act}
          money={money}
          options={options}
        />
      ) : null}
      {tab === "escalations" ? (
        <EscalationsSection
          lease={lease}
          rows={escalations}
          permissions={permissions}
          busy={busy}
          act={act}
        />
      ) : null}
      {tab === "deposits" ? (
        <DepositSection
          lease={lease}
          rows={deposits}
          options={options}
          permissions={permissions}
          busy={busy}
          act={act}
          money={money}
        />
      ) : null}
    </div>
  );
}
