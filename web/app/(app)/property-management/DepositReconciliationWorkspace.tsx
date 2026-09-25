"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@openbooks/ui";
import { useBusinessToday } from "@/components/business-date-provider";
import { Empty, Field, Small, Status, formatGroupedMoney, sumByCurrency } from "./workspace-ui";
import type { Money } from "./types";
import { InteractiveTableRow } from '@/components/interactive-table-row'

type ReconciliationRow = {
  propertyId: string;
  propertyName: string;
  propertyCode: string;
  /** Property currency, carried by the engine row: every amount below is
   * formatted in it, and the header totals group by it. */
  currency?: string;
  bankAccounts: Array<{ bankAccountName: string }>;
  defaultBankAccountName: string | null;
  subledgerBalance: string;
  linkedGlBalance: string;
  locationControlBalance: string | null;
  controlVariance: string | null;
  linkedVariance: string;
  controlShared?: boolean;
  controlGroupPropertyIds?: string[];
  controlGroupBalance?: string | null;
  controlGroupVariance?: string | null;
  controlNote?: string | null;
  lastActivityOn: string | null;
  status: string;
  /** Per-property cash activity behind the header total. */
  cashActivity?: string;
};
type ReconciliationResult = {
  rows: ReconciliationRow[];
  totals: {
    subledgerBalance: string;
    linkedGlBalance: string;
    cashActivity: string;
    discrepancies: number;
    configurationRequired: number;
  };
};

export function DepositReconciliationWorkspace({ money, onOpenProperty }: { money: Money; onOpenProperty: (id: string) => void }) {
  const [asOf, setAsOf] = useState(useBusinessToday());
  const [result, setResult] = useState<ReconciliationResult | null>(null);
  const [loading, setLoading] = useState(true);
  // Re-enter the loading state while refetching for another date, during
  // render (same committed value, no extra render).
  const [prevAsOf, setPrevAsOf] = useState(asOf);
  if (prevAsOf !== asOf) {
    setPrevAsOf(asOf);
    setLoading(true);
  }
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/property-management/deposit-reconciliation?asOf=${asOf}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Reconciliation failed");
        if (!cancelled) setResult(body);
      })
      .catch((error) => {
        if (!cancelled)
          toast.error(
            error instanceof Error ? error.message : "Reconciliation failed",
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [asOf]);
  if (loading && !result)
    return (
      <div className="p-12 text-center text-sm text-slate-500">
        Reconciling deposit subledger to the general ledger…
      </div>
    );
  const rows = result?.rows ?? [];
  const totals = result?.totals;
  // The engine totals sum across property currencies: regroup the per-row
  // balances by currency instead, like the workspace metrics above.
  const inCurrency = (row: ReconciliationRow) => row.currency ?? "";
  const subledgerByCurrency = sumByCurrency(rows.map((row) => ({ currency: inCurrency(row), amount: row.subledgerBalance })));
  const linkedByCurrency = sumByCurrency(rows.map((row) => ({ currency: inCurrency(row), amount: row.linkedGlBalance })));
  const cashByCurrency = sumByCurrency(rows.map((row) => ({ currency: inCurrency(row), amount: row.cashActivity ?? "0" })));
  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Security deposit reconciliation</h2>
          <p className="mt-1 max-w-3xl text-xs text-slate-500">
            Compare tenant deposit activity with posted deposit-liability entries
            and the property location control balance. Bank activity is supporting
            evidence and can differ after applications, interest, or adjustments.
          </p>
        </div>
        <div className="w-44">
          <Field label="As of">
            <Input
              type="date"
              value={asOf}
              onChange={(event) => setAsOf(event.target.value)}
            />
          </Field>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Small label="Deposit subledger" value={subledgerByCurrency.length ? formatGroupedMoney(subledgerByCurrency, money) : money(totals?.subledgerBalance ?? 0)} />
        <Small label="Linked posted GL" value={linkedByCurrency.length ? formatGroupedMoney(linkedByCurrency, money) : money(totals?.linkedGlBalance ?? 0)} />
        <Small label="Deposit cash activity" value={cashByCurrency.length ? formatGroupedMoney(cashByCurrency, money) : money(totals?.cashActivity ?? 0)} />
        <Small
          label="Exceptions"
          value={String(
            Number(totals?.discrepancies ?? 0) +
              Number(totals?.configurationRequired ?? 0),
          )}
        />
      </div>
      <div className="overflow-x-auto rounded-md border border-slate-200 dark:border-slate-800">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Property</TableHead>
              <TableHead>Deposit bank</TableHead>
              <TableHead className="text-right">Subledger</TableHead>
              <TableHead className="text-right">Linked GL</TableHead>
              <TableHead className="text-right">Location control</TableHead>
              <TableHead className="text-right">Difference</TableHead>
              <TableHead>Last activity</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              // A shared location control reconciles as one group: the
              // difference shown is the combined group variance, never a
              // per-property slice of the shared balance.
              const difference = row.controlShared
                ? (row.controlGroupVariance ?? row.linkedVariance)
                : (row.controlVariance ?? row.linkedVariance);
              // Every balance belongs to this property's currency: format in
              // it, never in the org default across a mixed portfolio.
              const rowMoney = (value: string | number | null | undefined) =>
                money(value ?? 0, row.currency ? { currency: row.currency } : undefined);
              return (
                <InteractiveTableRow
                  key={row.propertyId}
                  role="button"
                  tabIndex={0}
                  className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-600"
                  onClick={() => onOpenProperty(row.propertyId)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onOpenProperty(row.propertyId);
                    }
                  }}
                >
                  <TableCell>
                    <div className="font-medium">{row.propertyName}</div>
                    <div className="font-mono text-xs text-slate-500">{row.propertyCode}</div>
                    {row.controlNote ? (
                      <div className="text-xs text-slate-500">{row.controlNote}</div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {row.bankAccounts?.length
                      ? row.bankAccounts
                          .map((bank) => bank.bankAccountName)
                          .join(", ")
                      : row.defaultBankAccountName ?? "Not configured"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{rowMoney(row.subledgerBalance)}</TableCell>
                  <TableCell className="text-right tabular-nums">{rowMoney(row.linkedGlBalance)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.locationControlBalance == null ? "—" : rowMoney(row.locationControlBalance)}
                  </TableCell>
                  <TableCell className={cn("text-right tabular-nums", Number(difference) !== 0 && "font-medium text-red-600")}>
                    {rowMoney(difference)}
                  </TableCell>
                  <TableCell>{row.lastActivityOn ?? "—"}</TableCell>
                  <TableCell><Status value={row.status} /></TableCell>
                </InteractiveTableRow>
              );
            })}
          </TableBody>
        </Table>
        {!rows.length ? (
          <Empty title="No properties to reconcile" detail="Create a property and lease before running deposit reconciliation." />
        ) : null}
      </div>
    </div>
  );
}
