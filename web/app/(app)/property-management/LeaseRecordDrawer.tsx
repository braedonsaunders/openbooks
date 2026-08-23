"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button, Card, CardContent, Drawer, Input, Popover, cn } from "@openbooks/ui";
import { useBusinessToday } from "@/components/business-date-provider";
import { Field, RecordTabs, Status } from "./workspace-ui";
import { LeaseDetail } from "./LeaseDetail";

type LeaseTab = "overview" | "charges" | "escalations" | "deposits";

export function LeaseRecordDrawer({
  lease,
  data,
  options,
  permissions,
  busy,
  stacked,
  onClose,
  act,
  money,
  onSave,
}: any) {
  const today = useBusinessToday();
  const [tab, setTab] = useState<LeaseTab>("overview");
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [actionsOpen, setActionsOpen] = useState(false);
  const [terminationOpen, setTerminationOpen] = useState(false);
  const [termination, setTermination] = useState({
    terminatedOn: today,
    reason: "",
  });
  const [form, setForm] = useState(() => leaseForm(lease ?? {}));
  if (!lease) return null;
  const canEdit =
    permissions.manage && ["draft", "active", "notice"].includes(lease.status);
  const reset = () => {
    setForm(leaseForm(lease));
    setMode("view");
  };
  const save = async () => {
    const result = await onSave({
      leaseId: lease.id,
      ...form,
      unitId: form.unitId || null,
      endsOn: form.endsOn || null,
      billingDay: Number(form.billingDay),
      paymentTermsDays: Number(form.paymentTermsDays),
      graceDays: Number(form.graceDays),
      camSharePercent: form.camSharePercent || null,
    });
    if (result) setMode("view");
  };
  return (
    <Drawer
      open
      stacked={stacked}
      onClose={onClose}
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <span>{`Lease ${lease.leaseNumber}`}</span>
          <Status value={lease.status} />
        </span>
      }
      description={`${lease.propertyName}${lease.unitCode ? ` · ${lease.unitCode}` : ""} · ${lease.tenantName}`}
      subtabs={
        <RecordTabs
          label="Lease details"
          active={tab}
          tabs={[
            { key: "overview", label: "Overview" },
            { key: "charges", label: "Charges" },
            { key: "escalations", label: "Escalations" },
            { key: "deposits", label: "Deposits" },
          ]}
          onChange={(key) => {
            setTab(key as LeaseTab);
            if (key !== "overview" && mode === "edit") reset();
          }}
        />
      }
      headerActions={
        mode === "edit" ? (
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" disabled={busy} onClick={reset}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={
                busy ||
                !form.leaseNumber.trim() ||
                !form.propertyId ||
                !form.tenantId ||
                !form.startsOn ||
                !form.baseRent
              }
              onClick={save}
            >
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        ) : (
          <div className="flex gap-1.5">
            {canEdit && tab === "overview" ? (
              <Button size="sm" variant="outline" onClick={() => setMode("edit")}>
                Edit
              </Button>
            ) : null}
            {permissions.manage ? (
              <Popover
                open={actionsOpen}
                onOpenChange={setActionsOpen}
                align="end"
                className="w-56 p-1.5"
                trigger={
                  <Button size="sm" variant="outline" onClick={() => setActionsOpen((open) => !open)}>
                    Actions <ChevronDown className={cn("h-3.5 w-3.5", actionsOpen && "rotate-180")} />
                  </Button>
                }
              >
                {lease.status === "draft" ? (
                  <Button
                    variant="ghost"
                    className="h-8 w-full justify-start rounded px-2 text-xs text-red-600 hover:text-red-700"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(`Cancel lease ${lease.leaseNumber}? The record will remain in history.`)) {
                        void act({ action: "cancelLease", leaseId: lease.id }, "Lease cancelled");
                        setActionsOpen(false);
                      }
                    }}
                  >
                    Cancel lease
                  </Button>
                ) : ["active", "notice"].includes(lease.status) ? (
                  <Button
                    variant="ghost"
                    className="h-8 w-full justify-start rounded px-2 text-xs text-red-600 hover:text-red-700"
                    disabled={busy}
                    onClick={() => {
                      setTerminationOpen(true);
                      setActionsOpen(false);
                      setTab("overview");
                    }}
                  >
                    Terminate lease
                  </Button>
                ) : (
                  <div className="px-2 py-1.5 text-xs text-slate-500">This lease is read-only.</div>
                )}
              </Popover>
            ) : null}
          </div>
        )
      }
    >
      {terminationOpen ? (
        <Card className="border-red-200 dark:border-red-900">
          <CardContent className="space-y-4 p-4">
            <div>
              <h3 className="font-medium text-red-700 dark:text-red-300">Terminate lease</h3>
              <p className="mt-1 text-xs text-slate-500">Future scheduled rent will be cancelled and the unit returned to vacant.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Termination date">
                <Input type="date" value={termination.terminatedOn} onChange={(e) => setTermination({ ...termination, terminatedOn: e.target.value })} />
              </Field>
              <Field label="Reason">
                <Input value={termination.reason} onChange={(e) => setTermination({ ...termination, reason: e.target.value })} />
              </Field>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={busy} onClick={() => setTerminationOpen(false)}>Cancel</Button>
              <Button
                disabled={busy || !termination.terminatedOn || !termination.reason.trim()}
                onClick={async () => {
                  const result = await act(
                    { action: "terminateLease", leaseId: lease.id, ...termination },
                    "Lease terminated",
                  );
                  if (result) setTerminationOpen(false);
                }}
              >
                Terminate lease
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <LeaseDetail
          lease={lease}
          data={data}
          options={options}
          permissions={permissions}
          busy={busy}
          tab={tab}
          act={act}
          money={money}
          editing={mode === "edit"}
          form={form}
          setForm={setForm}
        />
      )}
    </Drawer>
  );
}

function leaseForm(lease: any) {
  return {
    propertyId: lease.propertyId ?? "",
    unitId: lease.unitId ?? "",
    tenantId: lease.tenantId ?? "",
    leaseNumber: lease.leaseNumber ?? "",
    startsOn: lease.startsOn ?? "",
    endsOn: lease.endsOn ?? "",
    baseRent: lease.baseRent ?? "",
    billingDay: String(lease.billingDay ?? 1),
    paymentTermsDays: String(lease.paymentTermsDays ?? 0),
    securityDepositRequired: lease.securityDepositRequired ?? "0",
    camMethod: lease.camMethod ?? "none",
    camSharePercent: lease.camSharePercent ?? "",
    lateFeeType: lease.lateFeeType ?? "none",
    lateFeeValue: lease.lateFeeValue ?? "0",
    graceDays: String(lease.graceDays ?? 0),
    autoInvoice: lease.autoInvoice ?? true,
    autoPost: lease.autoPost ?? false,
  };
}
