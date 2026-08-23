"use client";

import { useState } from "react";
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
            <TableHead>Charge</TableHead>
            <TableHead>Frequency</TableHead>
            <TableHead>Effective</TableHead>
            <TableHead className="text-right">Amount</TableHead>
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
                {row.effectiveFrom} – {row.effectiveTo || "Open"}
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
            <div className="font-medium">Add recurring charge</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Type">
                <Select
                  value={form.chargeType}
                  onChange={(e) =>
                    setForm({ ...form, chargeType: e.target.value })
                  }
                >
                  <option value="cam">CAM</option>
                  <option value="parking">Parking</option>
                  <option value="storage">Storage</option>
                  <option value="utility">Utility</option>
                  <option value="other">Other</option>
                </Select>
              </Field>
              <Field label="Description">
                <Input
                  value={form.description}
                  onChange={(e) =>
                    setForm({ ...form, description: e.target.value })
                  }
                />
              </Field>
              <Field label="Amount">
                <Input
                  type="number"
                  min="0"
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                />
              </Field>
              <Field label="Frequency">
                <Select
                  value={form.frequency}
                  onChange={(e) =>
                    setForm({ ...form, frequency: e.target.value })
                  }
                >
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="annually">Annually</option>
                  <option value="one_time">One time</option>
                </Select>
              </Field>
              <Field label="Effective from">
                <Input
                  type="date"
                  value={form.effectiveFrom}
                  onChange={(e) =>
                    setForm({ ...form, effectiveFrom: e.target.value })
                  }
                />
              </Field>
              <Field label="Effective to">
                <Input
                  type="date"
                  value={form.effectiveTo}
                  onChange={(e) =>
                    setForm({ ...form, effectiveTo: e.target.value })
                  }
                />
              </Field>
              <Field label="Income account">
                <Select
                  value={form.incomeAccountId}
                  onChange={(e) =>
                    setForm({ ...form, incomeAccountId: e.target.value })
                  }
                >
                  <option value="">Property default</option>
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
                  "Lease charge added",
                )
              }
            >
              Add charge
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

export function EscalationsSection({ lease, rows, permissions, busy, act }: any) {
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
              <TableHead>Effective</TableHead>
              <TableHead>Method</TableHead>
              <TableHead>Value</TableHead>
              <TableHead>Result</TableHead>
              <TableHead>Status</TableHead>
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
                          "Rent escalation applied",
                        )
                      }
                    >
                      Apply
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <Empty
          title="No rent escalations"
          detail="Schedule contractual percent, fixed-dollar, or replacement-rent changes."
        />
      )}
      {permissions.manage ? (
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="font-medium">Schedule escalation</div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Effective on">
                <Input
                  type="date"
                  value={form.effectiveOn}
                  onChange={(e) =>
                    setForm({ ...form, effectiveOn: e.target.value })
                  }
                />
              </Field>
              <Field label="Method">
                <Select
                  value={form.method}
                  onChange={(e) => setForm({ ...form, method: e.target.value })}
                >
                  <option value="percent">Percent increase</option>
                  <option value="fixed">Fixed increase</option>
                  <option value="new_amount">New monthly amount</option>
                </Select>
              </Field>
              <Field label="Value">
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
                  "Escalation scheduled",
                )
              }
            >
              Schedule
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
          label="Required"
          value={money(lease.securityDepositRequired, {
            currency: lease.currency,
          })}
        />
        <Small
          label="Held"
          value={money(lease.depositBalance, { currency: lease.currency })}
        />
      </div>
      <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200">
        Deposit entries post immediately and cannot be edited or deleted. Reverse an incorrect entry, then post its corrected replacement below.
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
          title="No deposit activity"
          detail="Record the receipt to establish the tenant deposit liability."
        />
      )}
      {reverseRow ? (
        <Card className="border-red-200 dark:border-red-900">
          <CardContent className="space-y-3 p-4">
            <div>
              <div className="font-medium text-red-700 dark:text-red-300">Reverse deposit transaction</div>
              <p className="mt-1 text-xs text-slate-500">
                {reverseRow.occurredOn} · {reverseRow.kind.replaceAll("_", " ")} · {money(reverseRow.amount, { currency: lease.currency })}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Reversal date">
                <Input type="date" value={reversal.occurredOn} onChange={(e) => setReversal({ ...reversal, occurredOn: e.target.value })} />
              </Field>
              <Field label="Reason">
                <Input value={reversal.reason} onChange={(e) => setReversal({ ...reversal, reason: e.target.value })} />
              </Field>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={busy} onClick={() => setReverseRow(null)}>Cancel</Button>
              <Button
                disabled={busy || !reversal.occurredOn || !reversal.reason.trim()}
                onClick={async () => {
                  const result = await act(
                    { action: "reverseDeposit", transactionId: reverseRow.id, ...reversal },
                    "Deposit transaction reversed",
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
                Post reversal
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
      {permissions.account ? (
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="font-medium">Record deposit transaction</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Transaction">
                <Select
                  value={form.kind}
                  onChange={(e) => setForm({ ...form, kind: e.target.value })}
                >
                  <option value="received">Received</option>
                  <option value="interest">Interest credited</option>
                  <option value="applied">Apply to tenant invoice</option>
                  <option value="refunded">Refunded</option>
                  <option value="adjustment_increase">
                    Adjustment increase
                  </option>
                  <option value="adjustment_decrease">
                    Adjustment decrease
                  </option>
                </Select>
              </Field>
              <Field label="Date">
                <Input
                  type="date"
                  value={form.occurredOn}
                  onChange={(e) =>
                    setForm({ ...form, occurredOn: e.target.value })
                  }
                />
              </Field>
              <Field label="Amount">
                <Input
                  type="number"
                  min="0"
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                />
              </Field>
              {["received", "refunded"].includes(form.kind) ? (
                <Field label="Bank account">
                  <Select
                    value={form.bankAccountId}
                    onChange={(e) =>
                      setForm({ ...form, bankAccountId: e.target.value })
                    }
                  >
                    <option value="">Property default</option>
                    {options.bankAccounts.map((o: Option) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
              {form.kind === "applied" ? (
                <Field label="Tenant invoice">
                  <Select
                    value={form.appliedDocumentId}
                    onChange={(e) =>
                      setForm({ ...form, appliedDocumentId: e.target.value })
                    }
                  >
                    <option value="">Select posted invoice</option>
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
                <Field label="Offset account">
                  <Select
                    value={form.offsetAccountId}
                    onChange={(e) =>
                      setForm({ ...form, offsetAccountId: e.target.value })
                    }
                  >
                    <option value="">Select account</option>
                    {options.expenseAccounts.map((o: Option) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
              <div className="sm:col-span-2">
                <Field label="Memo">
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
                  "Deposit transaction posted",
                )
              }
            >
              Post transaction
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
