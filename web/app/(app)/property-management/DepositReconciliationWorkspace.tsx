"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@openbooks/ui";
import { useBusinessToday } from "@/components/business-date-provider";
import { Empty, Field, Small, Status } from "./workspace-ui";

export function DepositReconciliationWorkspace({ money, onOpenProperty }: any) {
  const [asOf, setAsOf] = useState(useBusinessToday());
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
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
  const totals = result?.totals ?? {};
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
        <Small label="Deposit subledger" value={money(totals.subledgerBalance ?? 0)} />
        <Small label="Linked posted GL" value={money(totals.linkedGlBalance ?? 0)} />
        <Small label="Deposit cash activity" value={money(totals.cashActivity ?? 0)} />
        <Small
          label="Exceptions"
          value={String(
            Number(totals.discrepancies ?? 0) +
              Number(totals.configurationRequired ?? 0),
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
            {rows.map((row: any) => {
              const difference = row.controlVariance ?? row.linkedVariance;
              return (
                <TableRow
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
                  </TableCell>
                  <TableCell>
                    {row.bankAccounts?.length
                      ? row.bankAccounts
                          .map((bank: any) => bank.bankAccountName)
                          .join(", ")
                      : row.defaultBankAccountName ?? "Not configured"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(row.subledgerBalance)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(row.linkedGlBalance)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.locationControlBalance == null ? "—" : money(row.locationControlBalance)}
                  </TableCell>
                  <TableCell className={cn("text-right tabular-nums", Number(difference) !== 0 && "font-medium text-red-600")}>
                    {money(difference ?? 0)}
                  </TableCell>
                  <TableCell>{row.lastActivityOn ?? "—"}</TableCell>
                  <TableCell><Status value={row.status} /></TableCell>
                </TableRow>
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
