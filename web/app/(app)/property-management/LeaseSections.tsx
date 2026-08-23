"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Card, CardContent, Input, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@openbooks/ui";
import { useBusinessToday } from "@/components/business-date-provider";
import type { Option } from "./workspace-ui";
import { Empty, Field, Small, Status } from "./workspace-ui";
import { DepositTable } from "./LeaseTables";

export function ChargesSection({
  lease,
  charges,
  permissions,
  busy,
  act,
  money,
  options,
}: any) {
  const t = useTranslations("entities.propertyManagement");
  const [form, setForm] = useState({
    chargeType: "cam",
    description: "CAM estimate",
    amount: "",
    frequency: "monthly",
    effectiveFrom: lease.startsOn,
    effectiveTo: lease.endsOn || "",
    incomeAccountId: "",
    taxCodeId: "",
  });
  return (
    <div className="space-y-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("leaseSections.charges.table.charge")}</TableHead>
            <TableHead>{t("leaseSections.charges.table.frequency")}</TableHead>
            <TableHead>{t("leaseSections.charges.table.effective")}</TableHead>
            <TableHead className="text-right">{t("leaseSections.charges.table.amount")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {charges.map((row: any) => (
            <TableRow key={row.id}>
              <TableCell>
                <div className="font-medium">{row.description}</div>
                <div className="text-xs capitalize text-slate-500">
                  {row.chargeType.replaceAll("_", " ")}
                </div>
              </TableCell>
              <TableCell className="capitalize">{row.frequency}</TableCell>
              <TableCell>
                {row.effectiveFrom} – {row.effectiveTo || t("leaseSections.charges.table.open")}
              </TableCell>
              <TableCell className="text-right">
                {money(row.amount, { currency: lease.currency })}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {permissions.manage &&
      ["draft", "active", "notice"].includes(lease.status) ? (
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="font-medium">{t("leaseSections.charges.addTitle")}</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("leaseSections.charges.labels.type")}>
                <Select
                  value={form.chargeType}
                  onChange={(e) =>
                    setForm({ ...form, chargeType: e.target.value })
                  }
                >
                  <option value="cam">{t("leaseSections.charges.types.cam")}</option>
                  <option value="parking">{t("leaseSections.charges.types.parking")}</option>
                  <option value="storage">{t("leaseSections.charges.types.storage")}</option>
                  <option value="utility">{t("leaseSections.charges.types.utility")}</option>
                  <option value="other">{t("leaseSections.charges.types.other")}</option>
                </Select>
              </Field>
              <Field label={t("leaseSections.charges.labels.description")}>
                <Input
                  value={form.description}
                  onChange={(e) =>
                    setForm({ ...form, description: e.target.value })
                  }
                />
              </Field>
              <Field label={t("leaseSections.charges.labels.amount")}>
                <Input
                  type="number"
                  min="0"
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                />
              </Field>
              <Field label={t("leaseSections.charges.labels.frequency")}>
                <Select
                  value={form.frequency}
                  onChange={(e) =>
                    setForm({ ...form, frequency: e.target.value })
                  }
                >
                  <option value="monthly">{t("leaseSections.charges.frequencies.monthly")}</option>
                  <option value="quarterly">{t("leaseSections.charges.frequencies.quarterly")}</option>
                  <option value="annually">{t("leaseSections.charges.frequencies.annually")}</option>
                  <option value="one_time">{t("leaseSections.charges.frequencies.one_time")}</option>
                </Select>
              </Field>
              <Field label={t("leaseSections.charges.labels.effectiveFrom")}>
                <Input
                  type="date"
                  value={form.effectiveFrom}
                  onChange={(e) =>
                    setForm({ ...form, effectiveFrom: e.target.value })
                  }
                />
              </Field>
              <Field label={t("leaseSections.charges.labels.effectiveTo")}>
                <Input
                  type="date"
                  value={form.effectiveTo}
                  onChange={(e) =>
                    setForm({ ...form, effectiveTo: e.target.value })
                  }
                />
              </Field>
              <Field label={t("leaseSections.charges.labels.incomeAccount")}>
                <Select
                  value={form.incomeAccountId}
                  onChange={(e) =>
                    setForm({ ...form, incomeAccountId: e.target.value })
                  }
                >
                  <option value="">{t("leaseSections.charges.propertyDefault")}</option>
                  {options.incomeAccounts.map((o: Option) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Button
              size="sm"
              disabled={busy || !form.amount || !form.description}
              onClick={() =>
                act(
                  {
                    action: "addCharge",
                    leaseId: lease.id,
                    ...form,
                    effectiveTo: form.effectiveTo || null,
                    incomeAccountId: form.incomeAccountId || null,
                  },
                  t("toasts.chargeAdded"),
                )
              }
            >
              {t("leaseSections.charges.addCharge")}
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

export function EscalationsSection({ lease, rows, permissions, busy, act }: any) {
  const t = useTranslations("entities.propertyManagement");
  const [form, setForm] = useState({
    effectiveOn: lease.endsOn || lease.startsOn,
    method: "percent",
    value: "",
  });
  return (
    <div className="space-y-4">
      {rows.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("leaseSections.escalations.table.effective")}</TableHead>
              <TableHead>{t("leaseSections.escalations.table.method")}</TableHead>
              <TableHead>{t("leaseSections.escalations.table.value")}</TableHead>
              <TableHead>{t("leaseSections.escalations.table.result")}</TableHead>
              <TableHead>{t("leaseSections.escalations.table.status")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row: any) => (
              <TableRow key={row.id}>
                <TableCell>{row.effectiveOn}</TableCell>
                <TableCell className="capitalize">
                  {row.method.replaceAll("_", " ")}
                </TableCell>
                <TableCell>{row.value}</TableCell>
                <TableCell>{row.newAmount || "—"}</TableCell>
                <TableCell>
                  <Status value={row.status} />
                </TableCell>
                <TableCell>
                  {row.status === "scheduled" && permissions.manage ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        act(
                          { action: "applyEscalation", escalationId: row.id },
                          t("toasts.escalationApplied"),
                        )
                      }
                    >
                      {t("leaseSections.escalations.apply")}
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <Empty
          title={t("leaseSections.escalations.emptyTitle")}
          detail={t("leaseSections.escalations.emptyDetail")}
        />
      )}
      {permissions.manage ? (
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="font-medium">{t("leaseSections.escalations.scheduleTitle")}</div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={t("leaseSections.escalations.labels.effectiveOn")}>
                <Input
                  type="date"
                  value={form.effectiveOn}
                  onChange={(e) =>
                    setForm({ ...form, effectiveOn: e.target.value })
                  }
                />
              </Field>
              <Field label={t("leaseSections.escalations.labels.method")}>
                <Select
                  value={form.method}
                  onChange={(e) => setForm({ ...form, method: e.target.value })}
                >
                  <option value="percent">{t("leaseSections.escalations.methods.percent")}</option>
                  <option value="fixed">{t("leaseSections.escalations.methods.fixed")}</option>
                  <option value="new_amount">{t("leaseSections.escalations.methods.new_amount")}</option>
                </Select>
              </Field>
              <Field label={t("leaseSections.escalations.labels.value")}>
                <Input
                  type="number"
                  min="0"
                  value={form.value}
                  onChange={(e) => setForm({ ...form, value: e.target.value })}
                />
              </Field>
            </div>
            <Button
              size="sm"
              disabled={busy || !form.effectiveOn || !form.value}
              onClick={() =>
                act(
                  { action: "addEscalation", leaseId: lease.id, ...form },
                  t("toasts.escalationScheduled"),
                )
              }
            >
              {t("leaseSections.escalations.schedule")}
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

export function DepositSection({
  lease,
  rows,
  options,
  permissions,
  busy,
  act,
  money,
}: any) {
  const today = useBusinessToday();
  const t = useTranslations("entities.propertyManagement");
  const [form, setForm] = useState({
    kind: "received",
    occurredOn: today,
    amount: "",
    bankAccountId: "",
    offsetAccountId: "",
    appliedDocumentId: "",
    memo: "",
  });
  const [reverseRow, setReverseRow] = useState<any>(null);
  const [reversal, setReversal] = useState({
    occurredOn: today,
    reason: "",
  });
  const invoices = options.openInvoices.filter(
    (o: Option) => o.partyId === lease.tenantId,
  );
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Small
          label={t("leaseSections.deposits.required")}
          value={money(lease.securityDepositRequired, {
            currency: lease.currency,
          })}
        />
        <Small
          label={t("leaseSections.deposits.held")}
          value={money(lease.depositBalance, { currency: lease.currency })}
        />
      </div>
      <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200">
        {t("leaseSections.deposits.notice")}
      </div>
      {rows.length ? (
        <DepositTable
          deposits={rows}
          leases={[lease]}
          money={money}
          onReverse={permissions.account ? setReverseRow : undefined}
        />
      ) : (
        <Empty
          title={t("leaseSections.deposits.emptyTitle")}
          detail={t("leaseSections.deposits.emptyDetail")}
        />
      )}
      {reverseRow ? (
        <Card className="border-red-200 dark:border-red-900">
          <CardContent className="space-y-3 p-4">
            <div>
              <div className="font-medium text-red-700 dark:text-red-300">{t("leaseSections.deposits.reverseTitle")}</div>
              <p className="mt-1 text-xs text-slate-500">
                {reverseRow.occurredOn} · {reverseRow.kind.replaceAll("_", " ")} · {money(reverseRow.amount, { currency: lease.currency })}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("leaseSections.deposits.reverseLabels.reversalDate")}>
                <Input type="date" value={reversal.occurredOn} onChange={(e) => setReversal({ ...reversal, occurredOn: e.target.value })} />
              </Field>
              <Field label={t("leaseSections.deposits.reverseLabels.reason")}>
                <Input value={reversal.reason} onChange={(e) => setReversal({ ...reversal, reason: e.target.value })} />
              </Field>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={busy} onClick={() => setReverseRow(null)}>{t("leaseSections.deposits.cancel")}</Button>
              <Button
                disabled={busy || !reversal.occurredOn || !reversal.reason.trim()}
                onClick={async () => {
                  const result = await act(
                    { action: "reverseDeposit", transactionId: reverseRow.id, ...reversal },
                    t("toasts.depositReversed"),
                  );
                  if (result) {
                    setForm({
                      kind: reverseRow.kind,
                      occurredOn: reversal.occurredOn,
                      amount: reverseRow.amount,
                      bankAccountId: reverseRow.bankAccountId ?? "",
                      offsetAccountId: reverseRow.offsetAccountId ?? "",
                      appliedDocumentId: "",
                      memo: `Correction for ${reverseRow.occurredOn}`,
                    });
                    setReverseRow(null);
                    setReversal({ occurredOn: today, reason: "" });
                  }
                }}
              >
                {t("leaseSections.deposits.postReversal")}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
      {permissions.account ? (
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="font-medium">{t("leaseSections.deposits.recordTitle")}</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("leaseSections.deposits.labels.transaction")}>
                <Select
                  value={form.kind}
                  onChange={(e) => setForm({ ...form, kind: e.target.value })}
                >
                  <option value="received">{t("leaseSections.deposits.kinds.received")}</option>
                  <option value="interest">{t("leaseSections.deposits.kinds.interest")}</option>
                  <option value="applied">{t("leaseSections.deposits.kinds.applied")}</option>
                  <option value="refunded">{t("leaseSections.deposits.kinds.refunded")}</option>
                  <option value="adjustment_increase">
                    {t("leaseSections.deposits.kinds.adjustment_increase")}
                  </option>
                  <option value="adjustment_decrease">
                    {t("leaseSections.deposits.kinds.adjustment_decrease")}
                  </option>
                </Select>
              </Field>
              <Field label={t("leaseSections.deposits.labels.date")}>
                <Input
                  type="date"
                  value={form.occurredOn}
                  onChange={(e) =>
                    setForm({ ...form, occurredOn: e.target.value })
                  }
                />
              </Field>
              <Field label={t("leaseSections.deposits.labels.amount")}>
                <Input
                  type="number"
                  min="0"
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                />
              </Field>
              {["received", "refunded"].includes(form.kind) ? (
                <Field label={t("leaseSections.deposits.labels.bankAccount")}>
                  <Select
                    value={form.bankAccountId}
                    onChange={(e) =>
                      setForm({ ...form, bankAccountId: e.target.value })
                    }
                  >
                    <option value="">{t("leaseSections.deposits.propertyDefault")}</option>
                    {options.bankAccounts.map((o: Option) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
              {form.kind === "applied" ? (
                <Field label={t("leaseSections.deposits.labels.tenantInvoice")}>
                  <Select
                    value={form.appliedDocumentId}
                    onChange={(e) =>
                      setForm({ ...form, appliedDocumentId: e.target.value })
                    }
                  >
                    <option value="">{t("leaseSections.deposits.selectPostedInvoice")}</option>
                    {invoices.map((o: Option) => (
                      <option key={o.id} value={o.id}>
                        {o.name} ·{" "}
                        {money(o.openBalance, { currency: lease.currency })}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
              {[
                "interest",
                "adjustment_increase",
                "adjustment_decrease",
              ].includes(form.kind) ? (
                <Field label={t("leaseSections.deposits.labels.offsetAccount")}>
                  <Select
                    value={form.offsetAccountId}
                    onChange={(e) =>
                      setForm({ ...form, offsetAccountId: e.target.value })
                    }
                  >
                    <option value="">{t("leaseSections.deposits.selectAccount")}</option>
                    {options.expenseAccounts.map((o: Option) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
              <div className="sm:col-span-2">
                <Field label={t("leaseSections.deposits.labels.memo")}>
                  <Input
                    value={form.memo}
                    onChange={(e) => setForm({ ...form, memo: e.target.value })}
                  />
                </Field>
              </div>
            </div>
            <Button
              size="sm"
              disabled={
                busy ||
                !form.amount ||
                (form.kind === "applied" && !form.appliedDocumentId)
              }
              onClick={() =>
                act(
                  {
                    action: "recordDeposit",
                    leaseId: lease.id,
                    ...form,
                    bankAccountId: form.bankAccountId || null,
                    offsetAccountId: form.offsetAccountId || null,
                    appliedDocumentId: form.appliedDocumentId || null,
                  },
                  t("toasts.depositPosted"),
                )
              }
            >
              {t("leaseSections.deposits.postTransaction")}
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
