"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Badge,
  Button,
  Input,
  Label,
  Popover,
  SearchSelect,
  Select,
  Textarea,
  UrlDrawer,
  Drawer,
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@openbooks/ui";
import { useMoney } from "@/components/money-provider";
import { useBusinessToday } from "@/components/business-date-provider";
import { readApiErrorMessage } from "@/lib/api-error";
import {
  financialChangeEventLabel,
  financialChangeStatusLabel,
} from "@openbooks/engine/src/platform/financial-change-labels.ts";
import type { LeasePayload, LeaseDisplay } from "./_lib";
type Option = { value: string; label: string };
const frequencyMonths: Record<string, number> = {
  monthly: 1,
  quarterly: 3,
  annual: 12,
};
type Choices = { accounts: Option[]; subsidiaries: Option[] };
const frequencies = [
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "annual", label: "Annual" },
];
const timings = [
  { value: "advance", label: "Advance — beginning of period" },
  { value: "arrears", label: "Arrears — end of period" },
];
async function request(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(await readApiErrorMessage(res, "Lease action failed"));
  return (await res.json()) as {
    leaseId?: string;
    changeId?: string;
    posted?: number;
    skipped?: number;
  };
}
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
const accountFields = [
  ["rouAsset", "Right-of-use asset"],
  ["leaseLiability", "Lease liability"],
  ["interestExpense", "Interest expense"],
  ["amortizationExpense", "ROU amortization expense"],
  ["leaseExpense", "Operating / exempt lease expense"],
  ["payment", "Bank / payment clearing"],
] as const;
export function NewLeaseButton({
  accounts,
  subsidiaries,
  parent,
}: { parent?: LeaseDisplay } & Choices) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        variant={parent ? "outline" : "default"}
      >
        {parent ? "Add separate lease" : "New lease"}
      </Button>
      {open ? (
        <LeaseCreateForm
          accounts={accounts}
          subsidiaries={subsidiaries}
          parent={parent}
          close={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
function LeaseCreateForm({
  accounts,
  subsidiaries,
  parent,
  close,
}: { parent?: LeaseDisplay; close: () => void } & Choices) {
  const router = useRouter(),
    today = useBusinessToday();
  const [f, setF] = useState<Record<string, string>>({
    subsidiaryId:
      parent?.subsidiary_id ??
      (subsidiaries.length === 1 ? subsidiaries[0]!.value : ""),
    commencementOn: today,
    termPeriods: "12",
    paymentFrequency: "monthly",
    paymentTiming: "arrears",
    annualDiscountRatePercent: "0",
    initialDirectCosts: "0",
    prepayments: "0",
    incentives: "0",
  });
  const [flags, setFlags] = useState<Record<string, boolean>>({}),
    [busy, setBusy] = useState(false);
  const [requestKey] = useState(() => crypto.randomUUID());
  const set = (key: string, value: string) =>
    setF((old) => ({ ...old, [key]: value }));
  async function save() {
    setBusy(true);
    try {
      const classificationInputs = {
        transfersOwnership: !!flags.transfersOwnership,
        purchaseOptionReasonablyCertain:
          !!flags.purchaseOptionReasonablyCertain,
        specializedAsset: !!flags.specializedAsset,
        ...(f.economicLifeMonths
          ? {
              leaseTermMonths:
                Number(f.termPeriods) *
                (frequencyMonths[f.paymentFrequency!] ?? 1),
              economicLifeMonths: Number(f.economicLifeMonths),
            }
          : {}),
        ...(f.pvOfPayments && f.fairValue
          ? { pvOfPayments: f.pvOfPayments, fairValue: f.fairValue }
          : {}),
      };
      const agreement = {
        subsidiaryId: f.subsidiaryId,
        leaseNumber: f.leaseNumber,
        description: f.description,
        commencementOn: f.commencementOn,
        termPeriods: Number(f.termPeriods),
        paymentFrequency: f.paymentFrequency,
        paymentTiming: f.paymentTiming,
        paymentAmount: f.paymentAmount,
        annualDiscountRatePercent: f.annualDiscountRatePercent,
        classificationInputs,
        exemption: f.exemption || null,
        initialDirectCosts: f.initialDirectCosts,
        prepayments: f.prepayments,
        incentives: f.incentives,
        costClearingAccountId: f.costClearingAccountId || undefined,
        accounts: Object.fromEntries(
          accountFields.map(([key]) => [key, f[key]]),
        ),
      };
      const result = parent
        ? await request(`/api/leases/${parent.id}/changes`, {
            operation: "separate_lease",
            effectiveOn: f.commencementOn,
            reason: f.reason,
            assessment: f.assessment,
            idempotencyKey: requestKey,
            scopeReductionPercent: "0",
            settlementPayment: "0",
            gainLossAccountId: f.leaseExpense,
            separateLease: {
              additionalRightOfUse: !!flags.additionalRightOfUse,
              commensurateStandalonePrice: !!flags.commensurateStandalonePrice,
              agreement,
            },
          })
        : await request("/api/leases", agreement);
      close();
      router.push(
        result.changeId
          ? `/accounting/changes?change=${result.changeId}`
          : `/assets/leases?lease=${result.leaseId}`,
      );
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Lease could not be saved");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Drawer
      open
      onClose={close}
      stacked={!!parent}
      title={parent ? "Separate lease from modification" : "New lessee lease"}
      size="2xl"
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Legal entity">
            <SearchSelect
              value={f.subsidiaryId ?? ""}
              options={subsidiaries}
              onChange={(v) => set("subsidiaryId", v ?? "")}
              ariaLabel="Legal entity"
            />
          </Field>
          {(
            [
              ["leaseNumber", "Lease number"],
              ["description", "Description"],
              ["commencementOn", "Commencement date"],
              ["termPeriods", "Payment periods"],
              ["paymentAmount", "Payment amount"],
              ["annualDiscountRatePercent", "Annual discount rate (%)"],
            ] as const
          ).map(([key, label]) => (
            <Field key={key} label={label}>
              <Input
                aria-label={label}
                type={key === "commencementOn" ? "date" : "text"}
                value={f[key] ?? ""}
                onChange={(e) => set(key, e.target.value)}
              />
            </Field>
          ))}
          <Field label="Frequency">
            <Select
              value={f.paymentFrequency}
              onChange={(e) => set("paymentFrequency", e.target.value)}
            >
              {frequencies.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Contractual payment timing">
            <Select
              value={f.paymentTiming}
              onChange={(e) => set("paymentTiming", e.target.value)}
            >
              {timings.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Recognition exemption election">
          <Select
            value={f.exemption ?? ""}
            onChange={(e) => set("exemption", e.target.value)}
          >
            {[
              { value: "", label: "None — recognize ROU and liability" },
              { value: "short_term", label: "Qualifying short-term lease" },
              {
                value: "low_value",
                label: "Low-value underlying asset (IFRS only)",
              },
            ].map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        <fieldset className="space-y-2">
          <legend className="font-medium">Classification evidence</legend>
          {(
            [
              ["transfersOwnership", "Ownership transfers"],
              [
                "purchaseOptionReasonablyCertain",
                "Purchase option is reasonably certain",
              ],
              ["specializedAsset", "Asset has no alternative use"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex gap-2">
              <input
                type="checkbox"
                checked={!!flags[key]}
                onChange={(e) =>
                  setFlags((old) => ({ ...old, [key]: e.target.checked }))
                }
              />
              {label}
            </label>
          ))}
          {(
            [
              ["economicLifeMonths", "Remaining economic life (months)"],
              ["pvOfPayments", "PV for classification"],
              ["fairValue", "Asset fair value"],
            ] as const
          ).map(([key, label]) => (
            <Field key={key} label={label}>
              <Input
                aria-label={label}
                value={f[key] ?? ""}
                onChange={(e) => set(key, e.target.value)}
              />
            </Field>
          ))}
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          {accountFields.map(([key, label]) => (
            <Field key={key} label={label}>
              <SearchSelect
                value={f[key] ?? ""}
                options={accounts}
                onChange={(v) => set(key, v ?? "")}
                ariaLabel={label}
              />
            </Field>
          ))}
        </div>
        <fieldset className="space-y-2">
          <legend className="font-medium">
            Previously recorded cost adjustments
          </legend>
          <p className="text-sm">
            Amounts are reclassified from the clearing account; they do not
            create another cash payment.
          </p>
          {(
            [
              ["initialDirectCosts", "Initial direct costs"],
              ["prepayments", "Prepayments before commencement"],
              ["incentives", "Incentives received"],
            ] as const
          ).map(([key, label]) => (
            <Field key={key} label={label}>
              <Input
                aria-label={label}
                value={f[key] ?? ""}
                onChange={(e) => set(key, e.target.value)}
              />
            </Field>
          ))}
          <Field label="Cost / prepaid expense clearing">
            <SearchSelect
              value={f.costClearingAccountId ?? ""}
              options={accounts}
              onChange={(v) => set("costClearingAccountId", v ?? "")}
              ariaLabel="Cost clearing account"
              clearable
            />
          </Field>
        </fieldset>
        {parent ? (
          <>
            <Field label="Reason">
              <Textarea
                value={f.reason ?? ""}
                onChange={(e) => set("reason", e.target.value)}
              />
            </Field>
            <Field label="Standalone-price and scope assessment">
              <Textarea
                value={f.assessment ?? ""}
                onChange={(e) => set("assessment", e.target.value)}
              />
            </Field>
            {(
              [
                ["additionalRightOfUse", "The agreement adds a right of use"],
                [
                  "commensurateStandalonePrice",
                  "The added consideration is commensurate with its standalone price",
                ],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex gap-2">
                <input
                  type="checkbox"
                  checked={!!flags[key]}
                  onChange={(e) =>
                    setFlags((old) => ({ ...old, [key]: e.target.checked }))
                  }
                />
                {label}
              </label>
            ))}
          </>
        ) : null}
        <div className="flex gap-2">
          <Button disabled={busy} onClick={save}>
            {parent ? "Create approval proposal" : "Save draft lease"}
          </Button>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
        </div>
      </div>
    </Drawer>
  );
}
function ChangeLease({
  lease,
  accounts,
}: {
  lease: LeaseDisplay;
  accounts: Option[];
}) {
  const today = useBusinessToday();
  const router = useRouter(),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState("modification"),
    [date, setDate] = useState(today),
    [reason, setReason] = useState(""),
    [assessment, setAssessment] = useState("");
  const [payment, setPayment] = useState(lease.payment_amount),
    [periods, setPeriods] = useState(String(lease.term_periods)),
    [rate, setRate] = useState(lease.annual_discount_rate_percent),
    [timing, setTiming] = useState<string>(lease.payment_timing),
    [frequency, setFrequency] = useState<string>(lease.payment_frequency);
  const [scope, setScope] = useState("0"),
    [settlement, setSettlement] = useState("0"),
    [gainAccount, setGainAccount] = useState(""),
    [key, setKey] = useState(() => crypto.randomUUID());

  // Start the form from the given lease with a fresh idempotency key.
  function resetToLease() {
    setOperation("modification");
    setDate(today);
    setReason("");
    setAssessment("");
    setPayment(lease.payment_amount);
    setPeriods(String(lease.term_periods));
    setRate(lease.annual_discount_rate_percent);
    setTiming(lease.payment_timing);
    setFrequency(lease.payment_frequency);
    setScope("0");
    setSettlement("0");
    setGainAccount("");
    setCriteria((lease.classification_inputs ?? {}) as Record<string, unknown>);
    setKey(crypto.randomUUID());
  }

  // Every open also resets to THIS lease with a fresh key: without it, a
  // reopened popover replays the previous terms, and the second proposal
  // replays the first key and the server refuses it.
  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) return;
    resetToLease();
  }
  const [criteria, setCriteria] = useState<Record<string, unknown>>(
    lease.classification_inputs,
  );
  // A new lease id resets the form even when no remount happens (a keyless
  // parent): otherwise a proposal typed for lease A stays in the form when
  // the page shows lease B. Placed after every useState it touches.
  const [seenLeaseId, setSeenLeaseId] = useState(lease.id);
  if (seenLeaseId !== lease.id) {
    setSeenLeaseId(lease.id);
    resetToLease();
  }
  const criterion = (key: string, value: unknown) =>
    setCriteria((old) => ({ ...old, [key]: value }));
  async function propose() {
    setBusy(true);
    try {
      const result = await request(`/api/leases/${lease.id}/changes`, {
        operation,
        effectiveOn: date,
        reason,
        assessment,
        idempotencyKey: key,
        scopeReductionPercent: operation === "termination" ? "100" : scope,
        settlementPayment: settlement,
        gainLossAccountId: gainAccount,
        ...(operation !== "termination"
          ? {
              remainingTerms: {
                periods: Number(periods),
                payment,
                paymentFrequency: frequency,
                paymentTiming: timing,
                annualRatePercent: rate,
                classificationInputs: criteria,
              },
            }
          : {}),
      });
      router.push(`/accounting/changes?change=${result.changeId}`);
      router.refresh();
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Change proposal failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Popover
      open={open}
      onOpenChange={handleOpenChange}
      trigger={
        <Button variant="outline" onClick={() => handleOpenChange(!open)}>
          Change / terminate
        </Button>
      }
    >
      <div className="max-h-[75vh] w-96 space-y-3 overflow-y-auto p-4">
        <Field label="Change type">
          <Select
            value={operation}
            onChange={(e) => setOperation(e.target.value)}
          >
            {[
              { value: "modification", label: "Contract modification" },
              { value: "remeasurement", label: "Remeasurement" },
              { value: "termination", label: "Full termination" },
            ].map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Effective date">
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        {operation !== "termination" ? (
          <>
            <Field label="Remaining payment periods">
              <Input
                value={periods}
                onChange={(e) => setPeriods(e.target.value)}
              />
            </Field>
            <Field label="Revised payment">
              <Input
                value={payment}
                onChange={(e) => setPayment(e.target.value)}
              />
            </Field>
            <Field label="Annual discount rate (%)">
              <Input value={rate} onChange={(e) => setRate(e.target.value)} />
            </Field>
            <Field label="Payment frequency">
              <Select
                value={frequency}
                onChange={(e) => setFrequency(e.target.value)}
              >
                {frequencies.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Payment timing">
              <Select
                value={timing}
                onChange={(e) => setTiming(e.target.value)}
              >
                {timings.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            {(
              [
                ["transfersOwnership", "Ownership transfers"],
                [
                  "purchaseOptionReasonablyCertain",
                  "Purchase option reasonably certain",
                ],
                [
                  "specializedAsset",
                  "Specialized asset with no alternative use",
                ],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={criteria[key] === true}
                  onChange={(e) => criterion(key, e.target.checked)}
                />
                {label}
              </label>
            ))}
            <Field label="Remaining economic life (months)">
              <Input
                value={String(criteria.economicLifeMonths ?? "")}
                onChange={(e) =>
                  criterion(
                    "economicLifeMonths",
                    e.target.value ? Number(e.target.value) : undefined,
                  )
                }
              />
            </Field>
            {(
              [
                ["pvOfPayments", "Assessed present value of payments"],
                ["fairValue", "Asset fair value"],
                ["termThresholdPercent", "Major part threshold (%)"],
                ["pvThresholdPercent", "Substantially all threshold (%)"],
              ] as const
            ).map(([key, label]) => (
              <Field key={key} label={label}>
                <Input
                  value={String(criteria[key] ?? "")}
                  onChange={(e) => criterion(key, e.target.value || undefined)}
                />
              </Field>
            ))}
            {operation === "modification" ? (
              <Field label="Right-of-use scope removed (%)">
                <Input
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                />
              </Field>
            ) : null}
          </>
        ) : null}
        <Field label="Settlement payment (negative for a refund)">
          <Input
            value={settlement}
            onChange={(e) => setSettlement(e.target.value)}
          />
        </Field>
        <Field label="Gain / loss account">
          <SearchSelect
            value={gainAccount}
            options={accounts}
            onChange={(v) => setGainAccount(v ?? "")}
            ariaLabel="Gain or loss account"
          />
        </Field>
        <Field label="Reason">
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        <Field label="Scope, rate and classification assessment">
          <Textarea
            value={assessment}
            onChange={(e) => setAssessment(e.target.value)}
          />
        </Field>
        <p className="text-xs">
          This creates an immutable proposal. Independent approval is required
          before balances or future payments change.
        </p>
        <Button disabled={busy} onClick={propose}>
          Create approval proposal
        </Button>
      </div>
    </Popover>
  );
}
export function LeaseDrawer({
  payload,
  canManage,
  accounts,
  subsidiaries,
}: { payload: LeasePayload; canManage: boolean } & Choices) {
  const router = useRouter(),
    { money } = useMoney(),
    [busy, setBusy] = useState(false),
    [date, setDate] = useState(useBusinessToday());
  const l = payload.lease;
  async function act(action: "commence" | "post") {
    setBusy(true);
    try {
      const r = await request(`/api/leases/${l.id}/${action}`, {
        asOfDate: date,
      });
      toast.success(
        action === "post"
          ? `${r.posted} schedule events posted; ${r.skipped} skipped`
          : "Lease commenced",
      );
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Lease action failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <UrlDrawer
      open
      closeHref="/assets/leases"
      title={l.lease_number}
      description={l.description ?? undefined}
      size="2xl"
    >
      <div className="space-y-5">
        <div className="flex gap-3">
          <Badge>{l.status}</Badge>
          <span>
            Revision {l.revision} · {l.classification} · {l.payment_timing}
          </span>
        </div>
        <dl className="grid grid-cols-2 gap-3">
          <div>
            <dt>Payment</dt>
            <dd>
              {money(l.payment_amount)} / {l.payment_frequency}
            </dd>
          </div>
          <div>
            <dt>Commencement</dt>
            <dd>{l.commencement_on}</dd>
          </div>
          <div>
            <dt>Initial unpaid liability</dt>
            <dd>
              {l.initial_liability
                ? money(l.initial_liability)
                : "Not commenced"}
            </dd>
          </div>
          <div>
            <dt>Initial right-of-use asset</dt>
            <dd>
              {l.initial_rou_asset
                ? money(l.initial_rou_asset)
                : "Not commenced"}
            </dd>
          </div>
        </dl>
        {canManage ? (
          <div className="flex flex-wrap items-center gap-2">
            {l.status === "draft" ? (
              <Button disabled={busy} onClick={() => act("commence")}>
                Commence lease
              </Button>
            ) : l.status === "active" ? (
              <>
                <Input
                  className="w-40"
                  type="date"
                  value={date}
                  aria-label="Post through date"
                  onChange={(e) => setDate(e.target.value)}
                />
                <Button disabled={busy} onClick={() => act("post")}>
                  Post through date
                </Button>
                <ChangeLease lease={l} accounts={accounts} />
                <NewLeaseButton
                  parent={l}
                  accounts={accounts}
                  subsidiaries={subsidiaries}
                />
              </>
            ) : null}
          </div>
        ) : null}
        <section>
          <h3 className="font-semibold">Payment and accrual history</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Revision</TableHead>
                <TableHead>Cash date</TableHead>
                <TableHead>Accrual date</TableHead>
                <TableHead>Payment</TableHead>
                <TableHead>Interest</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payload.schedule.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    {row.revision} / {row.sequence}
                  </TableCell>
                  <TableCell>{row.due_on}</TableCell>
                  <TableCell>{row.period_end}</TableCell>
                  <TableCell>{money(row.payment)}</TableCell>
                  <TableCell>{money(row.interest)}</TableCell>
                  <TableCell>
                    {row.superseded
                      ? "Superseded"
                      : row.accrual_posted
                        ? "Accrued"
                        : row.payment_posted
                          ? "Paid; accrual pending"
                          : "Planned"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
        <section>
          <h3 className="font-semibold">Accounting events</h3>
          {payload.changes.map((c) => (
            <p key={c.id}>
              <Link
                className="underline"
                href={`/accounting/changes?change=${c.id}`}
              >
                {c.effective_on} · {financialChangeEventLabel(c.operation)} ·{" "}
                {financialChangeStatusLabel(c.status)}
              </Link>{" "}
              — {c.reason}
            </p>
          ))}
        </section>
      </div>
    </UrlDrawer>
  );
}
