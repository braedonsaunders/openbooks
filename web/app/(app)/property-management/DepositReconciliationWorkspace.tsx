"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Input, cn } from "@openbooks/ui";
import { PagedTable } from "../../../components/paged-table";
import { useBusinessToday } from "@/components/business-date-provider";
import { readApiErrorMessage } from "../../../lib/api-error";
import { Empty, Field, Small, Status, formatGroupedMoney, sumByCurrency } from "./workspace-ui";
import type { Money } from "./types";

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
  const [error, setError] = useState<string | null>(null);
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
        // The status is checked before the body parses: a non-JSON error
        // page must name the failure, never throw out of .json().
        if (!response.ok) throw new Error(await readApiErrorMessage(response, "Reconciliation failed"));
        if (!cancelled) {
          setResult(await response.json());
          setError(null);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : "Reconciliation failed";
          toast.error(message);
          // A failed refetch drops to the failure state: stale balances
          // must never keep rendering as if they were current.
          setResult(null);
          setError(message);
        }
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
  // Search text mirrors the displayed cells in plain strings: names, codes,
  // bank names and the status label.
  const searchText = (row: ReconciliationRow) =>
    [row.propertyName, row.propertyCode, row.controlNote,
      ...(row.bankAccounts ?? []).map((bank) => bank.bankAccountName),
      row.defaultBankAccountName, row.status]
      .map((value) => String(value ?? ""))
      .join(" ");
  return (
    <div className="space-y-4 p-4">
      <div>
        <h2 className="text-sm font-semibold">Security deposit reconciliation</h2>
        <p className="mt-1 max-w-3xl text-xs text-slate-500">
          Compare tenant deposit activity with posted deposit-liability entries
          and the property location control balance. Bank activity is supporting
          evidence and can differ after applications, interest, or adjustments.
        </p>
      </div>
      {error && rows.length === 0 ? (
        <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      ) : (
      <>
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
      <PagedTable
        source="property_deposit_reconciliation"
        rows={rows}
        rowKey={(row) => row.propertyId}
        searchable
        onRowClick={(row) => onOpenProperty(row.propertyId)}
        rowRole="button"
        empty={<Empty title="No properties to reconcile" detail="Create a property and lease before running deposit reconciliation." />}
        toolbarAfter={(
          <div className="w-44">
            <Field label="As of">
              <Input
                type="date"
                value={asOf}
                onChange={(event) => setAsOf(event.target.value)}
              />
            </Field>
          </div>
        )}
        columns={[
          {
            key: "property",
            header: "Property",
            cell: (row) => (
              <>
                <div className="font-medium">{row.propertyName}</div>
                <div className="font-mono text-xs text-slate-500">{row.propertyCode}</div>
                {row.controlNote ? (
                  <div className="text-xs text-slate-500">{row.controlNote}</div>
                ) : null}
              </>
            ),
            search: searchText,
          },
          {
            key: "bank",
            header: "Deposit bank",
            cell: (row) => row.bankAccounts?.length
              ? row.bankAccounts.map((bank) => bank.bankAccountName).join(", ")
              : row.defaultBankAccountName ?? "Not configured",
            search: searchText,
          },
          {
            key: "subledger",
            header: "Subledger",
            align: "right",
            cell: (row) => money(row.subledgerBalance, row.currency ? { currency: row.currency } : undefined),
          },
          {
            key: "linkedGl",
            header: "Linked GL",
            align: "right",
            cell: (row) => money(row.linkedGlBalance, row.currency ? { currency: row.currency } : undefined),
          },
          {
            key: "control",
            header: "Location control",
            align: "right",
            cell: (row) => row.locationControlBalance == null
              ? "—"
              : money(row.locationControlBalance, row.currency ? { currency: row.currency } : undefined),
          },
          {
            key: "difference",
            header: "Difference",
            align: "right",
            cell: (row) => {
              // A shared location control reconciles as one group: the
              // difference shown is the combined group variance, never a
              // per-property slice of the shared balance.
              const difference = row.controlShared
                ? (row.controlGroupVariance ?? row.linkedVariance)
                : (row.controlVariance ?? row.linkedVariance);
              // Every balance belongs to this property's currency: format in
              // it, never in the org default across a mixed portfolio.
              return (
                <span className={cn(Number(difference) !== 0 && "font-medium text-red-600")}>
                  {money(difference, row.currency ? { currency: row.currency } : undefined)}
                </span>
              );
            },
          },
          { key: "activity", header: "Last activity", cell: (row) => row.lastActivityOn ?? "—" },
          { key: "status", header: "Status", cell: (row) => <Status value={row.status} />, search: searchText },
        ]}
      />
      </>
      )}
    </div>
  );
}
